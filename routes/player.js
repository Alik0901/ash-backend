// src/routes/player.js
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const BOT_TOKEN  = process.env.BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;

// TON-конфигурация
const TON_ADDRESS = process.env.TON_WALLET_ADDRESS;
const TON_RPC     = process.env.TON_RPC_ENDPOINT;

// Генерация нового JWT
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// (Опционально) Проверка initData подписи
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
 * — публичный, без аутентификации. Возвращает профиль игрока или 404.
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
 * — публичный. Создаёт или возвращает существующего игрока + выдаёт JWT.
 */
router.post('/init', async (req, res) => {
  const { tg_id, name, initData } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData are required' });
  }
  // (По желанию) проверяем подпись initData:
  // if (!verifyInitData(initData)) {
  //   return res.status(403).json({ error: 'Invalid initData signature' });
  // }

  try {
    // Проверяем, есть ли уже игрок
    let result = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    let userRow = result.rows[0];

    if (!userRow) {
      // Если нет — создаём нового с name
      result = await pool.query(
        `INSERT INTO players (tg_id, name, is_cursed, curses_count, curse_expires)
         VALUES ($1, $2, FALSE, 0, NULL)
         RETURNING tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at`,
        [tg_id, name || null]
      );
      userRow = result.rows[0];
    }

    // Генерируем JWT
    const token = generateToken({ tg_id: userRow.tg_id, name: userRow.name });
    return res.json({ user: userRow, token });
  } catch (err) {
    console.error('[player] POST /api/init error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// Все последующие маршруты требуют аутентификации
router.use(authenticate);

/**
 * GET /api/fragments/:tg_id
 * — возвращает fragments[] игрока + обновлённый JWT.
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
 * — возвращает общее количество игроков + обновлённый JWT.
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
 * POST /api/burn-invoice
 * — генерирует счёт (invoice) на 0.5 TON и сохраняет в БД → возвращает client-у.
 */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) {
    return res.status(400).json({ ok: false, error: 'tg_id is required' });
  }
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    // Проверка игрока и его состояния
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
    const { last_burn, is_cursed, curse_expires } = playerRes.rows[0];
    const now = new Date();

    // Если проклятие ещё не истекло
    if (curse_expires && new Date(curse_expires) > now) {
      return res.status(403).json({
        ok: false,
        error: 'You are still cursed',
        curse_expires: curse_expires.toISOString(),
      });
    }

    // Сбрасываем устаревшее проклятие
    if (is_cursed && curse_expires && new Date(curse_expires) <= now) {
      await pool.query(
        `UPDATE players
            SET is_cursed = FALSE,
                curse_expires = NULL
          WHERE tg_id = $1`,
        [tg_id]
      );
    }

    // Проверка двухминутного кулдауна
    const lastBurnTime = last_burn ? new Date(last_burn).getTime() : 0;
    if (now.getTime() - lastBurnTime < 2 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }

    // Создаём запись в burn_invoices
    const amountNano = 500_000_000; // 0.5 TON в нанотоннах
    const comment    = 'burn-' + Date.now(); 
    const invoiceResult = await pool.query(
      `INSERT INTO burn_invoices (tg_id, amount_nano, address, comment)
       VALUES ($1, $2, $3, $4)
       RETURNING invoice_id, created_at`,
      [tg_id, amountNano, TON_ADDRESS, comment]
    );
    const invoiceId = invoiceResult.rows[0].invoice_id;

    // Ответ клиенту
    const tonInvoice = { address: TON_ADDRESS, amountNano, comment };
    const newToken  = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${newToken}`);
    return res.json({ ok: true, invoiceId, tonInvoice });
  } catch (err) {
    console.error('[player] POST /api/burn-invoice error:', err);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * GET /api/burn-status/:invoiceId?
 * — проверяет on-chain, оплачен ли счёт. Если да → runBurnLogic и выдаёт игроку награду.
 * Принимаем invoiceId либо в path, либо в query (?invoiceId=...)
 */
router.get('/burn-status/:invoiceId?', async (req, res) => {
  const invoiceId = req.params.invoiceId || req.query.invoiceId;
  console.log('[player] GET /api/burn-status, invoiceId:', invoiceId);

  if (!invoiceId || invoiceId === 'null' || invoiceId === 'undefined') {
    return res.status(400).json({ ok: false, error: 'Invalid or missing invoiceId' });
  }

  try {
    const invRes = await pool.query(
      `SELECT tg_id, amount_nano, address, comment, status, created_at
         FROM burn_invoices
        WHERE invoice_id = $1
        LIMIT 1`,
      [invoiceId]
    );
    if (!invRes.rows.length) {
      return res.status(404).json({ ok: false, error: 'invoice not found' });
    }
    const invoice = invRes.rows[0];

    if (invoice.tg_id.toString() !== req.user.tg_id.toString()) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (invoice.status === 'paid') {
      return res.json({ ok: true, paid: true });
    }

    // TODO: реализовать проверку on-chain через ваш TON SDK
    let paid = false;
    // если paid === true:
    if (paid) {
      await pool.query(
        `UPDATE burn_invoices
            SET status = 'paid',
                paid_at = NOW()
          WHERE invoice_id = $1`,
        [invoiceId]
      );
      const burnResult = await runBurnLogic(req.user.tg_id);
      const newToken   = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
      res.setHeader('Authorization', `Bearer ${newToken}`);
      return res.json({ ok: true, paid: true, ...burnResult });
    } else {
      const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
      res.setHeader('Authorization', `Bearer ${newToken}`);
      return res.json({ ok: true, paid: false });
    }
  } catch (err) {
    console.error('[player] GET /api/burn-status error:', err);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * Вспомогательная функция runBurnLogic(tgId):
 * — выдаёт фрагмент или проклятие по бизнес-логике, сохраняет в БД и возвращает результат.
 */
async function runBurnLogic(tgId) {
  const playerRes = await pool.query(
    `SELECT fragments, is_cursed, curses_count
       FROM players
      WHERE tg_id = $1
      LIMIT 1`,
    [tgId]
  );
  const { fragments = [], is_cursed, curses_count } = playerRes.rows[0];
  const now = new Date();

  if (is_cursed) {
    return { cursed: true, curse_expires: is_cursed };
  }

  const totalBurnsDone = fragments.length + curses_count;
  let giveCurse = false;
  if (totalBurnsDone >= 3 && curses_count < 6) {
    giveCurse = Math.random() < 0.5;
  }

  if (giveCurse) {
    const newCount = curses_count + 1;
    const expireTs = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await pool.query(
      `UPDATE players
          SET is_cursed     = TRUE,
              curses_count  = $1,
              curse_expires = $2
        WHERE tg_id = $3`,
      [newCount, expireTs.toISOString(), tgId]
    );
    return { cursed: true, curse_expires: expireTs.toISOString() };
  }

  const allFragments = [1,2,3,4,5,6,7,8];
  const available = allFragments.filter(f => !fragments.includes(f));
  const newFragment = available[Math.floor(Math.random() * available.length)];
  const updatedFragments = [...fragments, newFragment];

  await pool.query(
    `UPDATE players
        SET fragments = $1,
            last_burn  = NOW()
      WHERE tg_id = $2`,
    [updatedFragments, tgId]
  );
  await pool.query(
    `UPDATE global_stats
        SET value = value + 1
      WHERE id = 'total_users'`
  );

  return {
    cursed: false,
    newFragment,
    fragments: updatedFragments,
    lastBurn: now.toISOString(),
  };
}

export default router;
