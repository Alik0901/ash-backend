import fetch from 'node-fetch';
import pool  from '../db.js';

const API_URL   = process.env.TON_RPC_ENDPOINT   || 'https://toncenter.com/api/v2';
const API_KEY   = process.env.TONCENTER_API_KEY  || '';            // можно пустой
const ADDRESS   = process.env.TON_WALLET_ADDRESS;                  // обязателен
const AMOUNT_NT = 500_000_000;                                     // 0.5 TON в nano
const PERIOD    = Number(process.env.PAYMENT_CHECK_INTERVAL_MS) || 30_000;

if (!ADDRESS) {
  console.error('❌ TON_WALLET_ADDRESS не задан');
  process.exit(1);
}

const HEADERS = API_KEY ? { 'X-API-Key': API_KEY } : {};

//----------------------------------------
// утилиты
//----------------------------------------
const utf8ToHex = (str) => Buffer.from(str, 'utf8').toString('hex');
const sleep     = (ms)  => new Promise(r => setTimeout(r, ms));

//----------------------------------------
// запрос N «сырых» транзакций
//----------------------------------------
async function getRawTxs(limit = 30) {
  const url = `${API_URL}/getTransactions` +
              `?address=${ADDRESS}&limit=${limit}&archival=true`;
  const json = await fetch(url, { headers: HEADERS }).then(r => r.json());
  return json.result || [];
}

//----------------------------------------
// запрос одной транзакции с decode=true
//----------------------------------------
async function getDecodedTx({ lt, hash }) {
  const url = `${API_URL}/getTransaction` +
              `?address=${ADDRESS}&lt=${lt}&hash=${hash}&decode=true`;
  const json = await fetch(url, { headers: HEADERS }).then(r => r.json());
  return json.result;
}

//----------------------------------------
// основной цикл проверки
//----------------------------------------
async function checkPending() {
  try {
    // 1. берём все «pending» счета
    const { rows: pending } = await pool.query(
      `SELECT invoice_id, comment
         FROM burn_invoices
        WHERE status = 'pending'`
    );
    if (!pending.length) return;

    // 2. получаем свежие raw-тx
    const raws = await getRawTxs(40);

    for (const raw of raws) {
      const nano = Number(raw.in_msg?.value || 0);
      if (nano < AMOUNT_NT) continue;               // меньше 0.5 TON

      // 3. декодируем сообщение
      const { lt, hash } = raw.transaction_id;
      const full = await getDecodedTx({ lt, hash });

      const md   = full.in_msg?.msg_data || {};
      const text = md.text;                         // декодированный коммент
      const hex  = md.payload;                      // если text нет

      if (!text && !hex) continue;                  // нет комментария

      // 4. ищем совпадение среди pending
      for (const inv of pending) {
        const wantTxt = inv.comment;
        const wantHex = utf8ToHex(wantTxt);

        if (text === wantTxt || (hex && hex.includes(wantHex))) {
          await pool.query(
            `UPDATE burn_invoices
                SET status = 'paid', paid_at = NOW()
              WHERE invoice_id = $1`,
            [inv.invoice_id]
          );
          console.log('✔ invoice', inv.invoice_id, 'marked PAID');
        }
      }

      // ▸ небольшая задержка, чтобы не бомбить TonCenter
      await sleep(120); // ~8-9 запросов в секунду
    }
  } catch (err) {
    console.error('❌ payment-checker error:', err.message);
  }
}

//----------------------------------------
// запуск
//----------------------------------------
console.log(`🚀 Payment-checker started (interval ${PERIOD / 1000}s)`);
await checkPending();               // первая проверка сразу
setInterval(checkPending, PERIOD);  // далее по таймеру