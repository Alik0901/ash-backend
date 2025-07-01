// src/routes/validateFinal.js
import express from 'express'
import jwt     from 'jsonwebtoken'
import pool    from '../db.js'
import { authenticate } from '../middleware/auth.js'

const router = express.Router()
const {
  JWT_SECRET,
  FINAL_PHRASE_TEMPLATE = 'The Final Shape'
} = process.env

function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
}

// Все запросы здесь уже проходят authenticate (см. index.js)
router.post('/', authenticate, async (req, res) => {
  const { userId, inputPhrase } = req.body
  if (!userId || !inputPhrase) {
    return res.status(400).json({ ok: false, error: 'Missing userId or inputPhrase' })
  }

  // Убедимся, что под токеном тот же игрок
  if (String(req.user.tg_id) !== String(userId)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' })
  }

  try {
    // Берём имя, дату регистрации и список фрагментов
    const { rows } = await pool.query(
      `SELECT name, created_at, fragments
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [userId]
    )
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' })
    }

    const { name, created_at, fragments } = rows[0]

    // Проверяем, что окно ввода – та же минута, что и регистрация, и все фрагменты собраны
    const created = new Date(created_at)
    const now     = new Date()
    const sameMinute =
      created.getUTCFullYear()  === now.getUTCFullYear() &&
      created.getUTCMonth()     === now.getUTCMonth() &&
      created.getUTCDate()      === now.getUTCDate() &&
      created.getUTCHours()     === now.getUTCHours() &&
      created.getUTCMinutes()   === now.getUTCMinutes()

    if (!sameMinute || (fragments || []).length !== 8) {
      return res.status(400).json({
        ok: false,
        error: 'Time window for final phrase has expired or fragments missing'
      })
    }

    // Собираем ожидаемую фразу из шаблона + имя
    const expected = `${FINAL_PHRASE_TEMPLATE} ${name}`.trim()
    if (inputPhrase.trim() !== expected) {
      return res.status(400).json({ ok: false, error: 'Incorrect final phrase' })
    }

    // Успех — обновляем токен и отдаем ok:true
    const newToken = generateToken({ tg_id: req.user.tg_id, name: req.user.name })
    res.setHeader('Authorization', `Bearer ${newToken}`)
    return res.json({ ok: true })
  } catch (err) {
    console.error('[VALIDATE FINAL ERROR]', err)
    return res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})

export default router
