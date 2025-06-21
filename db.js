// db.js
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

console.log('ℹ️  ENV DATABASE_URL =', process.env.DATABASE_URL);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Мы теперь подключаемся внутри сети Railway, SSL не нужен:
  ssl: false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('❌ PG pool error:', err.code, err.message);
});

// сразу проверим коннект на старте
;(async () => {
  try {
    const client = await pool.connect();
    console.log('✅ PG initial connection successful');
    client.release();
  } catch (err) {
    console.error('❌ PG initial connection failed:', err.code, err.message);
    // process.exit(1);
  }
})();

export default pool;
