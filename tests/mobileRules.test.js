const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  makeQuote,
  priceOf,
  addressOf,
  validSignature,
  capturedPayment
} = require('../services/mobileRules');
const item = {
  cart_item_id: 1,
  variant_id: 11,
  product_id: 1,
  quantity: 2,
  mrp: 600,
  sale_price: 500,
  b2c_discount_pct: 10,
  on_hand: 5,
  reserved: 1,
  variant_active: true,
  product_active: true,
  stock_active: true,
  name: 'Test shirt'
};
test('server price follows catalogue discount and free shipping threshold', () => {
  const q = makeQuote([item], 100);
  assert.equal(q.subtotal, 1080);
  assert.equal(q.shipping, 0);
  assert.equal(q.payable, 980);
  assert.equal(q.discount, 120);
  const small = makeQuote([{
    ...item,
    quantity: 1
  }], 0);
  assert.equal(small.shipping, 75);
  assert.equal(small.payable, 615);
});
test('unknown, inactive, reserved and over-quantity stock cannot be sold', () => {
  for (const row of [{
    ...item,
    quantity: 5
  }, {
    ...item,
    product_active: false
  }, {
    ...item,
    stock_active: false
  }, {
    ...item,
    variant_active: false
  }]) assert.throws(() => makeQuote([row], 0), /no longer available/);
  for (const quantity of [0, -1, 1.4, NaN, 100]) assert.throws(() => makeQuote([{
    ...item,
    quantity
  }], 0), /Invalid/);
});
test('invalid prices, unsafe rewards, custom products and empty carts fail closed', () => {
  assert.throws(() => priceOf({
    mrp: 0,
    sale_price: 0
  }), /price/);
  for (const points of [-1, 1.5, 1000001, 99999]) assert.throws(() => makeQuote([item], points));
  assert.throws(() => makeQuote([], 0), /empty/);
  assert.throws(() => makeQuote([{
    ...item,
    is_custom: true
  }], 0), /pricing is unavailable/);
});
test('quotes ignore client totals and their fingerprint changes when a price or quantity changes', () => {
  const a = makeQuote([item], 0);
  assert.equal(a.fingerprint, makeQuote([{
    ...item,
    price: 1,
    total: 1,
    payable: 1
  }], 0).fingerprint);
  assert.notEqual(a.fingerprint, makeQuote([{
    ...item,
    quantity: 1
  }], 0).fingerprint);
  assert.notEqual(a.fingerprint, makeQuote([{
    ...item,
    mrp: 700
  }], 0).fingerprint);
});
test('payment authenticity requires HMAC and capture of exact order, amount and currency', () => {
  const sig = crypto.createHmac('sha256', 'test-secret').update('order_1|pay_1').digest('hex');
  assert.equal(validSignature('order_1', 'pay_1', sig, 'test-secret'), true);
  assert.equal(validSignature('order_2', 'pay_1', sig, 'test-secret'), false);
  assert.equal(validSignature('order_1', 'pay_1', 'invalid', 'test-secret'), false);
  const row = {
    gateway_order_id: 'order_1',
    amount_paise: 50000
  };
  const payment = {
    order_id: 'order_1',
    amount: 50000,
    currency: 'INR',
    status: 'captured'
  };
  assert.equal(capturedPayment(payment, row), true);
  for (const p of [{
    ...payment,
    amount: 1
  }, {
    ...payment,
    status: 'authorized'
  }, {
    ...payment,
    currency: 'USD'
  }, {
    ...payment,
    order_id: 'order_2'
  }]) assert.equal(capturedPayment(p, row), false);
});
test('delivery data must be complete before creating a sale', () => {
  assert.throws(() => addressOf({}), /complete/);
  assert.equal(addressOf({
    fullName: 'Test User',
    mobile: '9999999999',
    line1: '12 Test Street',
    city: 'Tirupati',
    state: 'Andhra Pradesh',
    pincode: '517501'
  }).city, 'Tirupati');
});
