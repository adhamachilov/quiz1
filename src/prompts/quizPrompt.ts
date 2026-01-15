import { Difficulty, QuestionType } from "../types/quiz.js";

export const getSystemInstruction = (): string => {
  return `You are a strict quiz generator. Output valid JSON only (no markdown/code fences).`;
};

export const generateQuizPrompt = (
  content: string,
  count: number,
  difficulty: Difficulty,
  language: 'en' | 'uz' | 'ru',
  avoidQuestions?: string[],
  questionType: QuestionType = 'poll'
): string => {
  let difficultyGuidance = "";

  switch (difficulty) {
    case 'easy':
      difficultyGuidance = "Basic definitions/vocabulary and simple facts.";
      break;
    case 'exam':
      difficultyGuidance = "Conceptual understanding and cause-effect (exam-style).";
      break;
    case 'hard':
      difficultyGuidance = "Tricky logic, edge cases, and synthesis of ideas.";
      break;
  }

  const avoidLimit = Math.max(0, parseInt(process.env.AVOID_QUESTIONS_LIMIT || '12', 10) || 12);
  const avoidMaxLen = Math.max(20, parseInt(process.env.AVOID_QUESTION_MAX_CHARS || '160', 10) || 160);
  const avoidBlock = Array.isArray(avoidQuestions) && avoidQuestions.length && avoidLimit > 0
    ? `\n\nAvoid duplicates (including paraphrases):\n${avoidQuestions
        .slice(0, avoidLimit)
        .map((q, i) => {
          const s = String(q ?? '');
          return `${i + 1}) ${s.length <= avoidMaxLen ? s : s.slice(0, Math.max(0, avoidMaxLen - 1)).trimEnd()}`;
        })
        .join('\n')}`
    : '';

  const taskLine = questionType === 'open'
    ? `Generate ${count} open-ended questions from the text below.`
    : questionType === 'tfng'
      ? `Generate ${count} True/False/Not Given (IELTS) questions from the text below.`
      : `Generate ${count} multiple-choice questions from the text below.`;

  const formatBlock = questionType === 'open'
    ? `{"questions":[{"question":"...","answer":"...","acceptableAnswers":["..."],"explanation":"..."}]}`
    : questionType === 'tfng'
      ? `{"questions":[{"question":"...","options":["True","False","NG"],"correctIndex":0,"explanation":"..."}]}`
      : `{"questions":[{"question":"...","options":["A","B","C","D"],"correctIndex":0,"explanation":"..."}]}`;

  const typeRules = questionType === 'open'
    ? `3. Provide a short correct answer.
4. acceptableAnswers: short variants/synonyms (can be empty).`
    : questionType === 'tfng'
      ? `3. Options must be exactly ["True","False","NG"] in this order.
4. correctIndex: 0/1/2.
5. Use NG only if the statement is NOT mentioned.`
      : `3. Exactly 4 options.
4. correctIndex: 0/1/2/3.`;

  return `
${taskLine}

Language: same as the text (do NOT translate). Hint: ${language === 'en' ? 'English' : language === 'uz' ? 'Uzbek' : 'Russian'}.
Difficulty: ${difficulty.toUpperCase()} — ${difficultyGuidance}

Rules:
1. Use ONLY the text. Do not invent facts.
2. If insufficient, return {"questions":[]}.
${typeRules}
5. explanation: 1 sentence, max 120 characters.
6. Avoid meta phrases like "according to the text" / mentioning the passage.
${avoidBlock}

Output Format (Strict JSON):
${formatBlock}

Text:
"${content}"
`;
};
