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

// 1. Security headers
app.use(helmet());

// 2. CORS
app.use(cors({
  origin: [
    'https://clean-ash-order.vercel.app',
    'https://web.telegram.org'
  ]
}));

// 3. Body parser
app.use(express.json({ limit: '10kb' }));

// 4. Rate limiting on validation routes
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' }
});
app.use('/api/validate', validateLimiter, validateRoute);
// validate-final тоже защищаем rate-limit, но сам роут защищён authenticate
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// 5. Подключаем /api/init без аутентификации
app.use('/api/init', playerRoutes); // в playerRoutes сам хендлер POST /init не проверяет authenticate

// 6. Аутентифицируем всё остальное (в playerRoutes):
app.use('/api', (req, res, next) => {
  // Все пути, кроме /init, должны проходить authenticate
  if (req.path.startsWith('/init')) {
    return next();
  }
  return authenticate(req, res, next);
});
app.use('/api', playerRoutes); // здесь уже попадут защищённые GET/POST маршруты playerRoutes

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
