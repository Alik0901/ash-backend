/* Order-of-Ash · db.js — v2.2
   ───────────────────────────────────────────────────────────────────
   • pool.max ↑ 15  (было 5)
   • statement_timeout = 5000 мс для всех новых соединений
*/

import pg     from 'pg';
import dotenv from 'dotenv';

dotenv.config();

console.log('ℹ️  ENV DATABASE_URL =', process.env.DATABASE_URL);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,                 // внутренний Railway → SSL не нужен
  max: 15,                    // ← увеличили запас соединений
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/* statement_timeout = 5 s — для любого нового клиента */
pool.on('connect', client => {
  client.query('SET statement_timeout TO 5000')
        .catch(err => console.error('❌ failed to set statement_timeout:', err));
});

pool.on('error', err => {
  console.error('❌ PG pool error:', err.code, err.message);
});

/* быстрая проверка коннекта при старте */
(async () => {
  try {
    const client = await pool.connect();
    console.log('✅ PG initial connection successful');
    client.release();
  } catch (err) {
    console.error('❌ PG initial connection failed:', err.code, err.message);
  }
})();

export default pool;
