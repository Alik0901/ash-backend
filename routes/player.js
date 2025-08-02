// файл: src/routes/player.js
import express from 'express';
import crypto  from 'crypto';
import jwt     from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import pool    from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const {
  JWT_SECRET,
  TON_WALLET_ADDRESS: TON_ADDR,
  FRAG_HMAC_SECRET,
} = process.env;

// Адреса и суммы для burn
const TONHUB_URL      = 'https://tonhub.com/transfer';
const TONSPACE_SCHEME = 'ton://transfer';
const AMOUNT_NANO     = 500_000_000; // 0.5 TON in nano

// Полный пул фрагментов
const FRAGS = [1,2,3,4,5,6,7,8];

// Категории и базовые шансы
const CATEGORIES = {
  common:    { ids: [1,2,3], baseChance: 50 },
  uncommon:  { ids: [4,5],    baseChance: 30 },
  rare:      { ids: [6,7],    baseChance: 15 },
  legendary: { ids: [8],      baseChance: 5  },
};
const PITY_BOOST_PER = 1;  // +1% за каждый неудачный burn
const PITY_CAP        = 20; // максимум +20%

/** Генерация JWT для API */
function sign(user) {
  return jwt.sign(
    { tg_id: user.tg_id, name: user.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/** Генерация псевдослучайного referral-кода */
function randRef() {
  return crypto.randomBytes(6).toString('base64url');
}
async function genUniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = randRef();
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE ref_code = $1 LIMIT 1`,
      [code]
    );
    if (!rows.length) return code;
  }
  return randRef();
}

/**
 * Основная логика "burn" с учётом проклятий и динамических шансов
 * @param {string} invoiceId
 * @returns {{newFragment: number|null, category: string, pity_counter: number}}
 */
async function runBurnLogic(invoiceId) {
  const client = await pool.connect();
  try {
    console.log('[runBurnLogic] start for invoiceId:', invoiceId);
    await client.query('BEGIN');

    // 1) Блокируем и проверяем burn_invoice
    const { rows: [inv] } = await client.query(
      `SELECT tg_id, processed
         FROM burn_invoices
        WHERE invoice_id = $1
          AND status = 'paid'
        FOR UPDATE`,
      [invoiceId]
    );
    if (!inv || inv.processed) {
      console.log('[runBurnLogic] invoice not found or already processed');
      await client.query('ROLLBACK');
      return { newFragment: null, category: null, pity_counter: null };
    }

    // 2) Блокируем игрока и читаем состояние
    const { rows: [pl] } = await client.query(
      `SELECT fragments, curses_count, pity_counter
         FROM players
        WHERE tg_id = $1
        FOR UPDATE`,
      [inv.tg_id]
    );
    const owned       = pl.fragments || [];
    const cursesCount = pl.curses_count || 0;
    const currentPity = pl.pity_counter || 0;
    console.log('[runBurnLogic] player state:', { owned, cursesCount, currentPity });

    // 3) Логика проклятий
    const mandatory = [1,2,3];
    const hasMandatory = mandatory.every(id => owned.includes(id));
    const CURSE_CHANCE = 1 / 3;
    if (hasMandatory && cursesCount < 3 && Math.random() < CURSE_CHANCE) {
      const expiry = new Date(Date.now() + 60 * 60 * 1000);
      console.log('[runBurnLogic] issuing curse');
      await client.query(
        `UPDATE players
            SET curses_count = curses_count + 1,
                is_cursed    = TRUE,
                curse_expires= $2,
                last_burn    = NOW()
          WHERE tg_id = $1`,
        [inv.tg_id, expiry]
      );
      await client.query(
        `UPDATE burn_invoices
            SET processed = TRUE
          WHERE invoice_id = $1`,
        [invoiceId]
      );
      await client.query('COMMIT');
      console.log('[runBurnLogic] curse committed');
      return { newFragment: null, category: 'curse', pity_counter: currentPity };
    }

    // 4) Вычисляем динамические шансы
    const boost = Math.min(currentPity * PITY_BOOST_PER, PITY_CAP);
    const baseR = CATEGORIES.rare.baseChance;
    const baseL = CATEGORIES.legendary.baseChance;
    const totalRL = baseR + baseL + boost;
    const totalU = CATEGORIES.uncommon.baseChance;
    const r = Math.random() * 100;
    let category;
    if (r < baseL) {
      category = 'legendary';
    } else if (r < baseL + baseR) {
      category = 'rare';
    } else if (r < totalRL) {
      const extra = r - (baseL + baseR);
      const legShare = baseL / (baseL + baseR);
      category = extra < boost * legShare ? 'legendary' : 'rare';
    } else if (r < totalRL + totalU) {
      category = 'uncommon';
    } else {
      category = 'common';
    }
    console.log('[runBurnLogic] roll result:', { r, category, boost });

    // 5) Выбираем конкретный фрагмент из категории
    const ids = CATEGORIES[category].ids.filter(id => !owned.includes(id));
    const pick = ids.length
      ? ids[crypto.randomInt(ids.length)]
      : null;
    console.log('[runBurnLogic] selected pick:', pick);

    // 6) Обновляем pity_counter and fragments
    const newPity = (category === 'rare' || category === 'legendary') ? 0 : currentPity + 1;
    await client.query(
      `UPDATE players
          SET fragments    = array_append(coalesce(fragments,'{}'::int[]), $2),
              last_burn     = NOW(),
              pity_counter  = $3
        WHERE tg_id = $1`,
      [inv.tg_id, pick, newPity]
    );

    // 7) Отмечаем инвойс как обработанный
    await client.query(
      `UPDATE burn_invoices
          SET processed = TRUE
        WHERE invoice_id = $1`,
      [invoiceId]
    );
    await client.query('COMMIT');
    console.log('[runBurnLogic] committed successfully');

    return { newFragment: pick, category, pity_counter: newPity };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[runBurnLogic] error:', err);
    throw err;
  } finally {
    client.release();
  }
}
// —————————————————————————————————————————————————————————————————————————
// 1) Публичные маршруты (до authenticate)
// —————————————————————————————————————————————————————————————————————————

/** POST /api/init */
router.post('/init', async (req, res) => {
  console.log('[POST /api/init] body:', req.body);
  const { tg_id, name = '', initData = '', referrer_code = null } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE tg_id = $1`,
      [tg_id]
    );
    let player;
    if (!rows.length) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const code = await genUniqueCode();
        const { rows: [me] } = await client.query(
          `INSERT INTO players
             (tg_id, name, ref_code, referral_reward_issued)
           VALUES($1, $2, $3, FALSE)
           RETURNING *`,
          [tg_id, name.trim() || null, code]
        );
        player = me;
        if (referrer_code) {
          const { rows: [ref] } = await client.query(
            `SELECT tg_id FROM players WHERE ref_code = $1 LIMIT 1`,
            [referrer_code.trim()]
          );
          if (ref) {
            await client.query(
              `INSERT INTO referrals
                 (referrer_id, referred_id, status)
               VALUES($1, $2, 'confirmed')`,
              [ref.tg_id, tg_id]
            );
          }
        }
        await client.query(
          `UPDATE global_stats SET value = value + 1 WHERE id = 'total_users'`
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('[POST /api/init] TX error:', e);
        throw e;
      } finally {
        client.release();
      }
    } else {
      const { rows: [me] } = await pool.query(
        `SELECT * FROM players WHERE tg_id = $1`,
        [tg_id]
      );
      player = me;
    }
    const token = sign(player);
    return res.json({ user: player, token });
  } catch (err) {
    console.error('[POST /api/init] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/** GET /api/player/:tg_id */
router.get('/player/:tg_id', async (req, res) => {
  console.log('[GET /api/player]', req.params.tg_id);
  try {
    const { rows } = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, curses_count, pity_counter
         FROM players
        WHERE tg_id = $1`,
      [req.params.tg_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('[GET /api/player] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

// Все последующие маршруты требуют JWT
router.use(authenticate);

/** GET /api/fragments/:tg_id */
router.get('/fragments/:tg_id', async (req, res) => {
  console.log('[GET /api/fragments]', req.params.tg_id);
  try {
    const { rows: [p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id = $1`,
      [req.params.tg_id]
    );
    if (!p) return res.status(404).json({ error: 'player not found' });
    return res.json({ fragments: p.fragments || [] });
  } catch (err) {
    console.error('[GET /api/fragments] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/** POST /api/burn-invoice */
router.post('/burn-invoice', async (req, res) => {
  console.log('[POST /api/burn-invoice]', req.body);
  const { tg_id } = req.body;
  if (!tg_id) return res.status(400).json({ error: 'tg_id required' });
  try {
    const invoiceId = uuid();
    const comment = crypto.randomBytes(4).toString('hex');
    await pool.query(
      `INSERT INTO burn_invoices
         (invoice_id, tg_id, amount_nano, address, comment, status, created_at)
       VALUES($1,$2,$3,$4,$5,'pending',NOW())`,
      [invoiceId, tg_id, AMOUNT_NANO, TON_ADDR, comment]
    );
    res.json({
      invoiceId,
      paymentUrl:  `${TONHUB_URL}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`,
      tonspaceUrl: `${TONSPACE_SCHEME}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`
    });
  } catch (err) {
    console.error('[POST /api/burn-invoice] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/** GET /api/burn-status/:invoiceId */
router.get('/burn-status/:invoiceId', async (req, res) => {
  res.set('Cache-Control','no-store');
  console.log('[GET /api/burn-status]', req.params.invoiceId);
  try {
    const { rows: [inv] } = await pool.query(
      `SELECT status FROM burn_invoices WHERE invoice_id = $1`,
      [req.params.invoiceId]
    );
    if (!inv) return res.status(404).json({ error: 'invoice not found' });
    if (inv.status !== 'paid') return res.json({ paid: false });
    const result = await runBurnLogic(req.params.invoiceId);
    return res.json({ paid: true, ...result });
  } catch (err) {
    console.error('[GET /api/burn-status] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/** GET /api/referral */
router.get('/referral', async (req, res) => {
  console.log('[GET /api/referral] user:', req.user.tg_id);
  try {
    const { rows: [p] } = await pool.query(
      `SELECT ref_code, referral_reward_issued FROM players WHERE tg_id = $1`,
      [req.user.tg_id]
    );
    if (!p) return res.status(404).json({ error: 'player not found' });
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM referrals WHERE referrer_id = $1 AND status = 'confirmed'`,
      [req.user.tg_id]
    );
    res.setHeader('Authorization', `Bearer ${sign(req.user)}`);
    return res.json({
      refCode: p.ref_code,
      invitedCount: Number(c.cnt),
      rewardIssued: p.referral_reward_issued
    });
  } catch (err) {
    console.error('[GET /api/referral] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/** POST /api/referral/claim */
router.post('/referral/claim', async (req, res) => {
  console.log('[POST /api/referral/claim] user:', req.user.tg_id);
  try {
    const { rows } = await pool.query(
      `SELECT fragments, referral_reward_issued FROM players WHERE tg_id = $1`,
      [req.user.tg_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'player not found' });
    const p = rows[0];
    if (p.referral_reward_issued) return res.status(400).json({ error: 'Reward already claimed' });
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM referrals WHERE referrer_id = $1 AND status = 'confirmed'`,
      [req.user.tg_id]
    );
    if (Number(c.cnt) < 3) return res.status(400).json({ error: 'Not enough invited users' });
    const owned = p.fragments || [];
    const available = FRAGS.filter(id => !owned.includes(id));
    const pick = available.length
      ? available[crypto.randomInt(available.length)]
      : null;
    await pool.query(
      `UPDATE players
          SET fragments = array_append(coalesce(fragments,'{}'::int[]), $2),
              referral_reward_issued = TRUE
        WHERE tg_id = $1`,
      [req.user.tg_id, pick]
    );
    res.setHeader('Authorization', `Bearer ${sign(req.user)}`);
    return res.json({ ok: true, fragment: pick });
  } catch (err) {
    console.error('[POST /api/referral/claim] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/leaderboard
 * Возвращает массив из 10 лучших игроков:
 * [{ tg_id, name, avatar_url, total_burns, total_ton }]
 */
router.get('/leaderboard', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.tg_id, p.name,
             COUNT(b.invoice_id)      AS total_burns,
             SUM(b.amount_nano)::bigint AS total_ton_nano
        FROM players p
        JOIN burn_invoices b ON b.tg_id = p.tg_id
       WHERE b.status = 'paid'
       GROUP BY p.tg_id, p.name
       ORDER BY total_ton_nano DESC
       LIMIT 10
    `);
    // преобразуем nano → TON
    const result = rows.map(r => ({
      tg_id: r.tg_id,
      name: r.name,
      totalBurns: Number(r.total_burns),
      totalTon:   Number(r.total_ton_nano) / 1e9,
    }));
    res.json(result);
  } catch (err) {
    console.error('[GET /api/leaderboard] ERROR:', err);
    res.status(500).json({ error: 'internal' });
  }
});

/** DELETE /api/player/:tg_id */
router.delete('/player/:tg_id', async (req, res) => {
  console.log('[DELETE /api/player] user:', req.user.tg_id, 'target:', req.params.tg_id);
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

export default router;
