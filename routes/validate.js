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
    // Разбиваем вручную
    const rawParts = initData.split('&');
    const parsed = [];
    let hash = '';

    for (const part of rawParts) {
      if (part.startsWith('hash=')) {
        hash = part.replace('hash=', '');
      } else {
        parsed.push(part);
      }
    }

    const dataCheckString = parsed.sort().join('\n');

    const token = BOT_TOKEN.includes(':') ? BOT_TOKEN.split(':')[1] : BOT_TOKEN;
    const secret = crypto.createHash('sha256').update(token).digest();
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    console.log('\n🔐 VALIDATE FINAL');
    console.log('dataCheckString:', dataCheckString);
    console.log('expected HMAC:', hmac);
    console.log('received hash:', hash);

    if (hmac !== hash) {
      return res.status(403).json({ ok: false, error: 'Invalid signature' });
    }

    // Извлекаем user вручную
    const userParam = rawParts.find(p => p.startsWith('user='));
    const userRaw = userParam?.substring(5);
    const user = JSON.parse(decodeURIComponent(userRaw));

    return res.json({ ok: true, user });
  } catch (err) {
    console.error('[VALIDATE ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
