// index.js

import express   from 'express';
import helmet    from 'helmet';
import cors      from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv    from 'dotenv';
import morgan    from 'morgan';
import path      from 'path';
import crypto    from 'crypto';
import process   from 'process';

import './worker/check-payments.js';
import validateRoute       from './routes/validate.js';
import validateFinalRoute  from './routes/validateFinal.js';
import playerRoutes        from './routes/player.js';
import { authenticate }    from './middleware/auth.js';

// ─── Load env in non-prod ────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') dotenv.config();

// ─── Check required env vars ─────────────────────────────────────────────
const { JWT_SECRET, FRAG_HMAC_SECRET, TON_WALLET_ADDRESS } = process.env;
const missing = [];
if (!JWT_SECRET)         missing.push('JWT_SECRET');
if (!FRAG_HMAC_SECRET)   missing.push('FRAG_HMAC_SECRET');
if (!TON_WALLET_ADDRESS) missing.push('TON_WALLET_ADDRESS');
if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

// ─── 0) Health-check early ───────────────────────────────────────────────
app.get('/', (_req, res) => res.sendStatus(200));

// ─── 1) Security, logging, JSON body ────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

// ─── 2) Static assets ────────────────────────────────────────────────────
app.use(
  '/images',
  express.static(path.join(process.cwd(), 'public', 'images'))
);

// ─── 3) CORS for /api ────────────────────────────────────────────────────
const ALLOWED = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/,
  /\.up\.railway\.app$/,
];
app.use(
  '/api',
  cors({
    origin(origin, callback) {
      // allow requests with no origin (e.g. mobile apps, curl)
      if (!origin) return callback(null, true);
      const ok = ALLOWED.some((rule) =>
        rule instanceof RegExp ? rule.test(origin) : rule === origin
      );
      return callback(ok ? null : new Error(`CORS blocked: ${origin}`), ok);
    },
    methods: ['GET','POST','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization'],
    credentials: true,
  })
);
app.options('/api/*', cors());

// ─── 4) Rate-limit for validate endpoints ────────────────────────────────
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' },
});
app.use('/api/validate',       validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// ─── 5) Signed fragment URLs (requires auth) ────────────────────────────
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
const FINAL_FILE = 'final-image.jpg';

app.get(
  '/api/fragments/urls',
  authenticate,
  (req, res) => {
    try {
      const TTL = 5 * 60 * 1000; // 5 minutes
      const now = Date.now();
      const signedUrls = {};

      for (const name of [...FRAG_FILES, FINAL_FILE]) {
        const exp     = now + TTL;
        const payload = `${name}|${exp}`;
        const sig     = crypto
          .createHmac('sha256', FRAG_HMAC_SECRET)
          .update(payload)
          .digest('hex');
        signedUrls[name] = `${req.protocol}://${req.get('host')}` +
          `/fragments/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`;
      }

      return res.json({ signedUrls });
    } catch (err) {
      console.error('[GET /api/fragments/urls] ERROR:', err);
      return res.status(500).json({ error: 'internal' });
    }
  }
);

// ─── 6) Mount game API routes ─────────────────────────────────────────────
app.use('/api', playerRoutes);

// ─── 7) Burn-status no-cache header ──────────────────────────────────────
app.use(
  '/api/burn-status/:invoiceId',
  (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
  }
);

// ─── 8) HMAC-protected fragment delivery ─────────────────────────────────
app.get('/fragments/:name', (req, res, next) => {
  const { name } = req.params;
  if (![...FRAG_FILES, FINAL_FILE].includes(name)) return next();

  const exp = Number(req.query.exp || 0);
  const sig = req.query.sig || '';
  if (Date.now() > exp) return res.status(403).json({ error: 'Link expired' });

  const expected = crypto
    .createHmac('sha256', FRAG_HMAC_SECRET)
    .update(`${name}|${exp}`)
    .digest('hex');
  if (sig !== expected) return res.status(403).json({ error: 'Invalid signature' });

  // Allow cross-origin access for delivered images
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return res.sendFile(path.join(FRAG_DIR, name));
});

// ─── 9) Fallback and error handler ────────────────────────────────────────
app.use((_req, res) => res.sendStatus(404));
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal' });
});

// ─── 10) Start server ────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`🟢 Server listening on port ${PORT}`);
});
