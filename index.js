// index.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// ------------ запустим воркер в том же процессе ------------
import './worker/check-payments.js';  // <-- вот это

import playerRoutes       from './routes/player.js';
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import { authenticate }   from './middleware/auth.js';

dotenv.config();
const app = express();

// 1. Безопасные HTTP-заголовки
app.use(helmet());

// 2. CORS — разрешаем фронту и Telegram WebApp
const corsConfig = {
  origin: [
    'https://clean-ash-order.vercel.app',
    'https://web.telegram.org',
  ],
};
app.use(cors(corsConfig));                      // CORS для простых запросов
app.options('/api/*', cors(corsConfig), (req, res) => {
  // Явно обрабатываем preflight на всех /api/*
  res.sendStatus(204);
});

// 3. Парсинг JSON-тела (макс. 10kb)
app.use(express.json({ limit: '10kb' }));

// 4. Rate limiting для маршрутов validate и validate-final
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' },
});
app.use('/api/validate', validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// 5. Прокси для всех /api:
//    • OPTIONS /api/*         — пропускаем (preflight обработан выше)
//    • POST  /api/init         — публичный (регистрация)
//    • GET   /api/player/:tgId — публичный (чтение профиля)
//    • всё остальное           — через authenticate
app.use('/api', (req, res, next) => {
  const { method, path } = req;

  // 5.1. Preflight уже пропущен через app.options
  if (method === 'OPTIONS') {
    return next();
  }

  // 5.2. Регистрация нового игрока
  if (method === 'POST' && path === '/init') {
    return next();
  }

  // 5.3. Получение профиля по tg_id
  if (method === 'GET' && path.match(/^\/player\/[^/]+$/)) {
    return next();
  }

  // 5.4. Всё остальное — проверяем JWT
  return authenticate(req, res, next);
});

// 6. Подключаем маршруты из routes/player.js
app.use('/api', playerRoutes);

// 7. Запуск сервера
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
