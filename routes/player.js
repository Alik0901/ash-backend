// routes/player.js
import express from 'express';
import pool from '../db.js';

const router = express.Router();

// Предопределённые части финальной фразы (кроме имени)
const PHRASE_PARTS = [
  'the key is time',
  'thirteen',
  'ashen',
  'mirror',
  'broken chain',
  'hour',
  'mark',
  'gate'
];

function computeExpectedPhrase(name) {
  return [...PHRASE_PARTS, name].join(' ').toLowerCase();
}

// 🔸 Регистрация или получение игрока
router.post('/init', async (req, res) => {
  const { tg_id, name } = req.body;
  if (!tg_id) return res.status(400).json({ error: 'tg_id is required' });

  try {
    const exists = await pool.query(
      'SELECT * FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (exists.rows.length > 0) return res.json(exists.rows[0]);

    const result = await pool.query(
      `INSERT INTO players (tg_id, name) VALUES ($1, $2) RETURNING *`,
      [tg_id, name]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// 🔸 Получение фрагментов
router.get('/fragments/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  try {
    const result = await pool.query(
      'SELECT fragments FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'player not found' });
    res.json(result.rows[0].fragments);
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// 🔥 Сожжение — выдать новый фрагмент
router.post('/burn', async (req, res) => {
  const { tg_id } = req.body;
  if (!tg_id) return res.status(400).json({ error: 'tg_id is required' });

  try {
    const playerRes = await pool.query(
      'SELECT * FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (playerRes.rows.length === 0)
      return res.status(404).json({ error: 'player not found' });

    const player = playerRes.rows[0];
    if (player.is_cursed) {
      return res.status(403).json({ error: 'you are cursed' });
    }

    const now = new Date();
    const last = player.last_burn ? new Date(player.last_burn) : null;
    if (last && now - last < 2 * 60 * 1000) {
      return res.status(403).json({ error: 'burn cooldown active' });
    }

    const allFragments = [1,2,3,4,5,6,7];
    const owned = player.fragments || [];
    const available = allFragments.filter(f => !owned.includes(f));
    if (available.length === 0) {
      return res.status(400).json({ message: 'all fragments collected' });
    }
    const newFragment = available[Math.floor(Math.random() * available.length)];
    const updatedFragments = [...owned, newFragment];

    await pool.query(
      'UPDATE players SET fragments = $1, last_burn = NOW() WHERE tg_id = $2',
      [updatedFragments, tg_id]
    );
    await pool.query(
      `UPDATE global_stats SET value = value + 1 WHERE id = 'total_users'`
    );

    res.json({ message: 'burn success', newFragment, fragments: updatedFragments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// 🔐 Проверка права входа на финальный экран
router.get('/final/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  try {
    const result = await pool.query(
      'SELECT fragments, created_at, name FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'player not found' });

    const player = result.rows[0];
    const fragments = player.fragments || [];
    const createdAt = new Date(player.created_at);
    const now = new Date();
    const allowed =
      fragments.length === 8 &&
      createdAt.getUTCFullYear() === now.getUTCFullYear() &&
      createdAt.getUTCMonth() === now.getUTCMonth() &&
      createdAt.getUTCDate() === now.getUTCDate() &&
      createdAt.getUTCHours() === now.getUTCHours() &&
      createdAt.getUTCMinutes() === now.getUTCMinutes();

    res.json({ canEnter: allowed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// 🔎 Проверка введённой фразы
router.post('/final', async (req, res) => {
  const { tg_id, phrase } = req.body;
  if (!tg_id || !phrase)
    return res.status(400).json({ error: 'tg_id and phrase are required' });

  try {
    const result = await pool.query(
      'SELECT fragments, created_at, name FROM players WHERE tg_id = $1',
      [tg_id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'player not found' });

    const player = result.rows[0];
    const fragments = player.fragments || [];
    const createdAt = new Date(player.created_at);
    const now = new Date();

    const timeMatch =
      createdAt.getUTCFullYear() === now.getUTCFullYear() &&
      createdAt.getUTCMonth() === now.getUTCMonth() &&
      createdAt.getUTCDate() === now.getUTCDate() &&
      createdAt.getUTCHours() === now.getUTCHours() &&
      createdAt.getUTCMinutes() === now.getUTCMinutes();

    if (fragments.length !== 8 || !timeMatch) {
      return res.status(403).json({ error: 'not allowed to enter phrase now' });
    }

    const expected = computeExpectedPhrase(player.name);
    if (phrase.trim().toLowerCase() === expected) {
      return res.json({ valid: true });
    } else {
      return res.status(400).json({ valid: false });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

export default router;
