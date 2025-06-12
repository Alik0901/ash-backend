import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const JWT_SECRET  = process.env.JWT_SECRET;
const TON_ADDRESS = process.env.TON_WALLET_ADDRESS;

/**
 * Генерация JWT
 */
function generateToken(payload) {
  return jwt.sign(
    { tg_id: payload.tg_id, name: payload.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/**
 * GET /api/player/:tg_id
 * — публичный, возвращает профиль игрока
 */
router.get('/player/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT tg_id, name, fragments, last_burn, is_cursed, curses_count, curse_expires, created_at
         FROM players
        WHERE tg_id = $1
        LIMIT 1`,
      [tg_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('[player] GET /api/player error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * POST /api/init
 * — публичный, создаёт или возвращает игрока + выдаёт JWT
 */
router.post('/init', async (req, res) => {
  const { tg_id, name, initData } = req.body;
  if (!tg_id || !initData) {
    return res.status(400).json({ error: 'tg_id and initData are required' });
  }
  try {
    let { rows } = await pool.query(
      `SELECT * FROM players WHERE tg_id = $1`,
      [tg_id]
    );
    if (!rows.length) {
      ({ rows } = await pool.query(
        `INSERT INTO players (tg_id, name, is_cursed, curses_count, curse_expires)
         VALUES ($1, $2, FALSE, 0, NULL)
         RETURNING *`,
        [tg_id, name || null]
      ));
    }
    const user = rows[0];
    const token = generateToken({ tg_id: user.tg_id, name: user.name });
    return res.json({ user, token });
  } catch (err) {
    console.error('[player] POST /api/init error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// Все маршруты ниже — под JWT
router.use(authenticate);

/**
 * GET /api/fragments/:tg_id
 */
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id = $1`,
      [tg_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'player not found' });
    }
    const fragments = rows[0].fragments || [];
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    return res.json({ fragments });
  } catch (err) {
    console.error('[player] GET /api/fragments error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/stats/total_users
 */
router.get('/stats/total_users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM global_stats WHERE id = 'total_users'"
    );
    const value = rows.length ? rows[0].value : 0;
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    return res.json({ value });
  } catch (err) {
    console.error('[player] GET /api/stats/total_users error:', err);
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    return res.json({ value: 0 });
  }
});

/**
 * POST /api/burn-invoice
 * — создаёт счёт на 0.5 TON (500 000 000 нанотонн), сохраняет в БД и возвращает
 *   { ok, invoiceId, tonInvoice: { address, amountNano, comment } }
 */
router.post('/burn-invoice', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) {
    return res.status(400).json({ ok: false, error: 'tg_id is required' });
  }
  if (req.user.tg_id.toString() !== tg_id.toString()) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    // 1) Проверка двухминутного кулдауна и проклятия
    const { rows: pr } = await pool.query(
      `SELECT last_burn, is_cursed, curse_expires
         FROM players
        WHERE tg_id = $1`,
      [tg_id]
    );
    if (!pr.length) {
      return res.status(404).json({ ok: false, error: 'player not found' });
    }
    const { last_burn, is_cursed, curse_expires } = pr[0];
    const now = new Date();
    // Если ещё под проклятием
    if (curse_expires && new Date(curse_expires) > now) {
      return res
        .status(403)
        .json({ ok: false, error: 'You are still cursed', curse_expires });
    }
    // Снятие просроченного
    if (is_cursed && curse_expires && new Date(curse_expires) <= now) {
      await pool.query(
        `UPDATE players
            SET is_cursed = FALSE,
                curse_expires = NULL
          WHERE tg_id = $1`,
        [tg_id]
      );
    }
    // Кулдаун 2 мин
    const lastMs = last_burn ? new Date(last_burn).getTime() : 0;
    if (now.getTime() - lastMs < 2 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: 'Burn cooldown active' });
    }

    // 2) Создаём invoice
    const amountNano = 500_000_000; // 0.5 TON
    const comment    = 'burn-' + Date.now();
    const { rows: ir } = await pool.query(
      `INSERT INTO burn_invoices (tg_id, amount_nano, address, comment)
       VALUES ($1, $2, $3, $4)
       RETURNING invoice_id`,
      [tg_id, amountNano, TON_ADDRESS, comment]
    );
    const invoiceId = ir[0].invoice_id;

    // 3) Отправляем клиенту данные
    const token = generateToken({ tg_id: req.user.tg_id, name: req.user.name });
    res.setHeader('Authorization', `Bearer ${token}`);
    return res.json({
      ok: true,
      invoiceId,
      tonInvoice: { address: TON_ADDRESS, amountNano, comment }
    });
  } catch (err) {
    console.error('[player] POST /api/burn-invoice error:', err);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * GET /api/burn-status/:invoiceId?
 * — проверяет статус. Если invoiceId не передан или == 'null',
 *   берёт последний созданный счёт для этого пользователя.
 *   При status === 'paid' вызывает runBurnLogic и возвращает результат.
 */
router.get('/burn-status/:invoiceId?', async (req, res) => {
  let invoiceId = req.params.invoiceId || req.query.invoiceId;
  if (!invoiceId || invoiceId === 'null') {
    const { rows } = await pool.query(
      `SELECT invoice_id
         FROM burn_invoices
        WHERE tg_id = $1
     ORDER BY created_at DESC
        LIMIT 1`,
      [req.user.tg_id]
    );
    invoiceId = rows[0]?.invoice_id;
  }
  if (!invoiceId) {
    return res.status(400).json({ ok: false, error: 'invoiceId missing' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT tg_id, status
         FROM burn_invoices
        WHERE invoice_id = $1`,
      [invoiceId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'invoice not found' });
    }
    if (rows[0].tg_id.toString() !== req.user.tg_id.toString()) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    // если уже оплачено
    if (rows[0].status === 'paid') {
      const burnResult = await runBurnLogic(req.user.tg_id);
      return res.json({ ok: true, paid: true, ...burnResult });
    }
    // иначе статус pending (или любой другой) — ждём оплаты
    return res.json({ ok: true, paid: false });
  } catch (err) {
    console.error('[player] GET /api/burn-status error:', err);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/**
 * runBurnLogic(tgId)
 * — выдаёт либо проклятие, либо фрагмент по вашей бизнес-логике,
 *   обновляет записи в БД и возвращает результат:
 *   { cursed: boolean, curse_expires?: string, newFragment?: number, fragments?: number[], lastBurn?: string }
 */
async function runBurnLogic(tgId) {
  // 1) Считываем данные игрока
  const playerRes = await pool.query(
    `SELECT fragments, is_cursed, curses_count
       FROM players
      WHERE tg_id = $1
      LIMIT 1`,
    [tgId]
  );
  const row = playerRes.rows[0];
  const fragments = row.fragments || [];
  const isCursed   = row.is_cursed;
  const cursesCount = row.curses_count;
  const now = new Date();

  // 2) Если вдруг осталось is_cursed == true
  if (isCursed) {
    // возвращаем текущее проклятие (маловероятно)
    return { cursed: true, curse_expires: now.toISOString() };
  }

  // 3) Подсчитываем общее число «сжиганий»
  const totalBurns = fragments.length + cursesCount;

  // 4) Решаем, дать проклятие или фрагмент
  let giveCurse = false;
  if (totalBurns < 3) {
    giveCurse = false; // первые три всегда фрагменты
  } else if (cursesCount < 6) {
    giveCurse = Math.random() < 0.5; // до 6 проклятий — 50/50
  } else {
    giveCurse = false; // после 6 проклятий — только фрагменты
  }

  if (giveCurse) {
    // выдаём проклятие на 24 часа
    const newCount = cursesCount + 1;
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await pool.query(
      `UPDATE players
          SET is_cursed = TRUE,
              curses_count = $1,
              curse_expires = $2
        WHERE tg_id = $3`,
      [newCount, expiresAt.toISOString(), tgId]
    );
    return { cursed: true, curse_expires: expiresAt.toISOString() };
  }

  // 5) Выдаём новый фрагмент
  const allFragments = [1, 2, 3, 4, 5, 6, 7, 8];
  const owned = fragments;
  const available = allFragments.filter(f => !owned.includes(f));
  const idx = Math.floor(Math.random() * available.length);
  const newFragment = available[idx];
  const updatedFragments = [...owned, newFragment];

  await pool.query(
    `UPDATE players
        SET fragments = $1,
            last_burn  = NOW()
      WHERE tg_id = $2`,
    [updatedFragments, tgId]
  );
  // Увеличиваем глобальную статистику
  await pool.query(
    `UPDATE global_stats
        SET value = value + 1
      WHERE id = 'total_users'`
  );

  return {
    cursed: false,
    newFragment,
    fragments: updatedFragments,
    lastBurn: now.toISOString()
  };
}

export default router;
