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
    // 1. Парсим параметры из строки
    const parsed = new URLSearchParams(initData);
    const receivedHash = parsed.get('hash');
    parsed.delete('hash');

    // 2. Собираем строку проверки в нужном порядке
    const dataCheckString = [...parsed.entries()]
      .map(([key, val]) => `${key}=${val}`)
      .sort()
      .join('\n');

    // 3. Вычисляем секрет и HMAC
    const token = BOT_TOKEN.includes(':') ? BOT_TOKEN.split(':')[1] : BOT_TOKEN;
    const secretKey = crypto.createHash('sha256').update(token).digest();
    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    // 4. Логируем для отладки
    console.log('\n📦 VALIDATION LOG');
    console.log('BOT_TOKEN:', BOT_TOKEN);
    console.log('Secret part:', token);
    console.log('initData:', initData);
    console.log('Parsed:', [...parsed.entries()]);
    console.log('dataCheckString:', dataCheckString);
    console.log('expected HMAC:', calculatedHash);
    console.log('received hash:', receivedHash);

    // 5. Сравниваем подписи
    if (calculatedHash !== receivedHash) {
      console.warn('❌ Invalid signature');
      return res.status(403).json({ ok: false, error: 'Invalid signature' });
    }

    // 6. Извлекаем данные пользователя
    const userRaw = parsed.get('user');
    const user = JSON.parse(userRaw);

    console.log('✅ Signature valid:', user);
    return res.json({ ok: true, user });
  } catch (err) {
    console.error('[VALIDATE ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
