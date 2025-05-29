// routes/player.js

import express from 'express';
import pool from '../db.js';

const router = express.Router();

// 🔹 POST /api/init — регистрация нового игрока или получение существующего
router.post('/init', async (req, res) => {
  const { tg_id, name, initData, initDataUnsafe } = req.body;
  if (!tg_id || !name) {
    return res.status(400).json({ error: 'tg_id и name обязательны' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Если игрок уже есть — возвращаем его
    const { rows: existing } = await client.query(
      'SELECT * FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.json(existing[0]);
    }

    // Вставляем нового игрока
    const insertText = `
      INSERT INTO players
        (tg_id, name, fragments, last_burn, is_cursed, created_at, init_data, init_data_unsafe)
      VALUES ($1, $2, $3, NULL, FALSE, NOW(), $4, $5)
      RETURNING *;
    `;
    const insertValues = [
      tg_id,
      name,
      [],               // fragments по умолчанию
      initData,         // текст initData
      initDataUnsafe,   // объект initDataUnsafe
    ];
    const { rows: [player] } = await client.query(insertText, insertValues);

    // Инкрементим global_stats.total_users
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

// 🔹 GET /api/player/:tg_id — получить весь профиль игрока
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

// 🔹 GET /api/fragments/:tg_id — получить только массив fragments
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

// 🔹 POST /api/burn — выполнить «сжигание», получить новый фрагмент
router.post('/burn', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) {
    return res.status(400).json({ error: 'tg_id is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Получаем игрока
    const { rows } = await client.query(
      'SELECT * FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'player not found' });
    }
    const player = rows[0];

    // Проверяем проклятие
    if (player.is_cursed) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'you are cursed' });
    }

    // Новый кулдаун для отладки: 2 минуты вместо 24 часов
    const cooldownMs = 2 * 60 * 1000; // 2 минуты
    const now = Date.now();
    const last = player.last_burn ? new Date(player.last_burn).getTime() : 0;
    if (last && (now - last) < cooldownMs) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'burn cooldown active' });
    }

    // Выбираем новый фрагмент
    const allFragments = [1,2,3,4,5,6,7];
    const owned = player.fragments || [];
    const available = allFragments.filter(f => !owned.includes(f));
    if (!available.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'all fragments collected' });
    }
    const newFragment = available[Math.floor(Math.random() * available.length)];
    const updatedFragments = [...owned, newFragment];

    // Обновляем игрока и глобальную статистику
    await client.query(
      'UPDATE players SET fragments = $1, last_burn = NOW() WHERE tg_id = $2',
      [updatedFragments, tg_id]
    );
    await client.query(
      "UPDATE global_stats SET value = value + 1 WHERE id = 'total_users'"
    );

    await client.query('COMMIT');
    res.json({
      message: 'burn success',
      newFragment,
      fragments: updatedFragments
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/burn error:', err);
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

// 🔹 GET /api/stats/total_users — вернуть value из global_stats
router.get('/stats/total_users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT value FROM global_stats WHERE id = $1',
      ['total_users']
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'total_users not found' });
    }
    res.json({ value: rows[0].value });
  } catch (err) {
    console.error('GET /api/stats/total_users error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

export default router;
