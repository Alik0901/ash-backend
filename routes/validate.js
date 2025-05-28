import express from 'express';
import crypto from 'crypto';

const router = express.Router();
const BOT_TOKEN = process.env.BOT_TOKEN;

router.post('/', (req, res) => {
  const { initData } = req.body;

  if (!initData || !BOT_TOKEN) {
    console.warn('[VALIDATE] ❌ Missing initData or BOT_TOKEN');
    return res.status(400).json({ ok: false, error: 'Missing initData or token' });
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    // НЕ декодируем параметры, а собираем вручную
    const keyValuePairs = initData
      .split('&')
      .filter((kv) => !kv.startsWith('hash='))
      .sort();

    const dataCheckString = keyValuePairs.join('\n');

    const secretKey = BOT_TOKEN.includes(':') ? BOT_TOKEN.split(':')[1] : BOT_TOKEN;
    const secret = crypto.createHash('sha256').update(secretKey).digest();
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    // Лог
    console.log('\n🔐 VALIDATE FIXED');
    console.log('BOT_TOKEN:', BOT_TOKEN);
    console.log('dataCheckString:', dataCheckString);
    console.log('expected HMAC:', hmac);
    console.log('received hash:', hash);

    if (hmac !== hash) {
      console.warn('❌ Invalid signature');
      return res.status(403).json({ ok: false, error: 'Invalid signature' });
    }

    const userJson = decodeURIComponent(params.get('user'));
    const user = JSON.parse(userJson);

    console.log('✅ Signature valid. User:', user);
    return res.json({ ok: true, user });
  } catch (err) {
    console.error('[VALIDATE ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
