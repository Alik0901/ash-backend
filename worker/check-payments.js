import fetch from 'node-fetch';
import pool  from '../db.js';

// --- конфиг ---
const API_URL   = process.env.TON_RPC_ENDPOINT  || 'https://toncenter.com/api/v2';
const API_KEY   = process.env.TONCENTER_API_KEY || '';
const ADDRESS   = process.env.TON_WALLET_ADDRESS;
const STEP_MS   = 30_000;               // каждые 30 с
const AMOUNT_NT = 500_000_000;          // 0.5 TON

if (!ADDRESS) { console.error('❌ TON_WALLET_ADDRESS not set'); process.exit(1); }
const HEADERS = API_KEY ? { 'X-API-Key': API_KEY } : {};
const hex = s => Buffer.from(s,'utf8').toString('hex');
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// --- запросы ---
const getRaw = async l=>{
  const u=`${API_URL}/getTransactions?address=${ADDRESS}&limit=${l}&archival=true`;
  return fetch(u,{headers:HEADERS}).then(r=>r.json()).then(j=>j.result||[]);
};
const getTx  = async ({lt,hash})=>{
  const u=`${API_URL}/getTransaction?address=${ADDRESS}&lt=${lt}&hash=${hash}&decode=true`;
  return fetch(u,{headers:HEADERS}).then(r=>r.json()).then(j=>j.result);
};

// --- основной цикл ---
async function check() {
  try {
    const { rows: pend } = await pool.query(
      `SELECT invoice_id, comment FROM burn_invoices WHERE status='pending'`
    );
    console.log('⏳ pending:', pend.length, pend.map(p=>p.invoice_id));

    if (!pend.length) return;

    const raws = await getRaw(40);
    console.log('📥 raw tx fetched:', raws.length);

    for (const r of raws) {
      if (!r.in_msg) { console.log('• skip (no in_msg)'); continue; }

      const nano = +r.in_msg.value || 0;
      if (nano < AMOUNT_NT) continue;

      const full = await getTx(r.transaction_id);
      const md   = full?.in_msg?.msg_data || {};
      const txt  = md.text;
      const pl   = md.payload;
      console.log('→ decoded', { lt:r.transaction_id.lt, nano, txt });

      for (const inv of pend) {
        const ok = txt===inv.comment || (pl && pl.includes(hex(inv.comment)));
        if (ok) {
          await pool.query(
            `UPDATE burn_invoices SET status='paid', paid_at=NOW() WHERE invoice_id=$1`,
            [inv.invoice_id]
          );
          console.log('✔ PAID', inv.invoice_id);
        }
      }
      await sleep(120);     // не спамим TonCenter
    }
  } catch(e){ console.error('💥 worker error:', e); }
}

console.log(`🚀 Payment-checker started (interval ${STEP_MS/1000}s)`);
await check();                                  // сразу
setInterval(check, STEP_MS);                    // далее по таймеру
