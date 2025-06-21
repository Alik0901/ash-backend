// index.js
import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import dotenv         from 'dotenv';

// воркер проверки платежей — не блокирует основной поток
import './worker/check-payments.js';

import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

// только в development грузим .env
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

/* 1) Безопасные HTTP-заголовки */
app.use(helmet());

/* 2) CORS — теперь включает ваш frontend и Railway-домен */
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  'https://ash-backend-production.up.railway.app',
  /\.telegram\.org$/,
];

app.use(cors({
  origin: (origin, callback) => {
    // запросы без Origin (Postman, curl) пропускаем
    if (!origin) return callback(null, true);
    // совпадает ли origin с ALLOWED?
    const ok = ALLOWED.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    if (ok) return callback(null, true);
    console.warn(`🔴 CORS blocked for origin ${origin}`);
    // отклоняем без аварии
    return callback(null, false);
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
// preflight
app.options('*', cors());

/* 3) Health-check для Railway */
app.get('/', (_req, res) => res.sendStatus(200));

/* 4) Отключаем ETag и кэширование для /api */
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control','no-store');
  next();
});

/* 5) Ограничение размера JSON */
app.use(express.json({ limit: '10kb' }));

/* 6) Rate-limit для validate */
const validateLimiter = rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            30,
  standardHeaders:true,
  legacyHeaders:  false,
  message:        { error: 'Too many requests, please try later.' }
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

/* Тестовый маршрут для проверки БД */
app.get('/test-db', async (_req, res) => {
  try {
    const { rows } = await import('./db.js').then(m => m.default.query('SELECT NOW()'));
    return res.json({ now: rows[0].now });
  } catch (err) {
    console.error('🔴 test-db error:', err);
    return res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

/* 7) Проксируем /api: какие публичные, какие под JWT */
app.use('/api', (req, res, next) => {
  const { method, path } = req;
  if (method === 'OPTIONS') return next();
  if (method === 'POST' && path === '/init') return next();
  if (method === 'GET' && /^\/player\/[^/]+$/.test(path)) return next();
  return authenticate(req, res, next);
});

/* 8) Игровые маршруты */
app.use('/api', playerRoutes);

/* 9) Динамический порт из окружения */
const PORT = process.env.PORT;
if (!PORT) {
  console.error('❌ $PORT is not set!');
  process.exit(1);
}
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Server is listening on port ${PORT}`);
});
