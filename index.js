// index.js — окончательная версия с расширенным CORS и health-check
import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import dotenv         from 'dotenv';

// Запускаем воркер проверки платежей
import './worker/check-payments.js';

// Роуты и middleware
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

// Загружаем .env только в development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

/* ──────────────────────────────────────────────────────────────── */
/* 1) Безопасные HTTP-заголовки                                   */
app.use(helmet());

/* ──────────────────────────────────────────────────────────────── */
/* 2) CORS: разрешаем запросы только с вашего фронта и Telegram   */
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/  // любой поддомен telegram.org
];

app.use(cors({
  origin: (origin, callback) => {
    // не-браузерные клиенты (curl, Postman) пропускаем
    if (!origin) return callback(null, true);
    // совпадение строки или regexp
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
// Обрабатываем preflight для всех путей
app.options('*', cors());

/* ──────────────────────────────────────────────────────────────── */
/* 3) Health-check для Railway (root GET должен вернуть 200)      */
app.get('/', (_req, res) => {
  res.sendStatus(200);
});

/* ──────────────────────────────────────────────────────────────── */
/* 4) Отключаем ETag и запрещаем кэширование всех /api              */
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control','no-store');
  next();
});

/* ──────────────────────────────────────────────────────────────── */
/* 5) Ограничение размера JSON                                     */
app.use(express.json({ limit: '10kb' }));

/* ──────────────────────────────────────────────────────────────── */
/* 6) Rate-limit для /api/validate и /api/validate-final           */
const validateLimiter = rateLimit({
  windowMs:    15 * 60 * 1000, // 15 минут
  max:         30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:     { error: 'Too many requests, please try later.' }
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

/* ──────────────────────────────────────────────────────────────── */
/* 7) «Проксируем» /api — публичные и защищённые маршруты          */
app.use('/api', (req, res, next) => {
  const { method, path } = req;

  // OPTIONS всегда разрешены
  if (method === 'OPTIONS') return next();
  // POST /api/init – публичный маршрут регистрации
  if (method === 'POST' && path === '/init') return next();
  // GET /api/player/:tg_id – публичный (чтение профиля)
  if (method === 'GET' && /^\/player\/[^/]+$/.test(path)) return next();

  // всё остальное — через JWT-аутентификацию
  return authenticate(req, res, next);
});

/* ──────────────────────────────────────────────────────────────── */
/* 8) Игровые маршруты */
app.use('/api', playerRoutes);

/* ──────────────────────────────────────────────────────────────── */
/* 9) Запуск сервера на порту из env.PORT, слушаем 0.0.0.0         */
const PORT = process.env.PORT;
if (!PORT) {
  console.error(
    '❌  $PORT env variable is not set! ' +
    'Railway назначает его автоматически, не переопределяйте.'
  );
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢  Server is listening on port ${PORT}`);
});
