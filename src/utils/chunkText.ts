/**
 * Chunks text to ensure it fits within reasonable context windows.
 * 
 * Approximate token count: 1 token ~= 4 chars.
 * 
 * Free Tier limits are strict (often ~1M tokens/minute or less depending on the model).
 * To ensure reliability for free accounts, we aggressively limit the context
 * to ~30,000 characters (approx 7,500 tokens). This leaves plenty of room
 * for the response and prevents instant 429 quota errors.
 */

export const getMaxInputChars = (): number => {
  return Math.max(1000, parseInt(process.env.LLM_INPUT_MAX_CHARS || '30000', 10) || 30000);
};

const MAX_CHARS = getMaxInputChars();

export const chunkText = (text: string, windowIndex: number = 0): string => {
  if (text.length <= MAX_CHARS) {
    return text;
  }

  console.warn(`Text length ${text.length} exceeds limit. Truncating to ${MAX_CHARS} chars to save quota.`);
  const start = ((Math.max(0, windowIndex) || 0) * MAX_CHARS) % text.length;
  const end = start + MAX_CHARS;
  if (end <= text.length) {
    return text.substring(start, end) + "\n\n[TRUNCATED_DUE_TO_QUOTA_LIMITS]";
  }
  const tail = text.substring(start);
  const head = text.substring(0, end - text.length);
  return (tail + head) + "\n\n[TRUNCATED_DUE_TO_QUOTA_LIMITS]";
};