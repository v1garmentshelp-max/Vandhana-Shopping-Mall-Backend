const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const supertest = require('supertest');
const Razorpay = require('../services/razorpayService');
process.env.RAZORPAY_KEY_ID = 'rzp_test_fixture';
process.env.RAZORPAY_KEY_SECRET = 'fixture-api-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'fixture-webhook-secret';
process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET = 'fixture-webhook-secret';
process.env.JWT_SECRET = 'fixture-jwt-secret';
const saleId = '7c494061-02be-4dbe-90f4-27c97bc12302';
let db, http, remotePayment, apiStatus;
const query = async (sql, values) => {
  const result = await db.query(sql, values);
  return { ...result, rowCount: Math.max(result.affectedRows || 0, result.rows.length) };
};
const pool = { query, connect: async () => ({ query, release() {} }) };
require.cache[require.resolve('../db')] = { exports: pool };
class Gateway extends Razorpay {
  constructor() {
    super({});
    this.client.defaults.adapter = async config => {
      if (apiStatus) throw Object.assign(new Error('provider failure'), { response: { status: apiStatus } });
      return { data: config.method === 'post' ? { id: 'order_created', ...JSON.parse(config.data) } : remotePayment, status: 200, config };
    };
  }
}
require.cache[require.resolve('../services/razorpayService')] = { exports: Gateway };
before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'support/mobile-schema.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname, '../migrations/20260923_mobile.sql'), 'utf8'));
  await db.exec('ALTER TABLE payments ADD COLUMN razorpay_signature text, ADD COLUMN method text; CREATE TABLE razorpay_webhook_events(event_id text PRIMARY KEY,event_type text,payload jsonb);');
  http = supertest(require('../app'));
});
beforeEach(async () => {
  apiStatus = 0;
  remotePayment = { id: 'pay_fixture', order_id: 'order_fixture', amount: 10000, currency: 'INR', status: 'captured' };
  await db.exec('TRUNCATE payments,sales,razorpay_webhook_events,mobile_checkouts CASCADE');
  await query("INSERT INTO sales(id,payment_status,payment_method,total,totals,status) VALUES($1,'PENDING','ONLINE',100,'{\"payable\":100}','PLACED')", [saleId]);
  await query("INSERT INTO payments(sale_id,razorpay_order_id,status,amount_paise,currency) VALUES($1,'order_fixture','created',10000,'INR')", [saleId]);
});
after(async () => { if (db) await db.close(); });
const fields = () => ({ razorpay_order_id: 'order_fixture', razorpay_payment_id: 'pay_fixture', razorpay_signature: crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update('order_fixture|pay_fixture').digest('hex') });
const saleStatus = async () => (await query('SELECT payment_status FROM sales')).rows[0].payment_status;

test('legacy verification returns 400 for missing or mismatched signatures and leaves payment pending', async () => {
  await http.post('/api/razorpay/payments/verify').send({}).expect(400);
  await http.post('/api/razorpay/payments/verify').send({ ...fields(), razorpay_signature: '0'.repeat(64) }).expect(400);
  assert.equal(await saleStatus(), 'PENDING');
  assert.equal((await query('SELECT status FROM payments')).rows[0].status, 'created');
});

test('legacy verification confirms only the correct captured payment and preserves completed refunds', async () => {
  remotePayment.amount = 100;
  await http.post('/api/razorpay/payments/verify').send(fields()).expect(409);
  assert.equal(await saleStatus(), 'PENDING');
  remotePayment.amount = 10000;
  remotePayment.status = 'authorized';
  await http.post('/api/razorpay/payments/verify').send(fields()).expect(409);
  remotePayment.status = 'captured';
  await http.post('/api/razorpay/payments/verify').send(fields()).expect(200);
  assert.equal(await saleStatus(), 'PAID');
  await query("UPDATE sales SET payment_status='REFUNDED'");
  await http.post('/api/razorpay/payments/verify').send(fields()).expect(200);
  assert.equal(await saleStatus(), 'REFUNDED');
});

test('legacy order creation uses saved totals and returns 401 for provider authentication failure', async () => {
  const response = await http.post('/api/razorpay/payments/create-order').send({ sale_id: saleId, amount: 100 }).expect(200);
  assert.equal(response.body.amount, 10000);
  apiStatus = 401;
  const rejected = await http.post('/api/razorpay/payments/create-order').send({ sale_id: saleId }).expect(401);
  assert.equal(rejected.body.code, 'RAZORPAY_AUTH_FAILED');
  await query("UPDATE sales SET total=0.5,totals='{\"payable\":0.5}'");
  await http.post('/api/razorpay/payments/create-order').send({ sale_id: saleId }).expect(400);
});

test('actual app preserves raw legacy webhook bytes and ignores a failure delivered after capture', async () => {
  const send = async (event, invalid = false) => {
    const raw = JSON.stringify({ event, payload: { payment: { entity: remotePayment } } }, null, 2) + '\n';
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    return http.post('/api/razorpay/razorpay/webhook').set('Content-Type', 'application/json').set('x-razorpay-event-id', `evt_${event}`).set('x-razorpay-signature', invalid ? '0'.repeat(64) : signature).send(raw);
  };
  assert.equal((await send('payment.captured', true)).status, 400);
  assert.equal(await saleStatus(), 'PENDING');
  assert.equal((await send('payment.captured')).status, 200);
  assert.equal((await send('payment.captured')).status, 200);
  remotePayment.status = 'failed';
  assert.equal((await send('payment.failed')).status, 200);
  assert.equal(await saleStatus(), 'PAID');
  assert.equal((await query('SELECT count(*)::int AS n FROM razorpay_webhook_events')).rows[0].n, 1);
});

test('public storefront webhook is reachable before customer authentication and requires a signature', async () => {
  await http.post('/api/storefront/payments/webhook').set('Content-Type', 'application/json').send('{}').expect(400);
  const raw = JSON.stringify({ event: 'payment.failed', payload: {} });
  const signature = crypto.createHmac('sha256', process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
  await http.post('/api/storefront/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', signature).send(raw).expect(200);
});
