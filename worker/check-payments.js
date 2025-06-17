/**
 * Payment-checker с расширенным извлечением комментария.
 *
 * 1. Берёт все pending-инвойсы из БД
 * 2. Читает последние транзакции кошелька через TonCenter
 * 3. Любой входящий ≥0.5 TON → вытаскиваем burn-uuid
 * 4. Если совпало — UPDATE burn_invoices SET status='paid'
 *
 * Подробные логи:
 *   ⏳ pending-id, 📥 кол-во raw-tx, → расшифровка каждой,
 *   ✔ найдено совпадение.
 */

import fetch   from 'node-fetch';
import pool    from '../db.js';
import { Buffer } from 'node:buffer';

// ──────────── конфигурация ────────────
const STEP_MS   = 30_000;                     // опрос каждые 30 с
const AMOUNT_NT = 500_000_000;                // 0.5 TON в нано
const ADDRESS   = process.env.TON_WALLET_ADDRESS;
const API_HOST  = process.env.TON_RPC_ENDPOINT || 'https://toncenter.com/api/v2';
const API_KEY   = process.env.TONCENTER_API_KEY || '';

if (!ADDRESS) { console.error('❌ TON_WALLET_ADDRESS не задан'); process.exit(1); }

const HEADERS = API_KEY ? { 'X-API-Key': API_KEY } : {};

/* ───────── helpers ───────── */

/** @return Buffer[] raw-transactions (decode=false) */
async function getRaw(limit = 40) {
  const url = `${API_HOST}/getTransactions?address=${ADDRESS}&limit=${limit}&archival=true`;
  return fetch(url, { headers: HEADERS }).then(r => r.json()).then(j => j.result || []);
}

/** @return Object одна транзакция (decode=true) */
async function getTx(lt, hash) {
  const url = `${API_HOST}/getTransaction?address=${ADDRESS}&lt=${lt}&hash=${hash}&decode=true`;
  return fetch(url, { headers: HEADERS }).then(r => r.json()).then(j => j.result);
}

/** Извлекаем `burn-<uuid>` из payload:
 *   1. конвертируем base64→Buffer
 *   2. собираем все печатные ASCII
 *   3. ищем regexp `burn-[0-9a-f-]{36}`
 */
function extractBurnTag(b64 = '') {
  try {
    const buf  = Buffer.from(b64, 'base64');
    let ascii  = '';
    for (const b of buf) {
      if (b >= 0x20 && b <= 0x7E) ascii += String.fromCharCode(b);
      else if (ascii.length) ascii += ' ';
    }
    const m = ascii.match(/burn-[0-9a-f-]{36}/i);
    return m ? m[0] : '';
  } catch { return ''; }
}

// ───────── основной цикл ─────────
async function checkOnce() {
  // pending
  const { rows: pend } = await pool.query(
    `SELECT invoice_id, comment FROM burn_invoices WHERE status='pending'`
  );
  console.log('⏳ pending:', pend.length, pend.map(p => p.invoice_id));

  if (!pend.length) return;

  // raw-tx
  const raws = await getRaw(40);
  console.log('📥 raw tx fetched:', raws.length);

  for (const raw of raws) {
    if (!raw.in_msg) continue;                         // не входящий → skip
    const nano = Number(raw.in_msg.value || 0);
    if (nano < AMOUNT_NT) continue;                   // меньше 0.5

    const { lt, hash } = raw.transaction_id;
    const tx   = await getTx(lt, hash);               // decode=true
       if (process.env.DEBUG_PAYLOAD === '1') {
         const md = tx?.in_msg?.msg_data || {};
         console.log('🪵 full msg_data for lt', lt);
         console.dir(md, { depth: 6 });
        }
        if (process.env.DEBUG_TX === '1') {
          console.log('🐙 FULL TX', JSON.stringify(tx, null, 2));
         // логируем первый входящий, чтобы не захламлять вывод
         process.env.DEBUG_TX = '0';
        }
    const md   = tx?.in_msg?.msg_data || {};
    const text = md.text || extractBurnTag(md.payload);

    console.log('→ decoded', {
      lt,
      nano,
      text: text || 'undefined'
    });

    // сравниваем
    for (const inv of pend) {
      if (text === inv.comment) {
        await pool.query(
          `UPDATE burn_invoices
              SET status='paid', paid_at=NOW()
            WHERE invoice_id=$1`,
          [inv.invoice_id]
        );
        console.log('✔ PAID', inv.invoice_id);
      }
    }
    await new Promise(r => setTimeout(r, 120));       // анти-спам TonCenter
  }
}

// ───────── запуск ─────────
console.log(`🚀 Payment-checker started (interval ${STEP_MS/1000}s)`);
await checkOnce();
setInterval(checkOnce, STEP_MS);
