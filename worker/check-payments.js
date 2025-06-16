// worker/check-payments.js
import fetch from 'node-fetch';
import pool  from '../db.js';

const RPC_URL     = process.env.TON_RPC_ENDPOINT;    // например, https://rpc.tonhub.com
const TON_ADDRESS = process.env.TON_WALLET_ADDRESS; // ваш адрес
const INTERVAL    = 30_000;                         // проверять раз в 30 секунд

async function checkPending() {
  // 1) Берём все pending-инвойсы из БД
  const { rows: pendings } = await pool.query(`
    SELECT invoice_id, comment
      FROM burn_invoices
     WHERE status = 'pending'
  `);

  for (const { invoice_id, comment } of pendings) {
    try {
      // 2) Запрашиваем все входящие сообщения в messages-коллекции
      const rpcBody = {
        jsonrpc: '2.0',
        id:      1,
        method:  'net.query_collection',
        params: {
          collection: 'messages',
          filter: {
            dst:     { eq: TON_ADDRESS },
            '@type': { eq: 'msg.dataRaw' }
          },
          result: 'id body'
        }
      };

      const rpcResp = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcBody)
      }).then(r => r.json());

      const msgs = rpcResp.result?.result || [];
      // комментарий сверяем в hex
      const hexComment = Buffer.from(comment).toString('hex');
      const paid = msgs.some(m => m.body.includes(hexComment));

      if (paid) {
        // 3) Обновляем статус в БД
        await pool.query(`
          UPDATE burn_invoices
             SET status  = 'paid',
                 paid_at = NOW()
           WHERE invoice_id = $1
        `, [invoice_id]);
        console.log(`✔ marked paid: ${invoice_id}`);
      }
    } catch (err) {
      console.error(`❌ error checking invoice ${invoice_id}:`, err);
    }
  }
}

// Запуск по таймеру
console.log(`🚀 Payment-checker started (every ${INTERVAL/1000}s)`);
setInterval(checkPending, INTERVAL);