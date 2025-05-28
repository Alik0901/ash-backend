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
    const searchParams = new URLSearchParams(initData);
    const receivedHash = searchParams.get('hash');

    // Сортируем и формируем строку без hash
    const dataCheckString = initData
      .split('&')
      .filter((x) => !x.startsWith('hash='))
      .sort()
      .join('\n');

    const token = BOT_TOKEN.includes(':') ? BOT_TOKEN.split(':')[1] : BOT_TOKEN;
    const secret = crypto.createHash('sha256').update(token).digest();
    const hmac = crypto
      .createHmac('sha256', secret)
      .update(dataCheckString)
      .digest('base64'); // ❗ Это важно

    console.log('\n✅ VALIDATE FINAL 🔐');
    console.log('dataCheckString:', dataCheckString);
    console.log('expected HMAC:', hmac);
    console.log('received hash:', receivedHash);

    if (hmac !== receivedHash) {
      return res.status(403).json({ ok: false, error: 'Invalid signature' });
    }

    const rawUser = searchParams.get('user');
    const user = JSON.parse(decodeURIComponent(rawUser));

    return res.json({ ok: true, user });
  } catch (err) {
    console.error('[VALIDATE ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
