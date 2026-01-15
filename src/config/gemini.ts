import { GoogleGenAI } from "@google/genai";

// Initialize the Gemini AI client
// Using the recommended pattern from guidelines
export const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

export const getGeminiApiKeys = (): string[] => {
  const base = [process.env.API_KEY, process.env.GEMINI_API_KEY, ...GEMINI_API_KEYS]
    .map(k => (k || '').trim())
    .filter(Boolean);
  return Array.from(new Set(base));
};

let geminiKeyIndex = 0;
export const getNextGeminiApiKey = (): string | undefined => {
  const keys = getGeminiApiKeys();
  if (keys.length === 0) return undefined;
  const k = keys[geminiKeyIndex % keys.length];
  geminiKeyIndex = (geminiKeyIndex + 1) % keys.length;
  return k;
};

export const createGeminiClient = (apiKey?: string) => {
  const key = (apiKey || '').trim() || getNextGeminiApiKey();
  return new GoogleGenAI({ apiKey: key });
};

export const ai = new GoogleGenAI({
  apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY || GEMINI_API_KEYS[0],
});

// Define models based on task requirements
// Updated to gemini-3-flash-preview as per coding guidelines for basic text tasks
export const QUIZ_MODELS = [
  // Quality-first
  'gemini-1.5-pro-latest',
  // Faster fallback
  'gemini-1.5-flash-latest',
  // Newer families (availability depends on account/region)
  'gemini-2.0-flash',
  'gemini-2.0-flash-exp',
  // Some accounts/regions expose non-latest aliases
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  // Some accounts expose numbered variants
  'gemini-1.5-pro-002',
  'gemini-1.5-flash-002',
];

export const QUIZ_MODEL = QUIZ_MODELS[0];