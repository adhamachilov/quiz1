const { bot } = require('../../dist/bot.js');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 200, body: 'ok' };
    }

    const update = event.body ? JSON.parse(event.body) : null;
    if (!update) {
      return { statusCode: 200, body: 'ok' };
    }

    await bot.handleUpdate(update);
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('telegram-webhook error', e);
    return { statusCode: 200, body: 'ok' };
  }
};
