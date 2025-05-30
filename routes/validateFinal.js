// src/routes/validateFinal.js
import express from 'express';
import pool from '../db.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const { userId, inputPhrase } = req.body;
  if (!userId || !inputPhrase) {
    return res.status(400).json({ ok: false, error: 'Missing userId or inputPhrase' });
  }

  try {
    // Теперь из таблицы players, а не users
    const result = await pool.query(
      `SELECT tg_id AS id, name, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [userId]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    // Проверка «ровно та же минута»
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

    // Ожидаемая фраза
    const template = process.env.FINAL_PHRASE_TEMPLATE || 'The Final Shape';
    const expected = `${template} ${user.name}`.trim();
    if (inputPhrase.trim() !== expected) {
      return res.status(400).json({ ok: false, error: 'Incorrect final phrase' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[VALIDATE FINAL ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
