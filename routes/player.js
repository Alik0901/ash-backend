// src/routes/player.js
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const BOT_TOKEN  = process.env.BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * helper для генерации нового JWT
 */
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// (Ваша verifyInitData, если нужна, можно раскомментировать в проде)
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
 * Регистрация (или получение) профиля + выдача JWT.
 */
router.post('/init', async (req, res) => {
  const { tg_id, name, initData } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData are required' });
  }
  // Проверка подписи initData (раскомментировать при необходимости)
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
      // Если нет — создаём новую запись
      result = await pool.query(
        `INSERT INTO players (tg_id, name, is_cursed, curses_count, curse_expires)
         VALUES ($1, $2, FALSE, 0, NULL)
         RETURNING tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at`,
        [tg_id, name || null]
      );
      userRow = result.rows[0];
    }

    // Генерируем токен
    const token = generateToken({ tg_id: userRow.tg_id, name: userRow.name });
    // Отправляем клиенту профиль + токен
    return res.json({ user: userRow, token });
  } catch (err) {
    console.error('[player] POST /api/init error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// ВСЕ ДАЛЬНЕЙШИЕ РАБОЧИЕ МАРШРУТЫ ЗАЩИЩЁННЫ authenticate
router.use(authenticate);

/**
 * GET /api/player/:tg_id
 * Возвращает профиль игрока + refresh JWT
 */
router.get('/player/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ error: 'Forbidden' });
  }
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
    const userRow = result.rows[0];
    // Генерируем новый токен (refresh)
    const newToken = generateToken({ tg_id: userRow.tg_id, name: userRow.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json(userRow);
  } catch (err) {
    console.error('[player] GET /api/player error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/fragments/:tg_id
 * Возвращает только fragments + refresh JWT
 */
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
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
 * Возвращает общее число игроков (или 0 при ошибке) + refresh JWT
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
 *  — если curse_expires > NOW(), возвращаем «вы под проклятием».
 *  — иначе, если curses_count < 6, накладываем новое «проклятие на 24 ч», возвращаем { cursed: true }.
 *  — иначе (curses_count >= 6), выдаём фрагмент по старой логике, обновляем last_burn, глобальную статистику и т. д.
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
      `SELECT fragments,
              last_burn,
              is_cursed,
              curses_count,
              curse_expires
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

    // 1) Проверим, действительно ли игрок ещё «под проклятием»:
    if (curse_expires) {
      const expireDate = new Date(curse_expires);
      if (expireDate > now) {
        // Всё ещё заморожен: выдаём ошибку
        return res.status(403).json({
          ok: false,
          error: 'You are still cursed',
          curse_expires: expireDate.toISOString(),
          curses_count,
        });
      }
    }

    // 2) Если предыдущее проклятие уже истекло, «снимаем» флаги проклятия
    if (is_cursed && curse_expires && new Date(curse_expires) <= now) {
      await pool.query(
        `UPDATE players
            SET is_cursed = FALSE,
                curse_expires = NULL
          WHERE tg_id = $1`,
        [tg_id]
      );
    }

    // Ещё раз вытаскиваем обновлённый curses_count, is_cursed:
    const fresh = await pool.query(
      `SELECT fragments,
              last_burn,
              is_cursed,
              curses_count,
              curse_expires
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
    } = fresh.rows[0];

    // 3) Если игрок сейчас «под проклятием» (после снятия, вероятно, false):
    if (curIsCursed) {
      const expireDate = new Date(curCurseExpires);
      return res.status(403).json({
        ok: false,
        error: 'You are cursed',
        curse_expires: expireDate.toISOString(),
        curses_count: curCursesCount,
      });
    }

    // 4) Если curses_count < 6 — накладываем новое проклятие на 24 ч
    if (curCursesCount < 6) {
      const newCount = curCursesCount + 1;
      const expireTs = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 ч
      await pool.query(
        `UPDATE players
            SET is_cursed     = TRUE,
                curses_count  = $1,
                curse_expires = $2
          WHERE tg_id = $3`,
        [newCount, expireTs.toISOString(), tg_id]
      );
      // После наложения проклятия выдаём клиенту информацию
      const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
      res.setHeader('Authorization', `Bearer ${newToken}`);
      return res.json({
        ok: true,
        cursed: true,
        curse_expires: expireTs.toISOString(),
        curses_count: newCount,
      });
    }

    // 5) Если игрок получил уже 6 проклятий — переходим к старой логике выдачи фрагмента
    //    (с 2-минутным кулдауном и обновлением global_stats)
    // Проверяем 2-минутный кулдаун (по last_burn)
    const lastBurnTime = curLastBurn ? new Date(curLastBurn).getTime() : 0;
    if (now.getTime() - lastBurnTime < 2 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }

    // Вычисляем, какие фрагменты ещё не собраны
    const allFragments = [1, 2, 3, 4, 5, 6, 7, 8];
    const owned = curFragments;
    const available = allFragments.filter((f) => !owned.includes(f));
    if (available.length === 0) {
      const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
      res.setHeader('Authorization', `Bearer ${newToken}`);
      return res.status(400).json({ ok: false, error: 'All fragments collected' });
    }

    // Выбираем случайный фрагмент из доступных
    const idx = Math.floor(Math.random() * available.length);
    const newFragment = available[idx];
    const updatedFragments = [...owned, newFragment];

    // Обновляем player: фрагменты + last_burn
    await pool.query(
      `UPDATE players
          SET fragments = $1,
              last_burn  = NOW()
        WHERE tg_id = $2`,
      [updatedFragments, tg_id]
    );

    // Обновляем глобальную статистику total_users (или как там она называется)
    await pool.query(
      `UPDATE global_stats
          SET value = value + 1
        WHERE id = 'total_users'`
    );

    // Возвращаем успешный результат + refresh JWT
    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({
      ok: true,
      cursed: false,
      newFragment,
      fragments: updatedFragments,
    });
  } catch (err) {
    console.error('[player] POST /api/burn error:', err);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * GET /api/final/:tg_id
 * (оставляем без изменений, только с генерацией нового токена и т. д.)
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
