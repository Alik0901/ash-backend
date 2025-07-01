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
const MANDATORY = [1, 2, 3];           // три обязательных фрагмента
const MAX_CURSES = MANDATORY.length;  // сколько всего проклятий нужно выдать

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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) блокируем счет
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

    // 2) блокируем игрока, читаем фрагменты и уже выданные проклятия
    const { rows: [pl] } = await client.query(
      `SELECT fragments, is_cursed, curses_count
         FROM players
        WHERE tg_id = $1
        FOR UPDATE`,
      [inv.tg_id]
    );
    const owned = pl.fragments || [];
    const cursesSoFar = pl.curses_count || 0;
    const hasAllMandatory = MANDATORY.every(id => owned.includes(id));

    // 3) если обязательные есть, и ещё не выдано все проклятия — выдаём их рандомно
    if (hasAllMandatory && cursesSoFar < MAX_CURSES) {
      const availableFrags = FRAGS.filter(f => !owned.includes(f));
      const fragsLeft = availableFrags.length;
      const cursesLeft = MAX_CURSES - cursesSoFar;
      const pCurse = cursesLeft / (fragsLeft + cursesLeft);
      if (Math.random() < pCurse) {
        // выдаём проклятие на 1 час (для 2 минут поменяйте 60*60*1000 → 2*60*1000)
        const curseExpires = new Date(Date.now() + 2 * 60 * 1000);
        await client.query(
          `UPDATE players
              SET is_cursed     = TRUE,
                  curses_count  = curses_count + 1,
                  curse_expires = $2
            WHERE tg_id = $1`,
          [inv.tg_id, curseExpires]
        );
        await client.query(
          `UPDATE burn_invoices
              SET processed = TRUE
            WHERE invoice_id = $1`,
          [invoiceId]
        );
        await client.query('COMMIT');
        return {
          newFragment: null,
          cursed: true,
          curse_expires: curseExpires.toISOString()
        };
      }
    }

    // 4) иначе выдаём новый фрагмент (или просто обновляем last_burn)
    const available = FRAGS.filter(f => !owned.includes(f));
    const pick = available.length
      ? available[crypto.randomInt(available.length)]
      : null;

    if (pick !== null) {
      await client.query(
        `UPDATE players
            SET fragments = array_append(fragments,$2::int),
                last_burn  = NOW()
          WHERE tg_id = $1`,
        [inv.tg_id, pick]
      );
    } else {
      await client.query(
        `UPDATE players
            SET last_burn = NOW()
          WHERE tg_id = $1`,
        [inv.tg_id]
      );
    }

    // 5) отмечаем инвойс как обработанный
    await client.query(
      `UPDATE burn_invoices
          SET processed = TRUE
        WHERE invoice_id = $1`,
      [invoiceId]
    );

    await client.query('COMMIT');
    return { newFragment: pick, cursed: false, curse_expires: null };

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[runBurnLogic]', e);
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
  const { tg_id, name = '', initData = '', referrer_code = null } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE tg_id = $1`, [tg_id]
    );
    let player;
    if (!rows.length) {
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
        if (referrer_code) {
          const { rows: [ref] } = await client.query(
            `SELECT tg_id FROM players WHERE ref_code=$1 LIMIT 1`,
            [referrer_code.trim()]
          );
          if (!ref) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid referral code' });
          }
          await client.query(
            `INSERT INTO referrals
               (referrer_id,referred_id,status)
             VALUES ($1,$2,'confirmed')`,
            [ref.tg_id, tg_id]
          );
        }
        await client.query(
          `UPDATE global_stats
              SET value = value + 1
            WHERE id = 'total_users'`
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
      const { rows: [me] } = await pool.query(
        `SELECT * FROM players WHERE tg_id=$1 LIMIT 1`, [tg_id]
      );
      player = me;
    }
    return res.json({ user: player, token: sign(player) });
  } catch (e) {
    console.error('[init]', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/player/:tg_id
 */
router.get('/player/:tg_id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tg_id,name,fragments,last_burn,is_cursed,
              curse_expires,curses_count,ref_code,referral_reward_issued
         FROM players
        WHERE tg_id=$1
        LIMIT 1`,
      [req.params.tg_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'player not found' });
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM referrals
        WHERE referrer_id=$1 AND status='confirmed'`,
      [req.params.tg_id]
    );
    return res.json({ ...rows[0], invitedCount: Number(c.cnt) });
  } catch (e) {
    console.error('[player]', e);
    return res.status(500).json({ error: 'internal' });
  }
});

//Проверяет, время создания аккаунта
//
router.get('/final/:tg_id', authenticate, async (req, res) => {
  try {
    // Получаем время создания аккаунта
    const { rows: [player] } = await pool.query(
      `SELECT created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [req.params.tg_id]
    );
    if (!player) {
      return res.status(404).json({ error: 'player not found' });
    }

    const createdAt = new Date(player.created_at);
    const now       = new Date();

    // Час и минута регистрации
    const targetHour   = createdAt.getHours();
    const targetMinute = createdAt.getMinutes();

    // Сейчас час и минута
    const nowHour   = now.getHours();
    const nowMinute = now.getMinutes();

    // Если час и минута совпадают — окно открыто
    const canEnter = (nowHour === targetHour && nowMinute === targetMinute);

    return res.json({ canEnter });
  } catch (err) {
    console.error('Error in GET /api/final/:tg_id', err);
    return res.status(500).json({ error: 'internal' });
  }
});

// ── PROTECTED ────────────────────────────────────────────────────
router.use(authenticate);

/**
 * GET /api/stats/total_users
 */
router.get('/stats/total_users', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM global_stats WHERE id='total_users' LIMIT 1`
    );
    const total = rows.length ? Number(rows[0].value) : 0;
    return res.json({ total });
  } catch (e) {
    console.error('[stats]', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/fragments/:tg_id
 */
router.get('/fragments/:tg_id', async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,
      [req.params.tg_id]
    );
    if (!p) return res.status(404).json({ error: 'player not found' });
    return res.json({ fragments: p.fragments || [] });
  } catch (e) {
    console.error('[fragments]', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/burn-invoice
 */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) return res.status(400).json({ error: 'tg_id required' });
  try {
    const invoiceId = uuid();
    const comment = crypto.randomBytes(4).toString('hex');
    await pool.query(
      `INSERT INTO burn_invoices
         (invoice_id,tg_id,amount_nano,address,comment,status,created_at)
       VALUES($1,$2,$3,$4,$5,'pending',NOW())`,
      [invoiceId, tg_id, AMOUNT_NANO, TON_ADDR, comment]
    );
    return res.json({
      invoiceId,
      paymentUrl: `${TONHUB_URL}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`,
      tonspaceUrl: `${TONSPACE_SCHEME}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`
    });
  } catch (e) {
    console.error('[burn-invoice]', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/burn-status/:invoiceId
 */
router.get('/burn-status/:invoiceId', async (req, res) => {
  try {
    const { rows: [inv] } = await pool.query(
      `SELECT status FROM burn_invoices WHERE invoice_id=$1`,
      [req.params.invoiceId]
    );
    if (!inv) return res.status(404).json({ error: 'invoice not found' });
    if (inv.status !== 'paid') return res.json({ paid: false });
    const result = await runBurnLogic(req.params.invoiceId);
    return res.json({ paid: true, ...result });
  } catch (e) {
    console.error('[burn-status]', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/referral
 */
router.get('/referral', async (req, res) => {
  const tg_id = req.user.tg_id;
  try {
    const { rows: [p] } = await pool.query(
      `SELECT ref_code,referral_reward_issued FROM players WHERE tg_id=$1`,
      [tg_id]
    );
    if (!p) return res.json({ refCode: null, invitedCount: 0, rewardIssued: false });
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM referrals
         WHERE referrer_id=$1 AND status='confirmed'`,
      [tg_id]
    );
    res.setHeader('Authorization', `Bearer ${sign(req.user)}`);
    return res.json({
      refCode: p.ref_code,
      invitedCount: Number(c.cnt),
      rewardIssued: p.referral_reward_issued
    });
  } catch (e) {
    console.error('[referral]', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/referral/claim
 */
router.post('/referral/claim', async (req, res) => {
  const tg_id = req.user.tg_id;
  try {
    const { rows } = await pool.query(
      `SELECT fragments,referral_reward_issued FROM players WHERE tg_id=$1`,
      [tg_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Player not found' });
    const p = rows[0];
    if (p.referral_reward_issued) {
      return res.status(400).json({ error: 'Reward already claimed' });
    }
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM referrals
         WHERE referrer_id=$1 AND status='confirmed'`,
      [tg_id]
    );
    if (Number(c.cnt) < 3) {
      return res.status(400).json({ error: 'Not enough invited users' });
    }
    const owned = p.fragments || [];
    const available = FRAGS.filter(f => !owned.includes(f));
    const pick = available.length
      ? available[crypto.randomInt(available.length)]
      : null;
    await pool.query(
      `UPDATE players
         SET fragments=array_append(fragments,$2::int),
             referral_reward_issued=TRUE
       WHERE tg_id=$1`,
      [tg_id, pick]
    );
    res.setHeader('Authorization', `Bearer ${sign(req.user)}`);
    return res.json({ ok: true, fragment: pick });
  } catch (e) {
    console.error('[referral claim]', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * DELETE /api/player/:tg_id
 */
router.delete('/player/:tg_id', async (req, res) => {
  if (String(req.user.tg_id) !== req.params.tg_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    return res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[delete]', e);
    return res.status(500).json({ error: 'internal' });
  } finally {
    client.release();
  }
});

export default router;
