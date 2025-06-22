/*  Order-of-Ash · routes/player.js – v2.4 (22 Jun 2025)
    ─────────────────────────────────────────────────────────
    • /burn-invoice  /burn-status  (полные)
    • /referral       — «мягкий» (не 404, если игрока нет)
    • /fragments      — выдаёт список фрагментов
    • /stats/total_users
*/

import express from 'express';
import crypto  from 'crypto';
import jwt     from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import pool    from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/* ── env ─────────────────────────────────────────────────── */
const { JWT_SECRET, TON_WALLET_ADDRESS: TON_ADDR } = process.env;

/* ── constants ───────────────────────────────────────────── */
const TONHUB_URL      = 'https://tonhub.com/transfer';
const TONSPACE_SCHEME = 'ton://transfer';
const AMOUNT_NANO     = 500_000_000;            // 0.5 TON
const FRAGS           = [1,2,3,4,5,6,7,8];

/* ── helpers ─────────────────────────────────────────────── */
const sign = u => jwt.sign(
  { tg_id: u.tg_id, name: u.name }, JWT_SECRET, { expiresIn:'1h' });
const randRef = () => crypto.randomBytes(6).toString('base64url');

/* ╔════════════════  PUBLIC  ══════════════════════════════ */

/* ► профиль */
router.get('/player/:tg_id', async (req,res)=>{
  try {
    const { rows } = await pool.query(
      `SELECT tg_id,name,fragments,last_burn,is_cursed,curse_expires,
              curses_count,ref_code,referral_reward_issued
         FROM players WHERE tg_id=$1 LIMIT 1`, [req.params.tg_id]);

    if (!rows.length) return res.status(404).json({error:'player not found'});

    const { rows:[{count}] } = await pool.query(
      `SELECT COUNT(*) FROM referrals
        WHERE referrer_id=$1 AND status='confirmed'`, [rows[0].tg_id]);

    res.json({ ...rows[0], invitedCount:Number(count) });
  } catch(e){
    console.error('[player] ',e); res.status(500).json({error:'internal'});
  }
});

/* ► регистрация / JWT */
router.post('/init', async (req,res)=>{
  const { tg_id, name='', initData='', referrer_code=null } = req.body;
  if(!tg_id||!initData) return res.status(400).json({error:'tg_id required'});

  try{
    let { rows } = await pool.query(
      `SELECT * FROM players WHERE tg_id=$1`,[tg_id]);

    if(!rows.length){                                // новый
      const myCode = await genUniqueCode();
      const client = await pool.connect();
      try{
        await client.query('BEGIN');

        const { rows:[me] } = await client.query(
          `INSERT INTO players
             (tg_id,name,is_cursed,curses_count,curse_expires,
              ref_code,referral_reward_issued)
           VALUES ($1,$2,FALSE,0,NULL,$3,FALSE)
           RETURNING *`,[tg_id,name||null,myCode]);

        if(referrer_code){
          const { rows:[ref] } = await client.query(
            `SELECT tg_id FROM players WHERE ref_code=$1 LIMIT 1`,
            [referrer_code.trim()]);
          if(!ref){ await client.query('ROLLBACK');
            return res.status(400).json({error:'Invalid referral code'});}

          await client.query(
            `INSERT INTO referrals (referrer_id,referred_id,status)
             VALUES ($1,$2,'pending')`,[ref.tg_id,tg_id]);
        }

        await client.query('COMMIT');
        rows=[me];
      }catch(e){await client.query('ROLLBACK');throw e;}
      finally{client.release();}
    }
    res.json({user:rows[0],token:sign(rows[0])});
  }catch(e){
    console.error('[init] ',e);res.status(500).json({error:'internal'});
  }
});

/* ╔══════════════  PROTECTED  ═════════════════════════════ */
router.use(authenticate);

/* ► создать счёт */
router.post('/burn-invoice', async (req,res)=>{
  const { tg_id } = req.body;
  if(!tg_id) return res.status(400).json({error:'tg_id required'});
  try{
    const id      = uuid();
    const comment = crypto.randomBytes(4).toString('hex');

    await pool.query(
      `INSERT INTO burn_invoices
         (invoice_id,tg_id,amount_nano,address,comment,status,created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',NOW())`,
      [id,tg_id,AMOUNT_NANO,TON_ADDR,comment]);

    res.json({
      invoiceId : id,
      paymentUrl: `${TONHUB_URL}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`,
      tonspaceUrl:`${TONSPACE_SCHEME}/${TON_ADDR}?amount=${AMOUNT_NANO}&text=${comment}`
    });
  }catch(e){console.error('[burn-invoice]',e);
    res.status(500).json({error:'internal'});}
});

/* ► статус счёта + бизнес-логика */
router.get('/burn-status/:invoiceId', async (req,res)=>{
  try{
    const { rows:[inv] } = await pool.query(
      `SELECT status FROM burn_invoices WHERE invoice_id=$1`,[req.params.invoiceId]);
    if(!inv) return res.status(404).json({error:'invoice not found'});
    if(inv.status!=='paid') return res.json({paid:false});

    const result = await runBurnLogic(req.params.invoiceId);
    res.json({paid:true, ...result});
  }catch(e){console.error('[burn-status]',e);
    res.status(500).json({error:'internal'});}
});

/* ► мои фрагменты */
router.get('/fragments/:tg_id', async (req,res)=>{
  try{
    const { rows:[p] } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,[req.params.tg_id]);
    if(!p) return res.status(404).json({error:'not found'});
    res.json({ fragments:p.fragments||[] });
  }catch(e){console.error('[fragments]',e);
    res.status(500).json({error:'internal'});}
});

/* ► общее число игроков */
router.get('/stats/total_users', async (_req,res)=>{
  try{
    const { rows:[{count}] } =
      await pool.query('SELECT COUNT(*) FROM players');
    res.json({ total:Number(count) });
  }catch(e){console.error('[stats]',e);
    res.status(500).json({error:'internal'});}
});

/* ► сводка по рефералам */
router.get('/referral/:tg_id', async (req,res)=>{
  if(String(req.user.tg_id)!==req.params.tg_id)
    return res.status(403).json({error:'Forbidden'});
  try{
    const { rows:[p] } = await pool.query(
      `SELECT ref_code,referral_reward_issued
         FROM players WHERE tg_id=$1`,[req.user.tg_id]);
    if(!p) return res.json({refCode:null,invitedCount:0,rewardIssued:false});

    const { rows:[{count}] } = await pool.query(
      `SELECT COUNT(*) FROM referrals
        WHERE referrer_id=$1 AND status='confirmed'`,[req.user.tg_id]);

    res.setHeader('Authorization',`Bearer ${sign(req.user)}`);
    res.json({ refCode:p.ref_code,invitedCount:Number(count),
               rewardIssued:p.referral_reward_issued });
  }catch(e){console.error('[referral]',e);
    res.status(500).json({error:'internal'});}
});

/* ── runBurnLogic ────────────────────────────────────────── */
async function runBurnLogic (invoiceId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    /* 1. Берём счёт, фиксируем строку (FOR UPDATE).
          Обрабатываем только unpaid-→paid и ещё не processed. */
    const { rows: [inv] } = await client.query(
      `SELECT tg_id, processed
         FROM burn_invoices
        WHERE invoice_id = $1
          AND status      = 'paid'
        FOR UPDATE`,
      [invoiceId]
    );

    if (!inv || inv.processed) {                // уже обработан или не найден
      await client.query('ROLLBACK');
      return { newFragment: null, cursed: false, curse_expires: null };
    }

    /* 2. Читаем игрока, решаем какой фрагмент выдать */
    const { rows: [pl] } = await client.query(
      `SELECT fragments
         FROM players
        WHERE tg_id = $1
        FOR UPDATE`,
      [inv.tg_id]
    );

    const owned     = pl.fragments ?? [];
    const available = FRAGS.filter(f => !owned.includes(f));
    const pick      = available.length
                        ? available[crypto.randomInt(available.length)]
                        : null;                    // могут закончиться

    /* 3. Обновляем игрока + помечаем счёт processed */
    await client.query(
      `UPDATE players
         SET fragments = CASE
                           WHEN $2 IS NULL       -- нет свободных фрагментов
                             THEN fragments
                           ELSE array_append(fragments, $2::int)
                         END,
             last_burn = NOW()
       WHERE tg_id = $1`,
      [inv.tg_id, pick]                          // ::int важно, иначе 42P08
    );

    await client.query(
      `UPDATE burn_invoices
          SET processed = TRUE
        WHERE invoice_id = $1`,
      [invoiceId]
    );

    await client.query('COMMIT');
    return { newFragment: pick, cursed: false, curse_expires: null };

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[runBurnLogic]', err);
    throw err;

  } finally {
    client.release();
  }
}

/* ── вспомогательное ─────────────────────────────────────── */
async function genUniqueCode(){
  for(let i=0;i<8;i++){
    const code = randRef();
    const { rows } =
      await pool.query(`SELECT 1 FROM players WHERE ref_code=$1 LIMIT 1`,
        [code]);
    if(!rows.length) return code;
  }
  return crypto.randomBytes(8).toString('base64url');
}

export default router;
