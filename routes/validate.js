import express from 'express';
import crypto from 'crypto';

const router = express.Router();
const BOT_TOKEN = process.env.BOT_TOKEN;

router.post('/', (req, res) => {
  const { initData } = req.body;

  if (!initData || !BOT_TOKEN) {
    return res.status(400).json({ ok: false, error: 'Missing initData or BOT_TOKEN' });
  }

  try {
    const hash = new URLSearchParams(initData).get('hash');

    // Парсим вручную, чтобы не терять кодировку и порядок
    const keyValuePairs = initData
      .split('&')
      .filter((entry) => !entry.startsWith('hash='))
      .sort();

    const dataCheckString = keyValuePairs.join('\n');

    const secretKey = BOT_TOKEN.includes(':') ? BOT_TOKEN.split(':')[1] : BOT_TOKEN;
    const secret = crypto.createHash('sha256').update(secretKey).digest();
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    // Отладка
    console.log('\n🔐 VALIDATE FIXED 2');
    console.log('dataCheckString:', dataCheckString);
    console.log('expected HMAC:', hmac);
    console.log('received hash:', hash);

    if (hmac !== hash) {
      return res.status(403).json({ ok: false, error: 'Invalid signature' });
    }

    // Получаем и декодируем user
    const rawUser = new URLSearchParams(initData).get('user');
    const user = JSON.parse(decodeURIComponent(rawUser));

    return res.json({ ok: true, user });
  } catch (err) {
    console.error('[VALIDATE ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
