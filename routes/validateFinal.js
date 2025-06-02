// src/routes/validateFinal.js
import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// Этот роут защищён в index.js, но можно дублировать
router.use(authenticate);

router.post('/', async (req, res) => {
  const { userId, inputPhrase } = req.body;
  if (!userId || !inputPhrase) {
    return res.status(400).json({ ok: false, error: 'Missing userId or inputPhrase' });
  }

  // Проверяем, что токен соответствует userId
  if (req.user.tg_id.toString() !== userId.toString()) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    const result = await pool.query(
      `SELECT name, created_at, fragments
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const { name, created_at, fragments } = row;
    const created = new Date(created_at);
    const now     = new Date();
    const sameMinute =
      created.getUTCFullYear()  === now.getUTCFullYear() &&
      created.getUTCMonth()     === now.getUTCMonth()    &&
      created.getUTCDate()      === now.getUTCDate()     &&
      created.getUTCHours()     === now.getUTCHours()    &&
      created.getUTCMinutes()   === now.getUTCMinutes();

    if (!sameMinute || (fragments || []).length !== 8) {
      return res.status(400).json({ ok: false, error: 'Time window for final phrase has expired or fragments missing' });
    }

    const template = process.env.FINAL_PHRASE_TEMPLATE || 'The Final Shape';
    const expected = `${template} ${name}`.trim();
    if (inputPhrase.trim() !== expected) {
      return res.status(400).json({ ok: false, error: 'Incorrect final phrase' });
    }

    // Успех — выдаём обновлённый токен
    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[VALIDATE FINAL ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
