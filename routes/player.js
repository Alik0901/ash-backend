// src/routes/player.js
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js'; // уже используется в index.js

const router = express.Router();
const BOT_TOKEN  = process.env.BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;

// Генерация нового JWT
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// Вспомогательная проверка initData (опционально)
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
 * GET /api/player/:tg_id
 * — Публичный (не требует JWT). Возвращает профиль, или 404.
 */
router.get('/player/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[player] GET /api/player error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * POST /api/init
 * — Публичный (не требует JWT). Создаёт или возвращает существующего, + выдаёт JWT.
 */
router.post('/init', async (req, res) => {
  const { tg_id, name, initData } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData are required' });
  }
  // (опционально) проверяем initData:
  // if (!verifyInitData(initData)) {
  //   return res.status(403).json({ error: 'Invalid initData signature' });
  // }

  try {
    let result = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    let userRow = result.rows[0];

    if (!userRow) {
      // создаём нового игрока
      result = await pool.query(
        `INSERT INTO players (tg_id, name, is_cursed, curses_count, curse_expires)
         VALUES ($1, $2, FALSE, 0, NULL)
         RETURNING tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at`,
        [tg_id, name || null]
      );
      userRow = result.rows[0];
    }

    // генерируем JWT
    const token = generateToken({ tg_id: userRow.tg_id, name: userRow.name });
    return res.json({ user: userRow, token });
  } catch (err) {
    console.error('[player] POST /api/init error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// Ниже — роуты, которые требуют JWT. Так как 
// мидлвар `authenticate` подключён уже в index.js, мы здесь его повторно вызывать не будем.

/**
 * GET /api/fragments/:tg_id
 * — Возвращает fragments[] + refresh JWT
 */
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  // После authenticate: req.user.tg_id уже заполнен
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await pool.query(
      `SELECT fragments
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    const fragments = result.rows[0].fragments || [];
    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ fragments });
  } catch (err) {
    console.error('[player] GET /api/fragments error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/stats/total_users
 * — Возвращает общее число игроков + refresh JWT
 */
router.get('/stats/total_users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM global_stats WHERE id = 'total_users'"
    );
    const total = rows.length > 0 ? rows[0].value : 0;
    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ value: total });
  } catch (err) {
    console.error('[player] GET /api/stats/total_users error:', err);
    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ value: 0 });
  }
});

/**
 * POST /api/burn
 * — Первая логика: первые 3 нажатия гарантированно даём фрагмент.
 *   Затем, пока проклятий < 6 — 50/50 «проклятие vs фрагмент».
 *   После 6 проклятий — только фрагмент.
 */
router.post('/burn', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) {
    return res.status(400).json({ ok: false, error: 'tg_id is required' });
  }
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    const playerRes = await pool.query(
      `SELECT fragments, last_burn, is_cursed, curses_count, curse_expires
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (!playerRes.rows.length) {
      return res.status(404).json({ ok: false, error: 'player not found' });
    }

    const {
      fragments = [],
      last_burn,
      is_cursed,
      curses_count,
      curse_expires,
    } = playerRes.rows[0];
    const now = new Date();

    // 1) Если ещё под проклятием (curse_expires > now) → 403
    if (curse_expires) {
      const expireDate = new Date(curse_expires);
      if (expireDate > now) {
        return res.status(403).json({
          ok: false,
          error: 'You are still cursed',
          curse_expires: expireDate.toISOString(),
        });
      }
    }

    // 2) Снимаем «устаревшее» проклятие, если оно уже истекло
    if (is_cursed && curse_expires && new Date(curse_expires) <= now) {
      await pool.query(
        `UPDATE players
            SET is_cursed = FALSE,
                curse_expires = NULL
          WHERE tg_id = $1`,
        [tg_id]
      );
    }

    // 3) Обновляем данные после снятия флага
    const freshRes = await pool.query(
      `SELECT fragments, last_burn, is_cursed, curses_count, curse_expires
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    const {
      fragments: curFragments = [],
      last_burn: curLastBurn,
      is_cursed: curIsCursed,
      curses_count: curCursesCount,
      curse_expires: curCurseExpires,
    } = freshRes.rows[0];

    // 4) Если снова «под проклятием» — 403
    if (curIsCursed) {
      const expireDate = new Date(curCurseExpires);
      return res.status(403).json({
        ok: false,
        error: 'You are cursed',
        curse_expires: expireDate.toISOString(),
      });
    }

    // 5) Проверяем двухминутный кулдаун (last_burn)
    const lastBurnTime = curLastBurn ? new Date(curLastBurn).getTime() : 0;
    if (now.getTime() - lastBurnTime < 2 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }

    // 6) Собираем список доступных фрагментов
    const allFragments = [1, 2, 3, 4, 5, 6, 7, 8];
    const owned = curFragments;
    const available = allFragments.filter((f) => !owned.includes(f));
    if (!available.length) {
      const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
      res.setHeader('Authorization', `Bearer ${newToken}`);
      return res.status(400).json({ ok: false, error: 'All fragments collected' });
    }

    // 7) Вычисляем, сколько «сжиганий» было раньше:
    //    totalBurnsDone = число выданных фрагментов + число проклятий
    const totalBurnsDone = owned.length + curCursesCount;

    // 8) Решаем, дать ли «проклятие» или «фрагмент»
    let giveCurse = false;
    if (totalBurnsDone < 3) {
      giveCurse = false; // первые 3 сжигания — гарантированный фрагмент
    } else if (curCursesCount < 6) {
      giveCurse = Math.random() < 0.5; // случайно, до 6 проклятий
    } else {
      giveCurse = false; // после 6 проклятий — всегда фрагмент
    }

    if (giveCurse) {
      // 9) Накладываем проклятие на 24 часа
      const newCount = curCursesCount + 1;
      const expireTs = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      await pool.query(
        `UPDATE players
            SET is_cursed     = TRUE,
                curses_count  = $1,
                curse_expires = $2
          WHERE tg_id = $3`,
        [newCount, expireTs.toISOString(), tg_id]
      );
      const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
      res.setHeader('Authorization', `Bearer ${newToken}`);
      return res.json({
        ok: true,
        cursed: true,
        curse_expires: expireTs.toISOString(),
      });
    }

    // 10) Иначе выдаём фрагмент
    const idx = Math.floor(Math.random() * available.length);
    const newFragment = available[idx];
    const updatedFragments = [...owned, newFragment];

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

    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({
      ok: true,
      cursed: false,
      newFragment,
      fragments: updatedFragments,
      lastBurn: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[player] POST /api/burn error:', err);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * GET /api/final/:tg_id — возвращает { canEnter } + refresh JWT
 */
router.get('/final/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await pool.query(
      `SELECT fragments, created_at, name
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    const { fragments, created_at, name } = result.rows[0];
    const createdAt = new Date(created_at);
    const now = new Date();
    const canEnter =
      (fragments || []).length === 8 &&
      createdAt.getUTCFullYear() === now.getUTCFullYear() &&
      createdAt.getUTCMonth() === now.getUTCMonth() &&
      createdAt.getUTCDate() === now.getUTCDate() &&
      createdAt.getUTCHours() === now.getUTCHours() &&
      createdAt.getUTCMinutes() === now.getUTCMinutes();

    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ canEnter });
  } catch (err) {
    console.error('[player] GET /api/final error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

export default router;
