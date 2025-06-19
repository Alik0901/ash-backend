/*  Order-of-Ash · Telegram Mini-App backend
 *  — REST API for players / invoices / curses
 *  — fixed burn price 0.5 TON
 *  — randomised fragments + 4×24h curses
 *  — JWT refresh on every protected call
 * ------------------------------------------------------------------------ */

import express  from 'express';
import crypto   from 'crypto';
import jwt      from 'jsonwebtoken';
import pool     from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/* ────────── .env ────────── */

const {
  JWT_SECRET,
  TON_WALLET_ADDRESS: TON_ADDRESS,
} = process.env;

const TONHUB_URL      = 'https://tonhub.com/transfer';
const TONSPACE_SCHEME = 'ton://transfer';

/* ────────── константы ────────── */

const FIXED_AMOUNT = '0.5';          // TON
const AMOUNT_NANO  = 500_000_000;    // 0.5 TON → nano
const COOLDOWN_MS  = 2 * 60 * 1000;  // 2 min

const FRAGS        = [1,2,3,4,5,6,7,8];
const MAX_CURSES   = 4;
const CURSE_HOURS  = 24;

/* ────────── helpers ────────── */

const sign = u => jwt.sign({ tg_id:u.tg_id, name:u.name }, JWT_SECRET, { expiresIn:'1h' });

/* ╔══════════ PUBLIC ══════════╗ */

/* ► get profile */
router.get('/player/:tg_id', async (req,res)=>{
  try{
    const { rows } = await pool.query(
      `SELECT tg_id,name,fragments,last_burn,is_cursed,curse_expires,curses_count
         FROM players WHERE tg_id=$1 LIMIT 1`,
      [req.params.tg_id]);
    if(!rows.length) return res.status(404).json({ error:'player not found' });
    res.json(rows[0]);
  }catch(e){
    console.error('[player] ',e);
    res.status(500).json({ error:'internal error' });
  }
});

/* ► first entry / JWT issue */
router.post('/init', async (req,res)=>{
  const { tg_id,name='',initData='' } = req.body;
  if(!tg_id || !initData) return res.status(400).json({ error:'tg_id and initData required' });

  try{
    let { rows } = await pool.query(`SELECT * FROM players WHERE tg_id=$1`,[tg_id]);

    if(!rows.length){
      ({ rows } = await pool.query(
        `INSERT INTO players (tg_id,name,is_cursed,curses_count,curse_expires)
           VALUES ($1,$2,FALSE,0,NULL) RETURNING *`,
        [tg_id,name || null]));
    }
    const user = rows[0];
    res.json({ user, token: sign(user) });
  }catch(e){
    console.error('[init] ',e);
    res.status(500).json({ error:'internal error' });
  }
});

/* ╔══════════ JWT-PROTECTED ══════════╗ */
router.use(authenticate);

/* ► DELETE account */
router.delete('/player/:tg_id', async (req,res)=>{
  if(String(req.user.tg_id)!==req.params.tg_id)
    return res.status(403).json({ ok:false,error:'Forbidden' });

  try{
    await pool.query('DELETE FROM players WHERE tg_id=$1',[req.params.tg_id]);
    await pool.query('DELETE FROM burn_invoices WHERE tg_id=$1',[req.params.tg_id]);
    res.json({ ok:true });
  }catch(e){
    console.error('[delete] ',e);
    res.status(500).json({ ok:false,error:'internal error' });
  }
});

/* ► fragments list */
router.get('/fragments/:tg_id', async (req,res)=>{
  if(String(req.user.tg_id)!==req.params.tg_id)
    return res.status(403).json({ error:'Forbidden' });

  try{
    const { rows } = await pool.query(
      `SELECT fragments FROM players WHERE tg_id=$1`,[req.params.tg_id]);
    if(!rows.length) return res.status(404).json({ error:'player not found' });

    res.setHeader('Authorization',`Bearer ${sign(req.user)}`);
    res.json({ fragments: rows[0].fragments || [] });
  }catch(e){
    console.error('[fragments] ',e);
    res.status(500).json({ error:'internal error' });
  }
});

/* ► global stats */
router.get('/stats/total_users', async (req,res)=>{
  try{
    const { rows } = await pool.query(`SELECT value FROM global_stats WHERE id='total_users'`);
    res.setHeader('Authorization',`Bearer ${sign(req.user)}`);
    res.json({ value: rows[0]?.value ?? 0 });
  }catch(e){
    console.error('[stats] ',e);
    res.setHeader('Authorization',`Bearer ${sign(req.user)}`);
    res.json({ value:0 });
  }
});

/* ► create burn invoice */
router.post('/burn-invoice', async (req,res)=>{
  const tg_id = req.body.tg_id;
  if(String(req.user.tg_id)!==String(tg_id))
    return res.status(403).json({ ok:false,error:'Forbidden' });

  try{
    /* cooldown & curse check */
    const { rows:[p] } = await pool.query(
      `SELECT last_burn,curse_expires FROM players WHERE tg_id=$1`,[tg_id]);

    const now = Date.now();
    if(p.curse_expires && new Date(p.curse_expires).getTime()>now)
      return res.status(403).json({ ok:false,error:`Cursed until ${p.curse_expires}` });

    if(p.last_burn && now-new Date(p.last_burn).getTime() < COOLDOWN_MS)
      return res.status(429).json({ ok:false,error:'Burn cooldown active' });

    /* create invoice */
    const invoiceId = crypto.randomUUID();
    const comment   = `burn-${invoiceId}`;
    await pool.query(
      `INSERT INTO burn_invoices
         (invoice_id,tg_id,amount_nano,address,comment,status,created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',NOW())`,
      [invoiceId,tg_id,AMOUNT_NANO,TON_ADDRESS,comment]);

    const tonspaceUrl = `${TONSPACE_SCHEME}/${TON_ADDRESS}?amount=${FIXED_AMOUNT}&text=${encodeURIComponent(comment)}`;
    const paymentUrl  = `${TONHUB_URL}/${TON_ADDRESS}?amount=${FIXED_AMOUNT}&text=${encodeURIComponent(comment)}`;

    res.setHeader('Authorization',`Bearer ${sign(req.user)}`);
    res.json({ ok:true, invoiceId, tonspaceUrl, paymentUrl });
  }catch(e){
    console.error('[invoice] ',e);
    res.status(500).json({ ok:false,error:'internal error' });
  }
});

/* ► poll invoice status */
router.get('/burn-status/:invoiceId?', async (req,res)=>{
  let invoiceId = req.params.invoiceId || req.query.invoiceId || null;
  if(!invoiceId){
    const { rows } = await pool.query(
      `SELECT invoice_id FROM burn_invoices WHERE tg_id=$1
       ORDER BY created_at DESC LIMIT 1`,[req.user.tg_id]);
    invoiceId = rows[0]?.invoice_id;
  }
  if(!invoiceId) return res.status(400).json({ ok:false,error:'invoiceId missing' });

  try{
    const { rows:[inv] } = await pool.query(
      `SELECT status FROM burn_invoices WHERE invoice_id=$1`,[invoiceId]);
    if(!inv) return res.status(404).json({ ok:false,error:'invoice not found' });

    if(inv.status==='pending'){
      res.setHeader('Authorization',`Bearer ${sign(req.user)}`);
      return res.json({ ok:true, paid:false });
    }

    const payload = await runBurnLogic(invoiceId);
    res.setHeader('Authorization',`Bearer ${sign(req.user)}`);
    res.json({ ok:true, paid:true, ...payload });
  }catch(e){
    console.error('[burn-status] ',e);
    res.status(500).json({ ok:false,error:'internal error' });
  }
});

/* ╔══════════ burn-business logic ══════════╗ */

async function runBurnLogic(invoiceId){
  await pool.query(`UPDATE burn_invoices SET status='processed',paid_at=NOW() WHERE invoice_id=$1`,[invoiceId]);

  const { rows:[{ tg_id }] } = await pool.query(
    `SELECT tg_id FROM burn_invoices WHERE invoice_id=$1`,[invoiceId]);

  const { rows:[pl] } = await pool.query(
    `SELECT fragments,curses_count FROM players WHERE tg_id=$1`,[tg_id]);

  const frags  = pl.fragments    || [];
  const curses = pl.curses_count || 0;
  const nowIso = new Date().toISOString();

  /* --- first 3 burns: always fragment (random) --- */
  if(frags.length < 3){
    const available = FRAGS.filter(f=>!frags.includes(f));
    const pick = available[crypto.randomInt(available.length)];
    const updated = [...frags,pick];

    await pool.query(
      `UPDATE players
         SET fragments=$2,last_burn=$3,is_cursed=FALSE,curse_expires=NULL
       WHERE tg_id=$1`,
      [tg_id,updated,nowIso]);

    return { cursed:false,newFragment:pick,fragments:updated,lastBurn:nowIso };
  }

  /* --- remaining pool (5 real + up to 4 curses) --- */
  const leftFragments = FRAGS.filter(f=>!frags.includes(f));
  const leftCurses    = MAX_CURSES - curses;

  /* нет ничего нового? */
  if(!leftFragments.length && !leftCurses){
    await pool.query(`UPDATE players SET last_burn=$2 WHERE tg_id=$1`,[tg_id,nowIso]);
    return { cursed:false,newFragment:null,fragments:frags,lastBurn:nowIso };
  }

  const poolArr = [
    ...leftFragments,
    ...Array.from({ length:leftCurses }, ()=>'curse')
  ];
  const pick = poolArr[crypto.randomInt(poolArr.length)];

  if(pick==='curse'){
    const tillIso = new Date(Date.now()+CURSE_HOURS*3600_000).toISOString();
    await pool.query(
      `UPDATE players
         SET is_cursed=TRUE,curse_expires=$2,curses_count=curses_count+1,last_burn=$3
       WHERE tg_id=$1`,
      [tg_id,tillIso,nowIso]);
    return { cursed:true,curse_expires:tillIso,lastBurn:nowIso };
  }

  /* fragment */
  const updated = [...frags,pick];
  await pool.query(
    `UPDATE players
       SET fragments=$2,is_cursed=FALSE,curse_expires=NULL,last_burn=$3
     WHERE tg_id=$1`,
    [tg_id,updated,nowIso]);

  return { cursed:false,newFragment:pick,fragments:updated,lastBurn:nowIso };
}

export default router;
