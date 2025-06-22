/*  Order-of-Ash · routes/player.js – v2.2 (22-Jun-2025)
   ──────────────────────────────────────────────────────────────
   • полноценные /burn-invoice и /burn-status
   • прежние маршруты без изменений
*/

import express  from 'express';
import crypto   from 'crypto';
import jwt      from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import pool     from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/* ── env ─────────────────────────────────────────────────────────── */
const {
  JWT_SECRET,
  TON_WALLET_ADDRESS: TON_ADDRESS,
} = process.env;

/* ── constants ───────────────────────────────────────────────────── */
const TONHUB_URL      = 'https://tonhub.com/transfer';
const TONSPACE_SCHEME = 'ton://transfer';

const FIXED_AMOUNT    = '0.5';        // TON — для фронта
const AMOUNT_NANO     = 500_000_000;  // 0.5 TON в nano
const COOLDOWN_MS     = 2 * 60 * 1_000;

const FRAGS       = [1,2,3,4,5,6,7,8];
const MAX_CURSES  = 4;
const CURSE_HOURS = 24;

/* ── helpers ─────────────────────────────────────────────────────── */
const sign = u =>
  jwt.sign({ tg_id: u.tg_id, name: u.name }, JWT_SECRET, { expiresIn: '1h' });

const randomRefCode = () => crypto.randomBytes(6).toString('base64url');


/* ╔═════════  PUBLIC  ═════════╗ */

/* ► профиль + прогресс рефералов */
router.get('/player/:tg_id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tg_id,name,fragments,last_burn,is_cursed,
              curse_expires,curses_count,
              ref_code,referral_reward_issued
         FROM players
        WHERE tg_id=$1
        LIMIT 1`,
      [req.params.tg_id]
    );
    if (!rows.length)
      return res.status(404).json({ error: 'player not found' });

    const { rows:[{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM referrals
        WHERE referrer_id=$1 AND status='confirmed'`,
      [rows[0].tg_id]
    );

    res.json({ ...rows[0], invitedCount: Number(count) });
  } catch (e) {
    console.error('[player] ', e);
    res.status(500).json({ error: 'internal error' });
  }
});

/* ► регистрация / JWT */
router.post('/init', async (req, res) => {
  const {
    tg_id,
    name            = '',
    initData        = '',
    referrer_code   = null
  } = req.body;

  if (!tg_id || !initData)
    return res.status(400).json({ error: 'tg_id and initData required' });

  try {
    /* уже существует? */
    let { rows } =
      await pool.query(`SELECT * FROM players WHERE tg_id=$1`, [tg_id]);

    /* ─────────── новый игрок ─────────── */
    if (!rows.length) {
      const myCode = await generateUniqueCode();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { rows:[me] } = await client.query(
          `INSERT INTO players
             (tg_id,name,is_cursed,curses_count,curse_expires,
              ref_code,referral_reward_issued)
           VALUES ($1,$2,FALSE,0,NULL,$3,FALSE)
           RETURNING *`,
          [tg_id, name || null, myCode]
        );

        /* если введён чужой код → создаём referral(pending) */
        if (referrer_code) {
          const { rows:[ref] } = await client.query(
            `SELECT tg_id FROM players
              WHERE ref_code=$1
              LIMIT 1`,
            [referrer_code.trim()]
          );

          if (!ref) {                               /* код не найден */
            await client.query('ROLLBACK');
            return res.status(400).json({ error:'Invalid referral code' });
          }

          try {
            await client.query(
              `INSERT INTO referrals (referrer_id,referred_id,status)
               VALUES ($1,$2,'pending')`,
              [ref.tg_id, tg_id]
            );
          } catch (e) {
            /* FK violation: пригласитель исчез между SELECT и INSERT */
            if (e.code === '23503') {
              await client.query('ROLLBACK');
              return res.status(400).json({
                error: 'Referral code is no longer valid'
              });
            }
            throw e;
          }
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

  } catch (e) {
    console.error('[init] ', e);
    res.status(500).json({ error: 'internal error' });
  }
});

/* ╔═════════  JWT-PROTECTED  ═════════╗ */
router.use(authenticate);
/* ► POST /api/burn-invoice — создать счёт */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) return res.status(400).json({ error: 'tg_id required' });

  try {
    const invoiceId = uuidv4();
    const comment   = crypto.randomBytes(4).toString('hex');   // 8-симв

    await pool.query(
      `INSERT INTO burn_invoices
         (invoice_id, tg_id, amount_nano, address, comment, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'pending', NOW())`,
      [invoiceId, tg_id, AMOUNT_NANO, TON_ADDRESS, comment]
    );

    const paymentUrl  =
      `${TONHUB_URL}/${TON_ADDRESS}?amount=${AMOUNT_NANO}&text=${comment}`;
    const tonspaceUrl =
      `${TONSPACE_SCHEME}/${TON_ADDRESS}?amount=${AMOUNT_NANO}&text=${comment}`;

    return res.json({ invoiceId, paymentUrl, tonspaceUrl });
  } catch (e) {
    console.error('[burn-invoice] ', e);
    return res.status(500).json({ error: 'internal error' });
  }
});

/* ► GET /api/burn-status/:invoiceId — статус счёта */
/* ► статус счёта */
router.get('/burn-status/:invoiceId?', async (req, res) => {
  const id = req.params.invoiceId;
  if (!id)
    return res.status(400).json({ error: 'invoiceId required' });

  try {
    const { rows:[inv] } = await pool.query(
      `SELECT status FROM burn_invoices WHERE invoice_id=$1`,
      [id]
    );
    if (!inv)
      return res.status(404).json({ error: 'invoice not found' });

    /* ещё не оплачено */
    if (inv.status !== 'paid')
      return res.json({ paid: false });

    /* оплачено — запускаем бизнес-логику (фрагмент/curse) */
    const result = await runBurnLogic(id);   // { newFragment, cursed, … }
    return res.json({ paid: true, ...result });

  } catch (e) {
    console.error('[burn-status] ', e);
    res.status(500).json({ error: 'internal error' });
  }
});

/* ► referral summary */
router.get('/referral/:tg_id', async (req,res)=>{
  if(String(req.user.tg_id)!==req.params.tg_id)
    return res.status(403).json({ error:'Forbidden' });

  try {
    const [{ rows:[p] }, { rows:[c] }] = await Promise.all([
      pool.query(
        `SELECT ref_code,referral_reward_issued
           FROM players WHERE tg_id=$1`,
        [req.user.tg_id]
      ),
      pool.query(
        `SELECT COUNT(*) FROM referrals
          WHERE referrer_id=$1 AND status='confirmed'`,
        [req.user.tg_id]
      )
    ]);

    res.setHeader('Authorization',`Bearer ${sign(req.user)}`);
    res.json({
      refCode      : p.ref_code,
      invitedCount : Number(c.count),
      rewardIssued : p.referral_reward_issued
    });
  } catch (e) {
    console.error('[referral GET] ', e);
    res.status(500).json({ error: 'internal error' });
  }
});

/* ► claim free fragment */
router.post('/referral/claim', async (req,res)=>{
  const tg_id = req.user.tg_id;

  try {
    const { rows:[p] } = await pool.query(
      `SELECT fragments,referral_reward_issued
         FROM players WHERE tg_id=$1`,
      [tg_id]
    );

    if (p.referral_reward_issued)
      return res.status(400).json({ error:'Reward already claimed' });

    const { rows:[{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM referrals
         WHERE referrer_id=$1 AND status='confirmed'`,
      [tg_id]
    );
    if (Number(count) < 3)
      return res.status(400).json({ error:'Not enough invited users' });

    const owned      = p.fragments || [];
    const available  = FRAGS.filter(f => !owned.includes(f));
    const pick       = available.length
                       ? available[crypto.randomInt(available.length)]
                       : null;

    await pool.query(
      `UPDATE players
         SET fragments = CASE
                           WHEN $2 IS NULL THEN fragments
                           ELSE array_append(fragments,$2)
                         END,
             referral_reward_issued = TRUE
       WHERE tg_id=$1`,
      [tg_id, pick]
    );

    res.setHeader('Authorization',`Bearer ${sign(req.user)}`);
    res.json({ ok:true, fragment: pick });

  } catch (e) {
    console.error('[referral claim] ', e);
    res.status(500).json({ error:'internal error' });
  }
});

/* ► DELETE profile */
router.delete('/player/:tg_id', async (req,res)=>{
  if(String(req.user.tg_id)!==req.params.tg_id)
    return res.status(403).json({ ok:false,error:'Forbidden' });

  try {
    await pool.query('DELETE FROM players WHERE tg_id=$1',[req.params.tg_id]);
    await pool.query('DELETE FROM burn_invoices WHERE tg_id=$1',[req.params.tg_id]);
    await pool.query(
      `DELETE FROM referrals
        WHERE referrer_id=$1 OR referred_id=$1`,
      [req.params.tg_id]
    );
    res.json({ ok:true });
  } catch (e) {
    console.error('[delete] ', e);
    res.status(500).json({ ok:false,error:'internal error' });
  }
});

/* ► фрагменты, статистика, burn-invoice, burn-status, runBurnLogic
     ───────── ВАШ ИСХОДНЫЙ КОД БЕЗ ИЗМЕНЕНИЙ ───────── */

router.get('/fragments/:tg_id', async (req,res)=>{/* unchanged */});
router.get('/stats/total_users', async (req,res)=>{/* unchanged */});
router.post('/burn-invoice', async (req,res)=>{/* unchanged */});
router.get('/burn-status/:invoiceId?', async (req,res)=>{/* unchanged */});

/* ——— runBurnLogic ——— */
async function runBurnLogic(invoiceId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* 1. выбираем счёт — только paid и ещё не processed */
    const { rows:[inv] } = await client.query(
      `SELECT tg_id, processed
         FROM burn_invoices
        WHERE invoice_id=$1
          AND status='paid'
        FOR UPDATE`,
      [invoiceId]
    );
    if (!inv || inv.processed) {            // счёт уже обработан
      await client.query('ROLLBACK');
      return { newFragment: null, cursed: false, curse_expires: null };
    }

    /* 2. выбираем игрока и решаем, какой фрагмент дать */
    const { rows:[pl] } = await client.query(
      `SELECT fragments FROM players WHERE tg_id=$1 FOR UPDATE`,
      [inv.tg_id]
    );
    const owned      = pl.fragments || [];
    const available  = FRAGS.filter(f => !owned.includes(f));
    const pick       = available.length
                       ? available[crypto.randomInt(available.length)]
                       : null;

    /* 3. обновляем игрока и помечаем счёт processed */
    await client.query(
      `UPDATE players
         SET fragments = CASE
                           WHEN $2 IS NULL THEN fragments
                           ELSE array_append(fragments,$2)
                         END,
             last_burn = NOW()
       WHERE tg_id=$1`,
      [inv.tg_id, pick]
    );

    await client.query(
      `UPDATE burn_invoices
          SET processed = TRUE
        WHERE invoice_id=$1`,
      [invoiceId]
    );

    await client.query('COMMIT');
    return { newFragment: pick, cursed: false, curse_expires: null };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[runBurnLogic] ', e);
    throw e;
  } finally {
    client.release();
  }
}
/* ────────────────────────────────────────────────────────────────── */
async function generateUniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = randomRefCode();
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE ref_code=$1 LIMIT 1`, [code]);
    if (!rows.length) return code;
  }
  /* крайне маловероятная коллизия × 8 → даём более длинный код */
  return crypto.randomBytes(8).toString('base64url');
}

export default router;
