// index.js — сервер + CORS + healthcheck + debug-эндпоинты

// Включаем разовый хак для TLS (чтобы NODE не вырубал соединения с самоподписанным)
// можно убрать, когда убедимся, что сломанный SSL более не нужен
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import express   from 'express';
import helmet    from 'helmet';
import cors      from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv    from 'dotenv';

// Запускаем воркер проверки платежей сразу же, он сам импортит db.js
import './worker/check-payments.js';

import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

// Подгружаем .env в dev
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

/* 1) Безопасные HTTP-заголовки */
app.use(helmet());

/* 2) CORS: разрешаем наш фронт + telegram.org */
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED.some(o => typeof o === 'string'
        ? o === origin
        : o.test(origin)
      )
    ) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin ${origin}`));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());

/* 3) Health-check для Railway */
app.get('/', (_req, res) => {
  res.sendStatus(200);
});

/* 4) Отключаем ETag и кэширование на всех /api */
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control','no-store');
  next();
});

/* 5) Ограничение размера JSON */
app.use(express.json({ limit: '10kb' }));

/* 6) Rate-limit для validate */
const validateLimiter = rateLimit({
  windowMs:    15 * 60 * 1000,
  max:         30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:     { error: 'Too many requests, please try later.' }
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

/* 7) Проксируем /api: public vs JWT */
app.use('/api', (req, res, next) => {
  const { method, path } = req;
  if (method === 'OPTIONS') return next();
  if (method === 'POST' && path === '/init') return next();
  if (method === 'GET' && /^\/player\/[^/]+$/.test(path)) return next();
  return authenticate(req, res, next);
});

/* 8) Игровые маршруты */
app.use('/api', playerRoutes);

/* === debug-эндпоинты для проверки сети/DNS/БД === */
import dns from 'dns/promises';

// Проверяем резолвинг приватного имени
app.get('/debug/dns', async (_req, res) => {
  try {
    const info = await dns.lookup('postgres.railway.internal');
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Минимальный тест подключения к БД
import pool from './db.js';
app.get('/test-db', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code });
  }
});

/* 9) Запуск сервера */
const PORT = process.env.PORT;
if (!PORT) {
  console.error(
    '❌  $PORT env variable is not set! Railway назначает его автоматически.'
  );
  process.exit(1);
}
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢  Server is listening on port ${PORT}`);
});
