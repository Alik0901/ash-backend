// routes/player.js
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
  AUTO_PAY_BURN,        // dev/stage helper: auto-mark invoice as "paid"
  FRAG_HMAC_SECRET,     // used to sign riddles/runes asset URLs
} = process.env;

/* ── Constants ────────────────────────────────────────────────────────── */

/** External payment URI schemes */
const TONHUB_URL = 'https://tonhub.com/transfer';
const TONSPACE_SCHEME = 'ton://transfer';

/** Default burn amount (0.5 TON = 500_000_000 nano) */
const AMOUNT_NANO = 500_000_000;

/** Fragments */
const MANDATORY = [1, 2, 3];       // free/mandatory ones
const PAID_POOL  = [4, 5, 6, 7, 8]; // paid fragments

/** Curses */
const MAX_CURSES   = 2;     // max curses applied to a player
const CURSE_CHANCE = 0.35;  // base chance once guarantees are over

/** Signed asset TTLs */
const RIDDLE_URL_TTL_SEC = 120; // 2 min
const RUNE_URL_TTL_SEC   = 300; // 5 min

/** Rune pairs per fragment (two choices) */
const RUNE_PAIRS = {
  1: [101, 102],
  2: [201, 202],
  3: [301, 302],
  4: [401, 402],
  5: [501, 502],
  6: [601, 602],
  7: [701, 702],
  8: [801, 802],
};

/** Rune id -> asset name (in /public/runes) */
const RUNE_ASSETS = {
  101: 'rune_1a.png', 102: 'rune_1b.png',
  201: 'rune_2a.png', 202: 'rune_2b.png',
  301: 'rune_3a.png', 302: 'rune_3b.png',
  401: 'rune_4a.png', 402: 'rune_4b.png',
  501: 'rune_5a.png', 502: 'rune_5b.png',
  601: 'rune_6a.png', 602: 'rune_6b.png',
  701: 'rune_7a.png', 702: 'rune_7b.png',
  801: 'rune_8a.png', 802: 'rune_8b.png',
};

/** Riddle bank: key = file name in /public/riddles, answer = number 0..99 */
const RIDDLE_BANK = [
  { key: 'riddle_01.png', answer: 48 },
  { key: 'riddle_02.png', answer: 20 },
  { key: 'riddle_03.png', answer: 30 },
  { key: 'riddle_04.png', answer: 60 },
  { key: 'riddle_05.png', answer: 10 },
  { key: 'riddle_06.png', answer: 35 },
  { key: 'riddle_07.png', answer: 50 },
  { key: 'riddle_08.png', answer: 48 },
];

/* ── Small helpers ────────────────────────────────────────────────────── */

/** Issue a short-lived JWT token for the user. */
function sign(user) {
  return jwt.sign({ tg_id: user.tg_id, name: user.name }, JWT_SECRET, { expiresIn: '1h' });
}

/** Generate a unique referral code (best-effort with a few retries). */
async function genUniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = crypto.randomBytes(6).toString('base64url');
    const { rows } = await pool.query(`SELECT 1 FROM players WHERE ref_code=$1 LIMIT 1`, [code]);
    if (!rows.length) return code;
  }
  return crypto.randomBytes(6).toString('base64url');
}

/**
 * Sign asset URL (riddles/runes) with HMAC; dev fallback returns plain URL.
 * @param {string} prefix e.g. '/riddles' or '/runes'
 * @param {string} name   file name inside /public/<folder>
 * @param {number} ttlSec seconds until link expires
 */
function signAssetUrl(prefix, name, ttlSec = RIDDLE_URL_TTL_SEC) {
  if (!FRAG_HMAC_SECRET) {
    // Dev: return a plain, non-expiring URL.
    return `${prefix}/${encodeURIComponent(name)}`;
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${name}|${exp}`;
  const sig = crypto.createHmac('sha256', FRAG_HMAC_SECRET).update(payload).digest('hex');
  return `${prefix}/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`;
}

/** In-place Fisher–Yates shuffle using crypto.randomInt. */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function abs(req, path) {
  const host  = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${host}${path}`;
}

/** Build a 4x4 grid of unique numbers (0..99) with a guaranteed correct value. */
function makeGridNumbers(correctNum, bannedCells = []) {
  const set = new Set([correctNum]);
  while (set.size < 16) {
    const n = crypto.randomInt(100);
    if (!set.has(n)) set.add(n);
  }
  const arr = Array.from(set);
  shuffleInPlace(arr);
  let correctCell = arr.findIndex((n) => n === correctNum);

  // Если “правильная” ячейка уже встречалась у этого игрока — переносим её.
  if (Array.isArray(bannedCells) && bannedCells.includes(correctCell)) {
    const all = Array.from({ length: 16 }, (_, i) => i);
    const allowed = all.filter((i) => !bannedCells.includes(i));
    if (allowed.length) {
      const newIdx = crypto.randomInt(allowed.length);
      const target = allowed[newIdx];
      // Меняем местами correctNum и число из target-ячейки
      const tmp = arr[target];
      arr[target] = correctNum;
      arr[correctCell] = tmp;
      correctCell = target;
    }
  }
  return { arr, correctCell };
}

  function sanitizeTaskForClient(task) {
    if (!task || task.type !== 'quiz') return task;
    const { rarity } = task;
    const q = task.params || {};
    return {
      type: 'quiz',
      rarity,
      params: {
        question: q.question || '',
        options: Array.isArray(q.options) ? q.options : [],
        // ВАЖНО: без answer
      },
    };
  }


/**
 * Ensure a personal cipher exists for (tg_id, frag_id). No-op if already present.
 * Stores: 4x4 grid, correct number and cell, and the riddle key.
 */
async function ensureCipherForFragment(clientOrPool, tgId, fragId) {
  const db = clientOrPool || pool;

  const { rows: existing } = await db.query(
    `SELECT tg_id FROM fragment_ciphers WHERE tg_id=$1 AND frag_id=$2 LIMIT 1`,
    [tgId, fragId]
  );
  if (existing.length) return;

  const { rows: usedRows } = await db.query(
    `SELECT correct_cell FROM fragment_ciphers WHERE tg_id=$1`,
    [tgId]
  );
  const banned = usedRows
    .map(r => Number(r.correct_cell))
    .filter(n => Number.isFinite(n));

  const ridx = crypto.randomInt(RIDDLE_BANK.length);
  const riddle = RIDDLE_BANK[ridx];
  const { arr: grid, correctCell } = makeGridNumbers(riddle.answer, banned);

  await db.query(
    `INSERT INTO fragment_ciphers
       (tg_id, frag_id, grid_numbers, correct_num, correct_cell, riddle_key)
     VALUES ($1,$2,$3::int[],$4,$5,$6)`,
    [tgId, fragId, grid, riddle.answer, correctCell, riddle.key]
  );
}

/* ── Burn core logic ─────────────────────────────────────────────────── */

/**
 * Transactional burn resolution for a PAID invoice.
 *
 * Rules:
 *  1) No curses before fragments #1–#3 are owned; first two paid burns always grant a fragment.
 *  2) Up to MAX_CURSES curses in total.
 *  3) Otherwise pick a random missing fragment from PAID_POOL.
 *
 * Persists result into burn_invoices.result_json (idempotent).
 * @returns {Promise<{ok: boolean, newFragment: number|null, cursed: boolean, pity_counter: number, curse_expires: string|null, awarded_rarity: string|null }>}
 */
async function runBurnLogic(invoiceId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock invoice
    const { rows: [inv] } = await client.query(
      `SELECT tg_id, processed, quest_data, result_json
         FROM burn_invoices
        WHERE invoice_id=$1 AND status='paid'
        FOR UPDATE`,
      [invoiceId]
    );
    if (!inv) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'invoice_not_found' };
    }
    if (inv.processed) {
      await client.query('ROLLBACK');
      // Return previously saved result to keep idempotency.
      return inv.result_json || { ok: true, newFragment: null, cursed: false, pity_counter: null, curse_expires: null };
    }

    // Lock player
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
    const paidOwned    = fr.filter(n => n >= 4).length;
    const guaranteeTwo = hasTutorial && paidOwned < 2;
    const canCurseMore = cursesCount < MAX_CURSES;

    // Decide: curse or fragment
    let giveCurse = false;
    if (!hasTutorial) {
      giveCurse = false;
    } else if (guaranteeTwo) {
      giveCurse = false;
    } else if (canCurseMore) {
      giveCurse = (crypto.randomInt(1_000_000) / 1_000_000) < CURSE_CHANCE;
    }

    if (giveCurse) {
      cursesCount += 1;
      const expiry = new Date(Date.now() + 24 * 3600 * 1000);
      const newPity = pity + 1;

      await client.query(
        `UPDATE players
           SET curses_count  = $2,
               is_cursed     = TRUE,
               curse_expires = $3,
               last_burn     = NOW(),
               pity_counter  = $4
         WHERE tg_id=$1`,
        [inv.tg_id, cursesCount, expiry, newPity]
      );

      const result = {
        ok: true,
        newFragment: null,
        cursed: true,
        pity_counter: newPity,
        curse_expires: expiry.toISOString(),
        awarded_rarity: null,
      };

      await client.query(
        `UPDATE burn_invoices
            SET processed=TRUE,
                quest_status='success',
                result_json=$2
          WHERE invoice_id=$1`,
        [invoiceId, result]
      );

      await client.query('COMMIT');
      return result;
    }

    // Grant a fragment from the paid pool
    const remaining = PAID_POOL.filter(id => !fr.includes(id));
    const pick = remaining.length ? remaining[crypto.randomInt(remaining.length)] : null;

    let awarded_rarity = inv?.quest_data?.rarity ?? null;

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

      try { await ensureCipherForFragment(client, inv.tg_id, pick); } catch {}
      pity = 0;
    } else {
      // All collected — rare case
      pity += 1;
      await client.query(
        `UPDATE players SET last_burn = NOW(), pity_counter = $2 WHERE tg_id=$1`,
        [inv.tg_id, pity]
      );
      awarded_rarity = null;
    }

    const result = {
      ok: true,
      newFragment: pick,
      cursed: false,
      pity_counter: pity,
      curse_expires: null,
      awarded_rarity,
    };

    await client.query(
      `UPDATE burn_invoices
          SET processed=TRUE,
              quest_status='success',
              awarded_rarity=$2,
              result_json=$3
        WHERE invoice_id=$1`,
      [invoiceId, awarded_rarity, result]
    );

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ── Routes ───────────────────────────────────────────────────────────── */

/**
 * POST /api/init
 * Create (or fetch) a player, gift fragment #1, handle referral, and return JWT.
 */
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

        try { await ensureCipherForFragment(client, tg_id, 1); } catch {}

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

/**
 * GET /api/player/:tg_id
 * Fetch current player public fields. Requires auth; user must match tg_id.
 */
router.get('/player/:tg_id', authenticate, async (req, res) => {
  try {
    if (String(req.user.tg_id) !== String(req.params.tg_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
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

/** Everything below requires auth. */
router.use(authenticate);

/**
 * GET /api/cipher/all
 * Returns { byFragment: { [fragId]: { runeId, answered } }, urls?: { [runeId]: url } }
 * If ?includeUrls=1, pre-sign and include rune URLs for known runeIds.
 */
router.get('/cipher/all', async (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try {
    const { rows } = await pool.query(  
      `SELECT frag_id, chosen_rune_id, answered_at
         FROM fragment_ciphers
        WHERE tg_id=$1`,
      [res.req.user.tg_id]
    );

    const byFragment = {};
    const runeIds = new Set();

    for (const r of rows) {
      const fragId = Number(r.frag_id);
      const runeId = r.chosen_rune_id ? Number(r.chosen_rune_id) : null;
      byFragment[fragId] = { runeId, answered: !!r.answered_at };
      if (runeId) runeIds.add(runeId);
    }

    let urls;
    const include = String(res.req.query.includeUrls ?? '').toLowerCase();
    if (include === '1' || include === 'true') {
      urls = {};
      for (const id of runeIds) {
        const name = RUNE_ASSETS[id];
        if (!name) continue;
        urls[id] = abs(res.req, signAssetUrl('/runes', name, RUNE_URL_TTL_SEC));
      }
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    return res.json({ byFragment, urls });
  } catch (err) {
    console.error('[GET /api/cipher/all] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/cipher/:fragId
 * Returns 4x4 grid + riddle image URL (HMAC-signed).
 */
router.get('/cipher/:fragId', async (req, res) => {
  try {
    const fragId = Number(req.params.fragId);
    if (!Number.isFinite(fragId) || fragId < 1 || fragId > 8) {
      return res.status(400).json({ error: 'bad_frag_id' });
    }

    // Ownership check
    const { rows: [p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    const owned = Array.isArray(p?.fragments) ? p.fragments.map(Number) : [];
    if (!owned.includes(fragId)) return res.status(403).json({ error: 'fragment_not_owned' });

    // Ensure cipher exists
    await ensureCipherForFragment(pool, req.user.tg_id, fragId);

    const { rows } = await pool.query(
      `SELECT grid_numbers, riddle_key, chosen_rune_id, answered_at
         FROM fragment_ciphers
        WHERE tg_id=$1 AND frag_id=$2`,
      [req.user.tg_id, fragId]
    );
    if (!rows.length) return res.status(404).json({ error: 'cipher_not_found' });

    const row = rows[0];
    const url = abs(req, signAssetUrl('/riddles', row.riddle_key, RIDDLE_URL_TTL_SEC));

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    return res.json({
      fragId,
      riddle: { type: 'image', url, ttl: RIDDLE_URL_TTL_SEC },
      gridNumbers: row.grid_numbers,
      answered: !!row.answered_at,
      chosenRuneId: row.chosen_rune_id || null,
    });
  } catch (err) {
    console.error('[GET /api/cipher/:fragId] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/fragments/:tg_id
 * Returns the current list of player's fragments.
 */
router.get('/fragments/:tg_id', async (req, res) => {
  try {
    if (String(req.user.tg_id) !== String(req.params.tg_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows: [p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,
      [req.params.tg_id]
    );
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json({ fragments: p.fragments || [] });
  } catch (err) {
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/burn-invoice
 * Creates an invoice and a mini-quest payload. Optionally auto-marks as paid.
 */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body;

  if (!tg_id) return res.status(400).json({ error: 'tg_id required' });
  if (String(req.user.tg_id) !== String(tg_id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { rows: [pp] } = await pool.query(
      `SELECT fragments, pity_counter FROM players WHERE tg_id=$1`,
      [tg_id]
    );
    const fr = Array.isArray(pp?.fragments) ? pp.fragments.map(Number) : [];
    const pity = Number(pp?.pity_counter || 0);

    const hasMandatory = MANDATORY.every(id => fr.includes(id));
    if (!hasMandatory) return res.status(403).json({ error: 'need_fragments_1_2_3' });

    const invoiceId = uuid();
    const comment   = crypto.randomBytes(4).toString('hex');

    // pity -> rarity weights boost
    const boost = Math.min(pity, 20);
    const weights = { legendary: 5, rare: 15 + boost, uncommon: 30 };
    weights.common = Math.max(0, 100 - (weights.legendary + weights.rare + weights.uncommon));

    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = (crypto.randomInt(1_000_000) / 1_000_000) * total;
    let rarity = 'common';
    for (const [k, w] of Object.entries(weights)) { if (r < w) { rarity = k; break; } r -= w; }

    /** Quiz bank per rarity */
    const QUIZ_BANK = {
      common: [
        { question: 'Which element is associated with fire?', options: ['Water', 'Earth', 'Fire', 'Air'], answer: 'Fire' },
        { question: 'What color are hot embers usually?', options: ['Blue', 'Red', 'Green', 'Purple'], answer: 'Red' },
        { question: 'Which one is hot?', options: ['Ice', 'Flame', 'Snow', 'Fog'], answer: 'Flame' },
        { question: 'Opposite of “cold”?', options: ['Dark', 'Hot', 'Wet', 'Dust'], answer: 'Hot' },
        { question: 'Best fuel for a campfire?', options: ['Stone', 'Water', 'Wood', 'Glass'], answer: 'Wood' },
        { question: 'Which symbol means multiplication?', options: ['÷', '×', '−', '+'], answer: '×' },
        { question: 'What color is ash most often?', options: ['Gray', 'Pink', 'Blue', 'Yellow'], answer: 'Gray' },
        { question: 'Heat naturally flows from…', options: ['Cold to hot', 'Hot to cold', 'Down to up', 'Left to right'], answer: 'Hot to cold' },
        { question: 'What do flames need to burn?', options: ['Oxygen', 'Salt', 'Iron', 'Plastic'], answer: 'Oxygen' },
        { question: 'Which season is usually the hottest?', options: ['Winter', 'Spring', 'Summer', 'Autumn'], answer: 'Summer' }
      ],
      uncommon: [
        { question: 'A synonym for “burn”?', options: ['Freeze', 'Scorch', 'Flow', 'Sink'], answer: 'Scorch' },
        { question: 'Charred wood turns into…', options: ['Ash', 'Ice', 'Steam', 'Clay'], answer: 'Ash' },
        { question: 'Which word means “to ignite”?', options: ['Kindle', 'Mend', 'Bury', 'Knead'], answer: 'Kindle' },
        { question: 'A safe indoor place for fire is a…', options: ['Hearth', 'Vase', 'Shelf', 'Bucket'], answer: 'Hearth' },
        { question: 'Which gas supports burning in air?', options: ['Oxygen', 'Nitrogen', 'Helium', 'Carbon dioxide'], answer: 'Oxygen' },
        { question: 'Main solid fuel in a candle?', options: ['Wax', 'Water', 'Sand', 'Salt'], answer: 'Wax' },
        { question: 'Least flammable here?', options: ['Dry paper', 'Wet cloth', 'Gasoline', 'Wood shavings'], answer: 'Wet cloth' },
        { question: 'Which icon warns about fire?', options: ['🔥', '❄️', '💧', '🍃'], answer: '🔥' },
        { question: 'Opposite of “ignite”?', options: ['Extinguish', 'Brighten', 'Sharpen', 'Combine'], answer: 'Extinguish' },
        { question: 'Tiny hot pieces from a fire are…', options: ['Embers', 'Pebbles', 'Bubbles', 'Crumbs'], answer: 'Embers' }
      ],
      rare: [
        { question: 'What consumes oxygen and gives heat?', options: ['Ice', 'Fire'], answer: 'Fire' },
        { question: 'Smoke with too little oxygen is often…', options: ['Black', 'Blue'], answer: 'Black' },
        { question: 'Safe to pour on a wood fire?', options: ['Water', 'Gasoline'], answer: 'Water' },
        { question: 'Which is NOT in the fire triangle?', options: ['Oxygen', 'Fuel', 'Time'], answer: 'Time' },
        { question: 'Which shines brighter?', options: ['Ember', 'Flame'], answer: 'Flame' },
        { question: 'Device that detects smoke?', options: ['Smoke detector', 'Thermometer'], answer: 'Smoke detector' },
        { question: 'Which is hotter?', options: ['100°C', '200°C'], answer: '200°C' },
        { question: 'What reduces a campfire?', options: ['Add air', 'Smother with sand'], answer: 'Smother with sand' },
        { question: 'Water on an oil fire is…', options: ['Dangerous', 'Safe'], answer: 'Dangerous' },
        { question: 'Which material is fire-resistant?', options: ['Asbestos', 'Paper'], answer: 'Asbestos' }
      ],
      legendary: [
        { question: 'Type the word "Fire" exactly:', options: [], answer: 'Fire' },
        { question: 'Type the word "Ash" exactly:', options: [], answer: 'Ash' },
        { question: 'Type the word "Flame" exactly:', options: [], answer: 'Flame' },
        { question: 'Type the word "Ember" exactly:', options: [], answer: 'Ember' },
        { question: 'Type the word "Smoke" exactly:', options: [], answer: 'Smoke' },
        { question: 'Type the word "Spark" exactly:', options: [], answer: 'Spark' },
        { question: 'Type the word "Torch" exactly:', options: [], answer: 'Torch' },
        { question: 'Type the word "Burn" exactly:', options: [], answer: 'Burn' },
        { question: 'Type the word "Heat" exactly:', options: [], answer: 'Heat' },
        { question: 'Type the word "Inferno" exactly:', options: [], answer: 'Inferno' }
      ]
    };

    /** Pick one quiz by rarity and shuffle options (cryptographically). */
    function pickQuiz(rarity = 'common') {
      const pool = QUIZ_BANK[rarity] || QUIZ_BANK.common;
      const base = pool[crypto.randomInt(pool.length)];
      const q = {
        question: base.question,
        options: Array.isArray(base.options) ? [...base.options] : [],
        answer: String(base.answer),
      };
      if (q.options.length > 1) shuffleInPlace(q.options);
      return q;
    }

    // Выбираем один вопрос по редкости и перемешиваем варианты
    const quiz = pickQuiz(rarity);
    const task = { type: 'quiz', rarity, params: quiz };

    await pool.query(
      `INSERT INTO burn_invoices
        (invoice_id,tg_id,amount_nano,address,comment,status,quest_data,quest_status,created_at,processed)
      VALUES($1,$2,$3,$4,$5,'pending',$6,'pending',NOW(),FALSE)`,
      [invoiceId, tg_id, AMOUNT_NANO, TON_ADDR, comment, task]
    );

    // Optional auto-payment (dev/stage)
    const auto = String(AUTO_PAY_BURN || '').toLowerCase();
    const autoPay = auto === 'true' || auto === '1';
    if (autoPay) {
      await pool.query(
        `UPDATE burn_invoices SET status='paid', paid_at=NOW() WHERE invoice_id=$1`,
        [invoiceId]
      );
    }

    return res.json({
      invoiceId,
      paymentUrl:  `${TONHUB_URL}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`,
      tonspaceUrl: `${TONSPACE_SCHEME}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`,
      task: sanitizeTaskForClient(task),
      paid: autoPay,
    });
  } catch (err) {
    console.error('[POST /api/burn-invoice] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/burn-status/:invoiceId
 * Returns payment state; once processed, returns the saved result.
 */
router.get('/burn-status/:invoiceId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { rows: [inv] } = await pool.query(
      `SELECT status, quest_data, processed, result_json
         FROM burn_invoices
        WHERE invoice_id=$1`,
      [req.params.invoiceId]
    );
    if (!inv) return res.status(404).json({ error: 'not found' });

    if (inv.processed) {
      return res.json({ paid: true, task: null, processed: true, result: inv.result_json || null });
    }
    if (inv.status !== 'paid') return res.json({ paid: false });

    return res.json({ paid: true, task: sanitizeTaskForClient(inv.quest_data || null), processed: false });
  } catch (err) {
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/cipher-answer/:fragId
 * Body: { chosenNumber: int }
 * Idempotent: if already answered, returns the same chosen rune.
 *
 * NOTE: At the moment we only require the number to exist in the grid.
 *       If you want to enforce the "correct" number, also compare with stored correct_num.
 */
router.post('/cipher-answer/:fragId', async (req, res) => {
  try {
    const fragId = Number(req.params.fragId);
    const chosenNumber = Number(req.body?.chosenNumber);

    if (!Number.isFinite(fragId) || fragId < 1 || fragId > 8) {
      return res.status(400).json({ error: 'bad_frag_id' });
    }
    if (!Number.isFinite(chosenNumber) || chosenNumber < 0 || chosenNumber > 99) {
      return res.status(400).json({ error: 'bad_number' });
    }

    // Ownership check
    const { rows: [p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    const owned = Array.isArray(p?.fragments) ? p.fragments.map(Number) : [];
    if (!owned.includes(fragId)) return res.status(403).json({ error: 'fragment_not_owned' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT grid_numbers, chosen_num, chosen_cell, chosen_rune_id
           FROM fragment_ciphers
          WHERE tg_id=$1 AND frag_id=$2
          FOR UPDATE`,
        [req.user.tg_id, fragId]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'cipher_not_found' });
      }

      const row = rows[0];

      // Idempotency: if already answered -> return the same rune
      if (row.chosen_rune_id) {
        await client.query('COMMIT');
        return res.json({ ok: true, symbolId: row.chosen_rune_id });
      }

      const idx = row.grid_numbers.findIndex((n) => Number(n) === chosenNumber);
      if (idx < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'number_not_in_grid' });
      }

      // Choose a random rune from the pair for this fragment
      const pair = RUNE_PAIRS[fragId] || [];
      if (pair.length !== 2) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'rune_pair_not_found' });
      }
      const symbolId = pair[crypto.randomInt(2)];

      await client.query(
        `UPDATE fragment_ciphers
            SET chosen_num=$3,
                chosen_cell=$4,
                chosen_rune_id=$5,
                answered_at=NOW()
          WHERE tg_id=$1 AND frag_id=$2`,
        [req.user.tg_id, fragId, chosenNumber, idx, symbolId]
      );

      await client.query('COMMIT');
      return res.json({ ok: true, symbolId });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /cipher-answer/:fragId] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/burn-complete/:invoiceId
 * Idempotent result submission. On success -> run burn logic.
 */
router.post('/burn-complete/:invoiceId', async (req, res) => {
  const { success, answer } = req.body;
  if (typeof success !== 'boolean') {
    return res.status(400).json({ error: 'success boolean required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock invoice
    const { rows: [inv] } = await client.query(
      `SELECT invoice_id, tg_id, status, processed, quest_status, result_json, quest_data
         FROM burn_invoices
        WHERE invoice_id=$1
        FOR UPDATE`,
      [req.params.invoiceId]
    );
    if (!inv) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'invoice not found' });
    }

    // Already has a saved result -> return it as-is
    if (inv.result_json) {
      await client.query('COMMIT');
      return res.json(inv.result_json);
    }

    // Not paid -> client logic error
    if (inv.status !== 'paid') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invoice not paid' });
    }

    // Если клиент говорит "success: true", проверим ответ против quest_data (если есть)
    if (success && inv.quest_data && inv.quest_data.type === 'quiz') {
      const correct = String(inv.quest_data?.params?.answer ?? '');
      if (correct) {
        const provided = String(answer ?? '');
        if (provided !== correct) {
          // Неверный ответ — считаем провалом квеста в ЭТОЙ ЖЕ транзакции
          const { rows: [pl] } = await client.query(
            `SELECT pity_counter FROM players WHERE tg_id=$1 FOR UPDATE`,
            [inv.tg_id]
          );
          const newPity = Number(pl?.pity_counter || 0) + 1;

          await client.query(
            `UPDATE players SET pity_counter=$2 WHERE tg_id=$1`,
            [inv.tg_id, newPity]
          );

          const result = { ok: false, pity_counter: newPity };

          await client.query(
            `UPDATE burn_invoices
                SET quest_status='failed',
                    processed=TRUE,
                    result_json=$2
              WHERE invoice_id=$1`,
            [req.params.invoiceId, result]
          );

          await client.query('COMMIT');
          return res.json(result);
        }
      }
    }



    if (!success) {
      // Idempotent fail: pity+1, mark as processed and store result
      const { rows: [pl] } = await client.query(
        `SELECT pity_counter FROM players WHERE tg_id=$1 FOR UPDATE`,
        [inv.tg_id]
      );
      const newPity = Number(pl?.pity_counter || 0) + 1;

      await client.query(
        `UPDATE players SET pity_counter=$2 WHERE tg_id=$1`,
        [inv.tg_id, newPity]
      );

      const result = { ok: false, pity_counter: newPity };

      await client.query(
        `UPDATE burn_invoices
            SET quest_status='failed',
                processed=TRUE,
                result_json=$2
          WHERE invoice_id=$1`,
        [req.params.invoiceId, result]
      );

      await client.query('COMMIT');
      return res.json(result);
    }

    // success === true -> run burn resolver (it is transactional inside)
    await client.query('COMMIT');
    const result = await runBurnLogic(req.params.invoiceId);

    // Sync status just in case
    try {
      await pool.query(
        `UPDATE burn_invoices
            SET quest_status='success'
          WHERE invoice_id=$1 AND result_json IS NOT NULL`,
        [req.params.invoiceId]
      );
    } catch {}

    return res.json(result);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /burn-complete] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/referral
 * Returns ref code, invited count and reward flag. Also rotates JWT via header.
 */
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
    return res.json({
      refCode: p.ref_code,
      invitedCount: Number(c.cnt),
      rewardIssued: p.referral_reward_issued,
    });
  } catch (err) {
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/referral/claim
 * Claim referral reward (needs >= 3 confirmed referrals), grants fragment #2.
 */
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

    try { await ensureCipherForFragment(pool, req.user.tg_id, 2); } catch {}

    res.setHeader('Authorization', `Bearer ${sign(req.user)}`);
    return res.json({ ok: true, awarded: [2] });
  } catch (err) {
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/third-quest
 * Announces availability of the third fragment quiz (if not owned yet).
 */
router.get('/third-quest', async (_req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,
      [res.req.user.tg_id]
    );
    const owned = Array.isArray(p?.fragments) ? p.fragments.map(Number) : [];
    if (owned.includes(3)) return res.json({ available: false });

    const task = {
      type: 'quiz',
      question: 'Choose the correct rune meaning for 🔥',
      options: ['Water', 'Ash', 'Flame', 'Stone'],
      answer: 'Flame',
    };
    return res.json({ available: true, task });
  } catch (err) {
    console.error('[GET /third-quest] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/third-claim
 * Validates answer and grants fragment #3 once.
 */
router.post('/third-claim', async (req, res) => {
  try {
    const { answer } = req.body || {};
    const { rows: [p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    const owned = Array.isArray(p?.fragments) ? p.fragments.map(Number) : [];
    if (owned.includes(3)) return res.json({ ok: true, awarded: [] });

    const correct = (answer === 'Flame');
    if (!correct) return res.status(400).json({ error: 'wrong_answer' });

    await pool.query(
      `UPDATE players SET fragments = array_append(coalesce(fragments,'{}'::int[]), 3) WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    try { await ensureCipherForFragment(pool, req.user.tg_id, 3); } catch {}

    return res.json({ ok: true, awarded: [3] });
  } catch (err) {
    console.error('[POST /third-claim] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/leaderboard
 * Top-10 by total TON paid.
 */
router.get('/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.tg_id, p.name,
             COUNT(b.invoice_id)        AS total_burns,
             SUM(b.amount_nano)::bigint AS total_ton_nano
        FROM players p
        JOIN burn_invoices b ON b.tg_id = p.tg_id
       WHERE b.status = 'paid'
       GROUP BY p.tg_id, p.name
       ORDER BY total_ton_nano DESC
       LIMIT 10
    `);
    const result = rows.map(r => ({
      tg_id: r.tg_id,
      name: r.name,
      totalBurns: Number(r.total_burns),
      totalTon: Number(r.total_ton_nano) / 1e9,
    }));
    res.json(result);
  } catch (err) {
    console.error('[GET /api/leaderboard] ERROR:', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * DELETE /api/player/:tg_id
 * Full account deletion (player, invoices, referrals).
 */
router.delete('/player/:tg_id', async (req, res) => {
  if (String(req.user.tg_id) !== String(req.params.tg_id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM referrals WHERE referrer_id = $1 OR referred_id = $1`, [req.user.tg_id]);
    await client.query(`DELETE FROM burn_invoices WHERE tg_id = $1`, [req.user.tg_id]);
    await client.query(`DELETE FROM fragment_ciphers WHERE tg_id = $1`, [req.user.tg_id]);
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

/**
 * GET /api/stats/:tg_id
 * Simple aggregates for the user (total burns and TON spent).
 */
router.get('/stats/:tg_id', async (req, res) => {
  try {
    if (String(req.user.tg_id) !== String(req.params.tg_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows: [stats] } = await pool.query(
      `SELECT COUNT(b.invoice_id) AS total_burns, COALESCE(SUM(b.amount_nano), 0) AS total_ton_nano
         FROM burn_invoices b
        WHERE b.tg_id = $1 AND b.status = 'paid'`,
      [req.params.tg_id]
    );
    return res.json({
      totalBurns: Number(stats.total_burns),
      totalTon: Number(stats.total_ton_nano) / 1e9,
    });
  } catch (err) {
    console.error('[GET /api/stats] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/daily-quest
 * Returns daily-quest availability and (optional) coupon percent.
 */
router.get('/daily-quest', async (_req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT last_daily_claim, daily_coupon_percent FROM players WHERE tg_id=$1`,
      [res.req.user.tg_id]
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

/**
 * POST /api/daily-quest/claim
 * Simple daily reward that sets a discount coupon once per day.
 */
router.post('/daily-quest/claim', async (_req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows: [p] } = await pool.query(
      `SELECT last_daily_claim FROM players WHERE tg_id=$1`,
      [res.req.user.tg_id]
    );
    if (!p) return res.status(404).json({ error: 'player not found' });
    if (p.last_daily_claim === today) {
      return res.status(400).json({ error: 'Already claimed today' });
    }

    const couponPercent = 30;
    await pool.query(
      `UPDATE players SET last_daily_claim=$2, daily_coupon_percent=$3 WHERE tg_id=$1`,
      [res.req.user.tg_id, today, couponPercent]
    );

    return res.json({ coupon: couponPercent });
  } catch (err) {
    console.error('[POST /daily-quest/claim] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/debug/grant-fragments
 * Dev helper to grant fragments; secured in production via DEBUG_KEY.
 */
router.post('/debug/grant-fragments', async (req, res) => {
  try {
    if (NODE_ENV === 'production' && (!DEBUG_KEY || req.headers['x-debug-key'] !== DEBUG_KEY)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const want = Array.isArray(req.body?.fragments) ? req.body.fragments.map(Number) : [];
    if (!want.length) return res.status(400).json({ error: 'fragments array required' });

    const { rows: [p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,
      [req.user.tg_id]
    );
    const owned = Array.isArray(p?.fragments) ? p.fragments.map(Number) : [];
    const set = new Set(owned);
    want.forEach(x => set.add(x));
    const merged = Array.from(set).sort((a, b) => a - b);

    const setReferral = want.includes(2);

    await pool.query(
      `UPDATE players
          SET fragments=$2,
              referral_reward_issued = CASE WHEN $3 THEN TRUE ELSE referral_reward_issued END
        WHERE tg_id=$1`,
      [req.user.tg_id, merged, setReferral]
    );

    return res.json({ ok: true, fragments: merged });
  } catch (err) {
    console.error('[POST /debug/grant-fragments] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

// POST /api/debug/reset-ciphers  — сбросить выбранные руны у игрока + ПЕРЕРОЛЛ сетки/загадки
router.post('/debug/reset-ciphers', async (req, res) => {
  try {
    const key = req.get('X-Debug-Key') || '';
    if (!process.env.DEBUG_KEY || key !== process.env.DEBUG_KEY) {
      // маскируем в проде
      return res.status(404).json({ error: 'not_found' });
    }

    const tgIdFromJwt = req.user?.tg_id;
    const { tg_id = tgIdFromJwt } = req.body || {};
    if (!tg_id) return res.status(400).json({ error: 'bad_tg_id' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // все персональные шифры игрока
      const { rows: list } = await client.query(
        `SELECT frag_id FROM fragment_ciphers WHERE tg_id = $1 ORDER BY frag_id`,
        [tg_id]
      );

      // прочитаем текущие позиции правильного ответа (до изменений)
      const { rows: beforeRows } = await client.query(
        `SELECT frag_id, correct_cell FROM fragment_ciphers WHERE tg_id=$1`,
        [tg_id]
      );
      const usedByFrag = new Map(
        beforeRows.map(x => [Number(x.frag_id), Number(x.correct_cell)])
      );

      let reset = 0;

      for (const r of list) {
        const fragId = Number(r.frag_id);

        // новая загадка и новая 4×4 сетка с гарантированным правильным числом
        const ridx = crypto.randomInt(RIDDLE_BANK.length);
        const riddle = RIDDLE_BANK[ridx];

        // запрещаем уже занятые другими фрагментами позиции
        const banned = Array.from(usedByFrag.entries())
          .filter(([fid]) => fid !== fragId)
          .map(([, cell]) => cell)
          .filter(n => Number.isFinite(n));

        // ВАЖНО: makeGridNumbers должна поддерживать сигнатуру (answer, banned)
        const { arr, correctCell } = makeGridNumbers(riddle.answer, banned);

        const q = await client.query(
          `UPDATE fragment_ciphers
              SET chosen_num     = NULL,
                  chosen_cell    = NULL,
                  chosen_rune_id = NULL,
                  answered_at    = NULL,
                  grid_numbers   = $3::int[],
                  correct_num    = $4,
                  correct_cell   = $5,
                  riddle_key     = $6
            WHERE tg_id = $1 AND frag_id = $2`,
          [tg_id, fragId, arr, riddle.answer, correctCell, riddle.key]
        );
        reset += q.rowCount;

        // фиксируем новую позицию, чтобы дальше её не использовать
        usedByFrag.set(fragId, correctCell);
      }

      await client.query('COMMIT');
      return res.json({ ok: true, reset, fragments: list.map(x => Number(x.frag_id)) });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[POST /debug/reset-ciphers] ERROR', e);
    res.status(500).json({ error: 'internal' });
  }
});


/**
 * GET /api/runes/urls?ids=101,202,...
 * Returns signed URLs for requested rune ids.
 */
router.get('/runes/urls', async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));

    if (!ids.length) return res.json({ urls: {} });

    const urls = {};
    for (const id of ids) {
      const name = RUNE_ASSETS[id];
      if (!name) continue;
      urls[id] = abs(req, signAssetUrl('/runes', name, RUNE_URL_TTL_SEC));
    }
    return res.json({ urls });
  } catch (err) {
    console.error('[GET /api/runes/urls] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

export default router;
