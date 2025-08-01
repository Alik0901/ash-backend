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

if (process.env.NODE_ENV !== 'production') dotenv.config();

const app = express();
app.set('trust proxy', 1);

// 1) HTTP headers, logging, JSON parsing
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

// 2) UI-статика (фоны, placeholder и т.д.)
app.use(
  '/images',
  express.static(path.join(process.cwd(), 'public', 'images'))
);

// 3) CORS для /api
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/,
  /\.up\.railway\.app$/
];
app.use(
  '/api',
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOWED.some(x => x instanceof RegExp ? x.test(origin) : x === origin)) {
        return cb(null, true);
      }
      cb(new Error(`CORS blocked: ${origin}`));
    },
    methods: ['GET','POST','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization'],
  })
);
app.options('/api/*', cors());

// 4) Rate-limit для валидации
const validateLimiter = rateLimit({
  windowMs: 15*60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' },
});

// 5) Public API (без JWT)
// 5.1) Валидация простых строк
app.use('/api/validate', validateLimiter, validateRoute);
// 5.2) Валидация финальной фразы
app.use('/api/validate-final', validateLimiter, validateFinalRoute);
// 5.3) Инициализация /login
app.use('/api/init', playerRoutes);
// 5.4) Получение данных игрока
app.use('/api/player/:tg_id', playerRoutes);

// 6) HMAC-подпись для фрагментов (URL list) — требует JWT
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
const FINAL_FILE  = 'final-image.jpg';
const HMAC_SECRET = process.env.FRAG_HMAC_SECRET;
if (!HMAC_SECRET) console.error('⚠️ FRAG_HMAC_SECRET not set');

app.get(
  '/api/fragments/urls',
  authenticate,
  (req, res) => {
    try {
      const TTL = 5*60_000;
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
          `/fragments/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`;
      }
      res.json({ signedUrls });
    } catch (err) {
      console.error('[fragments/urls]', err);
      res.status(500).json({ error: 'internal' });
    }
  }
);

// 7) JWT-middleware для всех прочих /api
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  // init и player/:tg_id уже пропущены выше
  return authenticate(req, res, next);
});

// 8) Protected API (burn, fragments retrieval, referral, final, stats…)
app.use('/api', playerRoutes);

// 9) HMAC-защита и отдача файлов фрагментов
app.get('/fragments/:name', (req, res, next) => {
  const { name } = req.params;
  if (![...FRAG_FILES, FINAL_FILE].includes(name)) return next();

  const exp = +req.query.exp || 0;
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

// 10) Health-check
app.get('/', (_req, res) => res.sendStatus(200));

// 11) Старт
const PORT = +process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🟢 Listening on ${PORT}`));
