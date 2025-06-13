import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

const JWT_SECRET      = process.env.JWT_SECRET;
const TON_ADDRESS     = process.env.TON_WALLET_ADDRESS;
const TONHUB_URL      = 'https://tonhub.com/transfer';
const TONSPACE_SCHEME = 'ton://transfer';

// Фиксированная сумма
const FIXED_AMOUNT = '0.5';         // в TON
const AMOUNT_NANO  = 500_000_000;   // 0.5 TON в наносах

// Кулдаун 2 минуты
const COOLDOWN_MS = 2 * 60 * 1000;

// Генерация JWT
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/**
 * GET /api/player/:tg_id
 * Публичный — возвращает профиль игрока
 */
router.get('/player/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed, curse_expires
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /player] error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/**
 * POST /api/init
 * Публичный — создаёт нового игрока (или возвращает существующего) и отдает JWT
 */
router.post('/init', async (req, res) => {
  const { tg_id, name, initData } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData are required' });
  }
  try {
    let { rows } = await pool.query(
      `SELECT * FROM players WHERE tg_id = $1`,
      [tg_id]
    );
    if (!rows.length) {
      ({ rows } = await pool.query(
        `INSERT INTO players (tg_id, name, is_cursed, curses_count, curse_expires)
           VALUES ($1, $2, FALSE, 0, NULL)
         RETURNING *`,
        [tg_id, name || null]
      ));
    }
    const user = rows[0];
    const token = generateToken({ tg_id: user.tg_id, name: user.name });
    res.json({ user, token });
  } catch (err) {
    console.error('[POST /init] error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Все дальше маршруты защищены JWT
router.use(authenticate);

/**
 * GET /api/fragments/:tg_id
 */
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  if (String(req.user.tg_id) !== String(tg_id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id = $1`,
      [tg_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ fragments: rows[0].fragments || [] });
  } catch (err) {
    console.error('[GET /fragments] error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/stats/total_users
 */
router.get('/stats/total_users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM global_stats WHERE id = 'total_users'`
    );
    const value = rows.length ? rows[0].value : 0;
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ value });
  } catch (err) {
    console.error('[GET /stats] error:', err);
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ value: 0 });
  }
});

/**
 * POST /api/burn-invoice
 * — проверяем кулдаун и проклятие
 * — создаём инвойс с status='pending'
 * — возвращаем два deeplink’а с жёстко 0.5 TON
 */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) {
    return res.status(400).json({ ok: false, error: 'tg_id is required' });
  }
  if (String(req.user.tg_id) !== String(tg_id)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    // 1) кулдаун и проклятие
    const { rows: pr } = await pool.query(
      `SELECT last_burn, is_cursed, curse_expires FROM players WHERE tg_id = $1`,
      [tg_id]
    );
    if (!pr.length) {
      return res.status(404).json({ ok: false, error: 'player not found' });
    }
    const { last_burn, is_cursed, curse_expires } = pr[0];
    const now = Date.now();
    if (curse_expires && new Date(curse_expires).getTime() > now) {
      return res
        .status(403)
        .json({ ok: false, error: `You are cursed until ${curse_expires}` });
    }
    const lastMs = last_burn ? new Date(last_burn).getTime() : 0;
    if (now - lastMs < COOLDOWN_MS) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }

    // 2) создаём запись в burn_invoices
    const invoiceId = crypto.randomUUID();
    const comment = `burn-${invoiceId}`;
    await pool.query(
      `INSERT INTO burn_invoices
         (invoice_id, tg_id, amount_nano, address, comment, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',NOW())`,
      [invoiceId, tg_id, AMOUNT_NANO, TON_ADDRESS, comment]
    );

    // 3) формируем deeplink’и
    const tonspaceUrl = `${TONSPACE_SCHEME}/${TON_ADDRESS}` +
                        `?amount=${FIXED_AMOUNT}` +
                        `&text=${encodeURIComponent(comment)}`;
    const paymentUrl  = `${TONHUB_URL}/${TON_ADDRESS}` +
                        `?amount=${FIXED_AMOUNT}` +
                        `&text=${encodeURIComponent(comment)}`;

    // 4) возвращаем клиенту
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ ok: true, invoiceId, tonspaceUrl, paymentUrl });
  } catch (err) {
    console.error('[POST /burn-invoice] error:', err);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * GET /api/burn-status/:invoiceId?
 * — если нет invoiceId, берём последний
 * — если status='pending', возвращаем { ok:true, paid:false }
 * — если status='paid', запускаем runBurnLogic и возвращаем новый фрагмент
 */
router.get('/burn-status/:invoiceId?', async (req, res) => {
  let invoiceId = req.params.invoiceId || req.query.invoiceId;
  if (!invoiceId || invoiceId === 'null') {
    const { rows } = await pool.query(
      `SELECT invoice_id
         FROM burn_invoices
        WHERE tg_id = $1
     ORDER BY created_at DESC
        LIMIT 1`,
      [req.user.tg_id]
    );
    invoiceId = rows[0]?.invoice_id;
  }
  if (!invoiceId) {
    return res.status(400).json({ ok: false, error: 'invoiceId missing' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT status FROM burn_invoices WHERE invoice_id = $1`,
      [invoiceId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'invoice not found' });
    }
    if (rows[0].status === 'pending') {
      const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
      res.setHeader('Authorization', `Bearer ${token}`);
      return res.json({ ok: true, paid: false });
    }

    // статус 'paid' → выдаём фрагмент
    const result = await runBurnLogic(invoiceId);
    const token  = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    return res.json({ ok: true, paid: true, ...result });
  } catch (err) {
    console.error('[GET /burn-status] error:', err);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * Бизнес-логика «сжигания»
 */
async function runBurnLogic(invoiceId) {
  // помечаем processed
  await pool.query(
    `UPDATE burn_invoices
        SET status = 'processed',
            paid_at = NOW()
      WHERE invoice_id = $1`,
    [invoiceId]
  );

  // получаем tg_id
  const { rows: inv } = await pool.query(
    `SELECT tg_id FROM burn_invoices WHERE invoice_id = $1`,
    [invoiceId]
  );
  const tg_id = inv[0].tg_id;

  // выдаём фрагмент
  const { rows: pr } = await pool.query(
    `SELECT fragments FROM players WHERE tg_id = $1`,
    [tg_id]
  );
  const current = pr[0].fragments || [];
  const newId = [1,2,3,4,5,6,7,8].find(i => !current.includes(i));
  const updated = newId ? [...current, newId] : current;
  const lastBurn = new Date().toISOString();
  await pool.query(
    `UPDATE players
        SET fragments = $2,
            last_burn  = $3
      WHERE tg_id = $1`,
    [tg_id, updated, lastBurn]
  );

  return { newFragment: newId, fragments: updated, lastBurn };
}

export default router;
