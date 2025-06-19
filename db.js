// db.js ── PostgreSQL pool (подключение не менялось)
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },  // Railway / Render требуют SSL
  keepAlive: true,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

pool.on('error', err => {
  console.error('Unexpected PG client error', err);
});

/*
   ⇣  Новые столбцы / таблицы после миграций ⇣
   ───────────────────────────────────────────
   players:
     • ref_code                VARCHAR UNIQUE
     • referral_reward_issued  BOOLEAN NOT NULL DEFAULT FALSE

   referrals:
     • id, referrer_id, referred_id, status ('pending'|'confirmed')
     • created_at, updated_at

   Эти поля/таблица уже используются в routes/player.js и worker/check-payments.js
*/

export default pool;