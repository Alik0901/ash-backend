// routes/player.js
import express from 'express';
import pool from '../db.js';

const router = express.Router();

/**
 * POST /api/init
 * Создаёт или возвращает профиль игрока по Telegram ID.
 * Ожидает JSON { tg_id: number|string, name?: string }.
 */
router.post('/init', async (req, res) => {
  const { tg_id, name } = req.body;
  if (!tg_id) {
    return res.status(400).json({ ok: false, error: 'tg_id is required' });
  }

  try {
    // Проверяем, есть ли уже игрок
    const exists = await pool.query(
      `SELECT tg_id, name, fragments, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );

    if (exists.rows.length > 0) {
      return res.json({ ok: true, user: exists.rows[0] });
    }

    // Вставляем нового игрока
    const result = await pool.query(
      `INSERT INTO players (tg_id, name)
       VALUES ($1, $2)
       RETURNING tg_id, name, fragments, created_at`,
      [tg_id, name || null]
    );

    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error('POST /api/init error:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/player/:tg_id
 * Возвращает профиль игрока: { tg_id, name, fragments, created_at }
 */
router.get('/player/:tg_id', async (req, res) => {
  const { tg_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT tg_id, name, fragments, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Player not found' });
    }

    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error('GET /api/player/:tg_id error:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/fragments/:tg_id
 * Возвращает массив fragments для данного игрока.
 */
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT fragments
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Player not found' });
    }

    res.json({ ok: true, fragments: result.rows[0].fragments });
  } catch (err) {
    console.error('GET /api/fragments/:tg_id error:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/stats/total_users
 * Возвращает общее число игроков.
 */
router.get('/stats/total_users', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value
         FROM global_stats
        WHERE id = 'total_users'`
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'Stat not found' });
    }

    res.json({ ok: true, total_users: rows[0].value });
  } catch (err) {
    console.error('GET /api/stats/total_users error:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/burn
 * Добавляет новый фрагмент игроку, если кулдаун истёк и фрагменты ещё не все собраны.
 * Ожидает JSON { tg_id: number|string }.
 */
router.post('/burn', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) {
    return res.status(400).json({ ok: false, error: 'tg_id is required' });
  }

  try {
    const playerRes = await pool.query(
      `SELECT fragments, last_burn, is_cursed
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (playerRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Player not found' });
    }

    const { fragments = [], last_burn, is_cursed } = playerRes.rows[0];

    if (is_cursed) {
      return res.status(403).json({ ok: false, error: 'You are cursed' });
    }

    const now = Date.now();
    const last = last_burn ? new Date(last_burn).getTime() : 0;
    const cooldown = 2 * 60 * 1000; // 2 минуты

    if (now - last < cooldown) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }

    const allFragments = [1, 2, 3, 4, 5, 6, 7, 8];
    const available = allFragments.filter(f => !fragments.includes(f));

    if (available.length === 0) {
      return res.status(400).json({ ok: false, error: 'All fragments collected' });
    }

    const newFragment = available[Math.floor(Math.random() * available.length)];
    const updatedFragments = [...fragments, newFragment];

    await pool.query(
      `UPDATE players
          SET fragments = $1,
              last_burn  = NOW()
        WHERE tg_id = $2`,
      [updatedFragments, tg_id]
    );

    await pool.query(
      `UPDATE global_stats
          SET value = value + 1
        WHERE id = 'total_users'`
    );

    res.json({
      ok: true,
      message: 'Burn success',
      newFragment,
      fragments: updatedFragments
    });
  } catch (err) {
    console.error('POST /api/burn error:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
