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

const MAX_CHARS = 30000;

export const chunkText = (text: string): string => {
  if (text.length <= MAX_CHARS) {
    return text;
  }

  console.warn(`Text length ${text.length} exceeds limit. Truncating to ${MAX_CHARS} chars to save quota.`);
  return text.substring(0, MAX_CHARS) + "\n\n[TRUNCATED_DUE_TO_QUOTA_LIMITS]";
};