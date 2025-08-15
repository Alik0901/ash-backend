// index.js
// Express bootstrap for Order of Ash backend
// Notes:
// - Maintains original behavior, but structure, readability, and consistency are improved
// - HMAC-signed delivery for fragments, riddles, and runes retained

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import morgan from 'morgan';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Worker (payment reconciler) — starts on server boot
import './worker/check-payments.js';

import validateRoute from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';
import playerRoutes from './routes/player.js';
import { authenticate } from './middleware/auth.js';

/* ────────────────────────────────────────────────────────────────────
 * Environment & Constants
 * ────────────────────────────────────────────────────────────────── */

// Load env in non-production to avoid leaking prod secrets via .env in prod
if (process.env.NODE_ENV !== 'production') dotenv.config();

const {
  NODE_ENV,
  PORT: PORT_ENV,
  JWT_SECRET,
  FRAG_HMAC_SECRET,
  TON_WALLET_ADDRESS,
} = process.env;

// Validate required envs early
const missing = [];
if (!JWT_SECRET) missing.push('JWT_SECRET');
if (!TON_WALLET_ADDRESS) missing.push('TON_WALLET_ADDRESS');

if (!FRAG_HMAC_SECRET) {
  // Optional in dev; warn loudly for production
  console.warn(
    '⚠️  FRAG_HMAC_SECRET is not set — riddles/runes/fragment links will be UNSIGNED in dev.'
  );
}
if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname; // repo root entry assumed
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const IMAGES_DIR = path.join(PUBLIC_DIR, 'images');
const FRAGMENTS_DIR = path.join(PUBLIC_DIR, 'fragments');


// API
const PORT = Number(PORT_ENV || 3000);
const IS_PROD = NODE_ENV === 'production';

// CORS allowlist — strings and regex
const CORS_ALLOWLIST = [
  'https://clean-ash-order.vercel.app',
  /\.telegram\.org$/,
  /\.up\.railway\.app$/,
];

/* ────────────────────────────────────────────────────────────────────
 * Utilities
 * ────────────────────────────────────────────────────────────────── */

/** Checks if an origin matches the allowlist. */
function isOriginAllowed(origin) {
  if (!origin) return true; // allow mobile apps, curl, server-to-server
  return CORS_ALLOWLIST.some((rule) =>
    rule instanceof RegExp ? rule.test(origin) : rule === origin
  );
}

/** Signs payload with HMAC-SHA256 (hex). */
function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** Simple guard for file names to avoid path traversal. */
function isSafeName(name) {
  return !!name && !name.includes('..') && !name.includes('/') && !name.includes('\\');
}

/** HMAC verifier used by riddles & runes (exp in seconds). */
function verifyHmacParams(name, exp, sig) {
  if (!exp || Number.isNaN(Number(exp))) return { ok: false, code: 400, msg: 'bad_exp' };
  if (Date.now() / 1000 > Number(exp)) return { ok: false, code: 403, msg: 'expired' };
  const want = hmacHex(FRAG_HMAC_SECRET, `${name}|${exp}`);
  if (want !== sig) return { ok: false, code: 403, msg: 'bad_sig' };
  return { ok: true };
}

/** Generic HMAC-signed static delivery (riddles, runes). */
function serveSignedAsset(app, routeBase, folder) {
  app.get(`${routeBase}/:name`, (req, res) => {
    try {
      const { name } = req.params;
      if (!isSafeName(name)) return res.status(400).json({ error: 'bad_name' });

      const filePath = path.join(PUBLIC_DIR, folder, name);

      // Dev fallback: serve unsigned with no-store to prevent caching surprises
      if (!FRAG_HMAC_SECRET) {
        if (!fs.existsSync(filePath)) return res.status(404).end();
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.set('Cache-Control', 'no-store');
        return res.sendFile(filePath);
      }

      const { exp, sig } = req.query;
      const v = verifyHmacParams(name, exp, sig);
      if (!v.ok) return res.status(v.code).json({ error: v.msg });

      if (!fs.existsSync(filePath)) return res.status(404).end();

      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      res.set('Cache-Control', 'public, max-age=60, must-revalidate');
      return res.sendFile(filePath);
    } catch (e) {
      console.error(`[GET ${routeBase}/:name] ERROR`, e);
      return res.status(500).json({ error: 'internal' });
    }
  });
}

/* ────────────────────────────────────────────────────────────────────
 * App Bootstrap
 * ────────────────────────────────────────────────────────────────── */

const app = express();
app.set('trust proxy', 1); // respect X-Forwarded-* from reverse proxies

// 0) Health-check (fast path)
app.get('/', (_req, res) => res.sendStatus(200));

// 1) Security, logging, JSON body
app.use(
  helmet({
    crossOriginResourcePolicy: false, // allow cross-origin images where needed
  })
);
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

// 2) Static assets (background images only)
app.use('/images', express.static(IMAGES_DIR));

// 3) CORS for /api (scoped)
app.use(
  '/api',
  cors({
    origin(origin, callback) {
      const allowed = isOriginAllowed(origin);
      return callback(allowed ? null : new Error(`CORS blocked: ${origin}`), allowed);
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Debug-Key'],
    credentials: true,
  })
);
app.options('/api/*', cors());

// 4) Rate-limit for validate endpoints
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try later.' },
});
app.use('/api/validate', validateLimiter, validateRoute);
app.use('/api/validate-final', validateLimiter, validateFinalRoute);

// 5) No-cache for burn-status to avoid stale payment state
app.use('/api/burn-status', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

// 6) Signed final image URL issuer (JWT-protected)
app.get('/api/fragments/urls', authenticate, (req, res) => {
  try {
    const TTL_MS = 5 * 60 * 1000; // 5 minutes (ms-based, как раньше)
    const now = Date.now();

    const names = [FINAL_IMAGE];
    const out = {};

    // Dev fallback: when no secret, expose unsigned direct URLs
    if (!FRAG_HMAC_SECRET) {
      for (const name of names) {
        out[name] = `${req.protocol}://${req.get('host')}/fragments/${encodeURIComponent(name)}`;
      }
      return res.json({ signedUrls: out });
    }

    for (const name of names) {
      const exp = now + TTL_MS; // ms-based
      const sig = hmacHex(FRAG_HMAC_SECRET, `${name}|${exp}`);
      out[name] = `${req.protocol}://${req.get('host')}/fragments/${encodeURIComponent(
        name
      )}?exp=${exp}&sig=${sig}`;
    }

    return res.json({ signedUrls: out });
  } catch (err) {
    console.error('[GET /api/fragments/urls] ERROR:', err);
    return res.status(500).json({ error: 'internal' });
  }
});


// 7) Game API routes (burn*, referral, third-quest, etc.)
app.use('/api', playerRoutes);

// 8) HMAC-protected fragment delivery (ms-based exp)
app.get('/fragments/:name', (req, res, next) => {
  const { name } = req.params;
  if (name !== FINAL_IMAGE) return next();

  // Dev fallback: serve unsigned
  if (!FRAG_HMAC_SECRET) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    const filePath = path.join(FRAGMENTS_DIR, name);
    return res.sendFile(filePath);
  }

  const exp = Number(req.query.exp || 0); // ms-based
  const sig = String(req.query.sig || '');
  if (Date.now() > exp) return res.status(403).json({ error: 'Link expired' });

  const expected = hmacHex(FRAG_HMAC_SECRET, `${name}|${exp}`);
  if (sig !== expected) return res.status(403).json({ error: 'Invalid signature' });

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  const filePath = path.join(FRAGMENTS_DIR, name);
  return res.sendFile(filePath);
});

// 9) Signed riddles & runes (sec-based exp)
serveSignedAsset(app, '/riddles', 'riddles');
serveSignedAsset(app, '/runes', 'runes');

// 10) 404 + Error handler
app.use((_req, res) => res.sendStatus(404));
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (String(err?.message || '').includes('CORS')) {
    return res.status(403).json({ error: 'CORS' });
  }
  res.status(500).json({ error: 'internal' });
});

// 11) Start server
app.listen(PORT, () => {
  console.log(`🟢 Server listening on port ${PORT} (${IS_PROD ? 'prod' : 'dev'})`);
});
