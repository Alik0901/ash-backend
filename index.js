// index.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import playerRoutes       from './routes/player.js';
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import { authenticate }   from './middleware/auth.js';

dotenv.config();
const app = express();

// 1. HTTP security headers
app.use(helmet());

// 2. CORS — разрешаем только фронт и Telegram Web
app.use(
  cors({
    origin: [
      'https://clean-ash-order.vercel.app',
      'https://web.telegram.org',
    ],
  })
);

// 3. Парсинг JSON с ограничением размера тела
app.use(express.json({ limit: '10kb' }));

// 4. Rate limiting для эндпоинтов валидации
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 30, // максимум 30 запросов за окно
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' },
});
app.use('/api/validate', validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

/**
 * 5. Теперь подключаем playerRoutes под /api, но с промежуточным мидлваром:
 *    - Если это GET /api/player/:tg_id — не трогаем authenticate
 *    - Если это POST /api/init         — не трогаем authenticate
 *    - Иначе — пропускаем через authenticate
 */
app.use('/api', (req, res, next) => {
  const { method, path } = req;

  // 5.1) Если запрос на POST /api/init → без аутентификации
  if (method === 'POST' && path === '/init') {
    return next();
  }
  // 5.2) Если запрос на GET /api/player/:tg_id (пусть path начинается с '/player/')
  //      и дальше идёт число (или строка) — тоже без аутентификации
  if (method === 'GET' && path.match(/^\/player\/[^/]+$/)) {
    return next();
  }
  // Во всех остальных случаях требуем JWT
  return authenticate(req, res, next);
});

// 6. Подключаем все маршруты из playerRoutes на префикс /api
app.use('/api', playerRoutes);

// 7. Запуск сервера
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
