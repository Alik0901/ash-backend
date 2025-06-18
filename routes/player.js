/* ──────────────────────────────────────────────────────────────────────────
 *  routes/player.js   —   API-роуты мини-приложения “Order of Ash”
 * -------------------------------------------------------------------------
 *  Публичные:
 *    • GET  /api/player/:tg_id
 *    • POST /api/init
 *
 *  Защищённые JWT:
 *    • GET  /api/fragments/:tg_id
 *    • GET  /api/stats/total_users
 *    • POST /api/burn-invoice
 *    • GET  /api/burn-status/:invoiceId?
 * ----------------------------------------------------------------------- */

import express  from 'express';
import crypto   from 'crypto';
import jwt      from 'jsonwebtoken';
import pool     from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/* ─────────── неизменяемые константы ─────────── */
const JWT_SECRET      = process.env.JWT_SECRET;
const TON_ADDRESS     = process.env.TON_WALLET_ADDRESS;
const TONHUB_URL      = 'https://tonhub.com/transfer';
const TONSPACE_SCHEME = 'ton://transfer';

const FIXED_AMOUNT  = '0.5';        // TON
const AMOUNT_NANO   = 500_000_000;  // 0.5 TON == 500 000 000 nanoTon
const COOLDOWN_MS   = 2 * 60 * 1000;

/* фрагменты и проклятия */
const FRAGS        = [1,2,3,4,5,6,7,8];
const MAX_CURSES   = 4;
const CURSE_HOURS  = 24;

/* ─────────── утилиты ─────────── */
function jwtToken(u){
  return jwt.sign({ tg_id:u.tg_id, name:u.name }, JWT_SECRET, { expiresIn:'1h' });
}

/* ─────────── ПУБЛИЧНЫЕ МАРШРУТЫ ─────────── */

/* ► профиль игрока ------------------------------------------------------ */
router.get('/player/:tg_id', async (req,res)=>{
  try{
    const { rows } = await pool.query(
      `SELECT tg_id,name,fragments,last_burn,is_cursed,curse_expires,curses_count
         FROM players WHERE tg_id=$1 LIMIT 1`,
      [req.params.tg_id]
    );
    if(!rows.length) return res.status(404).json({ error:'player not found' });
    res.json(rows[0]);
  }catch(e){ console.error(e); res.status(500).json({ error:'internal error' }); }
});

/* ► инициализация / выдача JWT ------------------------------------------ */
router.post('/init', async (req,res)=>{
  const { tg_id,name,initData } = req.body;
  if(!tg_id || !initData)
    return res.status(400).json({ error:'tg_id and initData are required' });

  try{
    let { rows } = await pool.query(`SELECT * FROM players WHERE tg_id=$1`,[tg_id]);
    if(!rows.length){
      ({ rows } = await pool.query(
        `INSERT INTO players (tg_id,name,is_cursed,curses_count,curse_expires)
           VALUES ($1,$2,FALSE,0,NULL) RETURNING *`,
        [tg_id,name||null]
      ));
    }
    res.json({ user:rows[0], token:jwtToken(rows[0]) });
  }catch(e){ console.error(e); res.status(500).json({ error:'internal error' }); }
});

/* ─────────── ЗАЩИЩЕННЫЕ JWT МАРШРУТЫ ─────────── */
router.use(authenticate);

/* ► вернуть список фрагментов ------------------------------------------ */
router.get('/fragments/:tg_id', async (req,res)=>{
  if(String(req.user.tg_id)!==req.params.tg_id)
    return res.status(403).json({ error:'Forbidden' });
  try{
    const { rows } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,[req.params.tg_id]);
    if(!rows.length) return res.status(404).json({ error:'player not found' });
    res.setHeader('Authorization',`Bearer ${jwtToken(req.user)}`);
    res.json({ fragments: rows[0].fragments || [] });
  }catch(e){ console.error(e); res.status(500).json({ error:'internal error' }); }
});

/* ► статистика ---------------------------------------------------------- */
router.get('/stats/total_users', async (req,res)=>{
  try{
    const { rows } = await pool.query(
      `SELECT value FROM global_stats WHERE id='total_users'`);
    const value = rows.length ? rows[0].value : 0;
    res.setHeader('Authorization',`Bearer ${jwtToken(req.user)}`);
    res.json({ value });
  }catch(e){
    console.error(e);
    res.setHeader('Authorization',`Bearer ${jwtToken(req.user)}`);
    res.json({ value:0 });
  }
});

/* ► создание инвойса ---------------------------------------------------- */
router.post('/burn-invoice', async (req,res)=>{
  const tg_id = req.body.tg_id;
  if(!tg_id) return res.status(400).json({ ok:false,error:'tg_id required' });
  if(String(req.user.tg_id)!==String(tg_id))
    return res.status(403).json({ ok:false,error:'Forbidden' });

  try{
    /* 1. кулдаун + проклятие */
    const { rows:[p] } = await pool.query(
      `SELECT last_burn,is_cursed,curse_expires
         FROM players WHERE tg_id=$1`,[tg_id]);
    if(!p) return res.status(404).json({ ok:false,error:'player not found' });

    const now = Date.now();
    if(p.curse_expires && new Date(p.curse_expires).getTime() > now)
      return res.status(403).json({ ok:false,error:`You are cursed until ${p.curse_expires}` });
    if(p.last_burn && now - new Date(p.last_burn).getTime() < COOLDOWN_MS)
      return res.status(429).json({ ok:false,error:'Burn cooldown active' });

    /* 2. запись счёта */
    const invoiceId = crypto.randomUUID();
    const comment   = `burn-${invoiceId}`;
    await pool.query(
      `INSERT INTO burn_invoices
         (invoice_id,tg_id,amount_nano,address,comment,status,created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',NOW())`,
      [invoiceId,tg_id,AMOUNT_NANO,TON_ADDRESS,comment]
    );

    /* 3. deeplink’и */
    const tonspaceUrl = `${TONSPACE_SCHEME}/${TON_ADDRESS}?amount=${FIXED_AMOUNT}&text=${encodeURIComponent(comment)}`;
    const paymentUrl  = `${TONHUB_URL}/${TON_ADDRESS}?amount=${FIXED_AMOUNT}&text=${encodeURIComponent(comment)}`;

    res.setHeader('Authorization',`Bearer ${jwtToken(req.user)}`);
    res.json({ ok:true, invoiceId, tonspaceUrl, paymentUrl });
  }catch(e){ console.error(e); res.status(500).json({ ok:false,error:'internal error' }); }
});

/* ► polling статуса ----------------------------------------------------- */
router.get('/burn-status/:invoiceId?', async (req,res)=>{
  let invId = req.params.invoiceId || req.query.invoiceId;
  if(!invId || invId==='null'){
    const { rows } = await pool.query(
      `SELECT invoice_id FROM burn_invoices WHERE tg_id=$1
        ORDER BY created_at DESC LIMIT 1`,[req.user.tg_id]);
    invId = rows[0]?.invoice_id;
  }
  if(!invId) return res.status(400).json({ ok:false,error:'invoiceId missing' });

  try{
    const { rows:[inv] } = await pool.query(
      `SELECT status FROM burn_invoices WHERE invoice_id=$1`,[invId]);
    if(!inv) return res.status(404).json({ ok:false,error:'invoice not found' });

    if(inv.status==='pending'){
      res.setHeader('Authorization',`Bearer ${jwtToken(req.user)}`);
      return res.json({ ok:true, paid:false });
    }

    /* status = paid */
    const result = await runBurnLogic(invId);
    res.setHeader('Authorization',`Bearer ${jwtToken(req.user)}`);
    res.json({ ok:true, paid:true, ...result });
  }catch(e){ console.error(e); res.status(500).json({ ok:false,error:'internal error' }); }
});

/* ─────────── бизнес-логика выдачи фрагмента / проклятия ─────────── */
async function runBurnLogic(invoiceId){
  await pool.query(
    `UPDATE burn_invoices SET status='processed',paid_at=NOW() WHERE invoice_id=$1`,
    [invoiceId]
  );

  const { rows:[inv] } = await pool.query(
    `SELECT tg_id FROM burn_invoices WHERE invoice_id=$1`,[invoiceId]);
  const tg_id = inv.tg_id;

  const { rows:[pl] } = await pool.query(
    `SELECT fragments,curses_count FROM players WHERE tg_id=$1`,[tg_id]);
  const frags   = pl.fragments || [];
  const cursesN = pl.curses_count ?? 0;
  const nowIso  = new Date().toISOString();

  /* --- первые 3 фрагмента обязательны --- */
  if(frags.length < 3){
    const newF = FRAGS.find(f=>!frags.includes(f));
    const upd  = [...frags,newF];
    await pool.query(
      `UPDATE players
         SET fragments=$2,last_burn=$3,is_cursed=FALSE,curse_expires=NULL
       WHERE tg_id=$1`,
      [tg_id,upd,nowIso]);
    return { cursed:false,newFragment:newF,fragments:upd,lastBurn:nowIso };
  }

  /* --- пул для рандома после 3-го раза --- */
  const restFrags  = FRAGS.filter(f=>!frags.includes(f));
  const restCurse  = MAX_CURSES - cursesN;
  if(restFrags.length===0 && restCurse===0){
    await pool.query(`UPDATE players SET last_burn=$2 WHERE tg_id=$1`,
                     [tg_id,nowIso]);
    return { cursed:false,newFragment:null,fragments:frags,lastBurn:nowIso };
  }

  const poolArr=[
    ...restFrags,
    ...Array.from({length:restCurse},()=> 'curse')
  ];
  const pick = poolArr[crypto.randomInt(poolArr.length)];

  if(pick==='curse'){
    const till = new Date(Date.now()+CURSE_HOURS*3600_000).toISOString();
    await pool.query(
      `UPDATE players
         SET is_cursed=TRUE,curse_expires=$2,curses_count=curses_count+1,last_burn=$3
       WHERE tg_id=$1`,
      [tg_id,till,nowIso]);
    return { cursed:true, curse_expires:till, lastBurn:nowIso };
  }else{
    const upd=[...frags,pick];
    await pool.query(
      `UPDATE players
         SET fragments=$2,last_burn=$3,is_cursed=FALSE,curse_expires=NULL
       WHERE tg_id=$1`,
      [tg_id,upd,nowIso]);
    return { cursed:false,newFragment:pick,fragments:upd,lastBurn:nowIso };
  }
}

/* ─────────────────────────────────────────────────────────────────────── */
export default router;
