let cachedBot;

const getBot = () => {
  if (cachedBot) return cachedBot;
  // Lazy require so we can surface errors in function logs
  // and avoid crashing the module at import time.
  const mod = require('./dist/bot.js');
  cachedBot = mod.bot;
  return cachedBot;
};

const getBaseUrl = (event) => {
  const envUrl = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (envUrl) return envUrl;
  const proto = (event.headers && (event.headers['x-forwarded-proto'] || event.headers['X-Forwarded-Proto'])) || 'https';
  const host = (event.headers && (event.headers['x-forwarded-host'] || event.headers['host'] || event.headers['Host'])) || '';
  return host ? `${proto}://${host}` : '';
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

    const baseUrl = getBaseUrl(event);
    if (baseUrl) {
      try {
        const backgroundUrl = `${baseUrl}/.netlify/functions/telegram-webhook-background`;
        const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
        // Fire-and-forget: do not block the webhook response.
        fetchFn(backgroundUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: rawBody,
        }).catch((e) => console.error('telegram-webhook forward error', e));
      } catch (e) {
        console.error('telegram-webhook forward error', e);
      }
      return { statusCode: 200, body: 'ok' };
    }

    const bot = getBot();
    await bot.handleUpdate(update);
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('telegram-webhook error', e);
    // Always return 200 to prevent Telegram from retrying the same update forever.
    return { statusCode: 200, body: 'ok' };
  }
};
