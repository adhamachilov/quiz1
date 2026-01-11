import dotenv from 'dotenv';

// Load .env file only for local development.
// In Netlify/production, environment variables must come from the runtime.
if (!process.env.NETLIFY && process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

interface EnvConfig {
  TELEGRAM_BOT_TOKEN: string;
  API_KEY: string;
}

const getEnvConfig = (): EnvConfig => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing in environment variables.');
  }

  if (!apiKey) {
    throw new Error('API_KEY is missing in environment variables.');
  }

  return {
    TELEGRAM_BOT_TOKEN: token,
    API_KEY: apiKey,
  };
};

export const config = getEnvConfig();