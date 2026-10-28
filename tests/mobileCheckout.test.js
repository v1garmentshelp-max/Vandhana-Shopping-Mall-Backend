const {
  test,
  before,
  after,
  beforeEach
} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  PGlite
} = require('@electric-sql/pglite');
const supertest = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'unit-test-only-secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fixture';
process.env.RAZORPAY_KEY_SECRET = 'test-gateway-secret';
process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret';
let db,
  shippingCalls = 0,
  paymentCalls = 0,
  gatewayMode = '',
  captures = [];
const query = async (sql, values) => {
  if (sql.includes('pg_advisory_xact_lock')) return {
    rows: [{}],
    rowCount: 1
  };
  const result = await db.query(sql, values);
  return {
    ...result,
    rowCount: Math.max(result.affectedRows || 0, result.rows.length)
  };
};
const pool = {
  query,
  connect: async () => ({
    query,
    release() {}
  })
};
require.cache[require.resolve('../db')] = {
  exports: pool
};
require.cache[require.resolve('../services/orderShippingWorkflow')] = {
  exports: {
    createWorkflow: () => ({
      connect: async () => {
        shippingCalls++;
        return {};
      }
    })
  }
};
class Gateway {
  constructor() {
    this.client = {
      get: async url => ({
        data: url.includes('/orders/') ? {
          items: captures
        } : captures.find(p => url.endsWith(p.id))
      })
    };
  }
  async createOrder() {
    paymentCalls++;
    if (gatewayMode === 'timeout') throw new Error('timeout');
    if (gatewayMode === 'auth') throw Object.assign(new Error('The store payment credentials were rejected.'), { status: 401, code: 'RAZORPAY_AUTH_FAILED', orderCreationRejected: true });
    return {
      id: `order_test_${paymentCalls}`
    };
  }
}
require.cache[require.resolve('../services/razorpayService')] = {
  exports: Gateway
};
const service = require('../services/mobileCheckout');
const user = {
  id: 1,
  email: 'customer@example.test',
  name: 'Test Customer',
  mobile: '9999999999',
  type: 'B2C'
};
const address = {
  fullName: user.name,
  mobile: user.mobile,
  line1: '12 Test Street',
  line2: '',
  city: 'Tirupati',
  state: 'Andhra Pradesh',
  pincode: '517501'
};
let http;
before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'support/mobile-schema.sql'), 'utf8'));
  for (const migration of ['20260923_order_shipping.sql', '20260923_mobile.sql', '20260925_mobile_store.sql', '20260929_store_commerce.sql', '20261003_order_operations.sql']) await db.exec(fs.readFileSync(path.join(__dirname, '../migrations', migration), 'utf8'));
  const app = express();
  app.post('/api/mobile/payments/webhook', express.raw({
    type: 'application/json'
  }), require('../routes/mobileWebhook'));
  app.post('/api/storefront/payments/webhook', express.raw({ type: 'application/json' }), require('../routes/mobileWebhook'));
  app.use(express.json());
  app.use('/api/mobile', require('../routes/mobileRoutes'));
  app.use('/api/storefront', require('../routes/mobileRoutes'));
  app.use('/api', require('../routes/returnsRoutes'));
  http = supertest(app);
});
beforeEach(async () => {
  shippingCalls = 0;
  paymentCalls = 0;
  captures = [];
  gatewayMode = '';
  await db.exec(`TRUNCATE mobile_checkouts,order_shipping_workflow,sale_items,sales,payments,vandana_cart,branch_variant_stock,reward_point_lots,reward_point_transactions,vandana_wishlist RESTART IDENTITY CASCADE;
    INSERT INTO branch_variant_stock VALUES(3,11,10,0,true,now());
    INSERT INTO vandana_cart(user_id,product_id,selected_size,selected_color,quantity,is_custom) VALUES(1,11,'M','BLACK',1,false);
    INSERT INTO reward_point_lots(user_id,source_type,points_granted,points_remaining,expires_at,status) VALUES(1,'SIGNUP_BONUS',100,100,now()+interval '30 days','ACTIVE');`);
});
after(async () => db.close());
async function body(method = 'COD', points = 0) {
  const q = await service.quote(pool, 1, points, false, method === 'COD' ? method : null);
  return {
    request_key: crypto.randomUUID(),
    address,
    fingerprint: q.fingerprint,
    reward_points: points,
    payment_method: method,
    ...(method === 'COD' ? { quote_version: 2 } : {})
  };
}
async function confirmAdvance(key) {
  const gateway = await service.paymentOrder(user, key);
  return service.complete(1, key, { id: `pay_${key}`, order_id: gateway.order_id, amount: gateway.amount, currency: 'INR', status: 'captured' });
}
test('COD creation is atomic and duplicate requests reuse one sale and one stock deduction', async () => {
  const payload = await body();
  payload.totals = {
    payable: 1
  };
  payload.price = 1;
  const a = await service.create(user, payload);
  const b = await service.create(user, payload);
  assert.equal(a.sale_id, b.sale_id);
  assert.equal(a.amount, 15000);
  assert.equal(a.payment_status, 'PENDING');
  assert.equal(shippingCalls, 0);
  assert.equal((await query('SELECT count(*)::int AS n FROM vandana_cart')).rows[0].n, 1);
  await confirmAdvance(a.key);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 1);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 9);
  assert.equal((await query('SELECT count(*)::int AS n FROM vandana_cart')).rows[0].n, 0);
});
test('an idempotency reference cannot be reused by a different customer or with a changed address', async () => {
  const payload = await body();
  await service.create(user, payload);
  await assert.rejects(service.create({
    ...user,
    id: 2
  }, payload), /unavailable/);
  await assert.rejects(service.create(user, {
    ...payload,
    address: {
      ...address,
      city: 'Other City'
    }
  }), /already started/);
});
test('a changed quote rejects the entire transaction without decrementing stock', async () => {
  const payload = await body();
  await query('UPDATE product_variants SET sale_price=700,mrp=800 WHERE id=11');
  await assert.rejects(service.create(user, payload), /prices changed/);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 10);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 0);
  await query('UPDATE product_variants SET sale_price=500,mrp=600 WHERE id=11');
});
test('rewards deduct once and a depleted wallet rolls back sale and stock', async () => {
  await query('UPDATE reward_point_lots SET points_remaining=10');
  const payload = await body('COD', 10);
  const a = await service.create(user, payload);
  await service.create(user, payload);
  assert.equal(a.amount, 15000);
  await confirmAdvance(a.key);
  assert.equal((await query('SELECT points_remaining FROM reward_point_lots')).rows[0].points_remaining, 0);
  await query("INSERT INTO vandana_cart(user_id,product_id,selected_size,selected_color,quantity,is_custom) VALUES(1,11,'M','BLACK',1,false)");
  const q = await service.quote(pool, 1, 10, true);
  const forged = {
    ...payload,
    request_key: crypto.randomUUID(),
    fingerprint: q.fingerprint
  };
  await assert.rejects(service.create(user, forged));
  assert.equal((await query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 1);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 9);
});
test('online checkout cannot ship until captured payment matches the stored amount', async () => {
  const payload = await body('ONLINE');
  const saved = await service.create(user, payload);
  assert.equal(shippingCalls, 0);
  assert.equal(saved.payment_status, 'PENDING');
  const gateway = await service.paymentOrder(user, payload.request_key);
  const same = await service.paymentOrder(user, payload.request_key);
  assert.equal(gateway.order_id, same.order_id);
  assert.equal(paymentCalls, 1);
  await assert.rejects(service.complete(1, payload.request_key, {
    id: 'pay_bad',
    order_id: gateway.order_id,
    amount: 1,
    currency: 'INR',
    status: 'captured'
  }), /not been captured/);
  assert.equal(shippingCalls, 0);
  const p = {
    id: 'pay_test',
    order_id: gateway.order_id,
    amount: gateway.amount,
    currency: 'INR',
    status: 'captured'
  };
  captures = [p];
  await query('UPDATE vandana_cart SET quantity=3 WHERE user_id=1');
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${p.order_id}|${p.id}`).digest('hex');
  const result = await service.verify(user, payload.request_key, {
    razorpay_order_id: p.order_id,
    razorpay_payment_id: p.id,
    razorpay_signature: sig
  });
  assert.equal(result.fully_paid, true);
  await service.reconcile(user, payload.request_key);
  assert.equal((await query('SELECT quantity FROM vandana_cart')).rows[0].quantity, 2);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 9);
});
test('an uncertain gateway creation is never blindly repeated', async () => {
  const payload = await body('ONLINE');
  await service.create(user, payload);
  gatewayMode = 'timeout';
  await assert.rejects(service.paymentOrder(user, payload.request_key), /safely/);
  gatewayMode = '';
  await assert.rejects(service.paymentOrder(user, payload.request_key), /reconciliation/);
  assert.equal(paymentCalls, 1);
});
test('customer routes require a signed session and ignore client-supplied owner IDs', async () => {
  await http.get('/api/mobile/cart').expect(401);
  const token = jwt.sign(user, process.env.JWT_SECRET);
  await http.post('/api/mobile/wishlist').set('Authorization', `Bearer ${token}`).send({
    user_id: 2,
    variant_id: 11
  }).expect(200);
  assert.equal(Number((await query('SELECT user_id FROM vandana_wishlist')).rows[0].user_id), 1);
  await query("INSERT INTO vandana_cart(user_id,product_id,selected_size,selected_color,quantity,is_custom) VALUES(2,11,'M','BLACK',1,false)");
  const id = (await query('SELECT id FROM vandana_cart WHERE user_id=2')).rows[0].id;
  await http.patch(`/api/mobile/cart/${id}`).set('Authorization', `Bearer ${token}`).send({
    quantity: 2
  }).expect(404);
  await http.delete(`/api/mobile/cart/${id}`).set('Authorization', `Bearer ${token}`).expect(200);
  assert.equal((await query('SELECT quantity FROM vandana_cart WHERE user_id=2')).rows[0].quantity, 1);
});
test('checkout rejection releases only a definitely uncreated attempt and rewards quotes reject insufficient balance', async () => {
  const token = jwt.sign(user, process.env.JWT_SECRET);
  const payload = await body();
  await query('UPDATE branch_variant_stock SET on_hand=0');
  const rejected = await http.post('/api/mobile/checkouts').set('Authorization', `Bearer ${token}`).send(payload).expect(409);
  assert.equal(rejected.body.code, 'OUT_OF_STOCK');
  assert.equal(rejected.body.checkout_not_created, true);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 0);
  await query('UPDATE branch_variant_stock SET on_hand=10');
  await service.create(user, payload);
  await confirmAdvance(payload.request_key);
  const collision = await http.post('/api/mobile/checkouts').set('Authorization', `Bearer ${token}`).send({
    ...payload,
    address: {
      ...address,
      city: 'Changed City'
    }
  }).expect(409);
  assert.equal(collision.body.checkout_not_created, undefined);
  await query("INSERT INTO vandana_cart(user_id,product_id,selected_size,selected_color,quantity,is_custom) VALUES(1,11,'M','BLACK',1,false)");
  await query('UPDATE reward_point_lots SET points_remaining=5');
  await assert.rejects(service.quote(pool, 1, 10), /Insufficient reward points/);
  const adminToken = jwt.sign({
    id: 1,
    role: 'SUPER_ADMIN'
  }, process.env.JWT_SECRET);
  await http.get('/api/mobile/cart').set('Authorization', `Bearer ${adminToken}`).expect(401);
  await http.get('/api/mobile/admin/account-requests').set('Authorization', `Bearer ${token}`).expect(403);
});
test('raw-body webhook rejects a forged signature and safely replays captured payment', async () => {
  const payload = await body('ONLINE');
  await service.create(user, payload);
  const gateway = await service.paymentOrder(user, payload.request_key);
  const event = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_webhook',
          order_id: gateway.order_id,
          amount: gateway.amount,
          currency: 'INR',
          status: 'captured'
        }
      }
    }
  });
  const post = signature => http.post('/api/mobile/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', signature).send(event);
  await post('0'.repeat(64)).expect(400);
  assert.equal((await query('SELECT payment_status FROM sales')).rows[0].payment_status, 'PENDING');
  const signature = crypto.createHmac('sha256', process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET).update(event).digest('hex');
  await post(signature).expect(200);
  await post(signature).expect(200);
  assert.equal((await query('SELECT payment_status FROM sales')).rows[0].payment_status, 'PAID');
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 9);
  assert.equal((await query('SELECT count(*)::int AS n FROM vandana_cart')).rows[0].n, 0);
});
test('wishlist, profile, cart and COD order work through the actual authenticated HTTP routes', async () => {
  const token = jwt.sign(user, process.env.JWT_SECRET);
  const auth = request => request.set('Authorization', `Bearer ${token}`);
  await auth(http.patch('/api/mobile/profile')).send({
    name: 'Updated Customer',
    mobile: '9999999999'
  }).expect(200);
  await auth(http.post('/api/mobile/wishlist')).send({
    variant_id: 11
  }).expect(200);
  const saved = await auth(http.get('/api/mobile/wishlist')).expect(200);
  assert.equal(Number(saved.body[0].actual_product_id), 1);
  assert.equal(Number(saved.body[0].variant_id), 11);
  await auth(http.post('/api/mobile/cart')).send({
    variant_id: 11,
    quantity: 1
  }).expect(201);
  const bag = await auth(http.get('/api/mobile/cart')).expect(200);
  assert.equal(bag.body[0].quantity, 2);
  assert.equal(Number(bag.body[0].product_id), 1);
  await auth(http.patch(`/api/mobile/cart/${bag.body[0].cart_item_id}`)).send({
    quantity: 1
  }).expect(200);
  const quote = await auth(http.post('/api/mobile/checkout/quote')).send({
    payment_method: 'COD', quote_version: 2,
    reward_points: 10
  }).expect(200);
  const placed = await auth(http.post('/api/mobile/checkouts')).send({
    request_key: crypto.randomUUID(),
    address,
    payment_method: 'COD', quote_version: 2,
    reward_points: 10,
    fingerprint: quote.body.fingerprint
  }).expect(200);
  assert.equal(placed.body.payment_status, 'PENDING');
  await confirmAdvance(placed.body.key);
  const order = await auth(http.get(`/api/mobile/orders/${placed.body.sale_id}`)).expect(200);
  assert.equal(order.body.items.length, 1);
  assert.equal(Number(order.body.totals.payable), 710);
  assert.equal((await auth(http.get('/api/mobile/cart')).expect(200)).body.length, 0);
  assert.equal((await auth(http.get('/api/mobile/orders')).expect(200)).body.length, 1);
  await auth(http.delete('/api/mobile/wishlist')).send({
    variant_id: 11
  }).expect(200);
  assert.equal((await auth(http.get('/api/mobile/wishlist')).expect(200)).body.length, 0);
});
test('unavailable online payments release an uncreated checkout without discarding an existing order', async () => {
  const token = jwt.sign(user, process.env.JWT_SECRET);
  const payload = await body('ONLINE');
  const secret = process.env.RAZORPAY_KEY_SECRET;
  delete process.env.RAZORPAY_KEY_SECRET;
  try {
    const response = await http.post('/api/mobile/checkouts').set('Authorization', `Bearer ${token}`).send(payload).expect(503);
    assert.equal(response.body.checkout_not_created, true);
    assert.equal((await query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 0);
  } finally {
    process.env.RAZORPAY_KEY_SECRET = secret;
  }
  const existing = await service.create(user, payload);
  delete process.env.RAZORPAY_KEY_SECRET;
  try {
    assert.equal((await service.create(user, payload)).sale_id, existing.sale_id);
  } finally {
    process.env.RAZORPAY_KEY_SECRET = secret;
  }
});
test('a mixed custom and stock checkout preserves design data and reprices custom garments on the server', async () => {
  const design = {
    garmentType: 'crew',
    size: 'M',
    color: '#ffffff',
    design: {
      front: 'https://example.test/custom.png',
      back: 'https://example.test/back.png'
    },
    sides: {
      front: [],
      back: []
    }
  };
  await query("INSERT INTO vandana_cart(user_id,quantity,is_custom,custom_title,custom_price,custom_payload,custom_image_url) VALUES(1,1,true,'Custom crew',1,$1::jsonb,$2)", [JSON.stringify(design), design.design.front]);
  const payload = await body();
  const result = await service.create(user, payload);
  assert.equal(result.amount, 15000);
  assert.equal(result.quote.payable, 1489);
  const custom = (await query('SELECT * FROM sale_items WHERE sale_id=$1 AND is_custom=true', [result.sale_id])).rows[0];
  assert.equal(Number(custom.price), 799);
  assert.equal(custom.custom_payload.garmentType, 'crew');
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 9);
});
test('saved addresses and designs are isolated by authenticated owner and default address is unique', async () => {
  const token = jwt.sign(user, process.env.JWT_SECRET),
    other = jwt.sign({
      ...user,
      id: 2,
      email: 'other@example.test'
    }, process.env.JWT_SECRET);
  const id = crypto.randomUUID();
  await http.put(`/api/mobile/addresses/${id}`).set('Authorization', `Bearer ${token}`).send({
    address,
    label: 'Home',
    is_default: true
  }).expect(200);
  await http.put(`/api/mobile/addresses/${id}`).set('Authorization', `Bearer ${other}`).send({
    address,
    label: 'Not mine'
  }).expect(404);
  await http.delete(`/api/mobile/addresses/${id}`).set('Authorization', `Bearer ${other}`).expect(200);
  assert.equal((await http.get('/api/mobile/addresses').set('Authorization', `Bearer ${token}`)).body.length, 1);
  await http.put(`/api/mobile/addresses/${crypto.randomUUID()}`).set('Authorization', `Bearer ${token}`).send({
    address,
    label: 'Work',
    is_default: true
  }).expect(200);
  assert.equal((await query('SELECT count(*)::int AS n FROM mobile_addresses WHERE user_id=1 AND is_default')).rows[0].n, 1);
  await http.get('/api/mobile/designs').expect(401);
  await http.put('/api/mobile/admin/store').set('Authorization', `Bearer ${token}`).send({}).expect(403);
  const secret = process.env.JWT_SECRET;
  try {
    process.env.JWT_SECRET = 'dev_secret';
    const forged = jwt.sign({
      id: 1,
      role: 'SUPER_ADMIN'
    }, 'dev_secret');
    await http.put('/api/mobile/admin/store').set('Authorization', `Bearer ${forged}`).send({}).expect(503);
    await http.get('/api/returns/admin').set('Authorization', `Bearer ${forged}`).expect(503);
  } finally {
    process.env.JWT_SECRET = secret;
  }
});
test('legacy refund-labelled physical returns still enforce policy and staff endpoints reject customer tokens', async () => {
  const token = jwt.sign(user, process.env.JWT_SECRET),
    other = jwt.sign({
      ...user,
      id: 2,
      email: 'other@example.test'
    }, process.env.JWT_SECRET);
  const saved = await service.create(user, await body());
  await confirmAdvance(saved.key);
  await query("INSERT INTO product_categories(id,name) VALUES(90,'Inner Wear') ON CONFLICT DO NOTHING");
  await query('UPDATE products SET category_id=90 WHERE id=1');
  await query("UPDATE sales SET status='DELIVERED',payment_status='PAID' WHERE id=$1", [saved.sale_id]);
  await query("INSERT INTO shipments(id,sale_id,status,created_at,delivered_at) VALUES($1,$2,'DELIVERED',now(),now()-interval '1 day')", [crypto.randomUUID(), saved.sale_id]);
  await http.post('/api/returns').send({
    sale_id: saved.sale_id,
    reason: 'Please return this item'
  }).expect(401);
  await http.post('/api/returns').set('Authorization', `Bearer ${other}`).send({
    sale_id: saved.sale_id,
    reason: 'Please return this item'
  }).expect(404);
  const result = await http.post('/api/returns').set('Authorization', `Bearer ${token}`).send({
    sale_id: saved.sale_id,
    type: 'REFUND',
    reason: 'Please return this item'
  }).expect(409);
  assert.match(result.body.message, /Innerwear/);
  await http.get('/api/returns/admin').set('Authorization', `Bearer ${token}`).expect(403);
  await query('UPDATE products SET category_id=NULL WHERE id=1');
});

test('storefront verification rejects missing fields and invalid signatures without marking an order paid', async () => {
  const payload = await body('ONLINE');
  await service.create(user, payload);
  const token = jwt.sign(user, process.env.JWT_SECRET);
  const auth = request => request.set('Authorization', `Bearer ${token}`);
  const gateway = (await auth(http.post(`/api/storefront/checkouts/${payload.request_key}/pay`)).send({ amount: 100 }).expect(200)).body;
  assert.notEqual(gateway.amount, 100);
  await auth(http.post(`/api/storefront/checkouts/${payload.request_key}/verify`)).send({}).expect(400);
  await auth(http.post(`/api/storefront/checkouts/${payload.request_key}/verify`)).send({ razorpay_order_id: gateway.order_id, razorpay_payment_id: 'pay_bad', razorpay_signature: '0'.repeat(64) }).expect(400);
  assert.equal((await query('SELECT payment_status FROM sales')).rows[0].payment_status, 'PENDING');
  assert.equal(shippingCalls, 0);
});

test('gateway auth failures return 401 and the same checkout can retry after credentials are fixed', async () => {
  const payload = await body('ONLINE');
  await service.create(user, payload);
  const token = jwt.sign(user, process.env.JWT_SECRET);
  const pay = () => http.post(`/api/storefront/checkouts/${payload.request_key}/pay`).set('Authorization', `Bearer ${token}`).send({});
  gatewayMode = 'auth';
  const response = await pay().expect(401);
  assert.equal(response.body.code, 'RAZORPAY_AUTH_FAILED');
  assert.equal((await query('SELECT gateway_state FROM mobile_checkouts')).rows[0].gateway_state, 'NEW');
  gatewayMode = '';
  await pay().expect(200);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 1);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 9);
});

test('the stored payment minimum is enforced before contacting Razorpay', async () => {
  const payload = await body('ONLINE');
  await service.create(user, payload);
  await query('UPDATE mobile_checkouts SET amount_paise=99');
  await assert.rejects(service.paymentOrder(user, payload.request_key), error => error.status === 400);
  assert.equal(paymentCalls, 0);
});

test('storefront webhook handles raw whitespace, order.paid, duplicate capture and reordered failures without carrier calls', async () => {
  const payload = await body();
  await service.create(user, payload);
  const gateway = await service.paymentOrder(user, payload.request_key);
  const payment = { id: 'pay_webhook_cod', order_id: gateway.order_id, amount: gateway.amount, currency: 'INR', status: 'captured' };
  const send = async event => {
    const raw = JSON.stringify({ event, payload: { payment: { entity: payment } } }, null, 2) + '\n';
    const signature = crypto.createHmac('sha256', process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    return http.post('/api/storefront/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', signature).send(raw).expect(200);
  };
  await send('order.paid');
  await send('payment.captured');
  payment.status = 'failed';
  await send('payment.failed');
  const sale = (await query('SELECT payment_status,totals FROM sales')).rows[0];
  assert.equal(sale.payment_status, 'COD');
  assert.equal(Number(sale.totals.cod_advance_paid), 150);
  assert.equal(shippingCalls, 0);
  assert.equal((await query('SELECT count(*)::int AS n FROM vandana_cart')).rows[0].n, 0);
  await service.reconcile(user, payload.request_key);
  assert.equal(shippingCalls, 1);
});

test('malformed signed webhook JSON returns 400 without changing payment state', async () => {
  const raw = '{invalid-json';
  const signature = crypto.createHmac('sha256', process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
  await http.post('/api/storefront/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', signature).send(raw).expect(400);
  assert.equal(shippingCalls, 0);
});
