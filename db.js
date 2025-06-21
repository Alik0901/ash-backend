// db.js — Postgres Pool
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const {
  PGHOST,
  PGPORT,
  PGDATABASE,
  PGUSER,
  PGPASSWORD,
  PGSSLMODE,
  DATABASE_URL
} = process.env;

// Логи окружения для PG
console.log('▶️ [db.js] PGHOST      =', PGHOST);
console.log('▶️ [db.js] PGPORT      =', PGPORT);
console.log('▶️ [db.js] PGDATABASE  =', PGDATABASE);
console.log('▶️ [db.js] PGUSER      =', PGUSER);
console.log('▶️ [db.js] PGPASSWORD  =', PGPASSWORD ? '***' : undefined);
console.log('▶️ [db.js] PGSSLMODE   =', PGSSLMODE);
console.log('▶️ [db.js] DATABASE_URL=', DATABASE_URL);

// Формируем конфиг для Pool
const poolConfig = PGHOST
  ? {
      host:     PGHOST,
      port:     Number(PGPORT || 5432),
      database: PGDATABASE,
      user:     PGUSER,
      password: PGPASSWORD,
      ssl:      PGSSLMODE === 'require'
                 ? { rejectUnauthorized: false }
                 : false,
      max:      5,
      idleTimeoutMillis:     30000,
      connectionTimeoutMillis: 5000
    }
  : {
      connectionString: DATABASE_URL,
      ssl: PGSSLMODE === 'require'
           ? { rejectUnauthorized: false }
           : false,
      max: 5,
      idleTimeoutMillis:     30000,
      connectionTimeoutMillis: 5000
    };

console.log('▶️ [db.js] Pool config =', poolConfig);

const pool = new pg.Pool(poolConfig);

pool.on('error', err => {
  console.error('🔥 Unexpected PG client error', err);
});

export default pool;
