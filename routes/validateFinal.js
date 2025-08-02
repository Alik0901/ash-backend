// файл: src/routes/validateFinal.js
import express from 'express';
import jwt from 'jsonwebtoken';
import pool from './db.js';
import { authenticate } from './middleware/auth.js';
import process from 'process';

const router = express.Router();

// Проверяем обязательную переменную окружения
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET не задан');
  process.exit(1);
}

/**
 * Генерация нового JWT для пользователя
 * @param {{tg_id: number, name: string}} user
 * @returns {string} JWT
 */
function generateToken(user) {
  return jwt.sign(
    { tg_id: user.tg_id, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' } // токен действителен 7 дней
  );
}

// Обрабатываем preflight-запрос
router.options('/', (_req, res) => res.sendStatus(204));
// Аутентификация JWT
router.use(authenticate);

/**
 * POST /api/validate-final
 * Проверка финальной фразы:
 * - пользователь прошёл аутентификацию JWT
 * - прошло не больше 1 минуты с момента регистрации
 * - у пользователя есть все 8 фрагментов
 * - введённая фраза соответствует шаблону
 * В теле запроса: { phrase: string }
 */
router.post('/', async (req, res) => {
  const { phrase } = req.body;
  if (!phrase) {
    return res.status(400).json({ ok: false, error: 'Missing phrase' });
  }

  const tgId = req.user.tg_id;

  try {
    // Извлекаем данные игрока
    const { rows } = await pool.query(
      `SELECT name, created_at, fragments
         FROM players
        WHERE tg_id = $1
        LIMIT 1;`,
      [tgId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Player not found' });
    }

    const { name, created_at, fragments } = rows[0];
    const created = new Date(created_at);
    const now = new Date();

    // Проверяем, что сейчас та же минута, что и при регистрации
    if (
      created.getUTCFullYear() !== now.getUTCFullYear() ||
      created.getUTCMonth()    !== now.getUTCMonth()    ||
      created.getUTCDate()     !== now.getUTCDate()     ||
      created.getUTCHours()    !== now.getUTCHours()    ||
      created.getUTCMinutes()  !== now.getUTCMinutes()
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Time window for final phrase has expired'
      });
    }

    // Проверяем наличие всех 8 фрагментов
    if (!Array.isArray(fragments) || fragments.length !== 8) {
      return res.status(400).json({ ok: false, error: 'Fragments missing' });
    }

    // Формируем ожидаемую фразу
    const template = (process.env.FINAL_PHRASE_TEMPLATE || '').trim();
    const expected = `${template}-${name}`.trim();

    if (phrase.trim().toLowerCase() !== expected.toLowerCase()) {
      return res.status(400).json({ ok: false, error: 'Incorrect final phrase' });
    }

    // Успешно — выдаём новый JWT
    const newToken = generateToken(req.user);
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ ok: true });

  } catch (err) {
    console.error('[VALIDATE-FINAL ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
