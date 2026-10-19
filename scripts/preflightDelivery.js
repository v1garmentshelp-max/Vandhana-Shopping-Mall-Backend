require('dotenv').config();
const pool = require('../db');
const postal = require('../services/postalLookup');
const delivery = require('../services/deliveryEstimate');
(async () => {
  await pool.query('SELECT id,user_id,label,address,is_default,created_at,updated_at FROM mobile_addresses LIMIT 0');
  console.log('Saved-address schema: ready');
  const location = await postal.lookup('532001');
  if (location.state !== 'Andhra Pradesh' || location.city !== 'Srikakulam') throw new Error('PIN lookup returned unexpected location data.');
  console.log('PIN lookup: 532001 → Srikakulam, Andhra Pradesh');
  if (!process.env.SHIPROCKET_API_USER_EMAIL || !process.env.SHIPROCKET_API_USER_PASSWORD) throw new Error('Set SHIPROCKET_API_USER_EMAIL and SHIPROCKET_API_USER_PASSWORD using your Shiprocket API user.');
  const branchId = Number(process.env.MOBILE_BRANCH_ID || 3);
  const warehouse = (await pool.query('SELECT name,pincode FROM shiprocket_warehouses WHERE branch_id=$1 LIMIT 1', [branchId])).rows[0];
  if (!warehouse?.name || !/^[1-9]\d{5}$/.test(String(warehouse.pincode))) throw new Error(`Map an existing Shiprocket pickup location to branch ${branchId} in the admin shipping panel.`);
  for (const paymentMethod of ['ONLINE', 'COD']) {
    const result = await delivery.estimate({ db: pool, branchId, pincode: '532001', paymentMethod, items: [{ qty: 1 }] });
    if (result.serviceable === null) throw new Error(`Shiprocket ${paymentMethod} check failed. Check API-user credentials, pickup mapping and account access.`);
    console.log(`Shiprocket ${paymentMethod}: ${result.status}. ${result.message}`);
  }
  console.log('Delivery preflight complete. No orders, AWBs or pickups were created.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
