// routes/player.js
import express from 'express'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import pool from '../db.js'
import { authenticate } from '../middleware/auth.js'

const router = express.Router()
const BOT_TOKEN = process.env.BOT_TOKEN
const JWT_SECRET = process.env.JWT_SECRET
const TON_ADDRESS = process.env.TON_WALLET_ADDRESS

/** Генерация JWT */
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
}

// (Опционально) проверка initData
function verifyInitData(initData) {
  const parsed = new URLSearchParams(initData)
  const hash = parsed.get('hash')
  parsed.delete('hash')
  const dataCheck = [...parsed.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secretPart = BOT_TOKEN.includes(':') ? BOT_TOKEN.split(':')[1] : BOT_TOKEN
  const secret = crypto.createHash('sha256').update(secretPart).digest()
  const hmac = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex')
  return hmac === hash
}

/** GET /api/player/:tg_id — публичный */
router.get('/player/:tg_id', async (req, res) => {
  const { tg_id } = req.params
  try {
    const { rows } = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed, curse_expires
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    )
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' })
    }
    res.json(rows[0])
  } catch (err) {
    console.error('[player] GET error:', err)
    res.status(500).json({ error: 'internal error' })
  }
})

/** POST /api/init — публичный */
router.post('/init', async (req, res) => {
  const { tg_id, name, initData } = req.body
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData are required' })
  }
  // если нужно, можно проверить:
//  if (!verifyInitData(initData)) return res.status(400).json({ error: 'Invalid initData' })
  try {
    let { rows } = await pool.query(`SELECT * FROM players WHERE tg_id = $1`, [
      tg_id,
    ])
    if (!rows.length) {
      ;({ rows } = await pool.query(
        `INSERT INTO players (tg_id,name,is_cursed,curses_count,curse_expires)
         VALUES ($1,$2,FALSE,0,NULL)
         RETURNING *`,
        [tg_id, name || null]
      ))
    }
    const user = rows[0]
    const token = generateToken({ tg_id: user.tg_id, name: user.name })
    res.json({ user, token })
  } catch (err) {
    console.error('[player] POST init error:', err)
    res.status(500).json({ error: 'internal error' })
  }
})

// JWT-защита всех последующих
router.use(authenticate)

/** GET /api/fragments/:tg_id */
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  try {
    const { rows } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id = $1`,
      [tg_id]
    )
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' })
    }
    const fragments = rows[0].fragments || []
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name })
    res.setHeader('Authorization', `Bearer ${token}`)
    res.json({ fragments })
  } catch (err) {
    console.error('[fragments] error:', err)
    res.status(500).json({ error: 'internal error' })
  }
})

/** GET /api/stats/total_users */
router.get('/stats/total_users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM global_stats WHERE id = 'total_users'"
    )
    const value = rows.length ? rows[0].value : 0
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name })
    res.setHeader('Authorization', `Bearer ${token}`)
    res.json({ value })
  } catch (err) {
    console.error('[stats] error:', err)
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name })
    res.setHeader('Authorization', `Bearer ${token}`)
    res.json({ value: 0 })
  }
})

/** POST /api/burn-invoice */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body
  if (!tg_id) {
    return res.status(400).json({ ok: false, error: 'tg_id is required' })
  }
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ ok: false, error: 'Forbidden' })
  }

  try {
    // 1) проверяем кулдаун/проклятие
    const { rows: pr } = await pool.query(
      `SELECT last_burn, is_cursed, curse_expires FROM players WHERE tg_id = $1`,
      [tg_id]
    )
    if (!pr.length) {
      return res.status(404).json({ ok: false, error: 'player not found' })
    }
    const { last_burn, is_cursed, curse_expires } = pr[0]
    const now = new Date()
    if (curse_expires && new Date(curse_expires) > now) {
      return res
        .status(403)
        .json({ ok: false, error: 'You are still cursed', curse_expires })
    }
    if (is_cursed && curse_expires && new Date(curse_expires) <= now) {
      await pool.query(
        `UPDATE players SET is_cursed = FALSE, curse_expires = NULL WHERE tg_id = $1`,
        [tg_id]
      )
    }
    const lastMs = last_burn ? new Date(last_burn).getTime() : 0
    if (now.getTime() - lastMs < 2 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' })
    }

    // 2) создаём инвойс
    const amountNano = 500_000_000 // 0.5 TON
    const comment = 'burn-' + Date.now()
    const { rows: ir } = await pool.query(
      `INSERT INTO burn_invoices (tg_id, amount_nano, address, comment)
       VALUES ($1, $2, $3, $4) RETURNING invoice_id`,
      [tg_id, amountNano, TON_ADDRESS, comment]
    )
    const invoiceId = ir[0].invoice_id

    // 3) HTTP-url & deep-link
    const paymentUrl = 
      `https://tonhub.com/transfer/${TON_ADDRESS}` +
      `?amount=${amountNano}` +
      `&text=${encodeURIComponent(comment)}`

    const u = new URL(paymentUrl)
    const path = u.pathname.replace(/^\//, '') // "transfer/…"
    const tonDeepLink = `ton://${path}${u.search}`

    // 4) ответ клиенту
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name })
    res.setHeader('Authorization', `Bearer ${token}`)
    return res.json({
      ok: true,
      invoiceId,
      tonInvoice: { address: TON_ADDRESS, amountNano, comment },
      paymentUrl,
      tonDeepLink,
    })
  } catch (err) {
    console.error('[burn-invoice] error:', err)
    return res.status(500).json({ ok: false, error: 'internal error' })
  }
})

/** GET /api/burn-status/:invoiceId? */
router.get('/burn-status/:invoiceId?', async (req, res) => {
  let invoiceId = req.params.invoiceId || req.query.invoiceId
  if (!invoiceId || invoiceId === 'null') {
    const { rows } = await pool.query(
      `SELECT invoice_id FROM burn_invoices
         WHERE tg_id = $1
      ORDER BY created_at DESC
         LIMIT 1`,
      [req.user.tg_id]
    )
    invoiceId = rows[0]?.invoice_id
  }
  if (!invoiceId) {
    return res.status(400).json({ ok: false, error: 'invoiceId missing' })
  }

  try {
    const { rows } = await pool.query(
      `SELECT tg_id, status FROM burn_invoices WHERE invoice_id = $1`,
      [invoiceId]
    )
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'invoice not found' })
    }
    if (rows[0].tg_id.toString() !== req.user.tg_id.toString()) {
      return res.status(403).json({ ok: false, error: 'Forbidden' })
    }

    if (rows[0].status === 'paid') {
      // вызываем вашу бизнес-логику
      try {
        await runBurnLogic(req.user.tg_id)
      } catch (e) {
        console.error('runBurnLogic error:', e)
      }
      // снова подгружаем свежие данные
      const { rows: p2 } = await pool.query(
        `SELECT fragments, last_burn, is_cursed, curse_expires
           FROM players WHERE tg_id = $1`,
        [req.user.tg_id]
      )
      const p = p2[0]
      const newFrag = p.fragments?.slice(-1)[0] || null

      return res.json({
        ok: true,
        paid: true,
        newFragment: newFrag,
        fragments: p.fragments,
        lastBurn: p.last_burn,
        cursed: p.is_cursed,
        curse_expires: p.curse_expires,
      })
    }

    // ещё не оплачено
    return res.json({ ok: true, paid: false })
  } catch (err) {
    console.error('[burn-status] error:', err)
    return res.status(500).json({ ok: false, error: 'internal error' })
  }
})

/**
 * Ваша бизнес-логика после оплаты.
 * Добавляем фрагмент или ставим проклятие, помечаем счёт «paid» в БД.
 */
async function runBurnLogic(tgId) {
  // пример:
  const { rows: pr } = await pool.query(
    `SELECT fragments FROM players WHERE tg_id = $1`,
    [tgId]
  )
  const frags = pr[0].fragments || []
  const nextFragment = frags.length + 1

  // пример случайного проклятия:
  if (Math.random() < 0.3) {
    const until = new Date(Date.now() + 5 * 60 * 1000) // 5 мин
    await pool.query(
      `UPDATE players
         SET is_cursed = TRUE, curse_expires = $1
       WHERE tg_id = $2`,
      [until.toISOString(), tgId]
    )
  } else {
    // выдаём новый фрагмент
    await pool.query(
      `UPDATE players
         SET fragments = array_append(fragments, $1), last_burn = NOW()
       WHERE tg_id = $2`,
      [nextFragment, tgId]
    )
  }
  // помечаем счёт paid
  await pool.query(
    `UPDATE burn_invoices SET status = 'paid', paid_at = NOW()
     WHERE tg_id = $1 AND status != 'paid'`,
    [tgId]
  )
}

export default router
