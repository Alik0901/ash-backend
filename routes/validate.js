// файл: src/routes/validate.js
import express from 'express';
import crypto  from 'crypto';
import process from 'process';
import jwt     from 'jsonwebtoken';
import pool    from '../db.js';

const router    = express.Router();
const BOT_TOKEN = process.env.BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;

// Проверяем обязательные переменные окружения
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET не задан');
  process.exit(1);
}

// Генерация случайного реф-кода
function randRef() {
  return crypto.randomBytes(6).toString('base64url');
}

// Генерация уникального реф-кода, проверка в БД
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
 * POST /api/validate
 * Проверка подписи Telegram initData, создание/обновление профиля и выдача JWT
 */
router.post('/', async (req, res) => {
  const { initData } = req.body;

  if (!initData) {
    console.warn('[VALIDATE] ❌ Пустой initData');
    return res.status(400).json({ ok: false, error: 'initData is required' });
  }

  try {
    // Разбираем initData формата "key1=value1&key2=value2..."
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    params.delete('hash');

    if (!hash) {
      console.warn('[VALIDATE] ❌ Отсутствует параметр hash');
      return res.status(400).json({ ok: false, error: 'Missing hash parameter' });
    }

    // Строка для проверки подписи
    const dataCheckString = [...params.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('\n');

    // Секрет для HMAC из BOT_TOKEN (часть после ":")
    const secretPart = BOT_TOKEN.includes(':')
      ? BOT_TOKEN.split(':')[1]
      : BOT_TOKEN;
    const secret = crypto.createHash('sha256')
                         .update(secretPart)
                         .digest();

    // Вычисляем HMAC и сравниваем с hash
    const computedHash = crypto.createHmac('sha256', secret)
                               .update(dataCheckString)
                               .digest('hex');
    if (computedHash !== hash) {
      console.warn('[VALIDATE] ❌ Неверная подпись initData');
      return res.status(403).json({ ok: false, error: 'Invalid initData signature' });
    }

    // Извлекаем данные пользователя из initData
    const userJson = params.get('user');
    if (!userJson) {
      console.warn('[VALIDATE] ❌ Отсутствуют данные user в initData');
      return res.status(400).json({ ok: false, error: 'Missing user data' });
    }
    const userInfo = JSON.parse(userJson);

    // Создаем или обновляем профиль в БД
    const tgId  = userInfo.id;
    const name  = userInfo.first_name || null;
    let player;
    const { rows } = await pool.query(
      `SELECT 1 FROM players WHERE tg_id = $1`,
      [tgId]
    );
    if (!rows.length) {
      // Новый игрок
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const code = await genUniqueCode();
        const { rows: [me] } = await client.query(
          `INSERT INTO players
             (tg_id, name, ref_code, referral_reward_issued)
           VALUES ($1, $2, $3, FALSE)
           RETURNING *`,
          [tgId, name, code]
        );
        // Обновляем глобальную статистику
        await client.query(
          `UPDATE global_stats SET value = value + 1 WHERE id = 'total_users'`
        );
        await client.query('COMMIT');
        player = me;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[VALIDATE] error creating user', err);
        throw err;
      } finally {
        client.release();
      }
    } else {
      // Существующий игрок
      const { rows: [me] } = await pool.query(
        `SELECT * FROM players WHERE tg_id = $1`,
        [tgId]
      );
      player = me;
    }

    // Генерируем JWT для клиента
    const token = jwt.sign(
      { tg_id: player.tg_id, name: player.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({ ok: true, user: player, token });
  } catch (err) {
    console.error('[VALIDATE ERROR]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
