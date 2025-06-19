// index.js — окончательная версия
import express from 'express';
import cors    from 'cors';
import dotenv  from 'dotenv';
import helmet  from 'helmet';
import rateLimit from 'express-rate-limit';

/* воркер оплаты */
import './worker/check-payments.js';

import playerRoutes       from './routes/player.js';
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import { authenticate }   from './middleware/auth.js';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}
const app = express();

/* ── security & cors ───────────────────────────────────────── */
app.use(helmet());

const corsConfig = {
  origin: [
    'https://clean-ash-order.vercel.app',
    'https://web.telegram.org',
  ],
};
app.use(cors(corsConfig));
app.options('/api/*', cors(corsConfig), (_,res)=>res.sendStatus(204));

/* ── no-cache ──────────────────────────────────────────────── */
app.disable('etag');
app.use('/api', (_,res,next)=>{ res.set('Cache-Control','no-store'); next(); });

/* ── json limit ────────────────────────────────────────────── */
app.use(express.json({ limit:'10kb' }));

/* ── rate-limits ───────────────────────────────────────────── */
const validateLimiter = rateLimit({
  windowMs: 15*60*1000,
  max: 30,
  standardHeaders:true,
  legacyHeaders:false,
  message:{ error:'Too many requests, please try later.' },
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

/* ── auth proxy for /api ───────────────────────────────────── */
app.use('/api', (req,res,next)=>{
  const { method, path } = req;

  if (method==='OPTIONS')                  return next();
  if (method==='POST' && path==='/init')   return next();
  if (method==='GET'  && /^\/player\/[^/]+$/.test(path)) return next();

  return authenticate(req,res,next);
});

app.use('/api', playerRoutes);

/* ── start server ─────────────────────────────────────────── */
const PORT = process.env.PORT;
if(!PORT){
  console.error('❌  $PORT env variable is not set! '
    +'Railway assigns it automatically - do not override it.');
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢  Server is listening on port ${PORT}`);
});
