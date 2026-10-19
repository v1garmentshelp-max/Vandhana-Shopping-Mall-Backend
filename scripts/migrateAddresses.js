require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../db');
(async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('v1-address-schema-20261019'))");
    await db.query(fs.readFileSync(path.join(__dirname, '../migrations/20261019_address_delivery.sql'), 'utf8').replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, ''));
    await db.query('COMMIT');
    console.log('Address migration complete. Existing addresses and orders preserved.');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
