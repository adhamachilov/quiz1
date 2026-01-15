import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load .env file only for local development.
// In Netlify/production, environment variables must come from the runtime.
if (!process.env.NETLIFY) {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../.env'),
    path.resolve(__dirname, '../../../.env'),
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const res = dotenv.config({ path: p, override: true });
      if (!res.error) break;
    } catch {
      // ignore
    }
  }
}

interface EnvConfig {
  TELEGRAM_BOT_TOKEN: string;
  API_KEY: string;
}

const getEnvConfig = (): EnvConfig => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const apiKey =
    process.env.API_KEY ||
    process.env.GEMINI_API_KEY ||
    (process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',')[0]?.trim() : undefined);

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing in environment variables.');
  }

  return {
    TELEGRAM_BOT_TOKEN: token,
    API_KEY: (apiKey || '').trim(),
  };
};

export const config = getEnvConfig();