// routes/validateFinal.js
import express          from 'express';
import jwt              from 'jsonwebtoken';
import pool             from '../db.js';
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

// Пропускаем preflight, потом — аутентификация
router.options('/', (_req, res) => res.sendStatus(204));
router.use(authenticate);

/**
 * POST /api/validate-final
 *  1) окно ввода (час+минута регистрации),
 *  2) есть 8 фрагментов,
 *  3) строка === `${ENV.TEMPLATE}-${nickname}` (без учёта регистра).
 */
router.post('/', async (req, res) => {
  const { userId, inputPhrase } = req.body;
  if (!userId || !inputPhrase) {
    return res
      .status(400)
      .json({ ok: false, error: 'Missing userId or inputPhrase' });
  }

  // Проверяем токен
  if (String(req.user.tg_id) !== String(userId)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    // Берём из БД
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

    // Окно: тот же час и минута
    const windowOpen =
         created.getHours()   === now.getHours() &&
         created.getMinutes() === now.getMinutes();

    const hasAllFragments =
      Array.isArray(fragments) && fragments.length === 8;

    if (!windowOpen || !hasAllFragments) {
      return res.status(400).json({
        ok: false,
        error:'Time window for final phrase has expired or fragments missing'
      });
    }

    // Составляем ожидаемую фразу
    const template = (process.env.FINAL_PHRASE_TEMPLATE||'').trim();
    const expected = `${template}-${name}`.trim();

    // Логи для дебага
    console.log('[VALIDATE-FINAL] received:', JSON.stringify(inputPhrase));
    console.log('[VALIDATE-FINAL] expected:',  JSON.stringify(expected));

    // Сравниваем case-insensitive
    if (inputPhrase.trim().toLowerCase() !== expected.toLowerCase()) {
      console.log('[VALIDATE-FINAL] MISMATCH');
      return res
        .status(400)
        .json({ ok: false, error: 'Incorrect final phrase' });
    }

    // Успех → новый токен
    const newToken = generateToken(req.user);
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ ok: true });

  } catch (err) {
    console.error('[VALIDATE-FINAL ERROR]', err);
    return res
      .status(500)
      .json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
