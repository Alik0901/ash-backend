// index.js — полный файл сервера с отключённой проверкой сертификата, debug-логами и тестовым endpoint

// 0) Отключаем проверку самоподписанных сертификатов
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import dotenv from 'dotenv';
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// DEBUG: логируем строку подключения
console.log('> DATABASE_URL =', process.env.DATABASE_URL);

import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';

import pool           from './db.js';                   // подключаем пул из db.js
import './worker/check-payments.js';                   // стартуем воркер
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

const app = express();

/* 1) Безопасные HTTP-заголовки */
app.use(helmet());

/* 2) CORS: разрешаем запросы лишь с вашего фронта и любых поддоменов telegram.org */
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // curl, Postman и другие non-browser
    if (ALLOWED.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    )) return callback(null, true);
    return callback(new Error(`CORS blocked for origin ${origin}`));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());

/* 3) Health-check корня для Railway */
app.get('/', (_req, res) => {
  res.sendStatus(200);
});

/* 3.1) Тест подключения к БД */
app.get('/test-db', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    return res.json({ ok: rows[0].ok });
  } catch (err) {
    console.error('🔥 test-db error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* 4) Отключаем ETag и запрещаем кэширование для /api */
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control','no-store');
  next();
});

/* 5) Ограничиваем размер JSON-тела */
app.use(express.json({ limit: '10kb' }));

/* 6) Rate-limit для маршрутов валидации */
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' }
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

/* 7) Прокси для публичных и защищённых API-маршрутов */
app.use('/api', (req, res, next) => {
  const { method, path } = req;
  if (method === 'OPTIONS') return next();
  if (method === 'POST' && path === '/init') return next();
  if (method === 'GET'  && /^\/player\/[^/]+$/.test(path)) return next();
  return authenticate(req, res, next);
});

/* 8) Основные игровые маршруты */
app.use('/api', playerRoutes);

/* 9) Запуск сервера на порту из env.PORT */
const PORT = process.env.PORT;
if (!PORT) {
  console.error('❌ $PORT env variable is not set! Railway назначает его автоматически.');
  process.exit(1);
}
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Server is listening on port ${PORT}`);
});
