import express from 'express'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import TelegramBot from 'node-telegram-bot-api'
import pool from '../db.js'
import { authenticate } from '../middleware/auth.js'

const router = express.Router()

const JWT_SECRET             = process.env.JWT_SECRET
const BOT_TOKEN              = process.env.BOT_TOKEN
const PAYMENT_PROVIDER_TOKEN = process.env.TELEGRAM_PAYMENTS_TOKEN
const TON_ADDRESS            = process.env.TON_WALLET_ADDRESS

// Telegram Bot, нужен только для createInvoiceLink
const bot = new TelegramBot(BOT_TOKEN, { polling: false })

// Генерация JWT
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
}

/**
 * GET /api/player/:tg_id
 * публично возвращает профиль
 */
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
    console.error('[GET /player] error:', err)
    res.status(500).json({ error: 'internal error' })
  }
})

/**
 * POST /api/init
 * создаёт нового игрока (если нужно) и отдает JWT
 */
router.post('/init', async (req, res) => {
  const { tg_id, name, initData } = req.body
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData are required' })
  }
  try {
    let { rows } = await pool.query(
      `SELECT * FROM players WHERE tg_id = $1`,
      [tg_id]
    )
    if (!rows.length) {
      ({ rows } = await pool.query(
        `INSERT INTO players (tg_id, name, is_cursed, curses_count, curse_expires)
           VALUES ($1, $2, FALSE, 0, NULL)
         RETURNING *`,
        [tg_id, name || null]
      ))
    }
    const user  = rows[0]
    const token = generateToken({ tg_id: user.tg_id, name: user.name })
    res.json({ user, token })
  } catch (err) {
    console.error('[POST /init] error:', err)
    res.status(500).json({ error: 'internal error' })
  }
})

// Ниже защищённые JWT роуты
router.use(authenticate)

/**
 * GET /api/fragments/:tg_id
 */
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params
  if (String(req.user.tg_id) !== String(tg_id)) {
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
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name })
    res.setHeader('Authorization', `Bearer ${token}`)
    res.json({ fragments: rows[0].fragments || [] })
  } catch (err) {
    console.error('[GET /fragments] error:', err)
    res.status(500).json({ error: 'internal error' })
  }
})

/**
 * GET /api/stats/total_users
 */
router.get('/stats/total_users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM global_stats WHERE id = 'total_users'`
    )
    const value = rows.length ? rows[0].value : 0
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name })
    res.setHeader('Authorization', `Bearer ${token}`)
    res.json({ value })
  } catch (err) {
    console.error('[GET /stats/total_users] error:', err)
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name })
    res.setHeader('Authorization', `Bearer ${token}`)
    res.json({ value: 0 })
  }
})

/**
 * POST /api/create-invoice
 * — проверяем кулдаун / проклятие
 * — создаём запись в burn_invoices с status = 'pending'
 * — генерим payload = invoiceId и вызываем Telegram Bot API
 */
router.post('/create-invoice', async (req, res) => {
  const { tg_id } = req.body
  if (!tg_id) {
    return res.status(400).json({ error: 'tg_id is required' })
  }
  if (String(req.user.tg_id) !== String(tg_id)) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    // 1) кулдаун и проклятие
    const { rows: pr } = await pool.query(
      `SELECT last_burn, is_cursed, curse_expires
         FROM players
        WHERE tg_id = $1`,
      [tg_id]
    )
    if (!pr.length) {
      return res.status(404).json({ error: 'player not found' })
    }
    const { last_burn, is_cursed, curse_expires } = pr[0]
    const now = Date.now()
    if (curse_expires && new Date(curse_expires).getTime() > now) {
      return res
        .status(403)
        .json({ error: 'You are still cursed', curse_expires })
    }
    if (is_cursed && curse_expires && new Date(curse_expires).getTime() <= now) {
      await pool.query(
        `UPDATE players SET is_cursed = FALSE, curse_expires = NULL WHERE tg_id = $1`,
        [tg_id]
      )
    }
    const lastMs = last_burn ? new Date(last_burn).getTime() : 0
    if (now - lastMs < 2 * 60 * 1000) {
      return res.status(429).json({ error: 'Burn cooldown active' })
    }

    // 2) создаём запись burn_invoices
    const invoiceId = crypto.randomUUID()
    const amountNano = 500_000_000  // 0.5 TON в наносах
    await pool.query(
      `INSERT INTO burn_invoices (invoice_id, tg_id, amount_nano, address, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [invoiceId, tg_id, amountNano, TON_ADDRESS]
    )

    // 3) генерим ссылку через Telegram Bot API
    const prices = [{ label: 'Burn 0.5 TON', amount: amountNano }]
    const link = await bot.createInvoiceLink({
      chat_id:       Number(tg_id),
      title:         '🔥 Burn Yourself',
      description:   'Сожгите 0.5 TON и получите новый фрагмент',
      payload:       invoiceId,
      provider_token: PAYMENT_PROVIDER_TOKEN,
      currency:      'TON',
      prices,
      photo_url:     undefined,
      is_flexible:   false,
    })

    // 4) отвечаем клиенту
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name })
    res.setHeader('Authorization', `Bearer ${token}`)
    res.json({ invoiceLink: link, invoiceId })
  } catch (err) {
    console.error('[POST /create-invoice] error:', err)
    res.status(500).json({ error: 'internal error' })
  }
})

export default router

// после определения runBurnLogic
export { runBurnLogic }