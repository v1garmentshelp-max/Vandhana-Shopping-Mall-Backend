require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../db');
async function main() {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('v1-commerce-schema-20260929'))");
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/20260929_store_commerce.sql'), 'utf8').replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '');
    await db.query(sql);
    await require('./preflightCommerce').preflight(db);
    await db.query('COMMIT');
    console.log('Commerce migration committed. No customer balances or existing order totals were changed.');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
    await pool.end();
  }
}
main().catch(e => {
  console.error('Commerce migration failed:', e.message);
  process.exitCode = 1;
});
