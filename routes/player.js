// routes/player.js
import express from 'express';
import pool from '../db.js';

const router = express.Router();

// 🔹 GET /api/player/:tg_id — проверить, есть ли игрок
router.get('/player/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/player error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// 🔹 POST /api/init — регистрация или получение игрока
router.post('/init', async (req, res) => {
  const { tg_id, name, initData, initDataUnsafe } = req.body;
  if (!tg_id || !name) {
    return res.status(400).json({ error: 'tg_id и name обязательны' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Если уже есть — вернуть
    const { rows: existing } = await client.query(
      'SELECT * FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.json(existing[0]);
    }

    // Создать нового
    const insertText = `
      INSERT INTO players
        (tg_id, name, fragments, last_burn, is_cursed, created_at, init_data, init_data_unsafe)
      VALUES ($1, $2, $3, NULL, FALSE, NOW(), $4, $5)
      RETURNING *;
    `;
    const insertValues = [
      tg_id,
      name,
      [],             // fragments по умолчанию
      initData,       // TEXT initData
      initDataUnsafe, // JSONB initDataUnsafe
    ];
    const { rows: [player] } = await client.query(insertText, insertValues);

    // Инкремент global_stats
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

// 🔹 GET /api/fragments/:tg_id
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT fragments FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    res.json(rows[0].fragments);
  } catch (err) {
    console.error('GET /api/fragments error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// 🔹 POST /api/burn
router.post('/burn', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) {
    return res.status(400).json({ error: 'tg_id is required' });
  }

  const client = await pool.connect();
  try {
    // ... ваша логика "burn" без изменений ...
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'player not found' });
    }
    const player = rows[0];
    if (player.is_cursed) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'you are cursed' });
    }
    const now = new Date();
    const last = player.last_burn ? new Date(player.last_burn) : null;
    if (last && now - last < 24 * 60 * 60 * 1000) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'burn cooldown active' });
    }

    const allFragments = [1, 2, 3, 4, 5, 6, 7];
    const owned = player.fragments || [];
    const available = allFragments.filter((f) => !owned.includes(f));
    if (!available.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'all fragments collected' });
    }
    const newFragment = available[Math.floor(Math.random() * available.length)];
    const updatedFragments = [...owned, newFragment];

    await client.query(
      'UPDATE players SET fragments = $1, last_burn = NOW() WHERE tg_id = $2',
      [updatedFragments, tg_id]
    );
    await client.query(
      "UPDATE global_stats SET value = value + 1 WHERE id = 'total_users'"
    );

    await client.query('COMMIT');
    res.json({ message: 'burn success', newFragment, fragments: updatedFragments });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/burn error:', err);
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

export default router;
