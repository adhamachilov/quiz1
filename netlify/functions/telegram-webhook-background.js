let cachedBot;

const processedUpdateIds = new Map();
const DEDUPE_TTL_MS = 10 * 60 * 1000;

const cleanupProcessed = (now) => {
  for (const [id, ts] of processedUpdateIds.entries()) {
    if (!ts || now - ts > DEDUPE_TTL_MS) processedUpdateIds.delete(id);
  }
};

const getBot = () => {
  if (cachedBot) return cachedBot;
  // Lazy require so we can surface errors in function logs
  // and avoid crashing the module at import time.
  const mod = require('./dist/bot.js');
  cachedBot = mod.bot;
  return cachedBot;
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 200, body: 'ok' };
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');

    const update = rawBody ? JSON.parse(rawBody) : null;
    if (!update) {
      return { statusCode: 200, body: 'ok' };
    }

    const now = Date.now();
    cleanupProcessed(now);
    const updateId = update.update_id;
    if (typeof updateId === 'number' || typeof updateId === 'string') {
      if (processedUpdateIds.has(updateId)) {
        return { statusCode: 200, body: 'ok' };
      }
      processedUpdateIds.set(updateId, now);
    }

    const bot = getBot();
    await bot.handleUpdate(update);
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('telegram-webhook-background error', e);
    // Always return 200 to prevent Telegram from retrying the same update forever.
    return { statusCode: 200, body: 'ok' };
  }
};
