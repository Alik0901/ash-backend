// index.js
import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import dotenv         from 'dotenv';
import './worker/check-payments.js';
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

app.use(helmet());

const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/,
  /\.up\.railway\.app$/,  // постепенно можно обобщить
];
app.use(cors({
  origin: (o, cb) => {
    if (!o) return cb(null, true);
    if (ALLOWED.some(x => typeof x === 'string' ? x === o : x.test(o)))
      return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.options('*', cors());

app.get('/', (_req, res) => res.sendStatus(200));

app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control','no-store');
  next();
});

app.use(express.json({ limit: '10kb' }));

const limiter = rateLimit({
  windowMs: 15*60*1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests' },
});
app.use('/api/validate',       limiter, validateRoute);
app.use('/api/validate-final', limiter, validateFinalRoute);

app.get('/test-db', async (_req, res) => {
  try {
    const pool = (await import('./db.js')).default;
    const { rows } = await pool.query('SELECT NOW()');
    return res.json({ now: rows[0].now });
  } catch (err) {
    console.error('🔴 /test-db error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.method === 'POST'  && req.path === '/init') return next();
  if (req.method === 'GET'   && /^\/player\/[^/]+$/.test(req.path)) return next();
  return authenticate(req, res, next);
});

app.use('/api', playerRoutes);

const portFromEnv = parseInt(process.env.PORT, 10);
const PORT = Number.isInteger(portFromEnv) ? portFromEnv : 8080;
console.log('▶️ [index.js] Using port', PORT);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Server is listening on port ${PORT}`);
});
console.log('▶️ ENV PORT =', PORT);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Server listening on ${PORT}`);
});
