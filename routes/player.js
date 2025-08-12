import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const {
  JWT_SECRET,
  TON_WALLET_ADDRESS: TON_ADDR,
  DEBUG_KEY,
  NODE_ENV,
} = process.env;

// \-\-\-\- Constants ---------------------------------------------------------
const TONHUB_URL = 'https://tonhub.com/transfer';
const TONSPACE_SCHEME = 'ton://transfer';
const AMOUNT_NANO = 500_000_000; // 0.5 TON

const MANDATORY = [1, 2, 3];        // бесплатные/обязательные
const PAID_POOL  = [4, 5, 6, 7, 8];  // платные фрагменты

const MAX_CURSES   = 2;    // лимит проклятий
const CURSE_CHANCE = 0.35; // базовый шанс проклятия (дальше можно модифицировать pity)

// \-\-\-\- Helpers -----------------------------------------------------------
function sign(user) {
  return jwt.sign({ tg_id: user.tg_id, name: user.name }, JWT_SECRET, { expiresIn: '1h' });
}

async function genUniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = crypto.randomBytes(6).toString('base64url');
    const { rows } = await pool.query(`SELECT 1 FROM players WHERE ref_code=$1 LIMIT 1`, [code]);
    if (!rows.length) return code;
  }
  return crypto.randomBytes(6).toString('base64url');
}

// \-\-\-\- Core burn logic ---------------------------------------------------
/**
 * runBurnLogic(invoiceId)
 * 1) гарантии: до #1–#3 проклятия не даём; первые ДВА платных сжигания — всегда фрагмент
 * 2) лимит проклятий: MAX_CURSES
 * 3) выдаём случайный недостающий фрагмент из PAID_POOL
 */
async function runBurnLogic(invoiceId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) invoice lock
    const { rows: [inv] } = await client.query(
      `SELECT tg_id, processed
         FROM burn_invoices
        WHERE invoice_id=$1 AND status='paid'
        FOR UPDATE`,
      [invoiceId]
    );
    if (!inv || inv.processed) {
      await client.query('ROLLBACK');
      return { newFragment: null, cursed: false, pity_counter: null, curse_expires: null };
    }

    // 2) player lock
    const { rows: [pl] } = await client.query(
      `SELECT fragments, curses_count, pity_counter
         FROM players
        WHERE tg_id=$1
        FOR UPDATE`,
      [inv.tg_id]
    );
    const fr = Array.isArray(pl?.fragments) ? pl.fragments.map(Number) : [];
    let cursesCount = Number(pl?.curses_count || 0);
    let pity        = Number(pl?.pity_counter || 0);

    const hasTutorial  = MANDATORY.every(x => fr.includes(x));
    const paidOwned    = fr.filter(n => n >= 4).length; // сколько платных уже есть
    const guaranteeTwo = hasTutorial && paidOwned < 2;  // первые 2 платных — всегда фрагмент
    const canCurseMore = cursesCount < MAX_CURSES;

    // 3) решить: порча или фрагмент
    let giveCurse = false;
    if (!hasTutorial) {
      giveCurse = false; // до #1–#3 — никогда не проклинаем
    } else if (guaranteeTwo) {
      giveCurse = false; // первые два платных — гарантированный фрагмент
    } else if (canCurseMore) {
      giveCurse = Math.random() < CURSE_CHANCE; // RNG (можно модифицировать pity)
    } else {
      giveCurse = false; // лимит исчерпан
    }

    if (giveCurse) {
      cursesCount += 1;
      const expiry = new Date(Date.now() + 24 * 3600 * 1000);
      await client.query(
        `UPDATE players
           SET curses_count  = $2,
               is_cursed     = TRUE,
               curse_expires = $3,
               last_burn     = NOW(),
               pity_counter  = $4
         WHERE tg_id=$1`,
        [inv.tg_id, cursesCount, expiry, pity + 1]
      );
      await client.query(`UPDATE burn_invoices SET processed=TRUE WHERE invoice_id=$1`, [invoiceId]);
      await client.query('COMMIT');
      return { newFragment: null, cursed: true, pity_counter: pity + 1, curse_expires: expiry.toISOString() };
    }

    // 4) выдаём фрагмент из PAID_POOL
    const remaining = PAID_POOL.filter(id => !fr.includes(id));
    const pick = remaining.length ? remaining[crypto.randomInt(remaining.length)] : null;

    if (pick !== null) {
      await client.query(
        `UPDATE players
           SET fragments     = array_append(coalesce(fragments,'{}'::int[]), $2),
               last_burn     = NOW(),
               pity_counter  = 0,
               is_cursed     = FALSE,
               curse_expires = NULL
         WHERE tg_id=$1`,
        [inv.tg_id, pick]
      );
      pity = 0;
    } else {
      // всё собрано — редкий случай: увеличим pity
      pity += 1;
      await client.query(
        `UPDATE players SET last_burn = NOW(), pity_counter = $2 WHERE tg_id=$1`,
        [inv.tg_id, pity]
      );
    }

    await client.query(`UPDATE burn_invoices SET processed=TRUE WHERE invoice_id=$1`, [invoiceId]);
    await client.query('COMMIT');
    return { newFragment: pick, cursed: false, pity_counter: pity, curse_expires: null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// \-\-\- Routes --------------------------------------------------------------
// 1) INIT — создаём игрока и дарим фрагмент #1
router.post('/init', async (req, res) => {
  const { tg_id, name = '', initData, referrer_code = null } = req.body;
  if (!tg_id || !initData) return res.status(400).json({ error: 'tg_id and initData required' });
  try {
    const { rows } = await pool.query(`SELECT 1 FROM players WHERE tg_id=$1`, [tg_id]);
    let player;
    if (!rows.length) {
      const client = await pool.connect();
      await client.query('BEGIN');
      try {
        const code = await genUniqueCode();
        const { rows: [me] } = await client.query(
          `INSERT INTO players
             (tg_id, name, ref_code, referral_reward_issued, fragments)
           VALUES($1,$2,$3,FALSE, ARRAY[1])
           RETURNING *`,
          [tg_id, name.trim() || null, code]
        );
        player = me;
        if (referrer_code) {
          const { rows: [ref] } = await client.query(
            `SELECT tg_id FROM players WHERE ref_code=$1 LIMIT 1`,
            [referrer_code.trim()]
          );
          if (ref) {
            await client.query(
              `INSERT INTO referrals(referrer_id,referred_id,status)
               VALUES($1,$2,'confirmed')`,
              [ref.tg_id, tg_id]
            );
          }
        }
        await client.query(`UPDATE global_stats SET value=value+1 WHERE id='total_users'`);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } else {
      const { rows: [me] } = await pool.query(`SELECT * FROM players WHERE tg_id=$1`, [tg_id]);
      player = me;
    }
    const token = sign(player);
    res.json({ user: player, token });
  } catch (err) {
    console.error('[POST /api/init] ERROR:', err);
    res.status(500).json({ error: 'internal' });
  }
});

// 2) GET /api/player/:tg_id
router.get('/player/:tg_id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tg_id,name,fragments,last_burn,curses_count,pity_counter,is_cursed,curse_expires
         FROM players WHERE tg_id=$1`,
      [req.params.tg_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'internal' });
  }
});

// auth required after this
router.use(authenticate);

// 3) GET /api/fragments/:tg_id
router.get('/fragments/:tg_id', async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(`SELECT fragments FROM players WHERE tg_id=$1`, [req.params.tg_id]);
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json({ fragments: p.fragments || [] });
  } catch (err) {
    res.status(500).json({ error: 'internal' });
  }
});

/** 4) POST /api/burn-invoice — создаём счёт + мини-квест
 *   Блокируем, если у игрока нет #1–#3
 */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) return res.status(400).json({ error: 'tg_id required' });
  try {
    const { rows: [pp] } = await pool.query(`SELECT fragments, pity_counter FROM players WHERE tg_id=$1`, [tg_id]);
    const fr = Array.isArray(pp?.fragments) ? pp.fragments.map(Number) : [];
    const pity = Number(pp?.pity_counter || 0);

    const hasMandatory = MANDATORY.every(id => fr.includes(id));
    if (!hasMandatory) {
      return res.status(403).json({ error: 'need_fragments_1_2_3' });
    }

    const invoiceId = uuid();
    const comment   = crypto.randomBytes(4).toString('hex');

    // pity → вес редкости
    const boost = Math.min(pity, 20);
    const weights = { legendary: 5, rare: 15 + boost, uncommon: 30 };
    weights.common = Math.max(0, 100 - (weights.legendary + weights.rare + weights.uncommon));

    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let rarity = 'common';
    for (const [k, w] of Object.entries(weights)) { if (r < w) { rarity = k; break; } r -= w; }

    const quizzes = {
      common:    { question: 'Какой элемент ассоциируется с огнём?', options: ['Water','Earth','Fire','Air'], answer: 'Fire' },
      uncommon:  { question: 'Синоним слова "burn"?',               options: ['Freeze','Scorch','Flow','Sink'], answer: 'Scorch' },
      rare:      { question: 'Что потребляет кислород и даёт тепло?', options: ['Ice','Fire'], answer: 'Fire' },
      legendary: { question: 'Введите слово "Fire" точно:',         options: [], answer: 'Fire' },
    };
    const task = { type: 'quiz', rarity, params: quizzes[rarity] };

    await pool.query(
      `INSERT INTO burn_invoices
         (invoice_id,tg_id,amount_nano,address,comment,status,quest_data,quest_status,created_at,processed)
       VALUES($1,$2,$3,$4,$5,'pending',$6,'pending',NOW(),FALSE)`,
      [invoiceId, tg_id, AMOUNT_NANO, TON_ADDR, comment, task]
    );

    return res.json({
      invoiceId,
      paymentUrl:  `${TONHUB_URL}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`,
      tonspaceUrl: `${TONSPACE_SCHEME}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`,
      task,
    });
  } catch (err) {
    console.error('[POST /api/burn-invoice] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

// 5) GET /api/burn-status/:invoiceId — после оплаты отдаём квест
router.get('/burn-status/:invoiceId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { rows: [inv] } = await pool.query(
      `SELECT status, quest_data FROM burn_invoices WHERE invoice_id=$1`,
      [req.params.invoiceId]
    );
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (inv.status !== 'paid') return res.json({ paid: false });
    return res.json({ paid: true, task: inv.quest_data || null });
  } catch (err) {
    return res.status(500).json({ error: 'internal' });
  }
});

// 6) POST /api/burn-complete/:invoiceId — результат мини-квеста
router.post('/burn-complete/:invoiceId', async (req, res) => {
  const { success } = req.body;
  if (typeof success !== 'boolean') {
    return res.status(400).json({ error: 'success boolean required' });
  }
  try {
    if (!success) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [inv] } = await client.query(
          `SELECT tg_id FROM burn_invoices WHERE invoice_id=$1 FOR UPDATE`,
          [req.params.invoiceId]
        );
        if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'invoice not found' }); }
        const { rows: [pl] } = await client.query(
          `SELECT pity_counter FROM players WHERE tg_id=$1 FOR UPDATE`,
          [inv.tg_id]
        );
        const newPity = Number(pl?.pity_counter || 0) + 1;
        await client.query(`UPDATE players SET pity_counter=$2 WHERE tg_id=$1`, [inv.tg_id, newPity]);
        await client.query(`UPDATE burn_invoices SET quest_status='failed' WHERE invoice_id=$1`, [req.params.invoiceId]);
        await client.query('COMMIT');
        return res.json({ ok: false, pity_counter: newPity });
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }

    const result = await runBurnLogic(req.params.invoiceId);
    try { await pool.query(`UPDATE burn_invoices SET quest_status='success' WHERE invoice_id=$1`, [req.params.invoiceId]); } catch {}
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[POST /api/burn-complete] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

// 7) Referral
router.get('/referral', async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT ref_code, referral_reward_issued FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    if (!p) return res.status(404).json({ error: 'not found' });
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM referrals WHERE referrer_id=$1 AND status='confirmed'`,
      [req.user.tg_id]
    );
    res.setHeader('Authorization', `Bearer ${sign(req.user)}`);
    return res.json({ refCode: p.ref_code, invitedCount: Number(c.cnt), rewardIssued: p.referral_reward_issued });
  } catch (err) {
    return res.status(500).json({ error: 'internal' });
  }
});

router.post('/referral/claim', async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT fragments, referral_reward_issued FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.referral_reward_issued) return res.status(400).json({ error: 'already claimed' });

    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM referrals WHERE referrer_id=$1 AND status='confirmed'`,
      [req.user.tg_id]
    );
    if (Number(c.cnt) < 3) return res.status(400).json({ error: 'not enough invited' });

    await pool.query(
      `UPDATE players
         SET fragments = array_cat(coalesce(fragments,'{}'::int[]), ARRAY[2]),
             referral_reward_issued = TRUE
       WHERE tg_id=$1`,
      [req.user.tg_id]
    );

    res.setHeader('Authorization', `Bearer ${sign(req.user)}`);
    return res.json({ ok: true, awarded: [2] });
  } catch (err) {
    return res.status(500).json({ error: 'internal' });
  }
});

// 8) Third fragment quest
router.get('/third-quest', async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(`SELECT fragments FROM players WHERE tg_id=$1`, [req.user.tg_id]);
    const owned = Array.isArray(p?.fragments) ? p.fragments : [];
    if (owned.includes(3)) return res.json({ available: false });

    const task = { type: 'quiz', question: 'Choose the correct rune meaning for 🔥', options: ['Water', 'Ash', 'Flame', 'Stone'], answer: 'Flame' };
    return res.json({ available: true, task });
  } catch (err) {
    console.error('[GET /third-quest] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

router.post('/third-claim', async (req, res) => {
  try {
    const { answer } = req.body || {};
    const { rows: [p] } = await pool.query(`SELECT fragments FROM players WHERE tg_id=$1`, [req.user.tg_id]);
    const owned = Array.isArray(p?.fragments) ? p.fragments : [];
    if (owned.includes(3)) return res.json({ ok: true, awarded: [] });

    const correct = (answer === 'Flame');
    if (!correct) return res.status(400).json({ error: 'wrong_answer' });

    await pool.query(
      `UPDATE players SET fragments = array_append(coalesce(fragments,'{}'::int[]), 3) WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    return res.json({ ok: true, awarded: [3] });
  } catch (err) {
    console.error('[POST /third-claim] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

// 9) Leaderboard / Delete / Stats / Daily quest (unchanged semantics)
router.get('/leaderboard', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.tg_id, p.name,
             COUNT(b.invoice_id)         AS total_burns,
             SUM(b.amount_nano)::bigint  AS total_ton_nano
        FROM players p
        JOIN burn_invoices b ON b.tg_id = p.tg_id
       WHERE b.status = 'paid'
       GROUP BY p.tg_id, p.name
       ORDER BY total_ton_nano DESC
       LIMIT 10
    `);
    const result = rows.map(r => ({ tg_id: r.tg_id, name: r.name, totalBurns: Number(r.total_burns), totalTon: Number(r.total_ton_nano) / 1e9 }));
    res.json(result);
  } catch (err) {
    console.error('[GET /api/leaderboard] ERROR:', err);
    res.status(500).json({ error: 'internal' });
  }
});

router.delete('/player/:tg_id', async (req, res) => {
  if (String(req.user.tg_id) !== req.params.tg_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM referrals WHERE referrer_id = $1 OR referred_id = $1`, [req.user.tg_id]);
    await client.query(`DELETE FROM burn_invoices WHERE tg_id = $1`, [req.user.tg_id]);
    await client.query(`DELETE FROM players WHERE tg_id = $1`, [req.user.tg_id]);
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DELETE /api/player] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  } finally {
    client.release();
  }
});

router.get('/stats/:tg_id', authenticate, async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(
      `SELECT COUNT(b.invoice_id) AS total_burns, COALESCE(SUM(b.amount_nano), 0) AS total_ton_nano
         FROM burn_invoices b
        WHERE b.tg_id = $1 AND b.status = 'paid'`,
      [req.params.tg_id]
    );
    return res.json({ totalBurns: Number(stats.total_burns), totalTon: Number(stats.total_ton_nano) / 1e9 });
  } catch (err) {
    console.error('[GET /api/stats] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

router.get('/daily-quest', authenticate, async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT last_daily_claim, daily_coupon_percent FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    if (!p) return res.status(404).json({ error: 'player not found' });
    const today = new Date().toISOString().split('T')[0];
    const canClaim = p.last_daily_claim !== today;
    return res.json({ canClaim, coupon: p.daily_coupon_percent });
  } catch (err) {
    console.error('[GET /daily-quest] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

router.post('/daily-quest/claim', authenticate, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows: [p] } = await pool.query(`SELECT last_daily_claim FROM players WHERE tg_id=$1`, [req.user.tg_id]);
    if (!p) return res.status(404).json({ error: 'player not found' });
    if (p.last_daily_claim === today) return res.status(400).json({ error: 'Already claimed today' });

    const couponPercent = 30;
    await pool.query(`UPDATE players SET last_daily_claim=$2, daily_coupon_percent=$3 WHERE tg_id=$1`, [req.user.tg_id, today, couponPercent]);
    return res.json({ coupon: couponPercent });
  } catch (err) {
    console.error('[POST /daily-quest/claim] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

// 10) Debug endpoints
router.post('/debug/grant-fragments', async (req, res) => {
  try {
    if (NODE_ENV === 'production' && (!DEBUG_KEY || req.headers['x-debug-key'] !== DEBUG_KEY)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const want = Array.isArray(req.body?.fragments) ? req.body.fragments.map(Number) : [];
    if (!want.length) return res.status(400).json({ error: 'fragments array required' });

    const { rows: [p] } = await pool.query(`SELECT fragments FROM players WHERE tg_id=$1`, [req.user.tg_id]);
    const owned = Array.isArray(p?.fragments) ? p.fragments : [];
    const set = new Set(owned);
    want.forEach(x => set.add(x));
    const merged = Array.from(set).sort((a, b) => a - b);

    const setReferral = want.includes(2);

    await pool.query(
      `UPDATE players
          SET fragments=$2, referral_reward_issued = CASE WHEN $3 THEN TRUE ELSE referral_reward_issued END
        WHERE tg_id=$1`,
      [req.user.tg_id, merged, setReferral]
    );
    return res.json({ ok: true, fragments: merged });
  } catch (err) {
    console.error('[POST /debug/grant-fragments] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

export default router;
