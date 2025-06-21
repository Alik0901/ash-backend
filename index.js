// index.js — HTTP-сервер + CORS + healthcheck + debug

import express   from 'express';
import helmet    from 'helmet';
import cors      from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv    from 'dotenv';
import dns       from 'dns/promises';

import pool            from './db.js';               // наш пул
import './worker/check-payments.js';                 // воркер
import validateRoute   from './routes/validate.js';
import validateFinal   from './routes/validateFinal.js';
import playerRoutes    from './routes/player.js';
import { authenticate } from './middleware/auth.js';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

// 1) Безопасные заголовки
app.use(helmet());

// 2) CORS
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED.some(o => typeof o === 'string' ? o === origin : o.test(origin))) {
      return cb(null, true);
    }
    cb(new Error(`CORS blocked for origin ${origin}`));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());

// 3) Health-check
app.get('/', (_req, res) => res.sendStatus(200));

// 4) Отключаем ETag и кэширование /api
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control','no-store');
  next();
});

// 5) JSON-лимит
app.use(express.json({ limit: '10kb' }));

// 6) Rate-limit для валидации
const validateLimiter = rateLimit({
  windowMs: 15*60*1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' }
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinal);

// 7) Публичные vs JWT-защищённые /api
app.use('/api', (req, res, next) => {
  const { method, path } = req;
  if (method === 'OPTIONS')                  return next();
  if (method === 'POST' && path === '/init') return next();
  if (method === 'GET'  && /^\/player\/[^/]+$/.test(path)) return next();
  return authenticate(req, res, next);
});

// 8) Игровые маршруты
app.use('/api', playerRoutes);

// === DEBUG ===

// 9a) DNS-lookup приватного хоста
app.get('/debug/dns', async (_req, res) => {
  try {
    const info = await dns.lookup('postgres.railway.internal');
    res.json({ ok: true, info });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 9b) Простой тест БД
app.get('/test-db', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    res.json({ ok: rows[0].ok });
  } catch (e) {
    console.error('❌ [/test-db] error:', e.code, e.message);
    res.status(500).json({ ok: false, error: e.message, code: e.code });
  }
});

// 10) Запуск
const PORT = process.env.PORT;
if (!PORT) {
  console.error('❌ $PORT is not set');
  process.exit(1);
}
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Server listening on port ${PORT}`);
});
