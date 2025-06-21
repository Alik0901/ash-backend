// db.js
import pg     from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Логи ENV, относящихся к PG
console.log('▶️ [db.js] ENV.DATABASE_URL =', process.env.DATABASE_URL);
console.log('▶️ [db.js] ENV.PGHOST       =', process.env.PGHOST);
console.log('▶️ [db.js] ENV.PGPORT       =', process.env.PGPORT);
console.log('▶️ [db.js] ENV.PGSSLMODE    =', process.env.PGSSLMODE);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require'
       ? { rejectUnauthorized: false }
       : false,
  max: 5,
  idleTimeoutMillis:      30000,
  connectionTimeoutMillis:5000,
});

console.log('▶️ [db.js] Pool config      =', {
  connectionString: pool.options.connectionString,
  ssl:               pool.options.ssl,
  max:               pool.options.max,
});

pool.on('error', err => {
  console.error('🔥 Unexpected PG client error', err);
});

export default pool;
