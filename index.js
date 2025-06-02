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

/** 1. HTTP security headers **/
app.use(helmet());

/** 2. CORS — разрешаем только наш фронт и Telegram Web **/
app.use(
  cors({
    origin: [
      'https://clean-ash-order.vercel.app',
      'https://web.telegram.org',
    ],
  })
);

/** 3. Парсинг JSON с ограничением размера тела **/
app.use(express.json({ limit: '10kb' }));

/** 4. Rate limiting для эндпоинтов валидации **/
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
 * 5. Монтируем все маршруты playerRoutes под префиксом '/api'
 *    Но перед этим ставим особую логику: 
 *    - Если запрос идёт на '/api/init', то авторизацию (authenticate) не делаем.
 *    - Для всех остальных путей внутри '/api' – вызываем authenticate.
 */
app.use('/api', (req, res, next) => {
  // req.path внутри этого middleware будет, например, '/init' или '/player/12345'
  // Если это именно '/init' (POST /api/init) — пропускаем без авторизации:
  if (req.path === '/init') {
    return next();
  }
  // Иначе пытаемся аутентифицировать по JWT:
  return authenticate(req, res, next);
});
app.use('/api', playerRoutes);

/** 6. Запуск сервера **/
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
