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

// 3. Парсинг JSON с ограничением размера
app.use(express.json({ limit: '10kb' }));

// 4. Rate limiting для validate и validate-final
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' },
});
app.use('/api/validate', validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// 5. «Прокси» для всех маршрутов /api:
//    - POST /api/init и GET /api/player/:tg_id — без authenticate
//    - всё остальное — через authenticate
app.use('/api', (req, res, next) => {
  const { method, path } = req;
  if (method === 'POST' && path === '/init') {
    return next();
  }
  if (method === 'GET' && path.match(/^\/player\/[^/]+$/)) {
    return next();
  }
  return authenticate(req, res, next);
});

// 6. Подключаем playerRoutes на /api
app.use('/api', playerRoutes);

// 7. Запуск сервера
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
