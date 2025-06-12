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

/** Генерируем новый JWT */
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/** GET /api/player/:tg_id — публичный маршрут */
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
    if (!rows.length) return res.status(404).json({ error: 'player not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /player] error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/** POST /api/init — публичный, создаёт игрока (если нового) и отдаёт JWT */
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
    const user  = rows[0];
    const token = generateToken({ tg_id: user.tg_id, name: user.name });
    res.json({ user, token });
  } catch (err) {
    console.error('[POST /init] error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Ниже — все роуты под JWT
router.use(authenticate);

/** GET /api/fragments/:tg_id */
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
    if (!rows.length) return res.status(404).json({ error: 'player not found' });
    const fragments = rows[0].fragments || [];
    const token     = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ fragments });
  } catch (err) {
    console.error('[GET /fragments] error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/** GET /api/stats/total_users */
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
    console.error('[GET /stats/total_users] error:', err);
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ value: 0 });
  }
});

/**
 * POST /api/burn-invoice
 * — создаёт счёт на 0.5 TON (500 000 000 nanoton) и возвращает два deeplink’а:
 *   • paymentUrl  — Tonhub (https://…)
 *   • tonspaceUrl — встроенный Telegram-кошелёк (ton://…)
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
    // 1) проверка кулдауна и проклятия
    const { rows: pr } = await pool.query(
      `SELECT last_burn, is_cursed, curse_expires
         FROM players
        WHERE tg_id = $1`,
      [tg_id]
    );
    if (!pr.length) return res.status(404).json({ ok: false, error: 'player not found' });
    const { last_burn, is_cursed, curse_expires } = pr[0];
    const nowMs = Date.now();

    if (curse_expires && new Date(curse_expires).getTime() > nowMs) {
      return res
        .status(403)
        .json({ ok: false, error: 'You are still cursed', curse_expires });
    }
    if (is_cursed && curse_expires && new Date(curse_expires).getTime() <= nowMs) {
      await pool.query(
        `UPDATE players SET is_cursed = FALSE, curse_expires = NULL WHERE tg_id = $1`,
        [tg_id]
      );
    }
    if (last_burn && nowMs - new Date(last_burn).getTime() < 2 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }

    // 2) создаём инвойс
    const amountNano = 500_000_000;                          // 0.5 TON в нанотоннах
    const comment    = 'burn-' + Date.now();
    const { rows: ir } = await pool.query(
      `INSERT INTO burn_invoices (tg_id, amount_nano, address, comment)
       VALUES ($1, $2, $3, $4) RETURNING invoice_id`,
      [tg_id, amountNano, TON_ADDRESS, comment]
    );
    const invoiceId = ir[0].invoice_id;

    // 3) формируем два deeplink’а (используем amountNano, чтобы жестко зафиксировать сумму)
    const paymentUrl  = `${TONHUB_URL}/${TON_ADDRESS}` +
                        `?amount=${amountNano}` +
                        `&text=${encodeURIComponent(comment)}`;
    const tonspaceUrl = `${TONSPACE_SCHEME}/${TON_ADDRESS}` +
                        `?amount=${amountNano}` +
                        `&text=${encodeURIComponent(comment)}`;

    // 4) отдадим клиенту
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ ok: true, invoiceId, paymentUrl, tonspaceUrl });
  } catch (err) {
    console.error('[POST /burn-invoice] error:', err);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * GET /api/burn-status/:invoiceId?
 * — если нет invoiceId или 'null', берём последний
 * — если status='paid', запускаем бизнес-логику и возвращаем результат
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
  if (!invoiceId) return res.status(400).json({ ok: false, error: 'invoiceId missing' });

  try {
    const { rows } = await pool.query(
      `SELECT tg_id, status FROM burn_invoices WHERE invoice_id = $1`,
      [invoiceId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'invoice not found' });
    const inv = rows[0];
    if (String(inv.tg_id) !== String(req.user.tg_id)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (inv.status === 'paid') {
      // выполняем бизнес-логику
      const result = await runBurnLogic(invoiceId);
      const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
      res.setHeader('Authorization', `Bearer ${token}`);
      return res.json({ ok: true, paid: true, ...result });
    }

    // ещё не оплачено
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ ok: true, paid: false });
  } catch (err) {
    console.error('[GET /burn-status] error:', err);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// Бизнес-логика «сжигания»
async function runBurnLogic(invoiceId) {
  // помечаем как обработанный
  await pool.query(
    `UPDATE burn_invoices SET status = 'processed' WHERE invoice_id = $1`,
    [invoiceId]
  );
  // достаём комментарий и tg_id
  const { rows: ir2 } = await pool.query(
    `SELECT tg_id, comment FROM burn_invoices WHERE invoice_id = $1`,
    [invoiceId]
  );
  const { tg_id, comment } = ir2[0];

  // тут — ваша логика раздачи фрагментов/проклятий
  // пример: всегда даём следующий фрагмент
  const { rows: pr } = await pool.query(
    `SELECT fragments FROM players WHERE tg_id = $1`,
    [tg_id]
  );
  const current = pr[0].fragments || [];
  const newId   = [1,2,3,4,5,6,7,8].find(i => !current.includes(i));
  const updated = [...current];
  if (newId) updated.push(newId);

  const lastBurn = new Date().toISOString();
  await pool.query(
    `UPDATE players SET fragments = $2, last_burn = $3 WHERE tg_id = $1`,
    [tg_id, updated, lastBurn]
  );

  return {
    cursed: false,
    newFragment: newId,
    fragments: updated,
    lastBurn
  };
}

export default router;
