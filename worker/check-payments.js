// worker/check-payments.js
import fetch from 'node-fetch';
import pool  from '../db.js';

const API_URL = process.env.TON_RPC_ENDPOINT   || 'https://toncenter.com/api/v2';
const API_KEY = process.env.TONCENTER_API_KEY  || '';
const ADDRESS = process.env.TON_WALLET_ADDRESS;
const AMOUNT  = 500_000_000;                      // 0.5 TON
const PERIOD  = Number(process.env.PAYMENT_CHECK_INTERVAL_MS) || 30_000;

const HEADERS = API_KEY ? { 'X-API-Key': API_KEY } : {};

const toHex = (s) => Buffer.from(s, 'utf8').toString('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getRawTxs (limit = 40) {
  const url = `${API_URL}/getTransactions?address=${ADDRESS}&limit=${limit}&archival=true`;
  return fetch(url, { headers: HEADERS }).then(r => r.json()).then(j => j.result || []);
}

async function getDecodedTx ({ lt, hash }) {
  const url = `${API_URL}/getTransaction?address=${ADDRESS}&lt=${lt}&hash=${hash}&decode=true`;
  return fetch(url, { headers: HEADERS }).then(r => r.json()).then(j => j.result);
}

async function checkPending () {
  try {
    const { rows: pend } = await pool.query(
      `SELECT invoice_id, comment FROM burn_invoices WHERE status='pending'`
    );
    if (!pend.length) return;

    const raws = await getRawTxs(40);

    for (const raw of raws) {
      if (!raw?.in_msg) continue;                 // <--- защита №1 (нет входящего msg)

      const nano = Number(raw.in_msg.value || 0);
      if (nano < AMOUNT) continue;                // меньше 0.5 TON → не интересует

      // декодируем конкретную транзакцию
      const { lt, hash } = raw.transaction_id;
      const full = await getDecodedTx({ lt, hash });

      const md   = full?.in_msg?.msg_data || {};
      const txt  = md.text;
      const hex  = md.payload;

      for (const inv of pend) {
        if (
          txt === inv.comment ||
          (hex && hex.includes(toHex(inv.comment)))
        ) {
          await pool.query(
            `UPDATE burn_invoices
                SET status = 'paid', paid_at = NOW()
              WHERE invoice_id = $1`,
            [inv.invoice_id]
          );
          console.log('✔ invoice', inv.invoice_id, 'marked PAID');
        }
      }

      await sleep(120);                           // <--- задержка только на «кандидатах»
    }
  } catch (err) {
    console.error('❌ payment-checker error:', err.message);
  }
}

console.log(`🚀 Payment-checker started (interval ${PERIOD / 1000}s)`);
await checkPending();                 // первый проход сразу
setInterval(checkPending, PERIOD);    // далее каждые PERIOD
