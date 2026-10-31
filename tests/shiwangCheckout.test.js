const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express'), request = require('supertest'), jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'shiwang-tests-only';
process.env.RAZORPAY_KEY_ID = 'rzp_test_only'; process.env.RAZORPAY_KEY_SECRET = 'test-only';
let pg, http, gatewayAmount;
const query = async (sql, args) => {
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
  const r = await pg.query(sql, args); return { ...r, rowCount: Math.max(r.rows.length, r.affectedRows || 0) };
};
const pool = { query, connect: async () => ({ query, release() {} }) };
require.cache[require.resolve('../db')] = { exports: pool };
require.cache[require.resolve('../services/orderShippingWorkflow')] = { exports: { createWorkflow: () => ({ connect: async () => ({}) }) } };
require.cache[require.resolve('../services/razorpayService')] = { exports: class { async createOrder(body) { gatewayAmount = body.amountPaise; return { id: 'order_shiwang_test' }; } } };
const checkout = require('../services/mobileCheckout');
const { orderRefundBasis, selectedRefund } = require('../services/commercePolicy');
const user = { id: 1, name: 'Test Customer', email: 'customer@example.test', mobile: '9999999999', type: 'B2C' };
const address = { fullName: user.name, mobile: user.mobile, line1: '12 Test Street', line2: '', city: 'Tirupati', state: 'Andhra Pradesh', pincode: '517501' };
const token = jwt.sign(user, process.env.JWT_SECRET);
const auth = req => req.set('Authorization', `Bearer ${token}`);
before(async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-16T12:00:00+05:30') });
  pg = new PGlite(); await pg.exec(fs.readFileSync(path.join(__dirname, 'support/mobile-schema.sql'), 'utf8'));
  for (const file of ['20260923_order_shipping.sql', '20260923_mobile.sql', '20260925_mobile_store.sql', '20260929_store_commerce.sql', '20261003_order_operations.sql','20261030_return_couriers.sql']) await pg.exec(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  await pg.exec("INSERT INTO product_categories VALUES(1,'Women',NULL),(15,'Kurthi Pant Set',1),(16,'Printed',15); UPDATE products SET brand_name='SHIWANG',gender='WOMEN',category_id=16; UPDATE product_variants SET mrp=1190,sale_price=990,b2c_discount_pct=0;");
  const app = express(); app.use(express.json()); app.use('/api/storefront', require('../routes/storefrontRoutes')); http = request(app);
});
beforeEach(async () => {
  mock.timers.setTime(Date.parse('2026-10-16T12:00:00+05:30')); delete process.env.SHIWANG_OFFER_ENABLED;
  await pg.exec("TRUNCATE mobile_checkouts,order_shipping_workflow,sale_items,sales,payments,vandana_cart,branch_variant_stock RESTART IDENTITY CASCADE; INSERT INTO branch_variant_stock VALUES(3,11,20,0,true,now()); INSERT INTO vandana_cart(user_id,product_id,selected_size,selected_color,quantity,is_custom) VALUES(1,11,'M','BLACK',3,false); UPDATE vandana_users SET type='B2C' WHERE id=1;");
});
after(async () => { mock.timers.reset(); await pg.close(); });
const body = async (method = 'COD') => ({ request_key: crypto.randomUUID(), address, payment_method: method, reward_points: 0, quote_version: 2, fingerprint: (await checkout.quote(pool, 1, 0, false, method)).fingerprint });
test('authenticated checkout ignores forged totals and saves exact split lines, inventory and offer metadata once', async () => {
  const payload = { ...await body(), price: 1, total: 1, offer_discount: 99999 };
  const response = await auth(http.post('/api/storefront/checkouts')).send(payload).expect(200);
  assert.equal(response.body.amount, 15000); assert.equal(response.body.quote.subtotal, 2589);
  assert.equal((await auth(http.post('/api/storefront/checkouts')).send(payload).expect(200)).body.sale_id, response.body.sale_id);
  const sale = (await query('SELECT * FROM sales')).rows[0], items = (await query('SELECT * FROM sale_items ORDER BY price')).rows;
  assert.deepEqual(items.map(i => [Number(i.qty), Number(i.price)]), [[2,799.5],[1,990]]);
  assert.equal(sale.totals.offers[0].discount, 381);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 17);
  assert.equal((await query('SELECT count(*)::int AS n FROM vandana_cart')).rows[0].n, 1);
  const gateway = await checkout.paymentOrder(user, response.body.key);
  await checkout.complete(1, response.body.key, { id: 'pay_shiwang_advance', order_id: gateway.order_id, amount: gateway.amount, currency: 'INR', status: 'captured' });
  assert.equal((await query('SELECT count(*)::int AS n FROM vandana_cart')).rows[0].n, 0);
  const basis = orderRefundBasis(sale, items);
  const refund = selectedRefund(basis, items.map(i => ({ sale_item_id: i.id, qty: Number(i.qty) })));
  assert.equal(refund.amount_paise, 258900);
  assert.equal(refund.excluded_fees_paise, 15000);
});
test('Razorpay receives the exact offer amount for seven sets without fractional paise', async () => {
  await query('UPDATE vandana_cart SET quantity=7');
  const result = await checkout.create(user, await body('ONLINE'));
  await checkout.paymentOrder(user, result.key);
  assert.equal(result.quote.subtotal, 5787); assert.equal(gatewayAmount, 578700);
  const items = (await query('SELECT * FROM sale_items')).rows;
  assert.equal(items.reduce((sum, i) => sum + Math.round(Number(i.price)*100)*Number(i.qty),0), gatewayAmount);
});
test('expiry rejects an old quote atomically and re-quotes at stored prices', async () => {
  const payload = await body(); mock.timers.setTime(Date.parse('2026-10-21T00:00:00+05:30'));
  const response = await auth(http.post('/api/storefront/checkouts')).send(payload).expect(409);
  assert.equal(response.body.code, 'QUOTE_CHANGED'); assert.equal(response.body.checkout_not_created, true);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 0);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 20);
  assert.equal((await checkout.quote(pool,1,0,false,'COD')).subtotal,2970);
});
test('public campaign state expires and staff details require authorization', async () => {
  assert.equal((await http.get('/api/storefront/offers').expect(200)).body.offers[0].active,true);
  await http.get('/api/storefront/admin/offers/shiwang').expect(401);
  const staffToken = jwt.sign({ id:9, role:'SUPER_ADMIN' },process.env.JWT_SECRET);
  const staff = await http.get('/api/storefront/admin/offers/shiwang').set('Authorization',`Bearer ${staffToken}`).expect(200);
  assert.equal(staff.body.products.length,1);
  process.env.SHIWANG_OFFER_ENABLED='false';
  assert.equal((await http.get('/api/storefront/offers').expect(200)).body.offers[0].active,false);
  assert.equal((await checkout.quote(pool,1,0,false,'COD')).subtotal,2970);
});
test('retail checkout rejects B2B accounts', async () => {
  await query("UPDATE vandana_users SET type='B2B' WHERE id=1");
  await auth(http.post('/api/storefront/checkout/quote')).send({ payment_method:'COD', reward_points:0 }).expect(403);
});
test('Shiwang split lines use the ten-percent reward cap after pair discounts and preserve offer totals', async () => {
  await query("INSERT INTO reward_point_lots(user_id,source_type,points_granted,points_remaining,expires_at,status) VALUES(1,'SIGNUP_BONUS',1000,1000,now()+interval '30 days','ACTIVE')");
  const quote = await checkout.quote(pool, 1, 258, false, 'COD');
  assert.equal(quote.items.length, 2);
  assert.equal(quote.max_reward_points, 258);
  assert.equal(quote.subtotal, 2589);
  const saved = await checkout.create(user, { request_key: crypto.randomUUID(), address, payment_method: 'COD', reward_points: 258, quote_version: 2, fingerprint: quote.fingerprint });
  assert.equal(saved.amount, 15000);
  assert.equal((await query('SELECT points_remaining FROM reward_point_lots')).rows[0].points_remaining, 742);
  const sale = (await query('SELECT * FROM sales WHERE id=$1', [saved.sale_id])).rows[0];
  const items = (await query('SELECT * FROM sale_items WHERE sale_id=$1', [saved.sale_id])).rows;
  assert.equal(selectedRefund(orderRefundBasis(sale, items), items.map(i => ({ sale_item_id: i.id, qty: Number(i.qty) }))).amount_paise, 233100);
});
