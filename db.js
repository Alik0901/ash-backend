// db.js ── PostgreSQL pool (подключение + логгирование)

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Показываем, какую строку коннекта получили из env
console.log('ℹ️  ENV DATABASE_URL =', process.env.DATABASE_URL);

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    // отключаем проверку цепочки сертификатов Railway-прокси
    rejectUnauthorized: false
  },
  max: 5,               // <= pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Логируем неожиданные ошибки клиента
pool.on('error', (err, client) => {
  console.error('❌ Unexpected PG client error:', err.code, err.message);
});

export default pool;
