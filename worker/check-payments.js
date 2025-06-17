// worker/check-payments.js
// ------------------------------------------------------------
// ⚙️  ENV (обязательно задайте в Railway → Variables)
//   DATABASE_URL         — строка подключения Postgres
//   TON_WALLET_ADDRESS   — ваш адрес (UQ… / EQ…)
//   TONCENTER_API_KEY    — не обязателен (TonCenter работает без ключа, но → 60 rps)
//   CHECK_INTERVAL_MS    — частота проверки (по-умолчанию 30 000)
//   DEBUG_TX             — =1 даст детальный вывод каждой транзакции
//
// ------------------------------------------------------------
import dotenv             from 'dotenv';
import fetch              from 'node-fetch';
import { Pool }           from 'pg';
import { base64Decode }   from './lib/boc.js';   // ↓ маленькая утилита в конце файла

dotenv.config();

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- TonCenter ----------
const TON_ADDR   = process.env.TON_WALLET_ADDRESS;
const API_KEY    = process.env.TONCENTER_API_KEY || '';
const ENDPOINT   = 'https://toncenter.com/api/v2/getTransactions'
                 + `?address=${TON_ADDR}`
                 + '&limit=30&decode=true&archival=true&include_msg_body=true';

const headers = API_KEY ? { 'X-API-Key': API_KEY } : {};

// ---------- основные функции ----------
async function loadPending() {
  const { rows } = await pool.query(`
      SELECT invoice_id, tg_id, comment
        FROM burn_invoices
       WHERE status = 'pending'
  `);
  return rows;                    // [{ invoice_id, tg_id, comment }, …]
}

function extractComment(tx) {
  // 1) самый лёгкий путь — TonCenter сам кладёт расшифрованный текст:
  const txt1 = tx?.in_msg?.msg_data?.text;
  if (txt1) return txt1.trim();

  // 2) если TonCenter вернул только raw body (base64-BOC) — пробуем распарсить
  const raw =
        tx?.in_msg?.msg_data?.body ??
        tx?.in_msg?.body ??
        tx?.body;

  if (!raw) return null;

  // пробуем извлечь человекочитаемые символы без полноценного парсинга BOC
  try {
    const bytes = base64Decode(raw);              // Uint8Array
    const ascii = Buffer.from(bytes).toString('utf8');
    // оставляем только печатные ASCII 32-126
    const clean = ascii.replace(/[^\x20-\x7E]/g, '').trim();
    if (clean.length) return clean;
  } catch { /* ignore */ }

  return null;
}

async function markPaid(invoiceId) {
  await pool.query(`
      UPDATE burn_invoices
         SET status   = 'paid',
             paid_at  = now()
       WHERE invoice_id = $1
  `, [invoiceId]);
  console.log('💰 invoice paid', invoiceId);
}

async function scan() {
  const pending = await loadPending();
  if (!pending.length) return;                         // ничего ждать
  console.log('⏳ pending:', pending.length,
              pending.map(p => `\n   ${p.comment}`).join(''));

  // загружаем свежие входящие транзакции кошелька
  const r   = await fetch(ENDPOINT, { headers });
  const res = await r.json();
  if (!res.ok) throw new Error(res.error || 'TonCenter error');

  const txs = res.result.filter(t => t.in_msg);        // только входящие
  console.log('📨 raw tx fetched:', txs.length);

  // при необходимости логируем каждую транзакцию целиком
  if (process.env.DEBUG_TX === '1') {
    for (const tx of txs) {
      console.dir(tx, { depth: 6 });
    }
  }

  for (const tx of txs) {
    const comment = extractComment(tx);
    const value   = Number(tx?.in_msg?.value || 0);     // в наносах

    if (process.env.DEBUG_TX === '1') {
      console.log('  → decoded',
        '{ lt:', `'${tx.utime}${tx.transaction_id?.lt ? '/' + tx.transaction_id.lt : ''}'`,
        ', nano:', value, ', text:', `'${comment}' }`);
    }

    if (!comment || value < 500_000_000) continue;      // < 0.5 TON

    const inv = pending.find(p => p.comment === comment);
    if (!inv) continue;                                // не наш платёж

    await markPaid(inv.invoice_id);
  }
}

// ---------- циклический луп ----------
const INTERVAL = Number(process.env.CHECK_INTERVAL_MS) || 30_000;
console.log('🚀 Payment-checker started (interval', INTERVAL / 1000, 's)');

setInterval(() => {
  scan().catch(err => console.error('❌ payment-checker error:', err));
}, INTERVAL);

// ------------------------------------------------------------
// mini-helper: очень примитивное Base64 → Uint8Array без зависимостей
// ------------------------------------------------------------
function base64Decode(b64) {
  return Uint8Array.from(Buffer.from(
    b64.replace(/[-_]/g, m => (m === '-' ? '+' : '/'))
      .padEnd(Math.ceil(b64.length / 4) * 4, '='), 'base64'));
}
