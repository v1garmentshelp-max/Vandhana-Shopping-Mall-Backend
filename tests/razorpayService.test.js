const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Razorpay = require('../services/razorpayService');
const createService = () => new Razorpay({ keyId: 'rzp_test_fixture', keySecret: 'fixture-secret' });

test('Razorpay rejects invalid amounts before making an API request', async () => {
  const service = createService();
  let calls = 0;
  service.client.defaults.adapter = async () => { calls++; throw new Error('Must not call provider'); };
  for (const amountPaise of [0, 99, -100, 100.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(service.createOrder({ amountPaise }), error => error.status === 400 && error.orderCreationRejected);
  }
  assert.equal(calls, 0);
});

test('Razorpay sends whole paise, currency and receipt with server authentication', async () => {
  const service = createService();
  service.client.defaults.adapter = async config => {
    assert.equal(config.url, '/orders');
    assert.equal(config.auth.username, 'rzp_test_fixture');
    assert.equal(config.auth.password, 'fixture-secret');
    const body = JSON.parse(config.data);
    assert.deepEqual(body, { amount: 100, currency: 'INR', receipt: 'sale-fixture', notes: {} });
    return { data: { id: 'order_fixture', amount: 100, currency: 'INR' }, status: 200, config };
  };
  const order = await service.createOrder({ amountPaise: 100, currency: 'INR', receipt: 'sale-fixture' });
  assert.equal(order.id, 'order_fixture');
});

test('Razorpay authentication rejection is a safe 401 and permits retry after configuration is fixed', async () => {
  const service = createService();
  service.client.defaults.adapter = async () => { throw Object.assign(new Error('sensitive provider response'), { response: { status: 401 } }); };
  await assert.rejects(service.createOrder({ amountPaise: 15000 }), error => {
    assert.equal(error.status, 401);
    assert.equal(error.code, 'RAZORPAY_AUTH_FAILED');
    assert.equal(error.orderCreationRejected, true);
    assert.doesNotMatch(error.message, /sensitive|fixture-secret/);
    return true;
  });
});

test('Razorpay network and server errors return 500 without promising that no order was created', async () => {
  for (const status of [undefined, 500, 502]) {
    const service = createService();
    service.client.defaults.adapter = async () => { throw Object.assign(new Error('provider detail'), { response: { status } }); };
    await assert.rejects(service.createOrder({ amountPaise: 15000 }), error => error.status === 500 && !error.orderCreationRejected);
  }
});

test('Razorpay rejects an inconsistent order response', async () => {
  const service = createService();
  service.client.defaults.adapter = async config => ({ data: { id: 'order_wrong', amount: 100, currency: 'INR' }, config });
  await assert.rejects(service.createOrder({ amountPaise: 15000 }), error => error.code === 'PAYMENT_RECONCILIATION' && !error.orderCreationRejected);
});

test('payment signature verifies the stored order and rejects missing, malformed and mismatched signatures', () => {
  const service = createService();
  const signature = crypto.createHmac('sha256', 'fixture-secret').update('order_fixture|pay_fixture').digest('hex');
  assert.equal(service.verifyPaymentSignature({ orderId: 'order_fixture', paymentId: 'pay_fixture', signature }), true);
  for (const value of ['', 'bad', '0'.repeat(64), null, { signature }]) {
    assert.equal(service.verifyPaymentSignature({ orderId: 'order_fixture', paymentId: 'pay_fixture', signature: value }), false);
  }
  assert.equal(service.verifyPaymentSignature({ orderId: 'order_other', paymentId: 'pay_fixture', signature }), false);
  assert.equal(service.verifyPaymentSignature({ orderId: null, paymentId: 'pay_fixture', signature }), false);
});

test('webhook verification signs exact raw bytes with its separate secret', () => {
  const service = createService();
  const bodyRaw = Buffer.from('{ "event": "payment.captured" }\n');
  const signature = crypto.createHmac('sha256', 'separate-webhook-secret').update(bodyRaw).digest('hex');
  assert.equal(service.verifyWebhookSignature({ bodyRaw, signature, secret: 'separate-webhook-secret' }), true);
  assert.equal(service.verifyWebhookSignature({ bodyRaw: JSON.stringify(JSON.parse(bodyRaw)), signature, secret: 'separate-webhook-secret' }), false);
  assert.equal(service.verifyWebhookSignature({ bodyRaw, signature, secret: 'fixture-secret' }), false);
  assert.equal(service.verifyWebhookSignature({ bodyRaw, signature }), false);
});
