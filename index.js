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
import playerRoutes        from './routes/player.js';  // здесь init, player/:tg_id и всё остальное
import { authenticate }    from './middleware/auth.js';

if (process.env.NODE_ENV !== 'production') dotenv.config();

const app = express();
app.set('trust proxy', 1);

// 1) Security, logging, JSON
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

// 2) UI-Static (фоновые картинки)
app.use(
  '/images',
  express.static(path.join(process.cwd(), 'public', 'images'))
);

// 3) CORS for /api
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
      if (ALLOWED.some(x => x instanceof RegExp ? x.test(origin) : x === origin))
        return cb(null, true);
      cb(new Error(`CORS blocked: ${origin}`));
    },
    methods: ['GET','POST','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization'],
  })
);
app.options('/api/*', cors());

// 4) Rate-limit for validate
const validateLimiter = rateLimit({
  windowMs: 15*60*1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' },
});

// 5) Public validation routes
app.use('/api/validate', validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// 6) Signed URLs for fragments (needs JWT)
const FRAG_DIR   = path.join(process.cwd(), 'public', 'fragments');
const FRAG_FILES = [ /* ...ваш список файлов... */ ];
const FINAL_FILE = 'final-image.jpg';
const HMAC_SECRET = process.env.FRAG_HMAC_SECRET;
if (!HMAC_SECRET) console.error('⚠️ FRAG_HMAC_SECRET not set');

app.get(
  '/api/fragments/urls',
  authenticate,
  (req, res) => {
    try {
      const TTL = 5*60*1000;
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

// 7) Mount all game routes (init, getPlayer, burn, fragments, referral, etc.)
//    внутри playerRoutes уже есть authenticate для защищённых маршрутов
app.use('/api', playerRoutes);

// 8) HMAC-protected delivery of fragment files
app.get('/fragments/:name', (req, res, next) => {
  const { name } = req.params;
  if (![...FRAG_FILES, FINAL_FILE].includes(name)) return next();

  const exp = Number(req.query.exp || 0);
  const sig = req.query.sig || '';
  if (Date.now() > exp) return res.status(403).json({ error: 'Link expired' });

  const expected = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`${name}|${exp}`)
    .digest('hex');
  if (sig !== expected) return res.status(403).json({ error: 'Invalid signature' });

  res.set('Access-Control-Allow-Origin','*');
  res.set('Cross-Origin-Resource-Policy','cross-origin');
  res.sendFile(path.join(FRAG_DIR, name));
});

// 9) Health-check
app.get('/', (_req, res) => res.sendStatus(200));

// 10) Start server
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`🟢 Listening on port ${PORT}`));
