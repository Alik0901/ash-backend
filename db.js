// db.js ── PostgreSQL pool (с пред-подключением и подробными логами)

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Покажем, откуда берем DATABASE_URL
console.log('ℹ️  ENV DATABASE_URL =', process.env.DATABASE_URL);

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Если вы подключаетесь по приватному хосту — SSL не нужен,
  // иначе отключаем проверку цепочки (Railway-прокси даёт самоподписанный).
  ssl: process.env.DATABASE_URL.includes('railway.internal')
       ? false
       : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Отслеживаем любые ошибки пула
pool.on('error', (err) => {
  console.error('❌ PG pool error:', err.code, err.message);
});

// Пытаемся подключиться немедленно — чтобы поймать ошибку на старте
;(async () => {
  try {
    const client = await pool.connect();
    console.log('✅ PG initial connection successful');
    client.release();
  } catch (err) {
    console.error('❌ PG initial connection failed:', err.code, err.message);
    // Если хотите — можно аварийно завершить процесс:
    // process.exit(1);
  }
})();

export default pool;
