// worker/check-payments.js – периодически проверяет входящие TON-транзакции
// и помечает счета как оплаченные (+ подтверждает рефералов)
import 'dotenv/config.js';
import fetch  from 'node-fetch';
import pool   from '../db.js';
import { setTimeout as wait } from 'timers/promises';

/* ── ENV ─────────────────────────────────────────────────────────────── */
const {
  TON_WALLET_ADDRESS : ADDRESS,
  TONCENTER_API_KEY  : API_KEY,
  TON_RPC_ENDPOINT   : ENDPOINT = 'https://toncenter.com/api/v2',
  CHECK_INTERVAL_SEC : INTERVAL = 30
} = process.env;

/* ── helpers ─────────────────────────────────────────────────────────── */
const b64urlDecode = str => {
  if (!str) return undefined;
  try   { return Buffer.from(str, 'base64url').toString('utf-8'); }
  catch { return str; }
};
const log = (...a) => console.log(...a);

/* ── основной цикл ───────────────────────────────────────────────────── */
async function checkLoop() {
  log(`🚀 payment-checker started (every ${INTERVAL}s)`);
  while (true) {
    try {
      /* 1. все pending-инвойсы */
      const { rows: pend } = await pool.query(
        `SELECT invoice_id, tg_id, comment
           FROM burn_invoices
          WHERE status = 'pending'`
      );
      if (!pend.length) {
        await wait(INTERVAL * 1_000);
        continue;
      }

      /* 2. берём последние входящие tx */
      const url  = `${ENDPOINT}/getTransactions?address=${ADDRESS}&limit=40&decode=true`;
      const hdrs = API_KEY ? { 'X-API-Key': API_KEY } : {};
      const txs  = (await (await fetch(url, { headers: hdrs })).json()).result ?? [];

      const decoded = txs.map(t => ({
        nano: Number(t.in_msg?.value ?? 0),
        text: b64urlDecode(t.in_msg?.msg_data?.text)
      })).filter(d => d.text);

      /* 3. пытаемся матчить каждый invoice-comment */
      for (const inv of pend) {
        const okTx = decoded.find(d =>
          d.text === inv.comment && d.nano >= 500_000_000 /* 0.5 TON */);

        if (!okTx) continue;

        /* 3.1 помечаем счёт оплаченным */
        await pool.query(
          `UPDATE burn_invoices
              SET status = 'paid', paid_at = NOW()
            WHERE invoice_id = $1`,
          [inv.invoice_id]
        );
        log('✅ invoice paid', inv.invoice_id);

        /* 3.2 сразу переводим pending-рефералов → confirmed */
        await pool.query(
          `UPDATE referrals
              SET status = 'confirmed', updated_at = NOW()
            WHERE referred_id = $1 AND status = 'pending'`,
          [inv.tg_id]
        );
      }
    } catch (e) {
      console.error('🔥 payment-checker error:', e);
    }

    await wait(INTERVAL * 1_000);
  }
}

/* ── старт ───────────────────────────────────────────────────────────── */
checkLoop();
