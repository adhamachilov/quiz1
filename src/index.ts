import { bot } from './bot.js';
import { config } from './config/env.js';
import process from 'process';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const launchWithRetry = async () => {
  console.log('🚀 Starting Gemini Quiz Bot...');
  console.log('🔑 API Key present:', !!config.API_KEY);
  console.log('🧠 DeepSeek key present:', !!(process.env.DEEPSEEK_API_KEY || '').trim());
  console.log('⚡ Groq key present:', !!(process.env.GROQ_API_KEY || '').trim());

  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  process.once('exit', () => bot.stop('exit'));

  process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Promise Rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
  });

  const initialDelayMs = Math.max(0, Number(process.env.BOT_START_DELAY_MS ?? 0) || 0);
  if (initialDelayMs > 0) {
    await delay(initialDelayMs);
  }

  let attempt = 0;
  while (true) {
    try {
      await bot.launch();
      console.log('🤖 Bot is online and listening for files!');
      return;
    } catch (error: any) {
      attempt += 1;
      console.error(`❌ Failed to start bot (attempt ${attempt}):`, error);

      try {
        bot.stop('retry');
      } catch {
        // ignore
      }

      const isConflict = error?.response?.error_code === 409 || String(error?.message ?? '').includes('409');
      const base = isConflict ? 4000 : 1500;
      const waitMs = Math.min(30000, base * Math.pow(2, Math.min(attempt, 5)));
      await delay(waitMs);
    }
  }
};

launchWithRetry();