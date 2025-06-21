// index.js — основная точка входа приложения

import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import dotenv         from 'dotenv';
import dns            from 'dns/promises';

import pool           from './db.js';                   // ваш pg Pool
import './worker/check-payments.js';                   // запускаем воркер
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

// Загружаем .env в development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

// Логгируем строку подключения при старте
console.log('ℹ️  ENV DATABASE_URL =', process.env.DATABASE_URL);

// 1) Безопасные HTTP-заголовки
app.use(helmet());

// 2) CORS: разрешаем только ваш фронт и telegram.org
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED.some(o => typeof o === 'string' ? o === origin : o.test(origin))) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin ${origin}`));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());

// 3) Health-check (Railway)
app.get('/', (_req, res) => res.sendStatus(200));

// 4) Запрещаем кэширование для всех /api
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control','no-store');
  next();
});

// 5) Ограничение размера JSON
app.use(express.json({ limit: '10kb' }));

// 6) Rate-limit для валидации
const validateLimiter = rateLimit({
  windowMs:    15 * 60 * 1000,
  max:         30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:     { error: 'Too many requests, please try later.' }
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// 7) Проксируем /api: public vs authenticated
app.use('/api', (req, res, next) => {
  const { method, path } = req;
  if (method === 'OPTIONS') return next();
  if (method === 'POST' && path === '/init') return next();
  if (method === 'GET'  && /^\/player\/[^/]+$/.test(path)) return next();
  return authenticate(req, res, next);
});

// 8) Игровые маршруты
app.use('/api', playerRoutes);

// ———————————————————————————————————————————————————————————————
// DIAGNOSTICS: тест подключения к базе
app.get('/test-db', async (_req, res) => {
  // Логгируем DNS-резолвинг хоста
  const host = process.env.DATABASE_URL?.split('@')[1]?.split('/')[0];
  if (host) {
    try {
      const addr = await dns.lookup(host);
      console.log('🔍 DNS lookup:', host, '→', addr);
    } catch (e) {
      console.error('❌ DNS lookup failed:', host, e.code, e.message);
    }
  }

  console.log('📡 [test-db] trying query on', process.env.DATABASE_URL);
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    console.log('✅ [test-db] success');
    return res.json({ ok: rows[0].ok });
  } catch (err) {
    console.error('❌ [test-db] failed:', err.code, err.message);
    return res.status(500).json({ error: err.message, code: err.code });
  }
});
// ———————————————————————————————————————————————————————————————

// 9) Запуск сервера
const PORT = process.env.PORT;
if (!PORT) {
  console.error('❌  $PORT env variable is not set!');
  process.exit(1);
}
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢  Server is listening on port ${PORT}`);
});
