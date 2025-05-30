import express from 'express';
import { getUserById } from '../db'; // адаптируйте путь под ваш модуль работы с БД

const router = express.Router();

/**
 * POST /api/validate-final
 * body: { userId: number|string, inputPhrase: string }
 */
router.post('/', async (req, res) => {
  const { userId, inputPhrase } = req.body;
  if (!userId || !inputPhrase) {
    return res.status(400).json({ ok: false, error: 'Missing userId or inputPhrase' });
  }

  try {
    // Получаем запись пользователя из БД
    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    // Проверяем, что сейчас та же минута, что и в created_at
    const created = new Date(user.created_at);
    const now     = new Date();
    const sameMinute =
      created.getUTCFullYear()  === now.getUTCFullYear()  &&
      created.getUTCMonth()     === now.getUTCMonth()     &&
      created.getUTCDate()      === now.getUTCDate()      &&
      created.getUTCHours()     === now.getUTCHours()     &&
      created.getUTCMinutes()   === now.getUTCMinutes();
    if (!sameMinute) {
      return res.status(400).json({ ok: false, error: 'Time window for final phrase has expired' });
    }

    // Формируем ожидаемую фразу
    const template = process.env.FINAL_PHRASE_TEMPLATE; // например, "The Final Shape"
    const expected = `${template} ${user.name}`.trim();
    if (inputPhrase.trim() !== expected) {
      return res.status(400).json({ ok: false, error: 'Incorrect final phrase' });
    }

    // Успех
    return res.json({ ok: true });
  } catch (err) {
    console.error('[VALIDATE FINAL ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
