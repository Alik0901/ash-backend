// index.js
import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import dotenv         from 'dotenv';

// Запускаем проверку платежей (воркер)
import './worker/check-payments.js';

// Роуты и аутентификация
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

// Подключение пула к PostgreSQL
import pool from './db.js';

// Загружаем .env в development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

/* ──────────────────────────────────────────────────────────────── */
/* 1) Безопасные HTTP-заголовки                                   */
app.use(helmet());

/* ──────────────────────────────────────────────────────────────── */
/* 2) CORS: только с фронта и Telegram                            */
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/   // любой поддомен telegram.org
];

app.use(cors({
  origin: (origin, callback) => {
    // ненативные клиенты (curl, Postman) пропускаем
    if (!origin) return callback(null, true);
    // совпадение строкой или регуляркой
    if (ALLOWED.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    )) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin ${origin}`));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
// Preflight
app.options('*', cors());

/* ──────────────────────────────────────────────────────────────── */
/* 3) Health-check на корень (Railway ждёт 200 на GET /)          */
app.get('/', (_req, res) => {
  res.sendStatus(200);
});

/* ──────────────────────────────────────────────────────────────── */
/* 4) Отключаем ETag и запрещаем кэширование /api                 */
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control','no-store');
  next();
});

/* ──────────────────────────────────────────────────────────────── */
/* 5) Ограничиваем размер JSON                                     */
app.use(express.json({ limit: '10kb' }));

/* ──────────────────────────────────────────────────────────────── */
/* 6) Rate-limit для `/api/validate*`                              */
const validateLimiter = rateLimit({
  windowMs:    15 * 60 * 1000, // 15 мин
  max:         30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:     { error: 'Too many requests, please try later.' }
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

/* ──────────────────────────────────────────────────────────────── */
/* 7) JWT-прокси /api                                             */
app.use('/api', (req, res, next) => {
  const { method, path } = req;
  if (method === 'OPTIONS') return next();
  if (method === 'POST' && path === '/init') return next();
  if (method === 'GET' && /^\/player\/[^\/]+$/.test(path)) return next();
  return authenticate(req, res, next);
});

/* ──────────────────────────────────────────────────────────────── */
/* 8) Игровые маршруты (/api/*)                                   */
app.use('/api', playerRoutes);

/* ──────────────────────────────────────────────────────────────── */
/* 9) Старт: сначала проверяем БД, потом HTTP-сервер                */
const PORT = process.env.PORT;
if (!PORT) {
  console.error('❌  $PORT env variable is not set');
  process.exit(1);
}

// Логируем ENV-переменные для дебага
console.log('ℹ️  ENV PORT         =', PORT);
console.log('ℹ️  ENV DATABASE_URL =', process.env.DATABASE_URL);

// Проверяем, что можем подключиться к Postgres
pool.query('SELECT 1')
  .then(() => {
    console.log('✅  PG initial connection successful');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🟢  Server is listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌  PG initial connection failed:', err);
    process.exit(1);
  });
