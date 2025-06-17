// worker/check-payments.js
// -----------------------------------------------------------------------------
import 'dotenv/config.js';
import fetch from 'node-fetch';
import pool  from '../db.js';
import { setTimeout as wait } from 'timers/promises';

// ─── env ----------------------------------------------------------------------
const {
  TON_WALLET_ADDRESS : ADDRESS,
  TONCENTER_API_KEY  : API_KEY,
  TON_RPC_ENDPOINT   : ENDPOINT = 'https://toncenter.com/api/v2',
  CHECK_INTERVAL_SEC : INTERVAL = 30,               // сек
} = process.env;

// ─── helpers ------------------------------------------------------------------
/** base64url → utf-8; если строка не base64, вернёт то, что пришло */
function b64urlDecode(str) {
  if (!str) return undefined;
  try { return Buffer.from(str, 'base64url').toString('utf-8'); }
  catch { return str; }
}
function log(...a) { console.log(...a); }

// ─── основной цикл ------------------------------------------------------------
async function checkLoop() {
  log(`🚀 payment-checker started (every ${INTERVAL}s)`);
  /* бесконечный цикл */
  while (true) {
    try {
      // 1. pending-инвойсы ------------------------------------------------------
      const { rows: pend } = await pool.query(
        `SELECT invoice_id, comment FROM burn_invoices
          WHERE status = 'pending'`
      );
      if (!pend.length) {
        log('😴  no pending invoices');
        await wait(INTERVAL * 1_000);
        continue;
      }
      log(`📋 pending = ${pend.length}`, pend.map(p => p.comment));

      // 2. последние входящие транзакции ---------------------------------------
      const url   = `${ENDPOINT}/getTransactions`
                  + `?address=${ADDRESS}&limit=40&decode=true`;
      const hdrs  = API_KEY ? { 'X-API-Key': API_KEY } : {};
      const resp  = await fetch(url, { headers: hdrs });
      const json  = await resp.json();
      const txs   = json.result ?? [];
      log(`📨 fetched ${txs.length} tx`);

      // 3. декодируем ----------------------------------------------------------
      const decoded = txs.map(t => ({
        lt  : t.transaction_id.lt,
        nano: Number(t.in_msg?.value ?? 0),
        text: b64urlDecode(t.in_msg?.msg_data?.text),
      })).filter(d => d.text);        // нам интересны только tx с текстом

      decoded.forEach(d => log('   →', d));

      // 4. ищем совпадения -----------------------------------------------------
      for (const inv of pend) {
        const ok = decoded.find(
          d => d.text === inv.comment && d.nano >= 500_000_000
        );
        if (!ok) continue;

        await pool.query(
          `UPDATE burn_invoices
              SET status='paid', paid_at = NOW()
            WHERE invoice_id = $1`,
          [inv.invoice_id]
        );
        log('✅ invoice paid', inv.invoice_id);
      }
    } catch (e) {
      console.error('🔥 payment-checker error:', e);
    }

    await wait(INTERVAL * 1_000);
  }
}

// ─── старт --------------------------------------------------------------------
checkLoop();
