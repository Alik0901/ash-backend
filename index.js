// index.js — окончательная версия с Health-check
import express        from 'express';
import cors           from 'cors';
import helmet         from 'helmet';
import rateLimit      from 'express-rate-limit';
import dotenv         from 'dotenv';

// 1) воркер проверки платежей (каждые 30 с)
import './worker/check-payments.js';

import playerRoutes       from './routes/player.js';
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import { authenticate }   from './middleware/auth.js';

// Загружаем .env только в development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

// ── 1. Безопасные HTTP-заголовки ──────────────────────────────
app.use(helmet());

// ── 2. CORS для фронта и Telegram WebApp ───────────────────────
const corsConfig = {
  origin: [
    'https://clean-ash-order.vercel.app',
    'https://web.telegram.org'
  ]
};
app.use(cors(corsConfig));
app.options('/api/*', cors(corsConfig), (_req, res) => {
  res.sendStatus(204);
});

// ── 3. Health-check для Railway ─────────────────────────────────
app.get('/', (_req, res) => {
  // Всегда возвращаем 200 OK, чтобы контейнер считался healthy
  res.sendStatus(200);
});

// ── 4. Отключаем ETag и запрещаем кэширование API ───────────────
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── 5. Парсинг JSON c ограничением размера ──────────────────────
app.use(express.json({ limit: '10kb' }));

// ── 6. Rate-limit для /validate и /validate-final ───────────────
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 минут
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' }
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// ── 7. Proxy-auth для всех остальных /api ───────────────────────
app.use('/api', (req, res, next) => {
  const { method, path } = req;

  // Allow preflight
  if (method === 'OPTIONS') return next();

  // Allow public registration
  if (method === 'POST' && path === '/init') return next();

  // Allow public profile fetch
  if (method === 'GET' && /^\/player\/[^/]+$/.test(path)) return next();

  // Everything else requires JWT auth
  return authenticate(req, res, next);
});

// ── 8. Игровые маршруты ─────────────────────────────────────────
app.use('/api', playerRoutes);

// ── 9. Запуск сервера ───────────────────────────────────────────
const PORT = process.env.PORT;
if (!PORT) {
  console.error(
    '❌  $PORT env variable is not set! ' +
    'Railway assigns it automatically — do not override it.'
  );
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢  Server is listening on port ${PORT}`);
});
