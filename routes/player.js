import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const JWT_SECRET  = process.env.JWT_SECRET;
const TON_ADDRESS = process.env.TON_WALLET_ADDRESS;
const TONHUB_URL  = 'https://tonhub.com/transfer';

/**
 * Генерация JWT
 */
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/**
 * GET /api/player/:tg_id — публичный
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
    console.error('[GET /player] ', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/**
 * POST /api/init — публичный, создаёт/возвращает игрока + JWT
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
           VALUES ($1,$2,FALSE,0,NULL)
         RETURNING *`,
        [tg_id, name || null]
      ));
    }
    const user  = rows[0];
    const token = generateToken({ tg_id: user.tg_id, name: user.name });
    res.json({ user, token });
  } catch (err) {
    console.error('[POST /init] ', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Все последующие маршруты — под JWT
router.use(authenticate);

/**
 * GET /api/fragments/:tg_id — возвращает fragments
 */
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  if (`${req.user.tg_id}` !== `${tg_id}`) {
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
    const token     = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ fragments });
  } catch (err) {
    console.error('[GET /fragments] ', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/stats/total_users — общее число игроков
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
    console.error('[GET /stats] ', err);
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ value: 0 });
  }
});

/**
 * POST /api/burn-invoice — создаёт счёт и возвращает deeplink на Tonhub
 */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) {
    return res.status(400).json({ ok: false, error: 'tg_id is required' });
  }
  if (`${req.user.tg_id}` !== `${tg_id}`) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    // проверка кулдауна и проклятья
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
        .json({ ok: false, error: 'You are still cursed', curse_expires });
    }
    if (is_cursed && curse_expires && new Date(curse_expires).getTime() <= now) {
      await pool.query(
        `UPDATE players SET is_cursed = FALSE, curse_expires = NULL WHERE tg_id = $1`,
        [tg_id]
      );
    }
    if (last_burn && now - new Date(last_burn).getTime() < 2 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }

    // вставляем инвойс
    const amountNano = 500_000_000;            // 0.5 TON
    const comment    = 'burn-' + Date.now();
    const { rows: ir } = await pool.query(
      `INSERT INTO burn_invoices (tg_id, amount_nano, address, comment)
       VALUES ($1,$2,$3,$4) RETURNING invoice_id`,
      [tg_id, amountNano, TON_ADDRESS, comment]
    );
    const invoiceId = ir[0].invoice_id;

    // deeplink на TON-блокчейн
    const amountTon  = (amountNano / 1e9).toString(); // "0.5"
    const paymentUrl = `${TONHUB_URL}/${TON_ADDRESS}`
                     + `?amount=${amountTon}`
                     + `&text=${encodeURIComponent(comment)}`;

    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ ok: true, invoiceId, paymentUrl });

  } catch (err) {
    console.error('[POST /burn-invoice] ', err);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * GET /api/burn-status/:invoiceId? — проверка оплаты и бизнес-логика
 */
router.get('/burn-status/:invoiceId?', async (req, res) => {
  let invoiceId = req.params.invoiceId || req.query.invoiceId;
  if (!invoiceId || invoiceId === 'null') {
    const { rows } = await pool.query(
      `SELECT invoice_id FROM burn_invoices
         WHERE tg_id = $1
      ORDER BY created_at DESC LIMIT 1`,
      [req.user.tg_id]
    );
    invoiceId = rows[0]?.invoice_id;
  }
  if (!invoiceId) {
    return res.status(400).json({ ok: false, error: 'invoiceId missing' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT tg_id, status FROM burn_invoices WHERE invoice_id = $1`,
      [invoiceId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'invoice not found' });
    }
    if (`${rows[0].tg_id}` !== `${req.user.tg_id}`) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (rows[0].status === 'paid') {
      // запускаем вашу логику и возвращаем результат
      const result = await runBurnLogic(invoiceId);
      const token  = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
      res.setHeader('Authorization', `Bearer ${token}`);
      return res.json({ ok: true, paid: true, ...result });
    }

    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    res.json({ ok: true, paid: false });

  } catch (err) {
    console.error('[GET /burn-status] ', err);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * Бизнес-логика «сжигания» (выдача фрагмента/проклятье)
 */
async function runBurnLogic(invoiceId) {
  // пометим счёт как обработанный
  await pool.query(
    `UPDATE burn_invoices SET status = 'processed' WHERE invoice_id = $1`,
    [invoiceId]
  );

  // достанем детали
  const { rows: ir2 } = await pool.query(
    `SELECT tg_id, comment FROM burn_invoices WHERE invoice_id = $1`,
    [invoiceId]
  );
  const tg_id = ir2[0].tg_id;

  // получим текущие фрагменты
  const { rows: pr } = await pool.query(
    `SELECT fragments FROM players WHERE tg_id = $1`,
    [tg_id]
  );
  const current = pr[0].fragments || [];

  // найдём первый свободный
  const newId = [1,2,3,4,5,6,7,8].find(i => !current.includes(i));
  const updated = [...current];
  if (newId) updated.push(newId);

  // обновим игрока
  const lastBurn = new Date().toISOString();
  await pool.query(
    `UPDATE players
        SET fragments = $2,
            last_burn = $3
      WHERE tg_id = $1`,
    [tg_id, updated, lastBurn]
  );

  return {
    cursed:     false,
    newFragment: newId,
    fragments:  updated,
    lastBurn,
  };
}

export default router;
