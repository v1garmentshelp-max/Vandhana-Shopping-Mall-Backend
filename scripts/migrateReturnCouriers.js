require('dotenv').config();
const fs=require('node:fs');
const path=require('node:path');
const pool=require('../db');
async function main(){
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('v1-return-couriers-20261030'))");
    const sql=fs.readFileSync(path.join(__dirname,'../migrations/20261030_return_couriers.sql'),'utf8').replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'');
    await db.query(sql);
    await require('./preflightCommerce').preflight(db);
    await db.query('COMMIT');
    console.log('Return courier migration committed. Order totals, balances and existing bookings were preserved.');
  }catch(e){await db.query('ROLLBACK');throw e;}
  finally{db.release();await pool.end();}
}
main().catch(e=>{console.error('Return courier migration failed:',e.message);process.exitCode=1;});
