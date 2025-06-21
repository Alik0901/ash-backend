// db.js ── PostgreSQL pool (подключение не менялось)
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Если вы подключаетесь к приватному endpoint:
  // в .env установите PGSSLMODE=disable
  // и здесь ssl=false
  ssl: process.env.PGSSLMODE === 'require'
       ? { rejectUnauthorized: false }
       : false,
  max: 5,                  // <= pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  keepAlive: true          // включаем TCP keep-alive
});

pool.on('error', err => {
  console.error('Unexpected PG client error', err);
});

export default pool;
