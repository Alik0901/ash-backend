import express from 'express';
import jwt     from 'jsonwebtoken';
import pool    from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

/** Генерация нового JWT */
function generateToken(user) {
  return jwt.sign(
    { tg_id: user.tg_id, name: user.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// Все запросы на этот роут требуют аутентификации
router.use(authenticate);

/**
 * POST /api/validate-final
 * Проверяет, что сейчас «окно» для ввода финальной фразы (раз в сутки в ту же минуту),
 * что у пользователя уже собрано 8 фрагментов,
 * и что введённая фраза === `${TEMPLATE}-${nickname}`.
 */
router.post('/', async (req, res) => {
  const { userId, inputPhrase } = req.body;
  if (!userId || !inputPhrase) {
    return res.status(400).json({ ok: false, error: 'Missing userId or inputPhrase' });
  }
  // Дополнительная проверка: tg_id из JWT должен совпадать с userId из тела
  if (String(req.user.tg_id) !== String(userId)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    // Берём из БД имя, время регистрации и список фрагментов
    const { rows } = await pool.query(
      `SELECT name, created_at, fragments
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [userId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const { name, created_at, fragments } = rows[0];
    const created = new Date(created_at);
    const now     = new Date();

    // Проверяем, что текущее время в тот же час и минуту, что и регистрация
    const windowOpen =
         created.getHours()   === now.getHours()
      && created.getMinutes() === now.getMinutes();

    // Доступ есть только если окно открыто и уже получено 8 фрагментов
    if (!windowOpen || (fragments || []).length !== 8) {
      return res.status(400).json({
        ok:    false,
        error: 'Time window for final phrase has expired or fragments missing'
      });
    }

    // Собираем ожидаемую строку: шаблон из ENV + дефис + nickname
    const template = (process.env.FINAL_PHRASE_TEMPLATE || '').trim();
    const expected = `${template}-${name}`.trim();

    if (inputPhrase.trim() !== expected) {
      return res.status(400).json({ ok: false, error: 'Incorrect final phrase' });
    }

    // Всё ок — выдаём новый токен и ответ { ok:true }
    const newToken = generateToken(req.user);
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ ok: true });

  } catch (err) {
    console.error('[VALIDATE FINAL ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
