// index.js
import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import dotenv         from 'dotenv';

// Запускаем воркер параллельно (не блокирует основной поток)
import './worker/check-payments.js';

import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

// 1) Безопасные заголовки
app.use(helmet());

// 2) CORS
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

// 5) JSON-парсер с лимитом
app.use(express.json({ limit: '10kb' }));

// 6) Rate-limit для /api/validate*
const validateLimiter = rateLimit({
  windowMs:    15 * 60 * 1000,
  max:         30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:     { error: 'Too many requests, please try later.' },
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// 7) Тестовый маршрут для БД
app.get('/test-db', async (_req, res) => {
  try {
    const { default: pool } = await import('./db.js');
    const { rows } = await pool.query('SELECT NOW()');
    return res.json({ now: rows[0].now });
  } catch (err) {
    console.error('🔴 /test-db error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 8) JWT-прокси для остальных /api
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.method === 'POST'  && req.path === '/init') return next();
  if (req.method === 'GET'   && /^\/player\/[^/]+$/.test(req.path)) return next();
  return authenticate(req, res, next);
});

// 9) Игровые маршруты
app.use('/api', playerRoutes);

// 10) Запуск на динамическом порту (выдаваемом Railway)
const PORT = parseInt(process.env.PORT, 10);
if (!PORT) {
  console.error('❌ $PORT is not defined!');
  process.exit(1);
}

console.log('▶️ [index.js] ENV PORT =', PORT);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Server is listening on port ${PORT}`);
});
