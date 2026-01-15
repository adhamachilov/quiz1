import {
  ai,
  QUIZ_MODEL,
  QUIZ_MODELS,
  createGeminiClient,
  getGeminiApiKeys,
} from "../config/gemini.js";
import { generateQuizPrompt, getSystemInstruction } from "../prompts/quizPrompt.js";
import { Difficulty, QuizResponse, Language, QuestionType } from "../types/quiz.js";
import { chunkText } from "../utils/chunkText.js";

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 2000;
const GENERATION_TIMEOUT_MS = 25000;

const MAX_GEMINI_RETRY_DELAY_MS = Math.max(
  1000,
  parseInt(process.env.GEMINI_MAX_RETRY_DELAY_MS || '7000', 10) || 7000
);

const MAX_GEMINI_TOTAL_TIME_MS = Math.max(
  5000,
  parseInt(process.env.GEMINI_MAX_TOTAL_TIME_MS || '35000', 10) || 35000
);

const MAX_GLOBAL_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.LLM_MAX_CONCURRENCY || "5", 10) || 5
);

let inFlight = 0;
const waiters: Array<() => void> = [];

const acquire = async () => {
  if (inFlight < MAX_GLOBAL_CONCURRENCY) {
    inFlight++;
    return;
  }
  await new Promise<void>(resolve => {
    waiters.push(() => {
      inFlight++;
      resolve();
    });
  });
};

const formatProviderError = (e: any): string => {
  const msg = String(e?.message || e || 'Unknown error');
  const status = e?.status ? ` status=${e.status}` : '';
  const body = String(e?.body || '').trim();
  const bodyLine = body ? `\n${body.slice(0, 400)}` : '';
  return `${msg}${status}${bodyLine}`;
};

const release = () => {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
};

const withConcurrencyLimit = async <T>(fn: () => Promise<T>): Promise<T> => {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
};

const sanitizeJsonString = (raw: string): string => {
  let s = String(raw ?? '').trim();
  if (!s) return s;

  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1).trim();
  }

  // Remove ```json fences if present
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*/m, '');
    s = s.replace(/```\s*$/m, '');
    s = s.trim();
  }

  const extractFirstBalancedJson = (input: string): string | null => {
    const startObj = input.indexOf('{');
    const startArr = input.indexOf('[');
    const start =
      startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
    if (start < 0) return null;

    const openChar = input[start];
    const closeChar = openChar === '{' ? '}' : ']';

    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < input.length; i++) {
      const ch = input[i];
      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === '\\') {
          esc = true;
          continue;
        }
        if (ch === '"') {
          inStr = false;
        }
        continue;
      }

      if (ch === '"') {
        inStr = true;
        continue;
      }

      if (ch === openChar) depth++;
      if (ch === closeChar) depth--;

      if (depth === 0) {
        return input.slice(start, i + 1);
      }
    }
    return null;
  };

  const balanced = extractFirstBalancedJson(s);
  if (balanced) {
    s = balanced;
  } else {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      s = s.slice(start, end + 1);
    }
  }

  // Remove trailing commas before } or ] (common LLM mistake)
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
};

const tryRecoverQuizJson = (raw: string): any | undefined => {
  const s = String(raw ?? '');
  const m = s.match(/"questions"\s*:\s*\[/);
  if (!m || !m.index) return undefined;

  const arrStart = s.indexOf('[', m.index);
  if (arrStart < 0) return undefined;

  const objs: any[] = [];
  let i = arrStart + 1;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === ']') break;
    if (s[i] !== '{') break;

    let depth = 0;
    let inStr = false;
    let esc = false;
    const start = i;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === '\\') {
          esc = true;
          continue;
        }
        if (ch === '"') {
          inStr = false;
        }
        continue;
      }

      if (ch === '"') {
        inStr = true;
        continue;
      }

      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth === 0) {
        const objStr = s.slice(start, i + 1);
        try {
          objs.push(JSON.parse(sanitizeJsonString(objStr)));
        } catch {
          return undefined;
        }
        i++;
        break;
      }
    }

    if (depth !== 0) break;
  }

  if (objs.length === 0) return undefined;
  return { questions: objs };
};

const safeJsonParse = (raw: string): any => {
  const cleaned = sanitizeJsonString(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    const recovered = tryRecoverQuizJson(String(raw ?? ''));
    if (recovered) return recovered;
    const err: any = new Error('Invalid JSON');
    err.body = cleaned.slice(0, 400);
    throw err;
  }
};

const callGroq = async (
  prompt: string,
  model: string
): Promise<{ content: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }> => {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY missing');
  }
  const wantJson = (process.env.LLM_JSON_MODE || '1') !== '0';
  const baseBody: any = {
    model,
    temperature: 0.3,
    max_tokens: Math.max(200, parseInt(process.env.GROQ_MAX_TOKENS || '900', 10) || 900),
    messages: [
      { role: 'system', content: getSystemInstruction() },
      { role: 'user', content: prompt },
    ],
    ...(wantJson ? { response_format: { type: 'json_object' } } : {}),
  };

  let res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(baseBody),
  });

  // If response_format isn't supported by a model/provider, retry once without it.
  if (!res.ok && wantJson && res.status === 400) {
    const text0 = await res.text().catch(() => '');
    if (text0.toLowerCase().includes('response_format')) {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ ...baseBody, response_format: undefined }),
      });
    } else {
      const err: any = new Error(`GROQ_HTTP_${res.status}`);
      err.status = res.status;
      err.body = text0;
      throw err;
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: any = new Error(`GROQ_HTTP_${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const data: any = await res.json();
  const contentRaw = data?.choices?.[0]?.message?.content;
  if (contentRaw === undefined || contentRaw === null) throw new Error('Empty response from Groq');
  const content = typeof contentRaw === 'string' ? contentRaw : JSON.stringify(contentRaw);
  if (!content) throw new Error('Empty response from Groq');
  const usage = data?.usage
    ? {
        promptTokens: Number(data.usage.prompt_tokens ?? 0) || 0,
        completionTokens: Number(data.usage.completion_tokens ?? 0) || 0,
        totalTokens: Number(data.usage.total_tokens ?? 0) || 0,
      }
    : undefined;
  return { content: String(content), usage };
};

const callDeepSeek = async (
  prompt: string,
  model: string
): Promise<{ content: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }> => {
  const apiKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY missing');
  }

  const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').trim().replace(/\/$/, '');
  const url = `${baseUrl}/chat/completions`;

  const wantJson = (process.env.LLM_JSON_MODE || '1') !== '0';
  const dsMaxTokensRaw = (process.env.DEEPSEEK_MAX_TOKENS || '').trim();
  const dsMaxTokens = dsMaxTokensRaw ? parseInt(dsMaxTokensRaw, 10) : NaN;
  const baseBody: any = {
    model,
    temperature: 0.3,
    max_tokens: Math.max(200, (Number.isFinite(dsMaxTokens) ? dsMaxTokens : 1800)),
    messages: [
      { role: 'system', content: getSystemInstruction() },
      { role: 'user', content: prompt },
    ],
    ...(wantJson ? { response_format: { type: 'json_object' } } : {}),
  };

  let res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(baseBody),
  });

  if (!res.ok && wantJson && res.status === 400) {
    const text0 = await res.text().catch(() => '');
    if (text0.toLowerCase().includes('response_format')) {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ ...baseBody, response_format: undefined }),
      });
    } else {
      const err: any = new Error(`DEEPSEEK_HTTP_${res.status}`);
      err.status = res.status;
      err.body = text0;
      throw err;
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: any = new Error(`DEEPSEEK_HTTP_${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const data: any = await res.json();
  const contentRaw = data?.choices?.[0]?.message?.content;
  if (contentRaw === undefined || contentRaw === null) throw new Error('Empty response from DeepSeek');
  const content = typeof contentRaw === 'string' ? contentRaw : JSON.stringify(contentRaw);
  if (!content) throw new Error('Empty response from DeepSeek');
  const usage = data?.usage
    ? {
        promptTokens: Number(data.usage.prompt_tokens ?? 0) || 0,
        completionTokens: Number(data.usage.completion_tokens ?? 0) || 0,
        totalTokens: Number(data.usage.total_tokens ?? 0) || 0,
      }
    : undefined;
  return { content: String(content), usage };
};

const normalizeUsage = (usage: any): { promptTokens?: number; completionTokens?: number; totalTokens?: number } => {
  if (!usage) return {};

  const prompt =
    usage.promptTokenCount ??
    usage.promptTokens ??
    usage.inputTokenCount ??
    usage.inputTokens ??
    usage.prompt_tokens;
  const completion =
    usage.candidatesTokenCount ??
    usage.candidateTokenCount ??
    usage.outputTokenCount ??
    usage.outputTokens ??
    usage.completionTokens ??
    usage.completion_tokens;
  const total = usage.totalTokenCount ?? usage.totalTokens ?? usage.total_tokens;

  const p = Number(prompt);
  const c = Number(completion);
  const t = Number(total);

  const out: { promptTokens?: number; completionTokens?: number; totalTokens?: number } = {};
  if (Number.isFinite(p) && p > 0) out.promptTokens = p;
  if (Number.isFinite(c) && c > 0) out.completionTokens = c;
  if (Number.isFinite(t) && t > 0) out.totalTokens = t;

  if (out.totalTokens === undefined) {
    const sum = (out.promptTokens ?? 0) + (out.completionTokens ?? 0);
    if (sum > 0) out.totalTokens = sum;
  }

  return out;
};

const GROQ_MODEL_CANDIDATES = Array.from(
  new Set(
    [
      (process.env.GROQ_MODEL || '').trim(),
      // Groq production models (see https://console.groq.com/docs/models)
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
      // Preview but often available; safe as a last resort
      'qwen/qwen3-32b',
    ].filter(Boolean)
  )
);

const DEEPSEEK_MODEL_CANDIDATES = Array.from(
  new Set(
    [
      (process.env.DEEPSEEK_MODEL || '').trim(),
      'deepseek-chat',
      'deepseek-reasoner',
    ].filter(Boolean)
  )
);

export const llmStats = {
  geminiAttempts: 0,
  geminiSuccess: 0,
  geminiFail: 0,
  deepseekAttempts: 0,
  deepseekSuccess: 0,
  deepseekFail: 0,
  groqAttempts: 0,
  groqSuccess: 0,
  groqFail: 0,
  lastProvider: '' as 'gemini' | 'deepseek' | 'groq' | '',
  lastModel: '' as string,
  lastError: '' as string,
};

export const getLlmStats = () => ({ ...llmStats });

export const resetLlmStats = () => {
  llmStats.geminiAttempts = 0;
  llmStats.geminiSuccess = 0;
  llmStats.geminiFail = 0;
  llmStats.deepseekAttempts = 0;
  llmStats.deepseekSuccess = 0;
  llmStats.deepseekFail = 0;
  llmStats.groqAttempts = 0;
  llmStats.groqSuccess = 0;
  llmStats.groqFail = 0;
  llmStats.lastProvider = '';
  llmStats.lastModel = '';
  llmStats.lastError = '';
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const generateQuiz = async (
  fileText: string, 
  count: number, 
  difficulty: Difficulty,
  language: Language,
  avoidQuestions?: string[],
  windowIndex?: number,
  questionType: QuestionType = 'poll',
  usageCollector?: (u: {
    provider: 'gemini' | 'deepseek' | 'groq';
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }) => void
): Promise<QuizResponse> => {
  return await withConcurrencyLimit(async () => {
    const startedAt = Date.now();

    // Safety: Limit text size
    const safeText = chunkText(fileText, windowIndex ?? 0);

    // Construct Prompt
    const prompt = generateQuizPrompt(safeText, count, difficulty, language, avoidQuestions, questionType);

    const envModel = (process.env.GEMINI_MODEL || process.env.QUIZ_MODEL || '').trim();
    const modelCandidates = Array.from(
      new Set([envModel, QUIZ_MODEL, ...(QUIZ_MODELS ?? [])].filter(Boolean))
    ) as string[];

    const keyCandidates = getGeminiApiKeys();

    let modelIndex = 0;
    let keyIndex = 0;
    let attempt = 0;
    let lastSuggestedRetrySeconds: string | undefined;

    const canUseGemini = keyCandidates.length > 0;
    const canUseDeepSeek = Boolean((process.env.DEEPSEEK_API_KEY || '').trim());
    const canUseGroq = Boolean((process.env.GROQ_API_KEY || '').trim());

    // If Gemini isn't configured at all, go straight to DeepSeek/Groq.
    if (!canUseGemini) {
      if (canUseDeepSeek) {
        llmStats.deepseekAttempts++;
        llmStats.lastProvider = 'deepseek';
        let lastDsErr: any;
        for (const m of DEEPSEEK_MODEL_CANDIDATES) {
          try {
            llmStats.lastModel = m;
            const dsRes = await callDeepSeek(prompt, m);
            const quizData: QuizResponse = safeJsonParse(dsRes.content);
            if (!quizData.questions || !Array.isArray(quizData.questions)) {
              throw new Error('Invalid JSON structure received from AI');
            }
            if (quizData.questions.length === 0) {
              throw new Error('Insufficient content');
            }
            try {
              const usage = normalizeUsage(dsRes.usage);
              usageCollector?.({ provider: 'deepseek', model: m, ...usage });
            } catch {
              // ignore token tracking errors
            }
            llmStats.deepseekSuccess++;
            llmStats.lastError = '';
            return quizData;
          } catch (e: any) {
            lastDsErr = e;
            const body = String(e?.body || '');
            const invalidReq = body.includes('invalid_request_error');
            const modelNotFound = body.toLowerCase().includes('model') && body.toLowerCase().includes('not found');
            if (e?.status === 400 && (invalidReq || modelNotFound)) {
              continue;
            }
            break;
          }
        }
        llmStats.deepseekFail++;
        llmStats.lastError = formatProviderError(lastDsErr);

        // If DeepSeek is configured but failed (and there is no Groq), surface the real error.
        if (!canUseGroq) {
          throw new Error(`DeepSeek failed: ${formatProviderError(lastDsErr)}`);
        }
      }

      if (canUseGroq) {
        llmStats.groqAttempts++;
        llmStats.lastProvider = 'groq';
        let lastGroqErr: any;
        for (const m of GROQ_MODEL_CANDIDATES) {
          try {
            llmStats.lastModel = m;
            const groqRes = await callGroq(prompt, m);
            const quizData: QuizResponse = safeJsonParse(groqRes.content);
            if (!quizData.questions || !Array.isArray(quizData.questions)) {
              throw new Error('Invalid JSON structure received from AI');
            }
            if (quizData.questions.length === 0) {
              throw new Error('Insufficient content');
            }
            try {
              const usage = normalizeUsage(groqRes.usage);
              usageCollector?.({ provider: 'groq', model: m, ...usage });
            } catch {
              // ignore token tracking errors
            }
            llmStats.groqSuccess++;
            llmStats.lastError = '';
            return quizData;
          } catch (e: any) {
            lastGroqErr = e;
            const body = String(e?.body || '');
            const modelDecom = body.includes('model_decommissioned') || body.toLowerCase().includes('decommissioned');
            const invalidReq = body.includes('invalid_request_error');
            if (e?.status === 400 && (modelDecom || invalidReq)) {
              continue;
            }
            break;
          }
        }
        llmStats.groqFail++;
        llmStats.lastError = formatProviderError(lastGroqErr);
        throw new Error(`Groq failed: ${formatProviderError(lastGroqErr)}`);
      }

      throw new Error('No LLM provider configured. Set DEEPSEEK_API_KEY and/or GROQ_API_KEY (and optionally Gemini keys).');
    }

    while (attempt <= MAX_RETRIES) {
      const currentModel = modelCandidates[modelIndex] || QUIZ_MODEL;
      const currentKey = keyCandidates.length > 0 ? keyCandidates[keyIndex % keyCandidates.length] : undefined;
      const client = currentKey ? createGeminiClient(currentKey) : ai;

      try {
        llmStats.geminiAttempts++;
        llmStats.lastProvider = 'gemini';
        llmStats.lastModel = currentModel;
        const generationPromise = (client as any).models.generateContent({
          model: currentModel,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            systemInstruction: getSystemInstruction(),
            temperature: 0.3,
          },
        });

        const response = (await Promise.race([
          generationPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('GENERATION_TIMEOUT')),
            GENERATION_TIMEOUT_MS)
          ),
        ])) as any;

        const responseText = response.text;
        if (!responseText) throw new Error("Empty response from Gemini");

        if (String(responseText).toLowerCase().includes("insufficient content")) {
          throw new Error("Insufficient content");
        }

        const quizData: QuizResponse = safeJsonParse(String(responseText));
        if (!quizData.questions || !Array.isArray(quizData.questions)) {
          throw new Error("Invalid JSON structure received from AI");
        }
        if (quizData.questions.length === 0) {
          throw new Error("Insufficient content");
        }

        try {
          const usage = normalizeUsage((response as any)?.usageMetadata ?? (response as any)?.usage);
          usageCollector?.({ provider: 'gemini', model: currentModel, ...usage });
        } catch {
          // ignore token tracking errors
        }

        llmStats.geminiSuccess++;
        llmStats.lastError = '';
        return quizData;
      } catch (error: any) {
        llmStats.geminiFail++;
        llmStats.lastError = String(error?.message || error);
        attempt++;

        if (error?.message === "Insufficient content") {
          throw error;
        }

        const msg = String(error?.message || '');
        const status = error?.status;

        const retryMatch1 = msg.match(/Please retry in\s+([0-9.]+)s/i);
        const retryMatch2 = msg.match(/retryDelay"\s*:\s*"(\d+)s"/i);
        const retrySeconds = retryMatch1?.[1] || retryMatch2?.[1];
        if (retrySeconds) {
          lastSuggestedRetrySeconds = retrySeconds;
        }

        // Some Gemini projects/models return "FreeTier ... limit: 0" even at 0 usage.
        // This is not a temporary rate limit; it effectively means "Gemini cannot be used".
        const isHardFreeTierZero =
          msg.includes('limit: 0') &&
          (msg.includes('generate_content_free_tier') || msg.includes('FreeTier'));

        const isModelNotFound = status === 404 || msg.includes('404') || msg.includes('models/') && msg.includes('not found');
        const isRateLimit = status === 429 || msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('quota');
        const isForbidden = status === 401 || status === 403 || msg.includes('403') || msg.includes('401') || msg.toLowerCase().includes('permission');
        const isServerOverload = status === 503 || msg.includes('503');
        const isTimeout = msg === 'GENERATION_TIMEOUT' || msg.includes('TIMEOUT');

        if (isModelNotFound && modelIndex + 1 < modelCandidates.length) {
          console.warn(`Switching Gemini model from ${currentModel} to ${modelCandidates[modelIndex + 1]}`);
          modelIndex++;
          attempt = 0;
          continue;
        }

        if ((isRateLimit || isForbidden || isServerOverload || isTimeout) && keyCandidates.length > 1) {
          keyIndex++;
        }

        if ((isRateLimit || isServerOverload || isTimeout) && attempt <= MAX_RETRIES && !isHardFreeTierZero) {
          const rawWaitTime = retrySeconds
            ? Math.max(500, Math.ceil(Number(retrySeconds) * 1000))
            : (INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt));

          const elapsed = Date.now() - startedAt;
          const cappedWaitTime = Math.min(rawWaitTime, MAX_GEMINI_RETRY_DELAY_MS);
          const wouldExceedBudget = elapsed + cappedWaitTime > MAX_GEMINI_TOTAL_TIME_MS;
          const suggestedTooLong = rawWaitTime > MAX_GEMINI_RETRY_DELAY_MS;

          // If Gemini tells us to wait tens of seconds and another provider is available, fall back immediately.
          if ((canUseDeepSeek || canUseGroq) && (suggestedTooLong || wouldExceedBudget)) {
            console.warn(
              `⚠️ Gemini suggested a long retry delay (${rawWaitTime}ms) or exceeded time budget; falling back to another provider.`
            );
          } else {
            console.warn(`⚠️ Gemini Busy/Slow (Attempt ${attempt}/${MAX_RETRIES}). Retrying in ${cappedWaitTime}ms...`);
            await delay(cappedWaitTime);
            continue;
          }
        }

        // Fallback to DeepSeek when Gemini is unavailable or overloaded
        if (canUseDeepSeek && (isModelNotFound || isRateLimit || isServerOverload || isTimeout || isForbidden)) {
          try {
            llmStats.deepseekAttempts++;
            llmStats.lastProvider = 'deepseek';
            let lastDsErr: any;
            for (const m of DEEPSEEK_MODEL_CANDIDATES) {
              try {
                llmStats.lastModel = m;
                const dsRes = await callDeepSeek(prompt, m);
                const quizData: QuizResponse = safeJsonParse(dsRes.content);
                if (!quizData.questions || !Array.isArray(quizData.questions)) {
                  throw new Error('Invalid JSON structure received from AI');
                }
                if (quizData.questions.length === 0) {
                  throw new Error('Insufficient content');
                }

                try {
                  const usage = normalizeUsage(dsRes.usage);
                  usageCollector?.({ provider: 'deepseek', model: m, ...usage });
                } catch {
                  // ignore token tracking errors
                }

                llmStats.deepseekSuccess++;
                llmStats.lastError = '';
                return quizData;
              } catch (e: any) {
                lastDsErr = e;
                const body = String(e?.body || '');
                const invalidReq = body.includes('invalid_request_error');
                const modelNotFound = body.toLowerCase().includes('model') && body.toLowerCase().includes('not found');
                if (e?.status === 400 && (invalidReq || modelNotFound)) {
                  continue;
                }
                throw e;
              }
            }
            throw lastDsErr;
          } catch (dsErr) {
            llmStats.deepseekFail++;
            llmStats.lastError = String((dsErr as any)?.message || dsErr);
            console.error('DeepSeek fallback failed:', dsErr);
          }
        }

        // Fallback to Groq when Gemini/DeepSeek are unavailable or overloaded
        if (canUseGroq && (isModelNotFound || isRateLimit || isServerOverload || isTimeout || isForbidden)) {
          try {
            llmStats.groqAttempts++;
            llmStats.lastProvider = 'groq';
            let lastGroqErr: any;
            for (const m of GROQ_MODEL_CANDIDATES) {
              try {
                llmStats.lastModel = m;
                const groqRes = await callGroq(prompt, m);
                const quizData: QuizResponse = safeJsonParse(groqRes.content);
                if (!quizData.questions || !Array.isArray(quizData.questions)) {
                  throw new Error("Invalid JSON structure received from AI");
                }
                if (quizData.questions.length === 0) {
                  throw new Error("Insufficient content");
                }

                try {
                  const usage = normalizeUsage(groqRes.usage);
                  usageCollector?.({ provider: 'groq', model: m, ...usage });
                } catch {
                  // ignore token tracking errors
                }

                llmStats.groqSuccess++;
                llmStats.lastError = '';
                return quizData;
              } catch (e: any) {
                lastGroqErr = e;
                const body = String(e?.body || '');
                const modelDecom = body.includes('model_decommissioned') || body.toLowerCase().includes('decommissioned');
                const invalidReq = body.includes('invalid_request_error');
                if (e?.status === 400 && (modelDecom || invalidReq)) {
                  continue;
                }
                throw e;
              }
            }
            throw lastGroqErr;
          } catch (groqErr) {
            llmStats.groqFail++;
            llmStats.lastError = String((groqErr as any)?.message || groqErr);
            console.error('Groq fallback failed:', groqErr);
          }
        }

        console.error("Gemini Generation Error:", error);
        if (attempt > MAX_RETRIES && isRateLimit) {
          const extra = lastSuggestedRetrySeconds ? ` Please retry in ${lastSuggestedRetrySeconds}s.` : '';
          throw new Error(`Gemini API Quota Exceeded. The system is currently busy.${extra}`);
        }
        throw new Error("Failed to generate quiz. The AI service might be busy or the file content is unclear.");
      }
    }

    throw new Error("Unexpected error in generation loop.");
  });
};