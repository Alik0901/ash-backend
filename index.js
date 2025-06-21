// index.js

import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import dotenv         from 'dotenv';

// запустим воркер параллельно
import './worker/check-payments.js';

import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Отладочные логи всех ключевых ENV
console.log('▶️ [index.js] ENV.NODE_ENV    =', process.env.NODE_ENV);
console.log('▶️ [index.js] ENV.PORT        =', process.env.PORT);
console.log('▶️ [index.js] ENV.DATABASE_URL=', process.env.DATABASE_URL);
console.log('▶️ [index.js] ENV.PGHOST      =', process.env.PGHOST);
console.log('▶️ [index.js] ENV.PGPORT      =', process.env.PGPORT);

const app = express();

// 1) Безопасные заголовки
app.use(helmet());

// 2) CORS
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/,
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const ok = ALLOWED.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    if (ok) return cb(null, true);
    console.warn(`🔴 CORS blocked for: ${origin}`);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.options('*', cors());

// 3) Health-check
app.get('/', (_req, res) => res.sendStatus(200));

// 4) no-cache для /api
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control','no-store');
  next();
});

// 5) JSON-limit
app.use(express.json({ limit: '10kb' }));

// 6) Rate-limit
const validateLimiter = rateLimit({
  windowMs: 15*60*1000,
  max:      30,
  message:  { error: 'Too many requests, please try later.' },
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// 7) Тестовый маршрут для БД
app.get('/test-db', async (_req, res) => {
  try {
    const pool = (await import('./db.js')).default;
    const { rows } = await pool.query('SELECT NOW() AS now');
    console.log('✅ [/test-db] DB responded:', rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error('🔴 [/test-db] DB error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8) Проксирование /api
app.use('/api', (req, res, next) => {
  const { method, path } = req;
  if (method === 'OPTIONS') return next();
  if (method === 'POST' && path === '/init') return next();
  if (method === 'GET'  && /^\/player\/[^/]+$/.test(path)) return next();
  return authenticate(req, res, next);
});

// 9) Игровые маршруты
app.use('/api', playerRoutes);

// 10) Запуск
const PORT = Number(process.env.PORT);
if (!PORT) {
  console.error('❌ $PORT is not defined! Exiting.');
  process.exit(1);
}
console.log('▶️ [index.js] Will listen on port', PORT);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢  Server is listening on port ${PORT}`);
});
