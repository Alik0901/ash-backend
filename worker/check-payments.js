/* Order-of-Ash · worker/check-payments.js — v2.2
   ───────────────────────────────────────────────────────────────────
   • больше НЕТ «вечного» клиента → каждую итерацию берём, используем, release
   • тем самым pool-exhaustion исключён
*/

import 'dotenv/config.js';
import fetch   from 'node-fetch';
import pool    from '../db.js';
import { setTimeout as wait } from 'timers/promises';

/* ─ env ─────────────────────────────────────────────────────────── */
const {
  TON_WALLET_ADDRESS : ADDRESS,
  TONCENTER_API_KEY  : API_KEY,
  TON_RPC_ENDPOINT   : ENDPOINT = 'https://toncenter.com/api/v2',
  CHECK_INTERVAL_SEC : INTERVAL = 30
} = process.env;

/* ─ helpers ─────────────────────────────────────────────────────── */
const b64urlDecode = str => {
  if (!str) return undefined;
  try   { return Buffer.from(str, 'base64url').toString('utf-8'); }
  catch { return str; }
};
const log = (...args) => console.log(...args);

/* ─ main loop ───────────────────────────────────────────────────── */
async function checkLoop() {
  log(`🚀 payment-checker started (every ${INTERVAL}s)`);

  while (true) {
    try {
      /* 1. pending invoices */
      const { rows: pending } = await pool.query(`
        SELECT invoice_id, tg_id, comment
          FROM burn_invoices
         WHERE status = 'pending'
      `);

      if (!pending.length) {
        await wait(INTERVAL * 1000);
        continue;
      }

      /* 2. last inbound tx */
      const url  = `${ENDPOINT}/getTransactions?address=${ADDRESS}&limit=40&decode=true`;
      const hdrs = API_KEY ? { 'X-API-Key': API_KEY } : {};
      const resp = await fetch(url, { headers: hdrs });
      const data = await resp.json();
      const txs  = data.result ?? [];

      const decoded = txs
        .map(t => ({
          nano: Number(t.in_msg?.value ?? 0),
          text: b64urlDecode(t.in_msg?.msg_data?.text)
        }))
        .filter(d => d.text);

      /* 3. обрабатываем каждую квитанцию */
      for (const inv of pending) {
        const match = decoded.find(d =>
          d.text === inv.comment && d.nano >= 500_000_000
        );
        if (!match) continue;

        /* транзакция — один клиент, автокоммит OFF */
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          await client.query(
            `UPDATE burn_invoices
                SET status = 'paid',
                    paid_at = NOW()
              WHERE invoice_id = $1`,
            [inv.invoice_id]
          );

          await client.query(
            `UPDATE referrals
                SET status     = 'confirmed',
                    updated_at = NOW()
              WHERE referred_id = $1
                AND status = 'pending'`,
            [inv.tg_id]
          );

          await client.query('COMMIT');
          log('✅ invoice paid', inv.invoice_id);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('🔥 worker tx error:', err);
        } finally {
          client.release();
        }
      }
    } catch (err) {
      console.error('🔥 payment-checker loop error:', err);
    }

    await wait(INTERVAL * 1000);
  }
}

checkLoop().catch(err => {
  console.error('🔥 payment-checker startup error:', err);
  process.exit(1);
});
