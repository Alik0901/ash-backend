// index.js
import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import dotenv         from 'dotenv';

// запустим воркер, он не должен блокировать основной поток
import './worker/check-payments.js';

import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

// 1. Безопасные заголовки
app.use(helmet());

// 2. CORS
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  'https://ash-backend-production.up.railway.app',
  /\.telegram\.org$/,
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const ok = ALLOWED.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    if (ok) return cb(null, true);
    console.warn(`🔴 CORS blocked for origin: ${origin}`);
    return cb(null, false);
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.options('*', cors());

// 3. Health-check
app.get('/', (_req, res) => res.sendStatus(200));

// 4. Отключаем ETag + no-cache для /api
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control','no-store');
  next();
});

// 5. JSON-лимит
app.use(express.json({ limit: '10kb' }));

// 6. Rate-limit для validate
const validateLimiter = rateLimit({
  windowMs:    15 * 60 * 1000,
  max:         30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:     { error: 'Too many requests, please try later.' },
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// 7. Тестовый маршрут для проверки БД
app.get('/test-db', async (_req, res) => {
  try {
    const { default: pool } = await import('./db.js');
    const { rows } = await pool.query('SELECT NOW()');
    res.json({ now: rows[0].now });
  } catch (err) {
    console.error('🔴 /test-db error:', err);
    res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

// 8. Проксируем /api — что публичное, что под JWT
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.method === 'POST' && req.path === '/init') return next();
  if (req.method === 'GET' && /^\/player\/[^/]+$/.test(req.path)) return next();
  return authenticate(req, res, next);
});

// 9. Игровые маршруты
app.use('/api', playerRoutes);

// 10. Запускаем на динамическом порту
const PORT = Number(process.env.PORT);
if (!PORT) {
  console.error('❌ $PORT is not defined!');
  process.exit(1);
}
// Обязательно печатаем, чтобы видеть в логах
console.log('▶️ ENV PORT =', PORT);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Server is listening on port ${PORT}`);
});
