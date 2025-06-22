/* Order-of-Ash · index.js — v2.2
   ───────────────────────────────────────────────────────────────────
   • PORT из Railway или локально 3000
   • morgan('dev') → моментально видим 200 / 404 / 500 прямо в логах
   • остальной код без изменений
*/

import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import dotenv         from 'dotenv';
import morgan         from 'morgan';

// асинхронный воркер (не блокирует event-loop)
import './worker/check-payments.js';

import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

/* ─── env ─────────────────────────────────────────────────────────── */
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

/* ─── middleware ──────────────────────────────────────────────────── */
app.use(helmet());
app.use(morgan('dev'));               // ← НОВОЕ: подробные логи запросов

/* — CORS ----------------------------------------------------------- */
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/,
  /\.up\.railway\.app$/,
];
app.use(cors({
  origin: (o, cb) => {
    if (!o) return cb(null, true);
    if (ALLOWED.some(x => typeof x === 'string' ? x === o : x.test(o)))
      return cb(null, true);
    return cb(new Error(`CORS blocked: ${o}`));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.options('*', cors());

/* — Health-check --------------------------------------------------- */
app.get('/', (_req, res) => res.sendStatus(200));

/* — no-cache для /api --------------------------------------------- */
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/* — JSON body-limit ----------------------------------------------- */
app.use(express.json({ limit: '10kb' }));

/* — Rate-limit только для validate-маршрутов ---------------------- */
const validateLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please try later.' },
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

/* — Быстрый test-route к БД --------------------------------------- */
app.get('/test-db', async (_req, res) => {
  try {
    const { default: pool } = await import('./db.js');
    const { rows } = await pool.query('SELECT NOW() AS now');
    return res.json(rows[0]);
  } catch (err) {
    console.error('🔴 /test-db error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* — Auth-прокси для остальных /api -------------------------------- */
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.method === 'POST' && req.path === '/init') return next();
  if (req.method === 'GET'  && /^\/player\/[^/]+$/.test(req.path)) return next();
  return authenticate(req, res, next);
});

/* — Основные игровые маршруты ------------------------------------- */
app.use('/api', playerRoutes);

/* ─── запуск ─────────────────────────────────────────────────────── */
const rawPort = process.env.PORT || process.env.RAILWAY_PORT;
const PORT    = parseInt(rawPort, 10) || 3000;

console.log('▶️  Listening on port', PORT);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Server is listening on port ${PORT}`);
});
