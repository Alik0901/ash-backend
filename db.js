// db.js
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Railway → Postgres: нужен SSL
  // дополнительные, но безопасные параметры
  keepAlive: true,            // TCP keep-alive
  idleTimeoutMillis: 30_000,  // закроет неактивные через 30 c
  connectionTimeoutMillis: 5_000 
});

// логируем неожиданные ошибки клиента
pool.on('error', (err) => {
  console.error('Unexpected PG client error', err);
});

export default pool;
