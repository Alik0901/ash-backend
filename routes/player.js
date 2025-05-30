// src/routes/player.js
import express from 'express';
import crypto from 'crypto';
import pool from '../db.js';

const router = express.Router();
const BOT_TOKEN = process.env.BOT_TOKEN;

// helper для проверки initData, можно вернуть в продакшене
function verifyInitData(initData) {
  const parsed = new URLSearchParams(initData);
  const hash = parsed.get('hash');
  parsed.delete('hash');
  const dataCheckString = [...parsed.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secretPart = BOT_TOKEN.includes(':') ? BOT_TOKEN.split(':')[1] : BOT_TOKEN;
  const secret = crypto.createHash('sha256').update(secretPart).digest();
  const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return hmac === hash;
}

/**
 * POST /api/init
 */
router.post('/init', async (req, res) => {
  const { tg_id, name, initData } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData are required' });
  }
  // временно пропускаем проверку подписи
  // if (!verifyInitData(initData)) {
  //   return res.status(403).json({ error: 'Invalid initData signature' });
  // }

  try {
    const exists = await pool.query(
      `SELECT tg_id, name, fragments, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (exists.rows.length > 0) {
      console.log(`[player] /init exists:`, exists.rows[0]);
      return res.json(exists.rows[0]);
    }

    const result = await pool.query(
      `INSERT INTO players (tg_id, name)
       VALUES ($1, $2)
       RETURNING tg_id, name, fragments, created_at`,
      [tg_id, name || null]
    );
    console.log(`[player] /init inserted:`, result.rows[0]);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[player] POST /api/init error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/player/:tg_id
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
      console.log(`[player] GET /player/${tg_id}: not found`);
      return res.status(404).json({ error: 'player not found' });
    }
    console.log(`[player] GET /player/${tg_id}:`, result.rows[0]);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[player] GET /api/player error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/fragments/:tg_id
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
      return res.status(404).json({ error: 'player not found' });
    }
    return res.json({ fragments: result.rows[0].fragments });
  } catch (err) {
    console.error('[player] GET /api/fragments error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/stats/total_users
 */
router.get('/stats/total_users', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM global_stats WHERE id = 'total_users'"
    );
    if (!rows.length) {
      console.log('[player] GET /stats/total_users: not found');
      return res.status(404).json({ error: 'not found' });
    }
    console.log('[player] GET /stats/total_users:', rows[0].value);
    return res.json({ value: rows[0].value });
  } catch (err) {
    console.error('[player] GET /api/stats error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * POST /api/burn
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
    if (now - last < 2 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }
    const all = [1,2,3,4,5,6,7,8];
    const avail = all.filter(f => !fragments.includes(f));
    if (avail.length === 0) {
      return res.status(400).json({ ok: false, error: 'All fragments collected' });
    }
    const newF = avail[Math.floor(Math.random()*avail.length)];
    const updated = [...fragments, newF];
    await pool.query(
      `UPDATE players
          SET fragments = $1, last_burn = NOW()
        WHERE tg_id = $2`,
      [updated, tg_id]
    );
    await pool.query(
      `UPDATE global_stats
          SET value = value + 1
        WHERE id = 'total_users'`
    );
    return res.json({ ok: true, newFragment: newF, fragments: updated });
  } catch (err) {
    console.error('[player] POST /api/burn error:', err);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * GET /api/final/:tg_id
 */
router.get('/final/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT fragments, created_at, name
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'player not found' });
    }
    const { fragments, created_at } = result.rows[0];
    const createdAt = new Date(created_at);
    const now = new Date();
    const canEnter =
      (fragments || []).length === 8 &&
      createdAt.getUTCFullYear() === now.getUTCFullYear() &&
      createdAt.getUTCMonth() === now.getUTCMonth() &&
      createdAt.getUTCDate() === now.getUTCDate() &&
      createdAt.getUTCHours() === now.getUTCHours() &&
      createdAt.getUTCMinutes() === now.getUTCMinutes();
    return res.json({ canEnter });
  } catch (err) {
    console.error('[player] GET /api/final error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

export default router;
