// src/routes/player.js
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const { JWT_SECRET, TON_WALLET_ADDRESS: TON_ADDR } = process.env;

const TONHUB_URL = 'https://tonhub.com/transfer';
const TONSPACE_SCHEME = 'ton://transfer';
const AMOUNT_NANO = 500_000_000; // 0.5 TON в нано
const FRAGS = [1, 2, 3, 4, 5, 6, 7, 8];
const MANDATORY = [1, 2, 3];
const MAX_CURSES = MANDATORY.length;

/** Генерация и подпись JWT */
function sign(user) {
  return jwt.sign(
    { tg_id: user.tg_id, name: user.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/** Случайный реф-код */
function randRef() {
  return crypto.randomBytes(6).toString('base64url');
}

/** Уникальный реф-код */
async function genUniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = randRef();
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE ref_code = $1 LIMIT 1`,
      [code]
    );
    if (!rows.length) return code;
  }
  return crypto.randomBytes(8).toString('base64url');
}

/**
 * Логика выдачи фрагмента или проклятия после оплаты
 */
async function runBurnLogic(invoiceId) {
  console.log(`[runBurnLogic] start for invoiceId=${invoiceId}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('[runBurnLogic] BEGIN');

    // 1) блокируем счёт
    const { rows: [inv] } = await client.query(
      `SELECT tg_id, processed
         FROM burn_invoices
        WHERE invoice_id = $1
          AND status      = 'paid'
        FOR UPDATE`,
      [invoiceId]
    );
    console.log('[runBurnLogic] invoice:', inv);
    if (!inv || inv.processed) {
      console.log('[runBurnLogic] nothing to do, ROLLBACK');
      await client.query('ROLLBACK');
      return { newFragment: null, cursed: false, curse_expires: null };
    }

    // 2) блокируем игрока
    const { rows: [pl] } = await client.query(
      `SELECT fragments
         FROM players
        WHERE tg_id = $1
        FOR UPDATE`,
      [inv.tg_id]
    );
    console.log('[runBurnLogic] player before:', pl);
    const owned = pl.fragments || [];
    console.log('[runBurnLogic] owned fragments:', owned);

    // 3) **отключаем проклятия полностью для теста**  
    // (раскомментируйте и используйте дальше, когда будете проверять curses)
    // - убираем весь код про hasAllMandatory и pCurse

    // 4) выдаём новый фрагмент
    const available = FRAGS.filter(f => !owned.includes(f));
    console.log('[runBurnLogic] available fragments:', available);
    const pick = available.length
      ? available[crypto.randomInt(available.length)]
      : null;
    console.log('[runBurnLogic] pick:', pick);

    if (pick !== null) {
      await client.query(
        `UPDATE players
            SET fragments = array_append(
                             coalesce(fragments, '{}'::int[]),
                             $2::int
                           ),
                last_burn  = NOW()
          WHERE tg_id = $1`,
        [inv.tg_id, pick]
      );
      console.log(`[runBurnLogic] appended fragment ${pick}`);
    } else {
      // на всякий случай, если pick=null, просто обновляем время
      await client.query(
        `UPDATE players
            SET last_burn = NOW()
          WHERE tg_id = $1`,
        [inv.tg_id]
      );
      console.log('[runBurnLogic] no pick, only updated last_burn');
    }

    // 5) помечаем инвойс как обработанный
    await client.query(
      `UPDATE burn_invoices
          SET processed = TRUE
        WHERE invoice_id = $1`,
      [invoiceId]
    );
    console.log('[runBurnLogic] marked invoice processed');

    await client.query('COMMIT');
    console.log('[runBurnLogic] COMMIT done');
    return { newFragment: pick, cursed: false, curse_expires: null };

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[runBurnLogic] ERROR, rolled back', e);
    throw e;
  } finally {
    client.release();
  }
}

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────

/**
 * POST /api/init
 */
router.post('/init', async (req, res) => {
  console.log('[POST /api/init] body:', req.body);
  const { tg_id, name = '', initData = '', referrer_code = null } = req.body;
  if (!tg_id || !initData) {
    console.warn('[POST /api/init] missing tg_id or initData');
    return res.status(400).json({ error: 'tg_id and initData required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE tg_id = $1`, [tg_id]
    );
    let player;
    if (!rows.length) {
      console.log('[POST /api/init] new player, inserting');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const code = await genUniqueCode();
        const { rows: [me] } = await client.query(
          `INSERT INTO players
             (tg_id,name,is_cursed,curses_count,curse_expires,ref_code,referral_reward_issued)
           VALUES ($1,$2,FALSE,0,NULL,$3,FALSE)
           RETURNING *`,
          [tg_id, name.trim() || null, code]
        );
        console.log('[POST /api/init] inserted player:', me);

        if (referrer_code) {
          console.log('[POST /api/init] processing referrer_code:', referrer_code);
          const { rows: [ref] } = await client.query(
            `SELECT tg_id FROM players WHERE ref_code=$1 LIMIT 1`,
            [referrer_code.trim()]
          );
          if (!ref) {
            console.warn('[POST /api/init] invalid referrer_code');
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid referral code' });
          }
          await client.query(
            `INSERT INTO referrals
               (referrer_id,referred_id,status)
             VALUES ($1,$2,'confirmed')`,
            [ref.tg_id, tg_id]
          );
          console.log('[POST /api/init] referral recorded:', ref.tg_id, '->', tg_id);
        }

        await client.query(
          `UPDATE global_stats
              SET value = value + 1
            WHERE id = 'total_users'`
        );
        await client.query('COMMIT');
        console.log('[POST /api/init] player creation transaction COMMIT');
        player = me;
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('[POST /api/init] ERROR during player insert, rolled back', e);
        throw e;
      } finally {
        client.release();
      }
    } else {
      console.log('[POST /api/init] existing player, fetching');
      const { rows: [me] } = await pool.query(
        `SELECT * FROM players WHERE tg_id=$1 LIMIT 1`, [tg_id]
      );
      player = me;
    }
    const token = sign(player);
    console.log('[POST /api/init] returning user and token');
    return res.json({ user: player, token });
  } catch (e) {
    console.error('[POST /api/init] ERROR', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/player/:tg_id
 */
router.get('/player/:tg_id', async (req, res) => {
  console.log('[GET /api/player] tg_id=', req.params.tg_id);
  try {
    const { rows } = await pool.query(
      `SELECT tg_id,name,fragments,last_burn,is_cursed,
              curse_expires,curses_count,ref_code,referral_reward_issued
         FROM players
        WHERE tg_id=$1
        LIMIT 1`,
      [req.params.tg_id]
    );
    if (!rows.length) {
      console.warn('[GET /api/player] player not found');
      return res.status(404).json({ error: 'player not found' });
    }
    const player = rows[0];
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM referrals
        WHERE referrer_id=$1 AND status='confirmed'`,
      [req.params.tg_id]
    );
    console.log('[GET /api/player] returning player data');
    return res.json({ ...player, invitedCount: Number(c.cnt) });
  } catch (e) {
    console.error('[GET /api/player] ERROR', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/fragments/:tg_id
 */
router.get('/fragments/:tg_id', async (req, res) => {
  console.log('[GET /api/fragments] tg_id=', req.params.tg_id);
  try {
    const { rows: [p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,
      [req.params.tg_id]
    );
    if (!p) {
      console.warn('[GET /api/fragments] player not found');
      return res.status(404).json({ error: 'player not found' });
    }
    console.log('[GET /api/fragments] fragments:', p.fragments);
    return res.json({ fragments: p.fragments || [] });
  } catch (e) {
    console.error('[GET /api/fragments] ERROR', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/burn-invoice
 */
router.post('/burn-invoice', async (req, res) => {
  console.log('[POST /api/burn-invoice] body:', req.body);
  const { tg_id } = req.body;
  if (!tg_id) {
    console.warn('[POST /api/burn-invoice] missing tg_id');
    return res.status(400).json({ error: 'tg_id required' });
  }
  try {
    const invoiceId = uuid();
    const comment = crypto.randomBytes(4).toString('hex');
    await pool.query(
      `INSERT INTO burn_invoices
         (invoice_id,tg_id,amount_nano,address,comment,status,created_at)
       VALUES($1,$2,$3,$4,$5,'pending',NOW())`,
      [invoiceId, tg_id, AMOUNT_NANO, TON_ADDR, comment]
    );
    console.log('[POST /api/burn-invoice] created invoice:', invoiceId);
    return res.json({
      invoiceId,
      paymentUrl: `${TONHUB_URL}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`,
      tonspaceUrl: `${TONSPACE_SCHEME}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`
    });
  } catch (e) {
    console.error('[POST /api/burn-invoice] ERROR', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/burn-status/:invoiceId
 */
router.get('/burn-status/:invoiceId', async (req, res) => {
  console.log('[GET /api/burn-status]', req.params.invoiceId);
  try {
    const { rows: [inv] } = await pool.query(
      `SELECT status FROM burn_invoices WHERE invoice_id=$1`,
      [req.params.invoiceId]
    );
    console.log('[GET /api/burn-status] invoice row:', inv);
    if (!inv) {
      console.warn('[GET /api/burn-status] invoice not found');
      return res.status(404).json({ error: 'invoice not found' });
    }
    if (inv.status !== 'paid') {
      console.log('[GET /api/burn-status] not paid yet');
      return res.json({ paid: false });
    }
    const result = await runBurnLogic(req.params.invoiceId);
    console.log('[GET /api/burn-status] burnLogic result:', result);
    return res.json({ paid: true, ...result });
  } catch (e) {
    console.error('[GET /api/burn-status] ERROR', e);
    return res.status(500).json({ error: 'internal' });
  }
});

// ── PROTECTED ROUTES ────────────────────────────────────────────────────
router.use(authenticate);

/**
 * GET /api/referral
 */
router.get('/referral', async (req, res) => {
  console.log('[GET /api/referral] user:', req.user.tg_id);
  try {
    const { rows: [p] } = await pool.query(
      `SELECT ref_code,referral_reward_issued FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM referrals
         WHERE referrer_id=$1 AND status='confirmed'`,
      [req.user.tg_id]
    );
    console.log('[GET /api/referral] code & count:', p, c);
    res.setHeader('Authorization', `Bearer ${sign(req.user)}`);
    return res.json({
      refCode: p.ref_code,
      invitedCount: Number(c.cnt),
      rewardIssued: p.referral_reward_issued
    });
  } catch (e) {
    console.error('[GET /api/referral] ERROR', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/referral/claim
 */
router.post('/referral/claim', async (req, res) => {
  console.log('[POST /api/referral/claim] user:', req.user.tg_id);
  try {
    const { rows } = await pool.query(
      `SELECT fragments,referral_reward_issued FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    const p = rows[0];
    console.log('[POST /api/referral/claim] player data:', p);
    if (p.referral_reward_issued) {
      console.warn('[POST /api/referral/claim] reward already claimed');
      return res.status(400).json({ error: 'Reward already claimed' });
    }
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM referrals
         WHERE referrer_id=$1 AND status='confirmed'`,
      [req.user.tg_id]
    );
    if (Number(c.cnt) < 3) {
      console.warn('[POST /api/referral/claim] not enough invites:', c.cnt);
      return res.status(400).json({ error: 'Not enough invited users' });
    }
    const available = FRAGS.filter(f => !p.fragments.includes(f));
    const pick = available.length ? available[crypto.randomInt(available.length)] : null;
    await pool.query(
      `UPDATE players
         SET fragments = array_append(
                          coalesce(fragments, '{}'::int[]),
                          $2::int
                        ),
             referral_reward_issued = TRUE
       WHERE tg_id = $1`,
      [tg_id, pick]
    );
    console.log('[POST /api/referral/claim] awarded fragment:', pick);
    res.setHeader('Authorization', `Bearer ${sign(req.user)}`);
    return res.json({ ok: true, fragment: pick });
  } catch (e) {
    console.error('[POST /api/referral/claim] ERROR', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * DELETE /api/player/:tg_id
 */
router.delete('/player/:tg_id', async (req, res) => {
  console.log('[DELETE /api/player] user:', req.user.tg_id, 'target:', req.params.tg_id);
  if (String(req.user.tg_id) !== req.params.tg_id) {
    console.warn('[DELETE /api/player] forbidden');
    return res.status(403).json({ error: 'Forbidden' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('[DELETE /api/player] BEGIN');
    await client.query(
      `DELETE FROM referrals WHERE referrer_id=$1 OR referred_id=$1`,
      [req.user.tg_id]
    );
    await client.query(
      `DELETE FROM burn_invoices WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    await client.query(
      `DELETE FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    await client.query('COMMIT');
    console.log('[DELETE /api/player] COMMIT');
    return res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DELETE /api/player] ERROR, rolled back', e);
    return res.status(500).json({ error: 'internal' });
  } finally {
    client.release();
  }
});

export default router;
