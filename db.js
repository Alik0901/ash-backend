// db.js ── PostgreSQL pool

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Выведем все переменные, относящиеся к PG
console.log('▶️ [db.js] ENV PORT         =', process.env.PORT);
console.log('▶️ [db.js] ENV DATABASE_URL =', process.env.DATABASE_URL);
console.log('▶️ [db.js] ENV PGHOST       =', process.env.PGHOST);
console.log('▶️ [db.js] ENV PGPORT       =', process.env.PGPORT);
console.log('▶️ [db.js] ENV PGDATABASE   =', process.env.PGDATABASE);
console.log('▶️ [db.js] ENV PGUSER       =', process.env.PGUSER);
console.log('▶️ [db.js] ENV PGPASSWORD   =', process.env.PGPASSWORD);
console.log('▶️ [db.js] ENV PGSSLMODE    =', process.env.PGSSLMODE);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

console.log('▶️ [db.js] Pool config      =', {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE,
  max: pool.options.max,
});

pool.on('error', err => {
  console.error('🔥 Unexpected PG client error', err);
});

export default pool;
