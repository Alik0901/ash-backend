import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const JWT_SECRET  = process.env.JWT_SECRET;
const TON_ADDRESS = process.env.TON_WALLET_ADDRESS;

/** Генерация JWT */
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/** GET /api/player/:tg_id — публичный */
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
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

/** POST /api/init — публичный. Создаёт/возвращает игрока + выдаёт JWT */
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
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Отсюда — все роуты под JWT
router.use(authenticate);

/** GET /api/fragments/:tg_id */
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  if (req.user.tg_id.toString() !== tg_id.toString()) {
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
    const fragments = rows[0].fragments || [];
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ fragments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

/** GET /api/stats/total_users */
router.get('/stats/total_users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM global_stats WHERE id = 'total_users'"
    );
    const value = rows.length ? rows[0].value : 0;
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ value });
  } catch (err) {
    console.error(err);
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ value: 0 });
  }
});

/** POST /api/burn-invoice — создаёт счёт на 0.5 TON в нанотоннах, возвращает `invoiceId` + deeplink */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) {
    return res.status(400).json({ ok: false, error: 'tg_id is required' });
  }
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    // 1) Проверка кулдауна и проклятия
    const { rows: pr } = await pool.query(
      `SELECT last_burn, is_cursed, curse_expires
         FROM players
        WHERE tg_id = $1`,
      [tg_id]
    );
    if (!pr.length) {
      return res.status(404).json({ ok: false, error: 'player not found' });
    }
    const { last_burn, is_cursed, curse_expires } = pr[0];
    const now = new Date();

    if (curse_expires && new Date(curse_expires) > now) {
      return res
        .status(403)
        .json({ ok: false, error: 'You are still cursed', curse_expires });
    }
    if (is_cursed && curse_expires && new Date(curse_expires) <= now) {
      await pool.query(
        `UPDATE players
            SET is_cursed = FALSE,
                curse_expires = NULL
          WHERE tg_id = $1`,
        [tg_id]
      );
    }
    const lastMs = last_burn ? new Date(last_burn).getTime() : 0;
    if (now.getTime() - lastMs < 2 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }

    // 2) Создаём инвойс
    const amountNano = 500_000_000;                    // 0.5 TON в нанотоннах
    const comment    = 'burn-' + Date.now();
    const { rows: ir } = await pool.query(
      `INSERT INTO burn_invoices (tg_id, amount_nano, address, comment)
       VALUES ($1, $2, $3, $4)
       RETURNING invoice_id`,
      [tg_id, amountNano, TON_ADDRESS, comment]
    );
    const invoiceId = ir[0].invoice_id;

    // 3) Deeplink на Tonhub — ПЕРЕДАЁТСЯ ЦЕЛОЕ ЧИСЛО
    const paymentUrl = `https://tonhub.com/transfer/${TON_ADDRESS}` +
                       `?amount=${amountNano}` +
                       `&text=${encodeURIComponent(comment)}`;

    // 4) Отправляем ответ
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ ok: true, invoiceId, paymentUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/** GET /api/burn-status/:invoiceId? — если invoiceId не указан или null, берём последний */
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
      `SELECT tg_id, status
         FROM burn_invoices
        WHERE invoice_id = $1`,
      [invoiceId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'invoice not found' });
    }
    if (rows[0].tg_id.toString() !== req.user.tg_id.toString()) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    if (rows[0].status === 'paid') {
      return res.json({ ok: true, paid: true });
    }
    // пока нет интеграции ончейн-проверки
    res.json({ ok: true, paid: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ... здесь ваша runBurnLogic, если нужно

export default router;
