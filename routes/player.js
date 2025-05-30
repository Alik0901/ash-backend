// src/routes/player.js
import express from 'express';
import crypto from 'crypto';
import pool from '../db.js';

const router = express.Router();
const BOT_TOKEN = process.env.BOT_TOKEN;

// helper (по желанию вернуть проверку)
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

// остальные routes без изменений…

export default router;
