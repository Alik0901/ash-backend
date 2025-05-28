import express from 'express';
import pool from '../db.js';

const router = express.Router();

// POST /api/init — регистрация или получение игрока
router.post('/init', async (req, res) => {
  const { tg_id, name, initData, initDataUnsafe } = req.body;
  if (!tg_id || !name) {
    return res.status(400).json({ error: 'tg_id и name обязательны' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Если игрок уже есть — вернём его
    const { rows: exists } = await client.query(
      'SELECT * FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (exists.length) {
      await client.query('ROLLBACK');
      return res.json(exists[0]);
    }

    // Вставка нового игрока
    const insertText = `
      INSERT INTO players
        (tg_id, name, fragments, last_burn, is_cursed, created_at, init_data, init_data_unsafe)
      VALUES ($1, $2, $3, NULL, FALSE, NOW(), $4, $5)
      RETURNING *;
    `;
    const insertValues = [
      tg_id,
      name,
      [],              // fragments по умолчанию
      initData,        // сохранённый initData
      initDataUnsafe,  // сохранённый JSONB initDataUnsafe
    ];
    const { rows: [player] } = await client.query(insertText, insertValues);

    // Инкрементим глобальный счётчик
    await client.query(`
      UPDATE global_stats
      SET value = value + 1
      WHERE id = 'total_users';
    `);

    await client.query('COMMIT');
    res.json(player);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/init error:', err);
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

export default router;
