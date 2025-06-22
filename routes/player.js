/*  Order-of-Ash · routes/player.js – v2.5 (23 Jun 2025)
    ─────────────────────────────────────────────────────────
    • все основные маршруты (init, player, burn, stats, fragments, referral)
    • DELETE /player/:tg_id — транзакционная очистка профиля
*/

import express from 'express';
import crypto  from 'crypto';
import jwt     from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import pool    from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/* ── ENV ─────────────────────────────────────────────────── */
const { JWT_SECRET, TON_WALLET_ADDRESS: TON_ADDR } = process.env;

/* ── CONSTANTS ───────────────────────────────────────────── */
const TONHUB_URL      = 'https://tonhub.com/transfer';
const TONSPACE_SCHEME = 'ton://transfer';
const AMOUNT_NANO     = 500_000_000;            // 0.5 TON
const FRAGS           = [1,2,3,4,5,6,7,8];

/* ── HELPERS ─────────────────────────────────────────────── */
const sign = user =>
  jwt.sign({ tg_id: user.tg_id, name: user.name }, JWT_SECRET, { expiresIn: '1h' });
const randRef = () => crypto.randomBytes(6).toString('base64url');

/* ╔════════════════  PUBLIC  ══════════════════════════════ */

/* ► GET /api/player/:tg_id — профиль + приглашения */
router.get('/player/:tg_id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tg_id,name,fragments,last_burn,is_cursed,curse_expires,
              curses_count,ref_code,referral_reward_issued
         FROM players
        WHERE tg_id=$1
        LIMIT 1`,
      [req.params.tg_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }

    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM referrals
         WHERE referrer_id=$1 AND status='confirmed'`,
      [rows[0].tg_id]
    );

    res.json({ ...rows[0], invitedCount: Number(count) });
  } catch (err) {
    console.error('[player]', err);
    res.status(500).json({ error: 'internal' });
  }
});

/* ► POST /api/init — регистрация + JWT */
router.post('/init', async (req, res) => {
  const { tg_id, name = '', initData = '', referrer_code = null } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData required' });
  }

  try {
    let { rows } = await pool.query(
      `SELECT * FROM players WHERE tg_id=$1`,
      [tg_id]
    );

    if (!rows.length) {
      const myCode = await genUniqueCode();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { rows: [me] } = await client.query(
          `INSERT INTO players
             (tg_id,name,is_cursed,curses_count,curse_expires,ref_code,referral_reward_issued)
           VALUES ($1,$2,FALSE,0,NULL,$3,FALSE)
           RETURNING *`,
          [tg_id, name || null, myCode]
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
            `INSERT INTO referrals (referrer_id,referred_id,status)
             VALUES ($1,$2,'pending')`,
            [ref.tg_id, tg_id]
          );
        }

        await client.query('COMMIT');
        rows = [me];
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    const user = rows[0];
    res.json({ user, token: sign(user) });
  } catch (err) {
    console.error('[init]', err);
    res.status(500).json({ error: 'internal' });
  }
});

/* ╔══════════════  PROTECTED  ═════════════════════════════ */
router.use(authenticate);

/* ► POST /api/burn-invoice — создать счёт */
router.post('/burn-invoice', async (req, res) => {
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
       VALUES ($1,$2,$3,$4,$5,'pending',NOW())`,
      [invoiceId, tg_id, AMOUNT_NANO, TON_ADDR, comment]
    );

    const paymentUrl  = `${TONHUB_URL}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`;
    const tonspaceUrl = `${TONSPACE_SCHEME}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`;

    res.json({ invoiceId, paymentUrl, tonspaceUrl });
  } catch (err) {
    console.error('[burn-invoice]', err);
    res.status(500).json({ error: 'internal' });
  }
});

/* ► GET /api/burn-status/:invoiceId — статус + выдача фрагмента */
router.get('/burn-status/:invoiceId', async (req, res) => {
  try {
    const { rows: [inv] } = await pool.query(
      `SELECT status FROM burn_invoices WHERE invoice_id=$1`,
      [req.params.invoiceId]
    );
    if (!inv) {
      return res.status(404).json({ error: 'invoice not found' });
    }
    if (inv.status !== 'paid') {
      return res.json({ paid: false });
    }

    const result = await runBurnLogic(req.params.invoiceId);
    res.json({ paid: true, ...result });
  } catch (err) {
    console.error('[burn-status]', err);
    res.status(500).json({ error: 'internal' });
  }
});

/* ► GET /api/fragments/:tg_id — мои фрагменты */
router.get('/fragments/:tg_id', async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,
      [req.params.tg_id]
    );
    if (!p) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ fragments: p.fragments || [] });
  } catch (err) {
    console.error('[fragments]', err);
    res.status(500).json({ error: 'internal' });
  }
});

/* ► GET /api/stats/total_users — общее число игроков */
router.get('/stats/total_users', async (_req, res) => {
  try {
    const { rows: [{ count }] } = await pool.query(
      'SELECT COUNT(*) FROM players'
    );
    res.json({ total: Number(count) });
  } catch (err) {
    console.error('[stats]', err);
    res.status(500).json({ error: 'internal' });
  }
});

/* ► GET /api/referral/:tg_id — сводка рефералов (мягко) */
router.get('/referral/:tg_id', async (req, res) => {
  if (String(req.user.tg_id) !== req.params.tg_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { rows: [p] } = await pool.query(
      `SELECT ref_code, referral_reward_issued
         FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    if (!p) {
      return res.json({
        refCode: null,
        invitedCount: 0,
        rewardIssued: false
      });
    }

    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM referrals
         WHERE referrer_id=$1 AND status='confirmed'`,
      [req.user.tg_id]
    );

    res.setHeader('Authorization', `Bearer ${sign(req.user)}`);
    res.json({
      refCode: p.ref_code,
      invitedCount: Number(count),
      rewardIssued: p.referral_reward_issued
    });
  } catch (err) {
    console.error('[referral]', err);
    res.status(500).json({ error: 'internal' });
  }
});  

router.post('/referral/claim', authenticate, async (req, res) => {
  const tg_id = req.user.tg_id;
  console.log('[referral claim] start for', tg_id);

  try {
    // 1) Забираем игрока
    const playerRes = await pool.query(
      `SELECT fragments, referral_reward_issued
         FROM players
        WHERE tg_id = $1`,
      [tg_id]
    );
    if (playerRes.rows.length === 0) {
      console.warn('[referral claim] player not found:', tg_id);
      return res.status(404).json({ error: 'Player not found' });
    }
    const p = playerRes.rows[0];
    console.log('[referral claim] player row', p);

    if (p.referral_reward_issued) {
      return res.status(400).json({ error: 'Reward already claimed' });
    }

    // 2) Считаем confirmed referrals
    const confRes = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM referrals
        WHERE referrer_id = $1
          AND status       = 'confirmed'`,
      [tg_id]
    );
    const confirmed = Number(confRes.rows[0].cnt);
    console.log('[referral claim] confirmed count', confirmed);

    if (confirmed < 3) {
      return res.status(400).json({ error: 'Not enough invited users' });
    }

    // 3) Выбираем свободный фрагмент
    const owned     = p.fragments || [];
    const available = FRAGS.filter(f => !owned.includes(f));
    const pick      = available.length
                      ? available[crypto.randomInt(available.length)]
                      : null;
    console.log('[referral claim] pick fragment', pick);

    // 4) Обновляем таблицу players
    await pool.query(
      `UPDATE players
          SET fragments              = CASE WHEN $2 IS NULL THEN fragments
                                             ELSE array_append(fragments,$2)
                                        END,
              referral_reward_issued = TRUE
        WHERE tg_id = $1`,
      [tg_id, pick]
    );
    console.log('[referral claim] player updated');

    // 5) Отправляем ответ + новый токен
    res.setHeader('Authorization', `Bearer ${sign(req.user)}`);
    return res.json({ ok: true, fragment: pick });

  } catch (err) {
    console.error('[referral claim] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/* ► DELETE /api/player/:tg_id — удалить профиль */
router.delete('/player/:tg_id', async (req, res) => {
  if (String(req.user.tg_id) !== req.params.tg_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Удаляем рефералы
    await client.query(
      `DELETE FROM referrals
         WHERE referrer_id=$1 OR referred_id=$1`,
      [req.user.tg_id]
    );
    // Удаляем счета
    await client.query(
      `DELETE FROM burn_invoices WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    // Удаляем профиль
    await client.query(
      `DELETE FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[delete]', err);
    res.status(500).json({ error: 'internal' });
  } finally {
    client.release();
  }
});

/* ── BUSINESS LOGIC — выдача фрагмента ───────────────────── */
async function runBurnLogic (invoiceId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) берём счёт
    const { rows: [inv] } = await client.query(
      `SELECT tg_id, processed
         FROM burn_invoices
        WHERE invoice_id=$1
          AND status='paid'
        FOR UPDATE`,
      [invoiceId]
    );
    if (!inv || inv.processed) {
      await client.query('ROLLBACK');
      return { newFragment: null, cursed: false, curse_expires: null };
    }

    // 2) читаем фрагменты игрока
    const { rows: [pl] } = await client.query(
      `SELECT fragments FROM players
        WHERE tg_id=$1
        FOR UPDATE`,
      [inv.tg_id]
    );
    const owned     = pl.fragments || [];
    const available = FRAGS.filter(f => !owned.includes(f));
    const pick      = available.length
                      ? available[crypto.randomInt(available.length)]
                      : null;

    // 3) обновляем игрока
    if (pick === null) {
      await client.query(
        `UPDATE players
            SET last_burn = NOW()
          WHERE tg_id=$1`,
        [inv.tg_id]
      );
    } else {
      await client.query(
        `UPDATE players
            SET fragments = array_append(fragments, $2::int),
                last_burn = NOW()
          WHERE tg_id=$1`,
        [inv.tg_id, pick]
      );
    }

    // 4) помечаем счёт
    await client.query(
      `UPDATE burn_invoices
          SET processed = TRUE
        WHERE invoice_id=$1`,
      [invoiceId]
    );

    await client.query('COMMIT');
    return { newFragment: pick, cursed: false, curse_expires: null };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[runBurnLogic]', err);
    throw err;
  } finally {
    client.release();
  }
}

/* ── UTILS — генерация уникального кода ───────────────────── */
async function genUniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = randRef();
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE ref_code=$1 LIMIT 1`,
      [code]
    );
    if (!rows.length) return code;
  }
  return crypto.randomBytes(8).toString('base64url');
}

export default router;
