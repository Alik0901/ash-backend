// index.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// 1) Сразу запускаем воркер проверки платежей
import './worker/check-payments.js';

import playerRoutes       from './routes/player.js';
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import { authenticate }   from './middleware/auth.js';

dotenv.config();
const app = express();

// 2. Безопасные HTTP-заголовки
app.use(helmet());

// 3. CORS — разрешаем фронту и Telegram WebApp
const corsConfig = {
  origin: [
    'https://clean-ash-order.vercel.app',
    'https://web.telegram.org',
  ],
};
app.use(cors(corsConfig));                      // простые запросы
app.options('/api/*', cors(corsConfig), (req, res) => {
  // явная обработка preflight для всех /api/*
  res.sendStatus(204);
});

// 4. Отключаем ETag и запрещаем кэширование API
app.disable('etag');
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// 5. Парсинг JSON с ограничением размера
app.use(express.json({ limit: '10kb' }));

// 6. Rate limiting для маршрутов validate и validate-final
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' },
});
app.use('/api/validate', validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// 7. «Прокси» для всех /api:
//    • OPTIONS  /api/*         — пропускаем (preflight обработан выше)
//    • POST     /api/init       — публичный (регистрация)
//    • GET      /api/player/:tg — публичный (профиль)
//    • всё остальное            — через authenticate
app.use('/api', (req, res, next) => {
  const { method, path } = req;

  if (method === 'OPTIONS') {
    return next();
  }
  if (method === 'POST' && path === '/init') {
    return next();
  }
  if (method === 'GET' && path.match(/^\/player\/[^/]+$/)) {
    return next();
  }

  return authenticate(req, res, next);
});

// 8. Подключаем игровые маршруты
app.use('/api', playerRoutes);

// 9. Запуск сервера
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🟢 Server is running on port ${PORT}`);
});
