// index.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import playerRoutes       from './routes/player.js';
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';

dotenv.config();
const app = express();

// 1. HTTP security headers
app.use(helmet());

// 2. CORS — разрешаем только ваш фронт и Telegram Web
app.use(cors({
  origin: [
    'https://clean-ash-order.vercel.app',
    'https://web.telegram.org'
  ]
}));

// 3. Парсинг JSON с ограничением размера тела
app.use(express.json({ limit: '10kb' }));

// 4. Rate limiting для эндпоинтов валидации
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 30,                  // максимум 30 запросов за окно
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please try again later.' }
});

app.use('/api/validate', validateLimiter);
app.use('/api/validate-final', validateLimiter);

// 5. Маршруты
app.use('/api/validate', validateRoute);              // initData validation
app.use('/api/validate-final', validateFinalRoute);   // final phrase validation
app.use('/api', playerRoutes);                        // остальные маршруты

// 6. Запуск сервера
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
