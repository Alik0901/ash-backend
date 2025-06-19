// routes/validate.js – проверка подписи Telegram initData
import express from 'express';
import crypto  from 'crypto';
import dotenv  from 'dotenv';

dotenv.config();

const router    = express.Router();
const BOT_TOKEN = process.env.BOT_TOKEN;          // задаётся в .env

router.post('/', (req, res) => {
  const { initData } = req.body;

  if (!initData || !BOT_TOKEN) {
    console.warn('[VALIDATE] ❌ Missing initData or BOT_TOKEN');
    return res.status(400).json({ ok: false, error: 'Missing initData or token' });
  }

  try {
    /* ── раскладываем initData ───────────────────────────────────────── */
    const parsed = new URLSearchParams(initData);
    const hash   = parsed.get('hash');
    parsed.delete('hash');               // сигнатура не участвует в вычислении

    const dataCheckString = [...parsed.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    /* ── Telegram-алгоритм ───────────────────────────────────────────── */
    const secretPart = BOT_TOKEN.includes(':')
      ? BOT_TOKEN.split(':')[1]          // "...:botHash" → берём вторую часть
      : BOT_TOKEN;
    const secret = crypto.createHash('sha256')
                          .update(secretPart)
                          .digest();
    const hmac   = crypto.createHmac('sha256', secret)
                         .update(dataCheckString)
                         .digest('hex');          // hex lower-case

    if (hmac !== hash) {
      console.warn('[VALIDATE] ❌ Invalid signature');
      return res.status(403).json({ ok: false, error: 'Invalid signature' });
    }

    /* ── успех ───────────────────────────────────────────────────────── */
    const user = JSON.parse(parsed.get('user'));
    return res.json({ ok: true, user });
  } catch (err) {
    console.error('[VALIDATE ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
