// src/routes/final.js
import express    from 'express';
import pool       from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// GET /api/final/:tg_id
// Пока без проверки по времени — просто проверяем, что собрано 8 фрагментов
router.get('/:tg_id', authenticate, async (req, res) => {
  try {
    const tg_id = req.params.tg_id;
    const { rows: [player] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id = $1 LIMIT 1`,
      [tg_id]
    );
    if (!player) return res.status(404).json({ error: 'player not found' });
    const gotAll = (player.fragments || []).length === 8;
    return res.json({ canEnter: gotAll });
  } catch (e) {
    console.error('Error in GET /api/final/:tg_id', e);
    return res.status(500).json({ error: 'internal' });
  }
});

export default router;
