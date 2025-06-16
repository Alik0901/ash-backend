import fetch from 'node-fetch';
import pool  from '../db.js';

const API   = process.env.TON_RPC_ENDPOINT      // https://toncenter.com/api/v2
const KEY   = process.env.TONCENTER_API_KEY     // опционально
const ADDR  = process.env.TON_WALLET_ADDRESS;   // ваш кошелёк
const STEP  = 30_000;                           // каждые 30 секунд

async function getLastTxs(limit = 20) {
  const url = `${API}/getTransactions?address=${ADDR}&limit=${limit}`;
  const resp = await fetch(url, {
    headers: KEY ? { 'X-API-Key': KEY } : {}
  }).then(r => r.json());
  return resp.result;         // массив транзакций
}

async function checkPending() {
  // 1) все pending инвойсы
  const { rows } = await pool.query(
    `SELECT invoice_id, comment
       FROM burn_invoices
      WHERE status = 'pending'`
  );

  if (!rows.length) return;

  // 2) свежие входящие tx
  const txs = await getLastTxs(50);

  for (const inv of rows) {
    const match = txs.find(t =>
      t.in_msg?.msg_data?.text === inv.comment &&
      Number(t.in_msg?.value)   >= 500_000_000      // минимум 0.5 TON
    );

    if (match) {
      await pool.query(
        `UPDATE burn_invoices
            SET status='paid', paid_at=NOW()
          WHERE invoice_id=$1`,
        [inv.invoice_id]
      );
      console.log(`✔ invoice ${inv.invoice_id} marked PAID`);
    }
  }
}

console.log(`🚀 Payment-checker started (every ${STEP/1000}s)`);
setInterval(checkPending, STEP);
