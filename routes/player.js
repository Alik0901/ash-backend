// src/routes/player.js
import express        from 'express'
import crypto         from 'crypto'
import jwt            from 'jsonwebtoken'
import { v4 as uuid } from 'uuid'
import pool           from '../db.js'
import { authenticate } from '../middleware/auth.js'

const router = express.Router()

// JWT secret and TON wallet address from environment
const JWT_SECRET         = process.env.JWT_SECRET
const TON_WALLET_ADDRESS = process.env.TON_WALLET_ADDRESS

// URLs and amounts for TON payments
const TONHUB_URL      = 'https://tonhub.com/transfer'
const TONSPACE_SCHEME = 'ton://transfer'
const AMOUNT_NANO     = 500_000_000  // 0.5 TON in nanoton

// All eight fragment IDs
const FRAGMENT_IDS = [1,2,3,4,5,6,7,8]

// The three “mandatory” fragments that trigger a curse
const MANDATORY_IDS = [1,2,3]

/**
 * Create and sign a JWT for the user payload.
 */
function signToken(user) {
  return jwt.sign(
    { tg_id: user.tg_id, name: user.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
}

/**
 * Generate a random referral code.
 */
function generateReferralCode() {
  return crypto.randomBytes(6).toString('base64url')
}

/**
 * Ensure the generated referral code is unique in the database.
 */
async function generateUniqueReferralCode() {
  for (let i = 0; i < 8; i++) {
    const candidate = generateReferralCode()
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE ref_code = $1 LIMIT 1`,
      [candidate]
    )
    if (rows.length === 0) {
      return candidate
    }
  }
  // Fallback if collisions occurred
  return crypto.randomBytes(8).toString('base64url')
}

/**
 * Core logic after a payment is marked "paid":
 * - If the user has collected all mandatory fragments and is not yet cursed,
 *   apply a curse instead of giving a new fragment.
 * - Otherwise, grant a random new fragment (if any remain) or just reset cooldown.
 */
async function runBurnLogic(invoiceId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1) Lock the invoice row and check if it's paid and not yet processed
    const { rows: [invoice] } = await client.query(
      `SELECT tg_id, processed
         FROM burn_invoices
        WHERE invoice_id = $1
          AND status      = 'paid'
        FOR UPDATE`,
      [invoiceId]
    )
    if (!invoice || invoice.processed) {
      await client.query('ROLLBACK')
      return { newFragment: null, cursed: false, curse_expires: null }
    }

    // 2) Lock the player's row and fetch their fragments and curse state
    const { rows: [player] } = await client.query(
      `SELECT fragments, is_cursed
         FROM players
        WHERE tg_id = $1
        FOR UPDATE`,
      [invoice.tg_id]
    )
    const ownedFragments = player.fragments || []
    const alreadyCursed   = player.is_cursed

    // 3) If all mandatory fragments are owned and player is not yet cursed → issue curse
    const hasAllMandatory = MANDATORY_IDS.every(id => ownedFragments.includes(id))
    if (hasAllMandatory && !alreadyCursed) {
      const curseDurationMs = 60 * 60 * 1000  // 1 hour
      const curseExpires    = new Date(Date.now() + curseDurationMs)
      await client.query(
        `UPDATE players
            SET is_cursed     = TRUE,
                curses_count  = curses_count + 1,
                curse_expires = $2
          WHERE tg_id = $1`,
        [invoice.tg_id, curseExpires]
      )
      await client.query(
        `UPDATE burn_invoices
            SET processed = TRUE
          WHERE invoice_id = $1`,
        [invoiceId]
      )
      await client.query('COMMIT')
      return {
        newFragment: null,
        cursed: true,
        curse_expires: curseExpires.toISOString()
      }
    }

    // 4) Otherwise, pick a random new fragment if any remain
    const remaining = FRAGMENT_IDS.filter(id => !ownedFragments.includes(id))
    const pick = remaining.length
      ? remaining[crypto.randomInt(remaining.length)]
      : null

    if (pick === null) {
      // No new fragment available → just update last_burn timestamp for cooldown
      await client.query(
        `UPDATE players
            SET last_burn = NOW()
          WHERE tg_id = $1`,
        [invoice.tg_id]
      )
    } else {
      // Grant the chosen fragment
      await client.query(
        `UPDATE players
            SET fragments = array_append(fragments, $2::int),
                last_burn  = NOW()
          WHERE tg_id = $1`,
        [invoice.tg_id, pick]
      )
    }

    // 5) Mark the invoice as processed
    await client.query(
      `UPDATE burn_invoices
          SET processed = TRUE
        WHERE invoice_id = $1`,
      [invoiceId]
    )

    await client.query('COMMIT')
    return { newFragment: pick, cursed: false, curse_expires: null }
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error in runBurnLogic:', error)
    throw error
  } finally {
    client.release()
  }
}

// ────────────────────────────────────────────────────────────────
// Public routes (no authentication required):
// ────────────────────────────────────────────────────────────────

/**
 * POST /api/init
 * Register a new player or return existing, then issue JWT.
 */
router.post('/init', async (req, res) => {
  const { tg_id, name = '', initData = '', referrer_code = null } = req.body
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData required' })
  }
  try {
    // Check if player already exists
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE tg_id = $1`,
      [tg_id]
    )
    let playerRecord
    if (rows.length === 0) {
      // New player → insert
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const code = await generateUniqueReferralCode()
        const { rows: [newPlayer] } = await client.query(
          `INSERT INTO players
             (tg_id, name, is_cursed, curses_count, curse_expires, ref_code, referral_reward_issued)
           VALUES ($1, $2, FALSE, 0, NULL, $3, FALSE)
           RETURNING *`,
          [tg_id, name.trim() || null, code]
        )
        if (referrer_code) {
          // Handle referral
          const { rows: [referrer] } = await client.query(
            `SELECT tg_id FROM players WHERE ref_code = $1 LIMIT 1`,
            [referrer_code.trim()]
          )
          if (!referrer) {
            await client.query('ROLLBACK')
            return res.status(400).json({ error: 'Invalid referral code' })
          }
          await client.query(
            `INSERT INTO referrals
               (referrer_id, referred_id, status)
             VALUES ($1, $2, 'confirmed')`,
            [referrer.tg_id, tg_id]
          )
        }
        // Increment global stats
        await client.query(
          `UPDATE global_stats
              SET value = value + 1
            WHERE id = 'total_users'`
        )
        await client.query('COMMIT')
        playerRecord = newPlayer
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    } else {
      // Existing player → fetch
      const { rows: [existingPlayer] } = await pool.query(
        `SELECT * FROM players WHERE tg_id = $1 LIMIT 1`,
        [tg_id]
      )
      playerRecord = existingPlayer
    }
    // Issue JWT
    const token = signToken(playerRecord)
    return res.json({ user: playerRecord, token })
  } catch (error) {
    console.error('Error in /api/init:', error)
    return res.status(500).json({ error: 'internal' })
  }
})

/**
 * GET /api/player/:tg_id
 * Return player profile and referral count.
 */
router.get('/player/:tg_id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed,
              curse_expires, curses_count, ref_code, referral_reward_issued
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [req.params.tg_id]
    )
    if (rows.length === 0) {
      return res.status(404).json({ error: 'player not found' })
    }
    const player = rows[0]
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM referrals
        WHERE referrer_id = $1
          AND status = 'confirmed'`,
      [req.params.tg_id]
    )
    const invitedCount = Number(countRow.cnt)
    return res.json({ ...player, invitedCount })
  } catch (error) {
    console.error('Error in /api/player/:tg_id:', error)
    return res.status(500).json({ error: 'internal' })
  }
})

// ────────────────────────────────────────────────────────────────
// Protected routes (authentication required):
// ────────────────────────────────────────────────────────────────

router.use(authenticate)

/**
 * GET /api/stats/total_users
 */
router.get('/stats/total_users', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM global_stats WHERE id = 'total_users' LIMIT 1`
    )
    const total = rows.length ? Number(rows[0].value) : 0
    return res.json({ total })
  } catch (error) {
    console.error('Error in /api/stats/total_users:', error)
    return res.status(500).json({ error: 'internal' })
  }
})

/**
 * GET /api/fragments/:tg_id
 */
router.get('/fragments/:tg_id', async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id = $1`,
      [req.params.tg_id]
    )
    if (!row) {
      return res.status(404).json({ error: 'player not found' })
    }
    return res.json({ fragments: row.fragments || [] })
  } catch (error) {
    console.error('Error in /api/fragments/:tg_id:', error)
    return res.status(500).json({ error: 'internal' })
  }
})

/**
 * POST /api/burn-invoice
 */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body
  if (!tg_id) {
    return res.status(400).json({ error: 'tg_id required' })
  }
  try {
    const invoiceId = uuid()
    const comment   = crypto.randomBytes(4).toString('hex')
    await pool.query(
      `INSERT INTO burn_invoices
         (invoice_id, tg_id, amount_nano, address, comment, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW())`,
      [invoiceId, tg_id, AMOUNT_NANO, TON_WALLET_ADDRESS, comment]
    )
    return res.json({
      invoiceId,
      paymentUrl:  `${TONHUB_URL}/${TON_WALLET_ADDRESS}?amount=${AMOUNT_NANO}&text=${comment}`,
      tonspaceUrl: `${TONSPACE_SCHEME}/${TON_WALLET_ADDRESS}?amount=${AMOUNT_NANO}&text=${comment}`
    })
  } catch (error) {
    console.error('Error in /api/burn-invoice:', error)
    return res.status(500).json({ error: 'internal' })
  }
})

/**
 * GET /api/burn-status/:invoiceId
 */
router.get('/burn-status/:invoiceId', async (req, res) => {
  try {
    const { rows: [inv] } = await pool.query(
      `SELECT status FROM burn_invoices WHERE invoice_id = $1`,
      [req.params.invoiceId]
    )
    if (!inv) {
      return res.status(404).json({ error: 'invoice not found' })
    }
    if (inv.status !== 'paid') {
      return res.json({ paid: false })
    }
    const result = await runBurnLogic(req.params.invoiceId)
    return res.json({ paid: true, ...result })
  } catch (error) {
    console.error('Error in /api/burn-status/:invoiceId:', error)
    return res.status(500).json({ error: 'internal' })
  }
})

/**
 * GET /api/referral
 */
router.get('/referral', async (req, res) => {
  const tg_id = req.user.tg_id
  try {
    const { rows: [row] } = await pool.query(
      `SELECT ref_code, referral_reward_issued
         FROM players
        WHERE tg_id = $1`,
      [tg_id]
    )
    if (!row) {
      return res.json({ refCode: null, invitedCount: 0, rewardIssued: false })
    }
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM referrals
        WHERE referrer_id = $1
          AND status = 'confirmed'`,
      [tg_id]
    )
    const invitedCount = Number(countRow.cnt)
    res.setHeader('Authorization', `Bearer ${signToken(req.user)}`)
    return res.json({
      refCode: row.ref_code,
      invitedCount,
      rewardIssued: row.referral_reward_issued
    })
  } catch (error) {
    console.error('Error in /api/referral:', error)
    return res.status(500).json({ error: 'internal' })
  }
})

/**
 * POST /api/referral/claim
 */
router.post('/referral/claim', async (req, res) => {
  const tg_id = req.user.tg_id
  try {
    const { rows } = await pool.query(
      `SELECT fragments, referral_reward_issued
         FROM players
        WHERE tg_id = $1`,
      [tg_id]
    )
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Player not found' })
    }
    const player = rows[0]
    if (player.referral_reward_issued) {
      return res.status(400).json({ error: 'Reward already claimed' })
    }
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM referrals
        WHERE referrer_id = $1
          AND status = 'confirmed'`,
      [tg_id]
    )
    if (Number(countRow.cnt) < 3) {
      return res.status(400).json({ error: 'Not enough invited users' })
    }
    const owned = player.fragments || []
    const available = FRAGMENT_IDS.filter(id => !owned.includes(id))
    const pick = available.length
      ? available[crypto.randomInt(available.length)]
      : null
    await pool.query(
      `UPDATE players
          SET fragments = array_append(fragments, $2::int),
              referral_reward_issued = TRUE
        WHERE tg_id = $1`,
      [tg_id, pick]
    )
    res.setHeader('Authorization', `Bearer ${signToken(req.user)}`)
    return res.json({ ok: true, fragment: pick })
  } catch (error) {
    console.error('Error in /api/referral/claim:', error)
    return res.status(500).json({ error: 'internal' })
  }
})

/**
 * DELETE /api/player/:tg_id
 */
router.delete('/player/:tg_id', async (req, res) => {
  if (String(req.user.tg_id) !== req.params.tg_id) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `DELETE FROM referrals WHERE referrer_id = $1 OR referred_id = $1`,
      [req.user.tg_id]
    )
    await client.query(
      `DELETE FROM burn_invoices WHERE tg_id = $1`,
      [req.user.tg_id]
    )
    await client.query(
      `DELETE FROM players WHERE tg_id = $1`,
      [req.user.tg_id]
    )
    await client.query('COMMIT')
    return res.json({ ok: true })
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error in DELETE /api/player/:tg_id:', error)
    return res.status(500).json({ error: 'internal' })
  } finally {
    client.release()
  }
})

export default router
