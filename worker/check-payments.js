// worker/check-payments.js ── Payment Checker
import 'dotenv/config.js';
import fetch from 'node-fetch';
import pool   from '../db.js';
import { setTimeout as wait } from 'timers/promises';

/* ── ENV ─────────────────────────────────────────────────────────────── */
const {
  TON_WALLET_ADDRESS : ADDRESS,
  TONCENTER_API_KEY  : API_KEY,
  TON_RPC_ENDPOINT   : ENDPOINT = 'https://toncenter.com/api/v2',
  CHECK_INTERVAL_SEC : INTERVAL = 30
} = process.env;

/* ── Helpers ────────────────────────────────────────────────────────── */
const b64urlDecode = str => {
  if (!str) return undefined;
  try   { return Buffer.from(str, 'base64url').toString('utf-8'); }
  catch { return str; }
};
const log = (...args) => console.log(...args);

/* ── Main Loop ──────────────────────────────────────────────────────── */
async function checkLoop() {
  log(`🚀 payment-checker started (every ${INTERVAL}s)`);

  // Одиночный клиент вместо pool.query()
  const client = await pool.connect();
  client.on('error', err => {
    console.error('❌ Fatal PG client error in worker:', err);
    // Принудительно выходим, чтобы Railway автоматически перезапустил сервис
    process.exit(1);
  });

  while (true) {
    try {
      /* 1. выберем все pending-инвойсы */
      const { rows: pending } = await client.query(`
        SELECT invoice_id, tg_id, comment
          FROM burn_invoices
         WHERE status = 'pending'
      `);

      if (pending.length === 0) {
        await wait(INTERVAL * 1000);
        continue;
      }

      /* 2. получить последние входящие транзакции */
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

      /* 3. пробегаем по каждому pending-инвойсу */
      for (const inv of pending) {
        const match = decoded.find(d =>
          d.text === inv.comment && d.nano >= 500_000_000
        );
        if (!match) continue;

        /* 3.1 отмечаем счёт как оплаченный */
        await client.query(`
          UPDATE burn_invoices
             SET status = 'paid',
                 paid_at = NOW()
           WHERE invoice_id = $1
        `, [inv.invoice_id]);
        log('✅ invoice paid', inv.invoice_id);

        /* 3.2 подтверждаем связанные рефералы */
        await client.query(`
          UPDATE referrals
             SET status     = 'confirmed',
                 updated_at = NOW()
           WHERE referred_id = $1
             AND status = 'pending'
        `, [inv.tg_id]);
      }
    } catch (err) {
      console.error('🔥 payment-checker loop error:', err);
    }

    // Ждём заданный интервал перед следующей итерацией
    await wait(INTERVAL * 1000);
  }
}

// Запускаем
checkLoop().catch(err => {
  console.error('🔥 payment-checker startup error:', err);
  process.exit(1);
});
