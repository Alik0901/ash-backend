/* eslint-disable no-console */
import dotenv   from 'dotenv';
import fetch    from 'node-fetch';
import { setTimeout as wait } from 'timers/promises';
import pool     from '../db.js';

dotenv.config();

// ───────────────────────────────────────────────────────
// 1. Константы

const WALLET  = process.env.TON_WALLET_ADDRESS;
const API_KEY = process.env.TONCENTER_API_KEY || '';          // optional
const PERIOD  = 30_000;                                       // 30 с
const NEED_NANO = 500_000_000;                                // 0,5 TON

// ───────────────────────────────────────────────────────
// 2. Вспомогалки

function nano(n) { return Number(n); }

// одна-единственная! функция декодирования
function base64Decode(b64) {
  return Buffer.from(b64, 'base64url');
}

// парсим ячейку boc → пытаемся вытащить комментарий (Text comment)
function parseMsgBody(boc) {
  try {
    const cell = base64Decode(boc);
    // буквы TL-B: первый бит “0” = ordinary text comment
    if (cell[0] === 0) {
      return cell.subarray(1).toString('utf-8');
    }
  } catch { /* ignore */ }
  return undefined;
}

// ───────────────────────────────────────────────────────
// 3. Функция одного цикла

async function runOnce() {
  // 3.1 «pending» счета
  const { rows: pending } = await pool.query(
    `SELECT invoice_id, comment
       FROM burn_invoices
      WHERE status = 'pending'`
  );
  if (!pending.length) {
    console.log('⏳ pending: 0');
    return;
  }
  console.log('⏳ pending:', pending.length, pending.map(p => `'${p.invoice_id}'`));

  // 3.2 подтягиваем последние входящие транзакции
  const url = 'https://toncenter.com/api/v2/getTransactions'
    + `?address=${WALLET}&limit=15&decode=true`;

  const r = await fetch(url, API_KEY ? { headers: { 'X-API-Key': API_KEY } } : {});
  const j = await r.json();
  const txs = j.result ?? [];
  console.log(`📦 raw tx fetched: ${txs.length}`);

  // 3.3 декодируем msg_data у каждой in-msg
  const decoded = txs.map(tx => {
    const body = tx.in_msg?.msg_data;
    const txt  = body?.text               // toncenter уже декодировал
             ?? parseMsgBody(body?.body); // пробуем сами
    return {
      lt:   tx.transaction_id.lt,
      nano: nano(tx.in_msg?.value ?? 0),
      text: txt
    };
  });

  decoded.forEach(d => console.log('➡ decoded', d));

  // 3.4 сопоставляем
  for (const inv of pending) {
    const hit = decoded.find(d =>
      d.text === inv.comment && d.nano >= NEED_NANO
    );
    if (!hit) continue;

    // 3.5 апдейтим базу
    await pool.query(
      `UPDATE burn_invoices
          SET status='paid', paid_at=NOW()
        WHERE invoice_id = $1`,
      [inv.invoice_id]
    );
    console.log('💰 invoice paid', inv.invoice_id);
  }
}

// ───────────────────────────────────────────────────────
// 4. Бесконечный цикл

(async function loop() {
  console.log(`🚀 Payment-checker started (interval ${PERIOD / 1000}s)`);
  /* eslint-disable no-constant-condition */
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      console.error('❌ payment-checker error:', e);
    }
    await wait(PERIOD);
  }
})();
