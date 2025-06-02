// src/routes/player.js
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const BOT_TOKEN   = process.env.BOT_TOKEN;
const JWT_SECRET  = process.env.JWT_SECRET;

// helper для проверки initData (раскомментировать в проде)
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

// helper для генерации JWT
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/**
 * POST /api/init
 * Создаёт (или возвращает) профиль игрока и выдаёт JWT.
 * Ожидает JSON { tg_id, name, initData }
 */
router.post('/init', async (req, res) => {
  const { tg_id, name, initData } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData are required' });
  }
  // Проверка подписи initData (раскомментировать в проде)
  // if (!verifyInitData(initData)) {
  //   return res.status(403).json({ error: 'Invalid initData signature' });
  // }

  try {
    // Сначала пробуем найти существующего игрока
    let result = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    let user = result.rows[0];
    if (!user) {
      // Если не найден — создаём нового
      result = await pool.query(
        `INSERT INTO players (tg_id, name)
         VALUES ($1, $2)
         RETURNING tg_id, name, fragments, last_burn, is_cursed, created_at`,
        [tg_id, name || null]
      );
      user = result.rows[0];
    }

    // Генерируем токен
    const token = generateToken({ tg_id: user.tg_id, name: user.name });
    // Отправляем профиль и токен
    res.json({ user, token });
  } catch (err) {
    console.error('[player] POST /api/init error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Все последующие маршруты — защищённые
// Подключаем authenticate перед ними:
router.use(authenticate);

/**
 * GET /api/player/:tg_id
 * Возвращает профиль игрока, обновляет JWT в заголовке.
 */
router.get('/player/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  // Проверяем, что запрашивает именно авторизованный пользователь
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const result = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    const user = result.rows[0];
    // Новый токен
    const newToken = generateToken({ tg_id: user.tg_id, name: user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json(user);
  } catch (err) {
    console.error('[player] GET /api/player error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/fragments/:tg_id
 * Возвращает только массив fragments, обновляет JWT.
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
    const fragments = result.rows[0].fragments;
    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ fragments });
  } catch (err) {
    console.error('[player] GET /api/fragments error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/stats/total_users — возвращает общее число игроков
 * При любой ошибке возвращаем value = 0, но статус 200.
 */
router.get('/stats/total_users', async (req, res) => {
  // В рамках нашей JWT-логики, сюда уже попал только аутентифицированный пользователь.
  try {
    const { rows } = await pool.query(
      "SELECT value FROM global_stats WHERE id = 'total_users'"
    );
    // Если записи нет, просто возвращаем 0, но не 404/500
    const total = rows.length > 0 ? rows[0].value : 0;

    // Сгенерируем новый токен (refresh) и отдадим его в заголовке
    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);

    // Возвращаем всегда 200 OK
    return res.json({ value: total });
  } catch (err) {
    console.error('[player] GET /api/stats/total_users error:', err);
    // В случае любой ошибки – возвращаем value:0, но не 500
    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ value: 0 });
  }
});

/**
 * POST /api/burn
 * Добавляет новый фрагмент (2-минутный кулдаун), обновляет JWT.
 */
router.post('/burn', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) {
    return res.status(400).json({ error: 'tg_id is required' });
  }
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const playerRes = await pool.query(
      `SELECT fragments, last_burn, is_cursed
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (!playerRes.rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    const { fragments = [], last_burn, is_cursed } = playerRes.rows[0];
    if (is_cursed) {
      return res.status(403).json({ error: 'You are cursed' });
    }
    const now = Date.now();
    const last = last_burn ? new Date(last_burn).getTime() : 0;
    if (now - last < 2 * 60 * 1000) {
      return res.status(429).json({ error: 'burn cooldown active' });
    }
    const all = [1,2,3,4,5,6,7,8];
    const avail = all.filter(f => !fragments.includes(f));
    if (!avail.length) {
      return res.status(400).json({ error: 'All fragments collected' });
    }
    const newF = avail[Math.floor(Math.random()*avail.length)];
    const updated = [...fragments, newF];

    await pool.query(
      `UPDATE players
          SET fragments = $1,
              last_burn  = NOW()
        WHERE tg_id = $2`,
      [updated, tg_id]
    );
    await pool.query(
      `UPDATE global_stats
          SET value = value + 1
        WHERE id = 'total_users'`
    );

    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ newFragment: newF, fragments: updated });
  } catch (err) {
    console.error('[player] POST /api/burn error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/final/:tg_id
 * Проверяет, можно ли вводить финальную фразу прямо сейчас, обновляет JWT.
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
      createdAt.getUTCMonth()    === now.getUTCMonth() &&
      createdAt.getUTCDate()     === now.getUTCDate() &&
      createdAt.getUTCHours()    === now.getUTCHours() &&
      createdAt.getUTCMinutes()  === now.getUTCMinutes();

    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ canEnter });
  } catch (err) {
    console.error('[player] GET /api/final error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

export default router;
