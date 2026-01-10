let cachedBot;

const getBot = () => {
  if (cachedBot) return cachedBot;
  // Lazy require so we can surface errors in function logs
  // and avoid crashing the module at import time.
  const mod = require('../../dist/bot.js');
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

    const bot = getBot();
    await bot.handleUpdate(update);
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('telegram-webhook error', e);
    return { statusCode: 500, body: 'error' };
  }
};
