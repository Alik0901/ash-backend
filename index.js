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

// Security
app.use(helmet());
app.use(cors({
  origin: [
    'https://clean-ash-order.vercel.app',
    'https://web.telegram.org'
  ]
}));
app.use(express.json({ limit: '10kb' }));

// Rate limit on validation routes
const validateLimiter = rateLimit({
  windowMs: 15*60*1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' }
});
app.use('/api/validate',  validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// Protect all /api/* except /api/init and /api/validate*
app.use('/api', (req, res, next) => {
  if (req.path === '/init' || req.path.startsWith('/validate')) {
    return next();
  }
  return authenticate(req, res, next);
});
app.use('/api', playerRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
