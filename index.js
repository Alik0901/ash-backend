// index.js
import express   from 'express';
import helmet    from 'helmet';
import cors      from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv    from 'dotenv';
import morgan    from 'morgan';
import path      from 'path';
import crypto    from 'crypto';

import './worker/check-payments.js';
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes       from './routes/player.js';
import { authenticate }   from './middleware/auth.js';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();
app.set('trust proxy', 1);

// ─── 1) Базовый middleware ───────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

// ─── 2) Статика для UI (фоновые иконки, изображения и т.п.) ────────
// Поместите ваши фоновые картинки в public/images
app.use(
  '/images',
  express.static(path.join(process.cwd(), 'public', 'images'))
);

// ─── 3) CORS для всех /api ──────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/,
  /\.up\.railway\.app$/
];
app.use(
  '/api',
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (
        ALLOWED_ORIGINS.some((x) =>
          x instanceof RegExp ? x.test(origin) : x === origin
        )
      ) {
        return cb(null, true);
      }
      cb(new Error(`CORS blocked: ${origin}`));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.options('/api/*', cors());

// ─── 4) Rate limiter для validate и validate-final ─────────────────
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' },
});

// ─── 5) Публичные API (без JWT) ────────────────────────────────────
// Форма валидации простой фразы
app.use('/api/validate', validateLimiter, validateRoute);
// Валидация финальной фразы
app.use('/api/validate-final', validateLimiter, validateFinalRoute);
// Инициализация игрока
app.use('/api/init', playerRoutes);
// Получение данных игрока по tg_id
app.use('/api/player/:tg_id', playerRoutes);

// ─── 6) Генерация подписанных URL для фрагментов ────────────────────
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
if (!HMAC_SECRET) console.error('⚠️ FRAG_HMAC_SECRET is not set');

app.get(
  '/api/fragments/urls',
  authenticate,
  (req, res) => {
    try {
      const TTL = 5 * 60 * 1000; // 5 минут
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

// ─── 7) JWT-аутентификация для остальных API ─────────────────────────
app.use(
  '/api',
  (req, res, next) => {
    // пропускаем preflight, init и получение игрока
    if (req.method === 'OPTIONS') return next();
    if (req.method === 'POST' && req.path === '/init') return next();
    if (req.method === 'GET' && /^\/player\/[^/]+$/.test(req.path))
      return next();
    return authenticate(req, res, next);
  }
);

// ─── 8) Защищённые API (с JWT) ──────────────────────────────────────
app.use('/api', playerRoutes);

// ─── 9) Раздача HMAC-защищённых фрагментов ──────────────────────────
app.get('/fragments/:name', (req, res, next) => {
  const { name } = req.params;
  if (![...FRAG_FILES, FINAL_FILE].includes(name)) return next();

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

  // CORS & cross-origin политика для файлов
  res.set('Access-Control-Allow-Origin','*');
  res.set('Cross-Origin-Resource-Policy','cross-origin');

  return res.sendFile(path.join(FRAG_DIR, name));
});

// ─── 10) Корневая проверка здоровья ──────────────────────────────────
app.get('/', (_req, res) => res.sendStatus(200));

// ─── 11) Запуск сервера ─────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Server listening on port ${PORT}`);
});
