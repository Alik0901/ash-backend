// index.js
import express     from 'express';
import helmet      from 'helmet';
import cors        from 'cors';
import rateLimit   from 'express-rate-limit';
import dotenv      from 'dotenv';
import morgan      from 'morgan';
import path        from 'path';
import crypto      from 'crypto';

import './worker/check-payments.js';
import validateRoute       from './routes/validate.js';
import validateFinalRoute  from './routes/validateFinal.js';
import playerRoutes        from './routes/player.js';
import { authenticate }    from './middleware/auth.js';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();
// доверяем proxy (чтобы rate-limit правильно определял IP)
app.set('trust proxy', 1);

// ─── 1) Общий middleware ────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

// ─── 2) CORS для всех /api ──────────────────────────────────────────
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/,
  /\.up\.railway\.app$/
];
app.use('/api', cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED.some(x => x instanceof RegExp ? x.test(origin) : x === origin))
      return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('/api/*', cors());

// ─── 3) Rate limiter для validate и validate-final ─────────────────
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' },
});

// ─── 4) Public routes (без аутентификации) ─────────────────────────
// простой проверочный роут из validate.js
app.use('/api/validate', validateLimiter, validateRoute);

// роут проверки финальной фразы
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// ─── 5) Presigned URLs для фрагментов ──────────────────────────────
const FRAG_DIR   = path.join(process.cwd(), 'public', 'fragments');
const FRAG_FILES = [
  'fragment_1_the_whisper.jpg',
  'fragment_2_the_number.jpg',
  'fragment_3_the_language.jpg',
  'fragment_4_the_mirror.jpg',
  'fragment_5_the_chain.jpg',
  'fragment_6_the_hour.jpg',
  'fragment_7_the_mark.jpg',
  'fragment_8_the_gate.jpg',
];
const FINAL_FILE   = 'final-image.jpg';
const HMAC_SECRET  = process.env.FRAG_HMAC_SECRET;
if (!HMAC_SECRET) console.error('⚠️ FRAG_HMAC_SECRET is not set');

app.get(
  '/api/fragments/urls',
  authenticate,
  (req, res) => {
    try {
      const TTL = 5 * 60 * 1000;
      const now = Date.now();
      const signedUrls = {};

      for (const name of [...FRAG_FILES, FINAL_FILE]) {
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
    } catch (err) {
      console.error('[ERROR fragments/urls]', err);
      res.status(500).json({ error: 'internal' });
    }
  }
);

// ─── 6) Auth для всех остальных /api ─────────────────────────────────
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS')                              return next();
  if (req.method === 'POST'   && req.path === '/init')       return next();
  if (req.method === 'GET'    && /^\/player\/[^/]+$/.test(req.path))
    return next();
  return authenticate(req, res, next);
});

// ─── 7) Основные игровые маршруты ──────────────────────────────────
app.use('/api', playerRoutes);

// ─── 8) Раздача HMAC-файлов (фрагменты) ────────────────────────────
app.get('/fragments/:name', (req, res, next) => {
  const { name } = req.params;
  if (!FRAG_FILES.includes(name)) return next();

  const exp = Number(req.query.exp || 0);
  const sig = req.query.sig || '';
  if (Date.now() > exp) {
    return res.status(403).json({ error: 'Link expired' });
  }

  const expected = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`${name}|${exp}`)
    .digest('hex');
  if (sig !== expected) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  res.set('Access-Control-Allow-Origin','*');
  res.set('Cross-Origin-Resource-Policy','cross-origin');
  res.sendFile(path.join(FRAG_DIR, name));
});

// ─── 9) Статика для финального изображения ──────────────────────────
app.get(`/fragments/${FINAL_FILE}`, (_req, res) => {
  res.set('Access-Control-Allow-Origin','*');
  res.set('Cross-Origin-Resource-Policy','cross-origin');
  res.sendFile(path.join(FRAG_DIR, FINAL_FILE));
});

// ─── 10) Health-check и старт ───────────────────────────────────────
app.get('/', (_req, res) => res.sendStatus(200));
const PORT = parseInt(process.env.PORT || '3000', 10);
console.log('🟢 Server listening on port', PORT);
app.listen(PORT, '0.0.0.0');
