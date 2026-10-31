const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { redemptionLimit } = require('../services/rewardRedemptionPolicy');
const { senderAddress, passwordResetMail, mailTransportOptions } = require('../services/storeEmail');

process.env.JWT_SECRET = 'reward-email-test-only';
process.env.RAZORPAY_KEY_ID = 'rzp_test_only';
process.env.RAZORPAY_KEY_SECRET = 'test-only';
process.env.PASSWORD_RESET_SECRET = 'password-reset-test-only';
process.env.DB_SCHEMA = 'public';
process.env.SMTP_PORT = '587';
process.env.SMTP_USER = 'sender@example.test';
process.env.SMTP_PASS = 'test-only';

let pg, http, sent = [], mailFailure = false, transportOptions;
const query = async (sql, values) => {
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
  const result = await pg.query(sql, values);
  return { ...result, rowCount: Math.max(result.rows.length, result.affectedRows || 0) };
};
const pool = { query, connect: async () => ({ query, release() {} }) };
require.cache[require.resolve('../db')] = { exports: pool };
require.cache[require.resolve('../services/orderShippingWorkflow')] = { exports: { createWorkflow: () => ({ connect: async () => ({}) }) } };
const transportMock = mock.method(nodemailer, 'createTransport', options => {
  transportOptions = options;
  return { sendMail: async message => {
    if (mailFailure) throw new Error('Test SMTP failure');
    sent.push(message);
    return { accepted: [message.to] };
  } };
});
const authRoutes = require('../routes/authRoutes');
transportMock.mock.restore();
const checkout = require('../services/mobileCheckout');
const rewards = require('../services/rewardPointsService');
const user = { id: 1, name: 'Test Customer', email: 'customer@example.test', mobile: '9999999999', type: 'B2C' };
const token = jwt.sign(user, process.env.JWT_SECRET);
const auth = req => req.set('Authorization', `Bearer ${token}`);
const address = { fullName: user.name, mobile: user.mobile, line1: '12 Test Street', line2: '', city: 'Tirupati', state: 'Andhra Pradesh', pincode: '517501' };

before(async () => {
  pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(__dirname, 'support/mobile-schema.sql'), 'utf8'));
  for (const file of ['20260923_order_shipping.sql', '20260923_mobile.sql', '20260925_mobile_store.sql', '20260929_store_commerce.sql', '20261003_order_operations.sql','20261030_return_couriers.sql']) {
    await pg.exec(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  }
  await pg.exec('ALTER TABLE vandana_users ADD COLUMN otp_attempts integer DEFAULT 0, ADD COLUMN otp_last_sent_at timestamptz;');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/rewards', require('../routes/rewardPointsRoutes'));
  app.use('/api/storefront', require('../routes/storefrontRoutes'));
  app.use('/api/mobile', require('../routes/mobileRoutes'));
  http = request(app);
});
beforeEach(async () => {
  sent = []; mailFailure = false;
  process.env.FROM_EMAIL = 'Taras Kart Shopping Mall <sender@example.test>';
  await pg.exec(`TRUNCATE mobile_checkouts,order_shipping_workflow,sale_items,sales,payments,vandana_cart,branch_variant_stock,reward_point_lots,reward_point_transactions RESTART IDENTITY CASCADE;
    UPDATE reward_settings SET setting_value='true' WHERE setting_key='enabled';
    UPDATE vandana_users SET otp=NULL,otp_expiry=NULL,otp_attempts=0,otp_last_sent_at=NULL;
    UPDATE product_variants SET mrp=600,sale_price=500,b2c_discount_pct=10;
    INSERT INTO branch_variant_stock VALUES(3,11,20,0,true,now());
    INSERT INTO vandana_cart(user_id,product_id,selected_size,selected_color,quantity,is_custom) VALUES(1,11,'M','BLACK',1,false);
    INSERT INTO reward_point_lots(user_id,source_type,points_granted,points_remaining,expires_at,status) VALUES(1,'SIGNUP_BONUS',1000,1000,now()+interval '30 days','ACTIVE');`);
});
after(async () => pg.close());

test('redemption is ten percent of the discounted product subtotal rounded down once', () => {
  for (const [price, expected] of [[1000, 100], [500, 50], [990, 99], [999.99, 99], [1000.01, 100], [10, 1], [0.99, 0]]) {
    assert.equal(redemptionLimit([{ qty: 1, price }]), expected);
  }
  assert.equal(redemptionLimit([{ qty: 2, price: 799.5 }]), 159);
  assert.equal(redemptionLimit([{ qty: 2, price: 799.5 }, { qty: 1, price: 990 }]), 258);
  assert.equal(redemptionLimit([{ qty: 4, price: 799.5 }]), 319);
  assert.equal(redemptionLimit([{ qty: 1, price: 799.5 }, { qty: 1, price: 799.5 }]), 159);
  assert.equal(redemptionLimit([{ qty: 1, price: 1000 }, { qty: 2, price: 250 }]), 150);
  assert.equal(redemptionLimit([{ qty: 2, price: 990 }], 1000), 100);
  assert.equal(redemptionLimit([{ qty: 1, price: 1000 }], 99999), 100);
  assert.equal(redemptionLimit([]), 0);
  assert.throws(() => redemptionLimit([{ qty: 1.5, price: 990 }]));
  assert.throws(() => redemptionLimit([{ qty: 1, price: NaN }]));
  assert.throws(() => redemptionLimit([{ qty: 1, price: 1000 }], -1));
});

test('website and mobile reject excess points regardless of forged client prices and quantities', async () => {
  for (const base of ['/api/storefront', '/api/mobile']) {
    for (const method of ['COD', 'ONLINE']) {
      const quote = await auth(http.post(`${base}/checkout/quote`)).send({ payment_method: method, reward_points: 54, quote_version: 2 }).expect(200);
      assert.equal(quote.body.subtotal, 540);
      assert.equal(quote.body.max_reward_points, 54);
      assert.equal(quote.body.max_redemption_percent, 10);
      assert.equal(quote.body.max_points_per_product, undefined);
      const rejected = await auth(http.post(`${base}/checkout/quote`)).send({ payment_method: method, reward_points: 55, quantity: 99, subtotal: 99999, max_reward_points: 99999, max_redemption_percent: 100 }).expect(409);
      assert.equal(rejected.body.code, 'REWARD_LIMIT_EXCEEDED');
      const placed = await auth(http.post(`${base}/checkouts`)).send({ request_key: crypto.randomUUID(), address, payment_method: method, reward_points: 540, fingerprint: quote.body.fingerprint, quote_version: 2, items: [{ qty: 99, price: 1 }] }).expect(409);
      assert.equal(placed.body.checkout_not_created, true);
    }
  }
  assert.equal((await query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 0);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 20);
  assert.equal((await query('SELECT points_remaining FROM reward_point_lots')).rows[0].points_remaining, 1000);
});

test('reward preview derives its cap from the authenticated cart and available wallet', async () => {
  await http.post('/api/rewards/preview').send({ points: 54 }).expect(401);
  const forged = { points: 55, quantity: 100, items: [{ qty: 100, price: 990 }], subtotal: 999999 };
  const preview = await auth(http.post('/api/rewards/preview')).send(forged).expect(200);
  assert.equal(preview.body.max_redeemable, 54);
  assert.equal(preview.body.can_redeem, false);
  await query('UPDATE vandana_cart SET quantity=3');
  assert.equal((await auth(http.post('/api/rewards/preview')).send({ points: 162 }).expect(200)).body.max_redeemable, 162);
  await query('UPDATE reward_point_lots SET points_remaining=7');
  assert.equal((await auth(http.post('/api/rewards/preview')).send({ points: 8 }).expect(200)).body.max_redeemable, 7);
  const available = await auth(http.post('/api/rewards/preview')).send({ points: 7 }).expect(200);
  assert.equal(available.body.can_redeem, true);
  await query("UPDATE reward_settings SET setting_value='false' WHERE setting_key='enabled'");
  assert.equal((await auth(http.post('/api/rewards/preview')).send({ points: 1 }).expect(200)).body.max_redeemable, 0);
});

test('the saved sale enforces the same cap before deducting wallet points', async () => {
  const q = await checkout.quote(pool, 1, 54, false, 'COD');
  const payload = { request_key: crypto.randomUUID(), address, payment_method: 'COD', reward_points: 54, quote_version: 2, fingerprint: q.fingerprint };
  const saved = await checkout.create(user, payload);
  assert.equal(saved.amount, 15000);
  assert.equal(saved.quote.payable, 666);
  await checkout.create(user, payload);
  assert.equal((await query('SELECT points_remaining FROM reward_point_lots')).rows[0].points_remaining, 946);
  assert.equal((await query("SELECT count(*)::int AS n FROM reward_point_transactions WHERE transaction_type='REDEEMED'")).rows[0].n, 1);
  await assert.rejects(rewards.redeemPoints(pool, { userId: 1, saleId: saved.sale_id, requestedPoints: 55, orderSubtotal: 99999, items: [{ qty: 100, price: 990 }] }), error => error.code === 'REWARD_LIMIT_EXCEEDED');
  assert.equal((await query('SELECT points_remaining FROM reward_point_lots')).rows[0].points_remaining, 946);
});

test('a 1000 rupee dress with a 1000 point wallet permits 100 points and leaves 900 rupees payable', async () => {
  await query('UPDATE product_variants SET mrp=1000,sale_price=1000,b2c_discount_pct=0');
  const q = await checkout.quote(pool, 1, 100, false, 'ONLINE');
  assert.equal(q.subtotal, 1000);
  assert.equal(q.max_reward_points, 100);
  assert.equal(q.shipping, 0);
  assert.equal(q.payable, 900);
  await assert.rejects(checkout.quote(pool, 1, 101, false, 'ONLINE'), error => error.code === 'REWARD_LIMIT_EXCEEDED');
  const saved = await checkout.create(user, { request_key: crypto.randomUUID(), address, payment_method: 'ONLINE', reward_points: 100, quote_version: 2, fingerprint: q.fingerprint });
  assert.equal(saved.amount, 90000);
  assert.equal(saved.fully_paid, false);
  assert.equal((await query('SELECT points_remaining FROM reward_point_lots')).rows[0].points_remaining, 900);
});

test('low-priced products cannot be paid fully with points even when shipping is charged', async () => {
  await query('UPDATE product_variants SET mrp=10,sale_price=10,b2c_discount_pct=0');
  const quote = await checkout.quote(pool, 1, 1, false, 'COD');
  assert.equal(quote.max_reward_points, 1);
  assert.equal(quote.subtotal - quote.reward_points, 9);
  await assert.rejects(checkout.quote(pool, 1, 2, false, 'COD'), error => error.code === 'REWARD_LIMIT_EXCEEDED');
});

test('email sender branding overrides a stale configured display name without changing its address', async () => {
  assert.deepEqual(senderAddress(), { name: 'V1 Garments', address: 'sender@example.test' });
  assert.deepEqual(senderAddress({ SMTP_USER: 'fallback@example.test' }), { name: 'V1 Garments', address: 'fallback@example.test' });
  assert.throws(() => senderAddress({ FROM_EMAIL: 'invalid' }));
  assert.throws(() => senderAddress({ FROM_EMAIL: 'one@example.test,two@example.test' }));
  assert.equal(transportOptions.secure, false);
  assert.equal(mailTransportOptions({ SMTP_PORT: '465' }).secure, true);
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const rendered = await transport.sendMail(passwordResetMail(user.email, '123456'));
  const raw = rendered.message.toString();
  assert.match(raw, /From: V1 Garments <sender@example\.test>/);
  assert.doesNotMatch(raw, /Taras Kart/i);
});

test('forgot password sends the V1 Garments email and completes a one-use password reset', async () => {
  await http.post('/api/auth/forgot/start').send({ email: user.email }).expect(200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from.name, 'V1 Garments');
  assert.equal(sent[0].from.address, 'sender@example.test');
  assert.match(sent[0].subject, /V1 Garments/);
  assert.match(sent[0].html, /V1 Garments/);
  assert.doesNotMatch(JSON.stringify(sent[0]), /Taras Kart/i);
  const otp = sent[0].text.match(/\b\d{6}\b/)[0];
  const stored = (await query('SELECT otp FROM vandana_users WHERE id=1')).rows[0].otp;
  assert.notEqual(stored, otp);
  assert.equal(await bcrypt.compare(otp, stored), true);
  await http.post('/api/auth/forgot/start').send({ email: user.email }).expect(429);
  const verified = await http.post('/api/auth/forgot/verify').send({ email: user.email, otp }).expect(200);
  const payload = { reset_token: verified.body.reset_token, newPassword: 'UpdatedPassword-Test-45' };
  await http.post('/api/auth/forgot/reset').send(payload).expect(200);
  const changed = (await query('SELECT password,otp FROM vandana_users WHERE id=1')).rows[0];
  assert.equal(await bcrypt.compare(payload.newPassword, changed.password), true);
  assert.equal(changed.otp, null);
  await http.post('/api/auth/forgot/reset').send(payload).expect(400);
});

test('failed mail delivery rolls back the OTP and permits a fresh request', async () => {
  mailFailure = true;
  await http.post('/api/auth/forgot/start').send({ email: user.email }).expect(500);
  const state = (await query('SELECT otp,otp_last_sent_at FROM vandana_users WHERE id=1')).rows[0];
  assert.equal(state.otp, null);
  assert.equal(state.otp_last_sent_at, null);
  mailFailure = false;
  await http.post('/api/auth/forgot/start').send({ email: user.email }).expect(200);
  assert.equal(sent.length, 1);
});
