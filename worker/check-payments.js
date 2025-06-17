/**
 * Payment-checker: каждые N секунд
 *   1. читает все инвойсы со статусом `pending`
 *   2. запрашивает последние транзакции кошелька TON
 *   3. если пришёл входящий платёж ≥ 0.5 TON и payload|comment
 *      совпадает с burn-uuid, помечает счёт как `paid`
 *
 * Для максимальной наглядности пишет подробные логи:
 *   🚀 старт, ⏳ список pending, 📥 сколько tx получено,
 *   → расшифрованная каждая транзакция,
 *   ✔ если найдено совпадение и счёт помечен «paid».
 */

import fetch from 'node-fetch';
import pool  from '../db.js';
import { Buffer } from 'node:buffer';

// ──────────────────── конфигурация ────────────────────
const STEP_MS   = 30_000;                              // интервал 30 с
const AMOUNT_NT = 500_000_000;                         // 0.5 TON в нано
const ADDRESS   = process.env.TON_WALLET_ADDRESS;
const API_HOST  =
  process.env.TON_RPC_ENDPOINT || 'https://toncenter.com/api/v2';
const API_KEY   = process.env.TONCENTER_API_KEY || '';

if (!ADDRESS) { console.error('❌ TON_WALLET_ADDRESS не задан'); process.exit(1); }

// в TonCenter авторизация — просто заголовок
const HEADERS = API_KEY ? { 'X-API-Key': API_KEY } : {};

// ──────────────────── удобные helpers ─────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Запрос последних raw-tx (decode=false) */
async function getRaw(limit = 40) {
  const url = `${API_HOST}/getTransactions`+
              `?address=${ADDRESS}&limit=${limit}&archival=true`;
  const r   = await fetch(url, { headers: HEADERS }).then(r => r.json());
  return r.result || [];
}

/** Запрос одной транзакции с decode=true */
async function getTx(lt, hash) {
  const url = `${API_HOST}/getTransaction`+
              `?address=${ADDRESS}&lt=${lt}&hash=${hash}&decode=true`;
  const r   = await fetch(url, { headers: HEADERS }).then(r => r.json());
  return r.result;
}

/**
 * TonCenter кладёт burn-uuid либо в msg_data.text (обычный комментарий),
 * либо только в msg_data.payload - base64-BOC.  Достаём строку из payload.
 * Декодируем очень грубо: идём после заголовка BOC
 * и собираем печатные UTF-8.
 */
function decodePayload(b64 = '') {
  try {
    const buf = Buffer.from(b64, 'base64');
    const ascii = [];
    for (const byte of buf) {
      // печатные ASCII + «-»
      if (byte >= 0x20 && byte <= 0x7E) ascii.push(byte);
      else if (ascii.length) break;
    }
    return Buffer.from(ascii).toString('utf8').trim();
  } catch { return ''; }
}

// ──────────────────── основной цикл ───────────────────
async function checkOnce() {
  // 1. берём список pending-инвойсов
  const { rows: pend } = await pool.query(
    `SELECT invoice_id, comment
       FROM burn_invoices
      WHERE status = 'pending'`
  );
  console.log('⏳ pending:', pend.length, pend.map(p => p.invoice_id));

  if (!pend.length) return;

  // 2. грузим последние транзакции
  const raws = await getRaw(40);
  console.log('📥 raw tx fetched:', raws.length);

  // 3. для каждой пытаемся расшифровать
  for (const raw of raws) {
    if (!raw.in_msg) continue;                    // входящего нет → пропуск
    const nano = Number(raw.in_msg.value || 0);
    if (nano < AMOUNT_NT) continue;              // меньше 0.5 TON

    const { lt, hash } = raw.transaction_id;
    const tx   = await getTx(lt, hash);
    const md   = tx?.in_msg?.msg_data || {};
    const text = md.text || decodePayload(md.payload);
    console.log('→ decoded', { lt, nano, text: text || 'undefined' });

    // 4. сверяем с каждым pending-счётом
    for (const inv of pend) {
      if (text === inv.comment) {
        await pool.query(
          `UPDATE burn_invoices
              SET status = 'paid', paid_at = NOW()
            WHERE invoice_id = $1`,
          [inv.invoice_id]
        );
        console.log('✔ PAID', inv.invoice_id);
      }
    }

    await sleep(150);            // чтобы не спамить тонцентр
  }
}

// ──────────────────── запуск ───────────────────────────
console.log(`🚀 Payment-checker started (interval ${STEP_MS/1000}s)`);

await checkOnce();               // первый прогон сразу
setInterval(checkOnce, STEP_MS); // далее по таймеру
