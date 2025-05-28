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
    // ✅ Парсим строку запроса
    const parsed = new URLSearchParams(initData);
    const hash = parsed.get('hash');
    parsed.delete('hash');

    // ✅ Создаем строку для подписи
    const dataCheckString = [...parsed.entries()]
      .map(([key, val]) => `${key}=${val}`)
      .sort()
      .join('\n');

    // ✅ Извлекаем часть токена после двоеточия (если есть)
    const secretPart = BOT_TOKEN.includes(':') ? BOT_TOKEN.split(':')[1] : BOT_TOKEN;
    const secret = crypto.createHash('sha256').update(secretPart).digest();

    const hmac = crypto.createHmac('sha256', secret)
      .update(dataCheckString)
      .digest('hex');

    // ✅ Отладочные логи
    console.log('🔐 VALIDATE FINAL');
    console.log('dataCheckString:', dataCheckString);
    console.log('query_id:', parsed.get('query_id'));
    console.log('signature:', hash);
    console.log('user=', parsed.get('user'));
    console.log('expected HMAC:', hmac);
    console.log('received hash:', hash);

    if (hmac !== hash) {
      console.warn('❌ Invalid signature');
      return res.status(403).json({ ok: false, error: 'Invalid signature' });
    }

    // ✅ Если всё хорошо, парсим user
    const userRaw = parsed.get('user');
    const user = JSON.parse(userRaw);

    console.log('✅ Signature valid. User:', user);
    return res.json({ ok: true, user });
  } catch (err) {
    console.error('[VALIDATE ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
