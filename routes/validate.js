import express from 'express';
import crypto from 'crypto';

const router = express.Router();
const BOT_TOKEN = process.env.BOT_TOKEN;

router.post('/', (req, res) => {
  const { initData } = req.body;

  console.log('📩 [validate] Received initData:', initData);
  if (!initData || !BOT_TOKEN) {
    console.warn('❌ Missing initData or BOT_TOKEN');
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

    const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    console.log('🧾 Parsed dataCheckString:\n' + dataCheckString);
    console.log('🧮 Computed HMAC:', hmac);
    console.log('📦 Provided hash:', hash);

    if (hmac !== hash) {
      console.warn('❌ Invalid signature');
      return res.status(403).json({ ok: false, error: 'Invalid signature' });
    }

    const userRaw = parsed.get('user');
    console.log('👤 Raw user string:', userRaw);

    const user = JSON.parse(userRaw);
    console.log('✅ Parsed user:', user);

    return res.json({ ok: true, user });
  } catch (err) {
    console.error('[❌ VALIDATE ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
