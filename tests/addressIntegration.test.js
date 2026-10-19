const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
process.env.JWT_SECRET = 'address-integration-test-only';
process.env.DB_SCHEMA = 'public';
process.env.RAZORPAY_KEY_ID = 'rzp_test_only';
process.env.RAZORPAY_KEY_SECRET = 'test-only';
let pg, http, serviceable = true, estimates = [];
const query = async (sql, values) => {
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
  const result = await pg.query(sql, values);
  return { ...result, rowCount: Math.max(result.rows.length, result.affectedRows || 0) };
};
const pool = { query, connect: async () => ({ query, release() {} }) };
require.cache[require.resolve('../db')] = { exports: pool };
require.cache[require.resolve('../services/orderShippingWorkflow')] = { exports: { createWorkflow: () => ({ connect: async () => ({}) }) } };
const delivery = require('../services/deliveryEstimate');
mock.method(delivery, 'estimate', async options => { estimates.push(options); return { serviceable, status: serviceable ? 'available' : 'not_serviceable', message: 'Test delivery availability' }; });
const transport = mock.method(nodemailer, 'createTransport', () => ({ sendMail: async () => { throw new Error('Email must not be sent'); } }));
const authRoutes = require('../routes/authRoutes');
transport.mock.restore();
const user = { id: 1, name: 'Test Customer', email: 'customer@example.test', mobile: '9999999999', type: 'B2C' };
const token = jwt.sign(user, process.env.JWT_SECRET);
const auth = req => req.set('Authorization', `Bearer ${token}`);
const address = { fullName: user.name, mobile: user.mobile, line1: '12 Test Road', line2: '', city: 'Srikakulam', state: 'Andhra Pradesh', pincode: '532001' };
before(async () => {
  pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(__dirname, 'support/mobile-schema.sql'), 'utf8'));
  for (const file of ['20260923_order_shipping.sql', '20260923_mobile.sql', '20260925_mobile_store.sql', '20260929_store_commerce.sql', '20261003_order_operations.sql', '20261019_address_delivery.sql']) await pg.exec(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  await pg.exec("CREATE SEQUENCE address_test_user_ids START 100; ALTER TABLE vandana_users ALTER COLUMN id SET DEFAULT nextval('address_test_user_ids');");
  const app = express(); app.use(express.json());
  app.use('/api/auth', authRoutes); app.use('/api/locations', require('../routes/locationRoutes')); app.use('/api/storefront', require('../routes/storefrontRoutes'));
  http = request(app);
});
beforeEach(async () => {
  serviceable = true; estimates = [];
  await pg.exec(`TRUNCATE mobile_checkouts,order_shipping_workflow,sale_items,sales,payments,vandana_cart,branch_variant_stock RESTART IDENTITY CASCADE;
    UPDATE reward_settings SET setting_value='false' WHERE setting_key='enabled';
    INSERT INTO branch_variant_stock VALUES(3,11,20,0,true,now());
    INSERT INTO vandana_cart(user_id,product_id,selected_size,selected_color,quantity,is_custom) VALUES(1,11,'M','BLACK',2,false);`);
});
after(async () => pg.close());
test('public state and PIN routes validate inputs without requiring login', async () => {
  const states = await http.get('/api/locations/states').expect(200);
  assert.equal(states.body.states.length, 36); assert.ok(states.body.states.includes('Andhra Pradesh'));
  await http.get('/api/locations/pincode/123').expect(400);
});
test('signup saves a canonical default address atomically and customer can retrieve it', async () => {
  const registered = await http.post('/api/auth/signup').send({ name: 'New Customer', email: 'new@example.test', mobile: '9999999999', password: 'Test-only-pass', address: { ...address, state: 'AP' } }).expect(201);
  const id = registered.body.user.id;
  const loginToken = jwt.sign({ id, email: 'new@example.test', type: 'B2C' }, process.env.JWT_SECRET);
  const saved = await http.get('/api/storefront/addresses').set('Authorization', `Bearer ${loginToken}`).expect(200);
  assert.equal(saved.body.length, 1); assert.equal(saved.body[0].is_default, true);
  assert.equal(saved.body[0].address.state, 'Andhra Pradesh'); assert.equal(saved.body[0].address.fullName, 'New Customer');
  assert.equal(saved.body[0].address.pincode, '532001');
  const own = await auth(http.get('/api/storefront/addresses')).expect(200);
  assert.ok(!own.body.some(row => row.id === saved.body[0].id));
  const migration = fs.readFileSync(path.join(__dirname, '../migrations/20261019_address_delivery.sql'), 'utf8');
  await pg.exec(migration); await pg.exec(migration);
  assert.equal((await query('SELECT count(*)::int AS n FROM mobile_addresses WHERE user_id=$1', [id])).rows[0].n, 1);
});
test('signup without an address still works; partial state and partial address are rejected before creating an account', async () => {
  const registered = await http.post('/api/auth/signup').send({ name: 'No Address', email: 'noaddress@example.test', mobile: '9999999999', password: 'Test-only-pass' }).expect(201);
  assert.equal((await query('SELECT count(*)::int AS n FROM mobile_addresses WHERE user_id=$1', [registered.body.user.id])).rows[0].n, 0);
  for (const supplied of [{ ...address, state: 'An' }, { pincode: '532001' }]) await http.post('/api/auth/signup').send({ name: 'Invalid Address', email: 'invalid@example.test', mobile: '9999999999', password: 'Test-only-pass', address: supplied }).expect(400);
  assert.equal((await query("SELECT count(*)::int AS n FROM vandana_users WHERE email='invalid@example.test'")).rows[0].n, 0);
});
test('delivery endpoint requires auth and uses actual cart quantities instead of client overrides', async () => {
  await http.post('/api/storefront/delivery/estimate').send({ pincode: '532001', payment_method: 'COD' }).expect(401);
  await auth(http.post('/api/storefront/delivery/estimate')).send({ pincode: '123', payment_method: 'COD' }).expect(400);
  const result = await auth(http.post('/api/storefront/delivery/estimate')).send({ pincode: '532001', payment_method: 'COD', weight: 0.01, quantity: 99, pickup_postcode: '110001', items: [{ qty: 99 }] }).expect(200);
  assert.equal(result.body.serviceable, true); assert.equal(estimates[0].branchId, 3); assert.equal(estimates[0].items.reduce((sum, item) => sum + item.qty, 0), 2);
});
test('unserviceable PIN is enforced at order creation with no stock, points or order changes', async () => {
  const quote = await auth(http.post('/api/storefront/checkout/quote')).send({ payment_method: 'COD', quote_version: 2 }).expect(200);
  serviceable = false;
  const rejected = await auth(http.post('/api/storefront/checkouts')).send({ request_key: crypto.randomUUID(), address, payment_method: 'COD', quote_version: 2, fingerprint: quote.body.fingerprint, delivery: { serviceable: true } }).expect(409);
  assert.equal(rejected.body.code, 'DELIVERY_UNAVAILABLE'); assert.equal(rejected.body.checkout_not_created, true);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 0);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 20);
});
test('existing checkout retries remain idempotent even when courier availability later changes', async () => {
  const quote = await auth(http.post('/api/storefront/checkout/quote')).send({ payment_method: 'COD', quote_version: 2 }).expect(200);
  const payload = { request_key: crypto.randomUUID(), address, payment_method: 'COD', quote_version: 2, fingerprint: quote.body.fingerprint };
  const first = await auth(http.post('/api/storefront/checkouts')).send(payload).expect(200);
  serviceable = false;
  const again = await auth(http.post('/api/storefront/checkouts')).send(payload).expect(200);
  assert.equal(first.body.sale_id, again.body.sale_id); assert.equal(estimates.length, 1);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 1);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 18);
});
