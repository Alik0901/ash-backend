// src/routes/player.js
import express from 'express';
import crypto  from 'crypto';
import jwt     from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import pool    from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const { JWT_SECRET, TON_WALLET_ADDRESS: TON_ADDR, FRAG_HMAC_SECRET } = process.env;

const TONHUB_URL      = 'https://tonhub.com/transfer';
const TONSPACE_SCHEME = 'ton://transfer';
const AMOUNT_NANO     = 500_000_000; // 0.5 TON in nano
const FRAGS           = [1,2,3,4,5,6,7,8];

// —————————————————————————————————————————————————————————————————————————
// 1) Хелперы и сама логика burn
// —————————————————————————————————————————————————————————————————————————

function sign(user) {
  return jwt.sign(
    { tg_id: user.tg_id, name: user.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function randRef() {
  return crypto.randomBytes(6).toString('base64url');
}

async function genUniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = randRef();
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE ref_code = $1 LIMIT 1`, [code]
    );
    if (!rows.length) return code;
  }
  return randRef();
}

/**
 * Основная логика выдачи фрагмента после успешной оплаты
 */
async function runBurnLogic(invoiceId) {
  console.log('[runBurnLogic] begin for', invoiceId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) забираем invoice
    const { rows: [inv] } = await client.query(
      `SELECT tg_id, processed
         FROM burn_invoices
        WHERE invoice_id = $1
          AND status      = 'paid'
        FOR UPDATE`,
      [invoiceId]
    );
    if (!inv || inv.processed) {
      await client.query('ROLLBACK');
      return { newFragment: null, cursed: false, curse_expires: null };
    }

    // 2) забираем игрока
    const { rows: [pl] } = await client.query(
      `SELECT fragments FROM players WHERE tg_id = $1 FOR UPDATE`,
      [inv.tg_id]
    );
    const owned = pl.fragments || [];

    // 3) выдаём новый фрагмент
    const available = FRAGS.filter(f => !owned.includes(f));
    const pick = available.length
      ? available[crypto.randomInt(available.length)]
      : null;

    if (pick !== null) {
      await client.query(
        `UPDATE players
            SET fragments = array_append(coalesce(fragments,'{}'::int[]), $2::int),
                last_burn  = NOW()
          WHERE tg_id = $1`,
        [inv.tg_id, pick]
      );
    } else {
      await client.query(
        `UPDATE players SET last_burn = NOW() WHERE tg_id = $1`,
        [inv.tg_id]
      );
    }

    // 4) помечаем инвойс как обработанный
    await client.query(
      `UPDATE burn_invoices SET processed = TRUE WHERE invoice_id = $1`,
      [invoiceId]
    );

    await client.query('COMMIT');
    console.log('[runBurnLogic] committed, pick=', pick);
    return { newFragment: pick, cursed: false, curse_expires: null };

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[runBurnLogic] error, rolled back', err);
    throw err;
  } finally {
    client.release();
  }
}

// —————————————————————————————————————————————————————————————————————————
// 2) ПУБЛИЧНЫЕ маршруты (до authenticate)
// —————————————————————————————————————————————————————————————————————————

/**
 * POST /api/init
 */
router.post('/init', async (req, res) => {
  console.log('[POST /api/init] body:', req.body);
  const { tg_id, name='', initData='', referrer_code=null } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE tg_id=$1`, [tg_id]
    );
    let player;
    if (!rows.length) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const code = await genUniqueCode();
        const { rows:[me] } = await client.query(
          `INSERT INTO players
             (tg_id,name,ref_code,referral_reward_issued)
           VALUES($1,$2,$3,FALSE) RETURNING *`,
          [tg_id, name.trim()||null, code]
        );
        if (referrer_code) {
          const { rows:[ref] } = await client.query(
            `SELECT tg_id FROM players WHERE ref_code=$1`, [referrer_code.trim()]
          );
          if (ref) {
            await client.query(
              `INSERT INTO referrals
                 (referrer_id,referred_id,status)
               VALUES($1,$2,'confirmed')`,
              [ref.tg_id, tg_id]
            );
          }
        }
        await client.query(
          `UPDATE global_stats SET value = value + 1 WHERE id='total_users'`
        );
        await client.query('COMMIT');
        player = me;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } else {
      const { rows:[me] } = await pool.query(
        `SELECT * FROM players WHERE tg_id=$1`, [tg_id]
      );
      player = me;
    }
    const token = sign(player);
    return res.json({ user: player, token });
  } catch (err) {
    console.error('[POST /api/init] error', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/player/:tg_id
 */
router.get('/player/:tg_id', async (req, res) => {
  console.log('[GET /api/player]', req.params.tg_id);
  try {
    const { rows } = await pool.query(
      `SELECT tg_id,name,fragments,last_burn FROM players WHERE tg_id=$1`,
      [req.params.tg_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('[GET /api/player] error', err);
    return res.status(500).json({ error: 'internal' });
  }
});

// ────────────────────────────────────────────────────────────────────────
// 3) ВСЕ ДАЛЬНЕЙШИЕ МАРШРУТЫ ЧЕРЕЗ JWT
router.use(authenticate);
// ────────────────────────────────────────────────────────────────────────

/**
 * GET /api/fragments/:tg_id
 */
router.get('/fragments/:tg_id', async (req, res) => {
  console.log('[GET /api/fragments]', req.params.tg_id);
  try {
    const { rows:[p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`, [req.params.tg_id]
    );
    if (!p) return res.status(404).json({ error: 'player not found' });
    return res.json({ fragments: p.fragments||[] });
  } catch (err) {
    console.error('[GET /api/fragments] error', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/burn-invoice
 */
router.post('/burn-invoice', async (req, res) => {
  console.log('[POST /api/burn-invoice]', req.body);
  const { tg_id } = req.body;
  if (!tg_id) {
    return res.status(400).json({ error: 'tg_id required' });
  }
  try {
    const invoiceId = uuid();
    const comment   = crypto.randomBytes(4).toString('hex');
    await pool.query(
      `INSERT INTO burn_invoices
         (invoice_id,tg_id,amount_nano,address,comment,status,created_at)
       VALUES($1,$2,$3,$4,$5,'pending',NOW())`,
      [invoiceId, tg_id, AMOUNT_NANO, TON_ADDR, comment]
    );
    return res.json({
      invoiceId,
      paymentUrl:  `${TONHUB_URL}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`,
      tonspaceUrl: `${TONSPACE_SCHEME}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`
    });
  } catch (err) {
    console.error('[POST /api/burn-invoice] error', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/burn-status/:invoiceId
 */
router.get('/burn-status/:invoiceId', async (req, res) => {
  // запрем кеширование, чтобы не было 304
  res.set('Cache-Control', 'no-store');
  console.log('[GET /api/burn-status]', req.params.invoiceId);
  try {
    const { rows:[inv] } = await pool.query(
      `SELECT status FROM burn_invoices WHERE invoice_id=$1`, 
      [req.params.invoiceId]
    );
    if (!inv) {
      return res.status(404).json({ error: 'invoice not found' });
    }
    if (inv.status !== 'paid') {
      console.log('[GET /api/burn-status] still pending');
      return res.json({ paid: false });
    }
    // теперь runBurnLogic уже определён и доступен
    const result = await runBurnLogic(req.params.invoiceId);
    console.log('[GET /api/burn-status] burnLogic:', result);
    return res.json({ paid: true, ...result });
  } catch (err) {
    console.error('[GET /api/burn-status] ERROR', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/referral
 */
router.get('/referral', async (req, res) => {
  console.log('[GET /api/referral]', req.user.tg_id);
  // … ваш код …
});

/**
 * POST /api/referral/claim
 */
router.post('/referral/claim', async (req, res) => {
  console.log('[POST /api/referral/claim]', req.user.tg_id);
  // … ваш код …
});

/**
 * DELETE /api/player/:tg_id
 */
router.delete('/player/:tg_id', async (req, res) => {
  console.log('[DELETE /api/player]', req.user.tg_id);
  // … ваш код …
});

export default router;
