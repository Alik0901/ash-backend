import express from 'express';
import crypto from 'crypto';

const router = express.Router();
const BOT_TOKEN = process.env.BOT_TOKEN;

router.post('/', (req, res) => {
  const { initData } = req.body;

  if (!initData || !BOT_TOKEN) {
    return res.status(400).json({ ok: false, error: 'Missing initData or token' });
  }

  try {
    const parsed = new URLSearchParams(initData);
    const hash = parsed.get('hash');
    parsed.delete('hash');

    const dataCheckString = [...parsed.entries()]
      .map(([key, val]) => `${key}=${val}`)
      .sort()
      .join('\n');

    const tokenSecret = BOT_TOKEN.split(':')[1]; // ← только секретная часть
    const secret = crypto.createHash('sha256').update(tokenSecret).digest();
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    if (hmac !== hash) {
      return res.status(403).json({ ok: false, error: 'Invalid signature' });
    }

    const userRaw = parsed.get('user');
    const user = JSON.parse(userRaw);

    return res.json({ ok: true, user });
  } catch (err) {
    console.error('[VALIDATE ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
