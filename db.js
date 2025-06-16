// src/db.js
import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // включаем TCP keep-alive, чтобы держать сокеты живыми
  keepAlive: true,
  // закрывать неактивные клиенты через 30 сек
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Ловим «неожиданные» ошибки клиента
pool.on('error', (err, client) => {
  console.error('Unexpected PG client error', err);
});

export default pool;
