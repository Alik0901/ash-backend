// index.js
import express          from 'express';
import cors             from 'cors';
import dotenv           from 'dotenv';
import helmet           from 'helmet';
import rateLimit        from 'express-rate-limit';

// 1) воркер проверки платежей (каждые 30 с)
import './worker/check-payments.js';

import playerRoutes       from './routes/player.js';
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import { authenticate }   from './middleware/auth.js';

dotenv.config();
const app = express();

/* ────────────────────────────────────────────────────────────── */
/* 1. Безопасные HTTP-заголовки                                   */
app.use(helmet());

/* 2. CORS – фронт и Telegram WebApp                              */
const corsConfig = {
  origin: [
    'https://clean-ash-order.vercel.app',
    'https://web.telegram.org',
  ],
};
app.use(cors(corsConfig));               // простые запросы
app.options('/api/*', cors(corsConfig), (_, res) => res.sendStatus(204));

/* 3. Отключаем ETag и кеш                                          */
app.disable('etag');
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/* 4. Парсинг JSON с ограничением размера                          */
app.use(express.json({ limit: '10kb' }));

/* 5. Rate-limit для /validate и /validate-final                    */
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 мин
  max: 30,
  standardHeaders: true,
  legacyHeaders : false,
  message       : { error: 'Too many requests, please try later.' },
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

/* 6. «Прокси» для всех /api                                        */
app.use('/api', (req, res, next) => {
  const { method, path } = req;

  if (method === 'OPTIONS') return next();
  if (method === 'POST' && path === '/init') return next();
  if (method === 'GET'  && /^\/player\/[^/]+$/.test(path)) return next();

  return authenticate(req, res, next);
});

/* 7. Игровые маршруты                                              */
app.use('/api', playerRoutes);

/* ─────────────── Запуск сервера ──────────────── */
const PORT = process.env.PORT;
if (!PORT) {
  console.error('❌  Environment variable PORT is not set.');
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢  Server is running on port ${PORT}`);
});
