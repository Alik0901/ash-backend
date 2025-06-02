// src/routes/player.js
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const BOT_TOKEN  = process.env.BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;

/** Генерация нового JWT */
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// (Опционально) вспомогательная проверка initData
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
 * 1) GET /api/player/:tg_id 
 *    — теперь публичный: проверяем, есть ли игрок в БД.
 *    Не требует авторизации (authenticate не применяется).
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
    // Отдаём профиль, без генерации токена
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[player] GET /api/player error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * 2) POST /api/init
 *    — создаёт нового игрока (если нет) или возвращает существующего и всегда выдаёт JWT.
 */
router.post('/init', async (req, res) => {
  const { tg_id, name, initData } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData are required' });
  }
  // (при желании) проверка подписи initData:
  // if (!verifyInitData(initData)) {
  //   return res.status(403).json({ error: 'Invalid initData signature' });
  // }

  try {
    // Сначала смотрим, есть ли уже игрок
    let result = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    let userRow = result.rows[0];

    if (!userRow) {
      // Если нет — создаём запись с указанным именем
      result = await pool.query(
        `INSERT INTO players (tg_id, name, is_cursed, curses_count, curse_expires)
         VALUES ($1, $2, FALSE, 0, NULL)
         RETURNING tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at`,
        [tg_id, name || null]
      );
      userRow = result.rows[0];
    }

    // Генерируем и возвращаем JWT
    const token = generateToken({ tg_id: userRow.tg_id, name: userRow.name });
    return res.json({ user: userRow, token });
  } catch (err) {
    console.error('[player] POST /api/init error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/** 
 * Теперь все остальные маршруты — под JWT-мидлваром 
 * (т.е. /api/burn, /api/fragments, /api/stats, /api/final/* — требуют authorize)
 */
router.use(authenticate);

/**
 * GET /api/fragments/:tg_id — возвращает массив fragments + refresh JWT
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
 * GET /api/stats/total_users — возвращает общее число игроков + refresh JWT
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
 *  — первые 3 нажатия дают гарантированно фрагмент, 
 *    следующие (до 6 проклятий) рандомно выдают либо проклятие, либо фрагмент, 
 *    после 6 проклятий — только фрагмент.
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

    // 1) Если сейчас под активным проклятием (т.е. curse_expires > now), 
    //    сразу отказываем:
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

    // 2) Если проклятие истекло (или его не было), снимем флаг is_cursed
    if (is_cursed && curse_expires && new Date(curse_expires) <= now) {
      await pool.query(
        `UPDATE players
            SET is_cursed = FALSE,
                curse_expires = NULL
          WHERE tg_id = $1`,
        [tg_id]
      );
    }

    // Обновим данные игрока после снятия флага:
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

    // 3) Если игрок снова «под проклятием» (после снятия — однако is_cursed уже false),
    //    пропуск (но по коду curIsCursed уже false, поэтому этот блок не сработает).
    if (curIsCursed) {
      const expireDate = new Date(curCurseExpires);
      return res.status(403).json({
        ok: false,
        error: 'You are cursed',
        curse_expires: expireDate.toISOString(),
      });
    }

    // 4) Проверяем двухминутный кулдаун (last_burn)
    const lastBurnTime = curLastBurn ? new Date(curLastBurn).getTime() : 0;
    if (now.getTime() - lastBurnTime < 2 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }

    // 5) Решаем, что дать:
    //    – если < 3 предыдущих «сжиганий», даём гарантированно фрагмент;
    //    – иначе, если проклятий < 6, random(0,1) решает «проклятие vs фрагмент»;
    //    – иначе (проклятий ≥ 6) — только фрагмент.

    const allFragments = [1, 2, 3, 4, 5, 6, 7, 8];
    const owned = curFragments;
    const available = allFragments.filter((f) => !owned.includes(f));

    // Если фрагменты уже все собраны, сразу возвращаем:
    if (available.length === 0) {
      const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
      res.setHeader('Authorization', `Bearer ${newToken}`);
      return res.status(400).json({ ok: false, error: 'All fragments collected' });
    }

    // Количество уже сделанных «сжиганий» = fragments.length + curses_count
    // Но нам важно лишь: сколько были «сжиганий» раньше? 
    // Иногда легче хранить в БД отдельный counter_burns. Но сейчас
    // мы предположим, что первым гарантированным сжиганием считается каждый раз, когда
    // игроку дают фрагмент (и НЕ даётся проклятие). То есть если curses_count=0,
    // а в fragments уже 2, значит игрок сделал 2 сжигания и получил 2 фрагмента.
    // Нужен счётчик «всех сжиганий» — для простоты введём:
    const totalBurnsDone = owned.length + curCursesCount;

    let giveCurse = false;
    if (totalBurnsDone < 3) {
      // первые 3 сжигания = всегда фрагмент
      giveCurse = false;
    } else if (curCursesCount < 6) {
      // после 3-х, пока проклятий < 6 → random
      giveCurse = Math.random() < 0.5;
    } else {
      // если проклятий ≥ 6 → только фрагмент
      giveCurse = false;
    }

    if (giveCurse) {
      // Накладываем новое проклятие:
      const newCount = curCursesCount + 1;
      const expireTs = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24h
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

    // Иначе — выдаём случайный фрагмент:
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
 * GET /api/final/:tg_id — без изменений (защищён auth)
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
