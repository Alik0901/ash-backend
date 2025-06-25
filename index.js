// index.js  (версия: v2.4)
import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import dotenv         from 'dotenv';
import morgan         from 'morgan';
import path           from 'path';
import crypto         from 'crypto';

import './worker/check-payments.js';
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

//
// 📌 НОВОЕ ДЛЯ PRESIGNED URLS
//
const FRAG_DIR    = path.join(process.cwd(), 'public', 'fragments');
const FRAG_FILES  = [
  'fragment_1_the_whisper.webp',
  'fragment_2_the_number.webp',
  'fragment_3_the_language.webp',
  'fragment_4_the_mirror.webp',
  'fragment_5_the_chain.webp',
  'fragment_6_the_hour.webp',
  'fragment_7_the_mark.webp',
  'fragment_8_the_gate.webp',
];
const HMAC_SECRET = process.env.FRAG_HMAC_SECRET;
if (!HMAC_SECRET) {
  console.error('⚠️ FRAG_HMAC_SECRET is not set in .env');
}

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

// —— стандартные middleware ——————————————————————————————————————————————
app.use(helmet());
app.use(morgan('dev'));

const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/,
  /\.up\.railway\.app$/,
];
app.use(
  cors({
    origin: (o, cb) => {
      if (!o) return cb(null, true);
      if (ALLOWED.some(x => (x instanceof RegExp ? x.test(o) : x === o)))
        return cb(null, true);
      return cb(new Error(`CORS blocked: ${o}`));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.options('*', cors());

app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '10kb' }));

const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' },
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

app.get('/', (_req, res) => res.sendStatus(200));
app.get('/test-db', async (_req, res) => {
  try {
    const { default: pool } = await import('./db.js');
    const { rows }        = await pool.query('SELECT NOW() AS now');
    return res.json(rows[0]);
  } catch (err) {
    console.error('🔴 /test-db error:', err);
    return res.status(500).json({ error: err.message });
  }
});

//
// ▶️ 1) PRESIGNED URLS ENDPOINT — до authenticate
//
app.get(
  '/api/fragments/urls',
  authenticate,
  (req, res) => {
    const TTL       = 5 * 60 * 1000; // 5 минут
    const now       = Date.now();
    const signedUrls = {};

    for (const name of FRAG_FILES) {
      const exp     = now + TTL;
      const payload = `${name}|${exp}`;
      const sig     = crypto
        .createHmac('sha256', HMAC_SECRET)
        .update(payload)
        .digest('hex');

      signedUrls[name] = `${req.protocol}://${req.get('host')}` +
                         `/fragments/${encodeURIComponent(name)}` +
                         `?exp=${exp}&sig=${sig}`;
    }

    res.json({ signedUrls });
  }
);

//
// ▶️ 2) Авторизация остальных /api
//
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.method === 'POST' && req.path === '/init') return next();
  if (req.method === 'GET' && /^\/player\/[^/]+$/.test(req.path))
    return next();
  return authenticate(req, res, next);
});

//
// ▶️ 3) Игровые /api-маршруты
//
app.use('/api', playerRoutes);

//
// ▶️ 4) СТАТИКА ФРАГМЕНТОВ С ПРОВЕРКОЙ SIG/EXP
//
app.get('/fragments/:name', (req, res) => {
  const { name } = req.params;
  const exp      = Number(req.query.exp || 0);
  const sig      = req.query.sig || '';

  // 1) проверяем, что запрашивают корректный файл
  if (!FRAG_FILES.includes(name)) {
    return res.status(404).end();
  }

  // 2) проверяем срок годности
  if (Date.now() > exp) {
    return res.status(403).json({ error: 'Link expired' });
  }

  // 3) сверяем HMAC
  const expected = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`${name}|${exp}`)
    .digest('hex');
  if (sig !== expected) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // 4) отдаем файл
  res.sendFile(path.join(FRAG_DIR, name));
});

//
// ▶️ 5) Старт сервера
//
const PORT = parseInt(process.env.PORT ?? '3000', 10);
console.log('ENV PORT        =', process.env.PORT);
console.log('→ Listening on', PORT);
app.listen(PORT, '0.0.0.0');
