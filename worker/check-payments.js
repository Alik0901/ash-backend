// worker/check-payments.js
// ───────────────────────────────────────────────────────────────────────────────
// Периодически проверяем входящие переводы на TON-кошелек и закрываем инвойсы
//
// • каждые 30 с получаем N последних tx через TonCenter
// • декодируем msg_data (base64url → utf-8, TL-B)
// • сравниваем с burn_invoices.status='pending'
// • если нашёлся матч ⇒ UPDATE status='paid', paid_at = NOW()
// • логируем **всё**, чтобы было видно, что происходит
// ───────────────────────────────────────────────────────────────────────────────

import 'dotenv/config.js';
import fetch               from 'node-fetch';
import pool                from '../db.js';
import { parseMsgBody }    from './tlb-decode.js';   // маленькая обёртка для tlb-codec
import { setTimeout as wait } from 'timers/promises';

// ─── env ──────────────────────────────────────────────────────────────────────
const {
  TON_WALLET_ADDRESS: ADDRESS,
  TONCENTER_API_KEY  : API_KEY,
  TON_RPC_ENDPOINT   : ENDPOINT = 'https://toncenter.com/api/v2',
  CHECK_INTERVAL_SEC : INTERVAL = 30,
} = process.env;

// ─── helpers ─────────────────────────────────────────────────────────────────
/** base64url → utf-8; если не base64url — вернём как есть */
function b64urlDecode(str) {
  if (!str) return undefined;
  try {
    return Buffer.from(str, 'base64url').toString('utf-8');
  } catch {              // не base64 → возвращаем исходное
    return str;
  }
}
/** красиво логируем JSON */
function log(...args) { console.log(...args); }

// ─── основная функция цикла ──────────────────────────────────────────────────
async function checkLoop() {
  while (true) {
    try {
      /** 1. Берём все «pending» инвойсы */
      const { rows: pending } = await pool.query(
        `SELECT invoice_id, comment, tg_id FROM burn_invoices
          WHERE status = 'pending'`
      );
      if (!pending.length) {
        log('😴  нет незакрытых инвойсов');
        await wait(INTERVAL * 1_000);
        continue;
      }

      log(`⏳ pending: ${pending.length} [`);
      pending.forEach(r => log(`  '${r.comment}',`));
      log(']');

      /** 2. Берём последние 40 входящих tx */
      const url   =
        `${ENDPOINT}/getTransactions?` +
        `address=${ADDRESS}&limit=40&decode=true`;
      const hdrs  = API_KEY ? { 'X-API-Key': API_KEY } : {};
      const res   = await fetch(url, { headers: hdrs });
      const json  = await res.json();
      const txs   = json.result ?? [];

      log(`📨 raw tx fetched: ${txs.length}`);

      /** 3. «Разжёвываем» каждую транзакцию */
      const decoded = txs.map(tx => {
        // 3.1 текст может быть либо в msg_data.text (base64url),
        //     либо в msg_data.body (BOC), либо вообще отсутствовать
        const txt =
              b64urlDecode(tx.in_msg?.msg_data?.text) ??
              parseMsgBody(tx.in_msg?.msg_data?.body);

        const obj = {
          lt  : tx.transaction_id.lt,
          nano: Number(tx.in_msg?.value ?? 0), // в наносах
          text: txt
        };
        log('➜ decoded', obj);
        return obj;
      });

      /** 4. Матчим каждую pending-строку */
      for (const inv of pending) {
        const match = decoded.find(d =>
          d.text === inv.comment && d.nano >= 500_000_000
        );

        if (!match) continue;

        // 4.1 Закрываем счёт
        await pool.query(
          `UPDATE burn_invoices
              SET status = 'paid', paid_at = NOW()
            WHERE invoice_id = $1`,
          [inv.invoice_id]
        );
        log('💰 invoice paid', inv.invoice_id);

        // 4.2 (по желанию) пуш-уведомление в чат можно вызвать здесь
      }
    } catch (err) {
      console.error('🔥 payment-checker error:', err);
    }

    await wait(INTERVAL * 1_000);
  }
}

// ─── старт ───────────────────────────────────────────────────────────────────
log(`🚀 payment-checker started (interval ${INTERVAL}s)`);
checkLoop();
