require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../db');
const {
  preflight
} = require('./preflightMobile');
(async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('v1-mobile-schema-v1'))");
    await preflight(db);
    for (const file of ['20260923_order_shipping.sql', '20260923_mobile.sql', '20260925_mobile_store.sql']) {
      const sql = fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8').replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '');
      await db.query(sql);
      console.log(`Prepared ${file}`);
    }
    await db.query('COMMIT');
    console.log('Mobile schema migration committed. Existing customers, products and orders preserved.');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
    await pool.end();
  }
})().catch(e => {
  console.error('Mobile migration failed:', e.message);
  process.exitCode = 1;
});
