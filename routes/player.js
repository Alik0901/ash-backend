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

// Генерация JWT
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// (Опционально) Проверка подписи initData
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
 */
router.get('/player/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'player not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[player] GET /api/player error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/**
 * POST /api/init
 */
router.post('/init', async (req, res) => {
  const { tg_id, name, initData } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData are required' });
  }
  try {
    let { rows } = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    let user = rows[0];
    if (!user) {
      ({ rows } = await pool.query(
        `INSERT INTO players (tg_id, name, is_cursed, curses_count, curse_expires)
         VALUES ($1, $2, FALSE, 0, NULL)
         RETURNING tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at`,
        [tg_id, name || null]
      ));
      user = rows[0];
    }
    const token = generateToken({ tg_id: user.tg_id, name: user.name });
    res.json({ user, token });
  } catch (err) {
    console.error('[player] POST /api/init error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Дальше все маршруты защищены JWT
router.use(authenticate);

/**
 * GET /api/fragments/:tg_id
 */
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id = $1 LIMIT 1`,
      [tg_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'player not found' });
    const fragments = rows[0].fragments || [];
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ fragments });
  } catch (err) {
    console.error('[player] GET /api/fragments error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/stats/total_users
 */
router.get('/stats/total_users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM global_stats WHERE id = 'total_users'"
    );
    const total = rows.length ? rows[0].value : 0;
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ value: total });
  } catch (err) {
    console.error('[player] GET /api/stats/total_users error:', err);
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ value: 0 });
  }
});

/**
 * POST /api/burn-invoice
 * — создаёт счёт (invoice) на 0.5 TON, сохраняет в БД и возвращает JSON с deeplink’ом.
 */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) return res.status(400).json({ ok: false, error: 'tg_id is required' });
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    // Проверка кулдауна и проклятия (как в вашем коде)
    const { rows: pr } = await pool.query(
      `SELECT last_burn, is_cursed, curse_expires FROM players WHERE tg_id = $1 LIMIT 1`,
      [tg_id]
    );
    if (!pr.length) return res.status(404).json({ ok: false, error: 'player not found' });
    const { last_burn, is_cursed, curse_expires } = pr[0];
    const now = new Date();

    if (curse_expires && new Date(curse_expires) > now) {
      return res.status(403).json({
        ok: false,
        error: 'You are still cursed',
        curse_expires
      });
    }
    if (is_cursed && curse_expires && new Date(curse_expires) <= now) {
      await pool.query(
        `UPDATE players SET is_cursed = FALSE, curse_expires = NULL WHERE tg_id = $1`,
        [tg_id]
      );
    }
    const lastTime = last_burn ? new Date(last_burn).getTime() : 0;
    if (now.getTime() - lastTime < 2 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }

    // Генерация счёта
    const amountNano = 500_000_000; // 0.5 TON
    const comment    = 'burn-' + Date.now();
    const { rows: ir } = await pool.query(
      `INSERT INTO burn_invoices (tg_id, amount_nano, address, comment)
       VALUES ($1, $2, $3, $4)
       RETURNING invoice_id`,
      [tg_id, amountNano, TON_ADDRESS, comment]
    );
    const invoiceId = ir[0].invoice_id;

    // Deeplink
    const amountTON  = (amountNano / 1e9).toString();
    const paymentUrl = `ton://transfer/${TON_ADDRESS}?amount=${amountTON}&text=${encodeURIComponent(comment)}`;

    // Возвращаем JSON, а не редирект
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    return res.json({
      ok: true,
      invoiceId,
      tonInvoice: { address: TON_ADDRESS, amountNano, comment },
      paymentUrl
    });
  } catch (err) {
    console.error('[player] POST /api/burn-invoice error:', err);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * GET /api/burn-status/:invoiceId?
 */
router.get('/burn-status/:invoiceId?', async (req, res) => {
  let invoiceId = req.params.invoiceId || req.query.invoiceId;
  if (!invoiceId || invoiceId === 'null') {
    const { rows } = await pool.query(
      `SELECT invoice_id FROM burn_invoices
         WHERE tg_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
      [req.user.tg_id]
    );
    invoiceId = rows[0]?.invoice_id;
  }
  console.log('[player] GET /api/burn-status, invoiceId:', invoiceId);
  if (!invoiceId) {
    return res.status(400).json({ ok: false, error: 'Invalid or missing invoiceId' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT tg_id, status FROM burn_invoices WHERE invoice_id = $1 LIMIT 1`,
      [invoiceId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'invoice not found' });
    const inv = rows[0];
    if (inv.tg_id.toString() !== req.user.tg_id.toString()) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    if (inv.status === 'paid') {
      return res.json({ ok: true, paid: true });
    }
    // TODO: проверка on-chain…
    return res.json({ ok: true, paid: false });
  } catch (err) {
    console.error('[player] GET /api/burn-status error:', err);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// Бизнес-логика runBurnLogic() без изменений
async function runBurnLogic(tgId) {
  /* ... */
}

export default router;
