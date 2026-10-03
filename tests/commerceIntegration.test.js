const {
  test,
  before,
  after,
  beforeEach
} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const {
  PGlite
} = require('@electric-sql/pglite');
const express = require('express'),
  supertest = require('supertest'),
  jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'commerce-tests-only-secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_commerce';
process.env.RAZORPAY_KEY_SECRET = 'commerce-gateway-test-secret';
let pg,
  http,
  captures = [],
  refunds = {},
  carrierStatus = 'NEW',
  carrierMode = '',
  carrierCalls = 0,
  carrierSale = '',
  gatewayCalls = 0;
let refundPosts=[],refundCreates=0,refundMode='',refundKeys=new Map();
const locks = new Set();
async function query(sql, args) {
  if (sql.includes('pg_advisory_xact_lock')) return {
    rows: [{}],
    rowCount: 1
  };
  if (sql.includes('pg_try_advisory_lock')) {
    const locked = !locks.has(args[0]);
    if (locked) locks.add(args[0]);
    return {
      rows: [{
        locked
      }],
      rowCount: 1
    };
  }
  if (sql.includes('pg_advisory_unlock')) {
    locks.delete(args[0]);
    return {
      rows: [{}],
      rowCount: 1
    };
  }
  const r = await pg.query(sql, args);
  return {
    ...r,
    rowCount: Math.max(r.rows.length, r.affectedRows || 0)
  };
}
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
      connect: async () => ({})
    })
  }
};
class Gateway {
  constructor() {
    this.client = {
      post: async (url,body,config) => {
        const key=config.headers['X-Refund-Idempotency'];refundPosts.push({key,body});
        if(!refundKeys.has(key)){refundCreates++;const entity={id:`rfnd_auto_${refundCreates}`,payment_id:url.split('/')[2],amount:body.amount,currency:'INR',status:refundMode==='failed'?'failed':'pending',receipt:body.receipt};refundKeys.set(key,entity);refunds[entity.id]=entity;}
        if(refundMode==='timeout')throw new Error('gateway timeout after creation');
        return {data:refundKeys.get(key)};
      },
      get: async url => ({
        data: url.includes('/refunds/') ? refunds[url.split('/').pop()] : url.startsWith('/orders/') ? {
          items: captures
        } : captures.find(p => url.endsWith(p.id))
      })
    };
  }
  async createOrder() {
    gatewayCalls++;
    return {
      id: `order_commerce_${gatewayCalls}`
    };
  }
}
class Carrier {
  async init() {}
  async api() {
    return {
      data: {
        data: {
          channel_order_id: carrierSale,
          status: carrierStatus
        }
      }
    };
  }
  async cancelOrders() {
    carrierCalls++;
    if (carrierMode === 'timeout') throw new Error('carrier timeout');
    if (carrierMode !== 'pending') carrierStatus = 'CANCELED';
    return {
      status: 200
    };
  }
}
require.cache[require.resolve('../services/razorpayService')] = {
  exports: Gateway
};
require.cache[require.resolve('../services/shiprocketService')] = {
  exports: Carrier
};
let reverseCalls=0,reverseMode='';
require.cache[require.resolve('../services/returnsService')]={exports:class {
  async init(){}
  async createReversePickup({request}){
    reverseCalls++;
    if(reverseMode==='timeout')throw new Error('Return pickup timed out');
    return (await query('INSERT INTO reverse_shipments(request_id) VALUES($1) RETURNING *',[request.id])).rows[0];
  }
}};
const checkout = require('../services/mobileCheckout'),
  cancellations = require('../services/orderCancellation'),
  returnPolicy = require('../services/returnPolicy'),
  refundService = require('../services/storeRefunds'),
  rewards = require('../services/rewardPointsService');
const user = {
    id: 1,
    name: 'Test Customer',
    email: 'customer@example.test',
    mobile: '9999999999',
    type: 'B2C'
  },
  staff = {
    id: 9,
    role: 'SUPER_ADMIN'
  },
  address = {
    fullName: 'Test Customer',
    mobile: '9999999999',
    line1: '12 Test Street',
    line2: '',
    city: 'Tirupati',
    state: 'Andhra Pradesh',
    pincode: '517501'
  };
const token = jwt.sign(user, process.env.JWT_SECRET),
  other = jwt.sign({
    ...user,
    id: 2,
    email: 'other@example.test'
  }, process.env.JWT_SECRET);
const auth = r => r.set('Authorization', `Bearer ${token}`);
before(async () => {
  pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(__dirname, 'support/mobile-schema.sql'), 'utf8'));
  for (const file of ['20260923_order_shipping.sql', '20260923_mobile.sql', '20260925_mobile_store.sql', '20260929_store_commerce.sql']) await pg.exec(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  await pg.exec('ALTER TABLE shipments ADD COLUMN shiprocket_order_id text,ADD COLUMN shiprocket_shipment_id text,ADD COLUMN raw_status text,ADD COLUMN updated_at timestamptz;');
  await pg.exec("CREATE TABLE branches(id bigint PRIMARY KEY,name text);INSERT INTO branches VALUES(3,'Test branch');CREATE TABLE reverse_shipments(id bigserial PRIMARY KEY,request_id bigint);");
  await pg.exec('ALTER TABLE shipments ADD COLUMN current_location text,ADD COLUMN status_synced_at timestamptz,ADD COLUMN last_tracking_payload jsonb,ADD COLUMN tracking_url text,ADD COLUMN label_url text,ADD COLUMN awb_assigned_at timestamptz;');
  await pg.exec(fs.readFileSync(path.join(__dirname,'../migrations/20261003_order_operations.sql'),'utf8'));
  const app = express();
  app.post('/api/mobile/payments/webhook',express.raw({type:'application/json'}),require('../routes/mobileWebhook'));
  app.use(express.json());
  app.use('/api/storefront', require('../routes/storefrontRoutes'));
  app.use('/api/rewards', require('../routes/rewardPointsRoutes'));
  app.use('/api/orders', require('../routes/orderRoutes'));
  app.use('/api/mobile', require('../routes/mobileRoutes'));
  app.use('/api/order-management', require('../routes/orderManagementRoutes'));
  app.use('/api/cart',require('../routes/cartRoutes'));
  app.use('/api/wishlist',require('../routes/wishlistRoutes'));
  app.use('/api/user',require('../routes/userRoutes'));
  app.use('/api/sales',require('../routes/salesRoutes'));
  app.use('/api', require('../routes/returnsRoutes'));
  app.use('/api',require('../routes/shipmentRoutes'));
  app.use('/api',require('../routes/shiprocketPublicRoutes'));
  app.use('/api',require('../routes/shiprocketRoutes'));
  http = supertest(app);
});
beforeEach(async () => {
  reverseCalls=0;reverseMode='';refundPosts=[];refundCreates=0;refundMode='';refundKeys=new Map();
  captures = [];
  refunds = {};
  carrierStatus = 'NEW';
  carrierMode = '';
  carrierCalls = 0;
  gatewayCalls = 0;
  locks.clear();
  await pg.exec(`TRUNCATE reverse_shipments,mobile_checkouts,storefront_cancellations,order_cancellations,order_shipping_workflow,return_items,return_requests,shipments,sale_items,sales,payments,vandana_cart,branch_variant_stock,reward_point_lots,reward_point_transactions RESTART IDENTITY CASCADE;
    UPDATE reward_settings SET setting_value='true' WHERE setting_key='enabled';
    INSERT INTO branch_variant_stock VALUES(3,11,10,0,true,now());
    INSERT INTO vandana_cart(user_id,product_id,selected_size,selected_color,quantity,is_custom) VALUES(1,11,'M','BLACK',1,false);
    INSERT INTO reward_point_lots(user_id,source_type,points_granted,points_remaining,expires_at,status) VALUES(1,'SIGNUP_BONUS',100,100,now()+interval '30 days','ACTIVE');`);
});
after(async () => pg.close());
async function place(method = 'COD', points = 0) {
  const q = await checkout.quote(pool, 1, points, false, method);
  const body = {
    request_key: crypto.randomUUID(),
    address,
    payment_method: method,
    reward_points: points,
    fingerprint: q.fingerprint,
    quote_version: 2
  };
  return {
    ...(await checkout.create(user, body)),
    body
  };
}
async function paid(points = 0) {
  const saved = await place('ONLINE', points),
    order = await checkout.paymentOrder(user, saved.key);
  captures = [{
    id: 'pay_commerce',
    order_id: order.order_id,
    amount: order.amount,
    currency: 'INR',
    status: 'captured'
  }];
  await checkout.complete(1, saved.key, captures[0]);
  return saved;
}
async function delivered(saved) {
  await query("UPDATE sales SET status='DELIVERED' WHERE id=$1", [saved.sale_id]);
  await query("INSERT INTO shipments(id,sale_id,status,delivered_at,created_at) VALUES($1,$2,'DELIVERED',now()-interval '1 day',now())", [crypto.randomUUID(), saved.sale_id]);
}
test('website quote and placement use authoritative method-aware totals and ignore forged prices', async () => {
  await http.post('/api/storefront/checkout/quote').send({
    payment_method: 'COD'
  }).expect(401);
  await auth(http.post('/api/storefront/checkout/quote')).send({}).expect(400);
  const q = await auth(http.post('/api/storefront/checkout/quote')).send({
    payment_method: 'COD',
    reward_points: 20
  }).expect(200);
  assert.equal(q.body.shipping, 40);
  assert.equal(q.body.payable, 560);
  const body = {
    request_key: crypto.randomUUID(),
    address,
    payment_method: 'COD',
    reward_points: 20,
    fingerprint: q.body.fingerprint,
    total: 1,
    shipping: 0
  };
  const saved = await auth(http.post('/api/storefront/checkouts')).send(body).expect(200);
  assert.equal(saved.body.amount, 56000);
  const replay = await auth(http.post('/api/storefront/checkouts')).send(body).expect(200);
  assert.equal(replay.body.sale_id, saved.body.sale_id);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 9);
});
test('a payment-method change invalidates a displayed quote before stock or rewards change', async () => {
  const q = await checkout.quote(pool, 1, 20, false, 'ONLINE');
  await assert.rejects(checkout.create(user, {
    request_key: crypto.randomUUID(),
    address,
    payment_method: 'COD',
    reward_points: 20,
    fingerprint: q.fingerprint,
    quote_version: 2
  }), /prices changed/);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 0);
});
test('missed signup credit is repaired once using admin settings, and expired bonuses are not reissued', async () => {
  await query('DELETE FROM reward_point_lots');
  const wallet = await auth(http.get('/api/rewards/wallet')).expect(200);
  assert.equal(wallet.body.balance, 1000);
  await auth(http.get('/api/rewards/wallet')).expect(200);
  assert.equal((await query('SELECT count(*)::int AS n FROM reward_point_transactions')).rows[0].n, 1);
  await query("UPDATE reward_point_lots SET expires_at=now()-interval '1 day'");
  assert.equal((await rewards.getWalletSummary(1)).balance, 0);
  assert.equal((await query('SELECT count(*)::int AS n FROM reward_point_lots')).rows[0].n, 1);
});
test('disabled rewards and business accounts cannot receive a new signup credit', async () => {
  await query('DELETE FROM reward_point_lots');
  await query("UPDATE reward_settings SET setting_value='false' WHERE setting_key='enabled'");
  assert.equal((await rewards.getWalletSummary(1)).balance, 0);
  await query("UPDATE reward_settings SET setting_value='true' WHERE setting_key='enabled'");
  await query("UPDATE vandana_users SET type='B2B' WHERE id=2");
  assert.equal(await rewards.creditSignupBonus(2), null);
  await query("UPDATE vandana_users SET type='B2C' WHERE id=2");
});
test('customers can only cancel their own order and cannot call staff processing', async () => {
  const saved = await place();
  await http.post(`/api/storefront/orders/${saved.sale_id}/cancel`).set('Authorization', `Bearer ${other}`).send({
    reason: 'Wrong size'
  }).expect(404);
  await auth(http.post(`/api/storefront/admin/cancellations/${saved.sale_id}/process`)).send({}).expect(403);
  await http.post('/api/orders/cancel').send({
    sale_id: saved.sale_id
  }).expect(401);
  await auth(http.get('/api/rewards/admin/summary')).expect(403);
});
test('unpaid COD cancellation restores stock and redeemed rewards once, with no cash refund', async () => {
  const saved = await place('COD', 100);
  const request = await cancellations.requestCancellation(user, saved.sale_id, {
    reason: 'Ordered wrong size'
  });
  assert.equal(request.refund_amount, 0);
  assert.equal(request.excluded_fees, 40);
  await cancellations.requestCancellation(user, saved.sale_id, {
    reason: 'A duplicate click'
  });
  const done = await cancellations.processCancellation(staff, saved.sale_id);
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.refund_status, 'NOT_DUE');
  await cancellations.processCancellation(staff, saved.sale_id);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 10);
  assert.equal((await query('SELECT points_remaining FROM reward_point_lots')).rows[0].points_remaining, 100);
  assert.equal((await query("SELECT count(*)::int AS n FROM reward_point_transactions WHERE transaction_type='REFUNDED'")).rows[0].n, 1);
});
test('dispatched and older-than-seven-day orders cannot be cancelled', async () => {
  const saved = await place();
  await query("UPDATE sales SET status='SHIPPED' WHERE id=$1", [saved.sale_id]);
  await assert.rejects(cancellations.requestCancellation(user, saved.sale_id, {
    reason: 'Wrong size'
  }), /dispatch/);
  await query("UPDATE sales SET status='PLACED',created_at=now()-interval '8 days' WHERE id=$1", [saved.sale_id]);
  await assert.rejects(cancellations.requestCancellation(user, saved.sale_id, {
    reason: 'Wrong size'
  }), /7-day/);
});
test('carrier timeouts preserve a pending request and never resend cancellation blindly', async () => {
  const saved = await place();
  carrierSale = saved.sale_id;
  await query("INSERT INTO shipments(id,sale_id,status,shiprocket_order_id,created_at) VALUES($1,$2,'CONFIRMED','900',now())", [crypto.randomUUID(), saved.sale_id]);
  await cancellations.requestCancellation(user, saved.sale_id, {
    reason: 'Wrong size'
  });
  carrierMode = 'timeout';
  await assert.rejects(cancellations.processCancellation(staff, saved.sale_id), /timeout/);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 9);
  carrierMode = '';
  await assert.rejects(cancellations.processCancellation(staff, saved.sale_id), /awaiting confirmation/);
  assert.equal(carrierCalls, 1);
  carrierStatus = 'CANCELED';
  await query("UPDATE sales SET status='CANCELLED' WHERE id=$1", [saved.sale_id]);
  assert.equal((await cancellations.processCancellation(staff, saved.sale_id)).status, 'COMPLETED');
});
test('online cancellation blocks new payment sessions and a late capture queues only the product refund', async () => {
  const saved = await place('ONLINE');
  const gateway = await checkout.paymentOrder(user, saved.key);
  await cancellations.requestCancellation(user, saved.sale_id, {
    reason: 'Wrong size'
  });
  await assert.rejects(checkout.paymentOrder(user, saved.key), /cancellation/);
  assert.equal((await cancellations.processCancellation(staff, saved.sale_id)).status, 'COMPLETED');
  const payment = {
    id: 'pay_late',
    order_id: gateway.order_id,
    amount: gateway.amount,
    currency: 'INR',
    status: 'captured'
  };
  await checkout.complete(1, saved.key, payment);
  await checkout.complete(1, saved.key, payment);
  const request = (await query('SELECT * FROM storefront_cancellations WHERE sale_id=$1', [saved.sale_id])).rows[0];
  assert.equal(request.refund_status, 'PENDING_REFUND');
  assert.equal(Number(request.refund_amount_paise), 54000);
  assert.equal((await query('SELECT status FROM sales WHERE id=$1', [saved.sale_id])).rows[0].status, 'CANCELLED');
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand, 10);
  assert.equal((await query('SELECT quantity FROM vandana_cart')).rows[0].quantity, 1);
});
test('paid cancellation exposes only product cash and verifies exact processed Razorpay refund', async () => {
  const saved = await paid(100);
  await cancellations.requestCancellation(user, saved.sale_id, {
    reason: 'Wrong size'
  });
  const result = await cancellations.processCancellation(staff, saved.sale_id);
  assert.equal(result.refund_amount, 440);
  assert.equal(result.excluded_fees, 30);
  await assert.rejects(refundService.completeCancellation(staff, saved.sale_id, {
    amount_paise: 47000,
    reference: 'rfnd_exact'
  }), /exactly/);
  refunds.rfnd_exact = {
    id: 'rfnd_exact',
    payment_id: 'pay_other',
    status: 'processed',
    currency: 'INR',
    amount: 44000
  };
  await assert.rejects(refundService.completeCancellation(staff, saved.sale_id, {
    amount_paise: 44000,
    reference: 'rfnd_exact'
  }), /Razorpay/);
  refunds.rfnd_exact.payment_id = 'pay_commerce';
  const done = await refundService.completeCancellation(staff, saved.sale_id, {
    amount_paise: 44000,
    reference: 'rfnd_exact'
  });
  assert.equal(done.refund.status, 'REFUNDED');
  assert.equal((await refundService.completeCancellation(staff, saved.sale_id, {
    amount_paise: 44000,
    reference: 'rfnd_exact'
  })).refund.status, 'REFUNDED');
});
test('COD partial returns exclude all fees, require receipt and transfer proof, and restore only allocated points', async () => {
  await query('UPDATE vandana_cart SET quantity=2 WHERE user_id=1');
  const saved = await place('COD', 100);
  await delivered(saved);
  const item = (await query('SELECT id FROM sale_items WHERE sale_id=$1', [saved.sale_id])).rows[0];
  const requested = await returnPolicy.createReturn(pool, saved.sale_id, {
    reason: 'The shirt size does not fit',
    items: [{
      sale_item_id: item.id,
      qty: 1
    }]
  });
  assert.equal(requested.request.refund.amount, 490);
  assert.equal(requested.request.refund.reward_points, 50);
  assert.equal(requested.request.refund.excluded_delivery_and_cod, 30);
  await query("UPDATE return_requests SET status='APPROVED',refund_status='PENDING_REFUND' WHERE id=$1", [requested.request.id]);
  const body = {
    amount_paise: 49000,
    reference: 'BANK123456',
    items_received: true,
    transfer_confirmed: true
  };
  await assert.rejects(refundService.completeReturn(staff, requested.request.id, {
    ...body,
    items_received: false
  }), /received/);
  await assert.rejects(refundService.completeReturn({
    ...staff,
    role: 'BRANCH_ADMIN',
    branch_id: 8
  }, requested.request.id, body), /access/);
  await refundService.completeReturn(staff, requested.request.id, body);
  await refundService.completeReturn(staff, requested.request.id, body);
  assert.equal((await query('SELECT points_remaining FROM reward_point_lots')).rows[0].points_remaining, 50);
  const second = await returnPolicy.createReturn(pool, saved.sale_id, {
    reason: 'The second shirt also does not fit',
    items: [{
      sale_item_id: item.id,
      qty: 1
    }]
  });
  assert.equal(second.request.refund.amount, 490);
  await query("UPDATE return_requests SET status='APPROVED',refund_status='PENDING_REFUND' WHERE id=$1", [second.request.id]);
  await assert.rejects(refundService.completeReturn(staff, second.request.id, body), /already recorded/);
  await refundService.completeReturn(staff, second.request.id, {
    ...body,
    reference: 'BANK789012'
  });
  assert.equal((await query('SELECT points_remaining FROM reward_point_lots')).rows[0].points_remaining, 100);
});
test('commerce migration can be reapplied without changing saved orders or balances', async () => {
  const saved = await place('COD', 20);
  await pg.exec(fs.readFileSync(path.join(__dirname, '../migrations/20260929_store_commerce.sql'), 'utf8'));
  assert.equal(Number((await query('SELECT total FROM sales WHERE id=$1', [saved.sale_id])).rows[0].total), 560);
  assert.equal((await query('SELECT points_remaining FROM reward_point_lots')).rows[0].points_remaining, 80);
});

test('staff cancellation through the existing admin endpoint is audited and cannot bypass branch ownership',async()=>{
 const saved=await place();const wrong=jwt.sign({id:9,role:'BRANCH_ADMIN',branch_id:8},process.env.JWT_SECRET);
 await http.post('/api/orders/cancel').set('Authorization',`Bearer ${wrong}`).send({sale_id:saved.sale_id,reason:'Customer asked to cancel'}).expect(403);
 const admin=jwt.sign(staff,process.env.JWT_SECRET);
 await http.post('/api/orders/cancel').set('Authorization',`Bearer ${admin}`).send({sale_id:saved.sale_id,reason:'Customer asked to cancel'}).expect(200);
 const row=(await query('SELECT source,requested_by,status FROM storefront_cancellations WHERE sale_id=$1',[saved.sale_id])).rows[0];
 assert.equal(row.source,'ADMIN');assert.equal(Number(row.requested_by),9);assert.equal(row.status,'COMPLETED');
});
test('return approval is idempotent and a refunded return cannot be rejected to reset its entitlement',async()=>{
 const saved=await place('COD',100);await delivered(saved);
 const item=(await query('SELECT id FROM sale_items WHERE sale_id=$1',[saved.sale_id])).rows[0];
 const created=await returnPolicy.createReturn(pool,saved.sale_id,{reason:'The shirt size does not fit',items:[{sale_item_id:item.id,qty:1}]});
 const id=created.request.id,admin=jwt.sign(staff,process.env.JWT_SECRET);
 const send=(action,body={})=>http.post(`/api/returns/${id}/${action}`).set('Authorization',`Bearer ${admin}`).send(body);
 await send('approve').expect(200);await send('approve').expect(200);assert.equal(reverseCalls,1);
 await send('refund-complete',{amount_paise:44000,reference:'BANK999001',items_received:true,transfer_confirmed:true}).expect(200);
 await send('reject',{reason:'Try to reset a refunded return'}).expect(409);
 assert.equal((await query('SELECT refund_status FROM return_requests WHERE id=$1',[id])).rows[0].refund_status,'REFUNDED');
 assert.equal((await returnPolicy.eligibility(pool,saved.sale_id)).ok,false);
});
test('an uncertain return pickup is never created again on approval retry',async()=>{
 const saved=await place();await delivered(saved);
 const item=(await query('SELECT id FROM sale_items WHERE sale_id=$1',[saved.sale_id])).rows[0];
 const created=await returnPolicy.createReturn(pool,saved.sale_id,{reason:'Wrong clothing size received',items:[{sale_item_id:item.id,qty:1}]});
 const admin=jwt.sign(staff,process.env.JWT_SECRET);reverseMode='timeout';
 const approve=()=>http.post(`/api/returns/${created.request.id}/approve`).set('Authorization',`Bearer ${admin}`).send({});
 await approve().expect(409);reverseMode='';await approve().expect(409);assert.equal(reverseCalls,1);
});

test('pending mobile cancellation appears immediately in admin queues and branch permissions apply',async()=>{
 const saved=await place('COD',20);
 await auth(http.post(`/api/mobile/orders/${saved.sale_id}/cancel`)).send({reason:'Customer no longer needs this shirt'}).expect(202);
 const admin=jwt.sign(staff,process.env.JWT_SECRET),branch=jwt.sign({id:9,role:'BRANCH_ADMIN',branch_id:8},process.env.JWT_SECRET);
 const result=await http.get('/api/order-management/orders?queue=cancellations').set('Authorization',`Bearer ${admin}`).expect(200);
 assert.equal(result.body.total,1);assert.equal(result.body.rows[0].display_status,'CANCELLATION REQUESTED');
 assert.equal(Number((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand),9);
 assert.equal((await http.get('/api/order-management/orders?queue=cancellations').set('Authorization',`Bearer ${branch}`).expect(200)).body.total,0);
 await http.get(`/api/order-management/orders/${saved.sale_id}`).set('Authorization',`Bearer ${branch}`).expect(403);
 const summary=await http.get('/api/order-management/summary').set('Authorization',`Bearer ${admin}`).expect(200);
 assert.equal(summary.body.cancellation_requests,1);
 const history=await auth(http.get(`/api/mobile/orders/${saved.sale_id}/timeline`)).expect(200);
 assert(history.body.some(e=>e.event_type==='CANCELLATION_UPDATED'&&e.status==='REQUESTED'));
 await http.get(`/api/mobile/orders/${saved.sale_id}/timeline`).set('Authorization',`Bearer ${other}`).expect(404);
});
test('a refund timeout reuses the same immutable gateway key and provider reconciliation settles it once',async()=>{
 const saved=await paid(20);
 await cancellations.requestCancellation(user,saved.sale_id,{reason:'Please cancel my clothing order'});
 await cancellations.processCancellation(staff,saved.sale_id);
 const operations=require('../services/refundOperations');refundMode='timeout';
 await assert.rejects(operations.initiate(staff,'CANCELLATION',saved.sale_id,{amount_paise:52000}),/confirmation is pending/);
 assert.equal(refundCreates,1);
 refundMode='';const retried=await operations.initiate(staff,'CANCELLATION',saved.sale_id,{amount_paise:52000});
 assert.equal(retried.operation.status,'PENDING');assert.equal(refundCreates,1);assert.equal(refundPosts.length,2);
 assert.deepEqual(refundPosts[0],refundPosts[1]);
 assert.equal((await query('SELECT payment_status FROM sales WHERE id=$1',[saved.sale_id])).rows[0].payment_status,'PAID');
 refunds[retried.operation.reference].status='processed';
 const settled=await operations.reconcile(staff,'CANCELLATION',saved.sale_id);assert.equal(settled.operation.status,'PROCESSED');
 await operations.reconcile(staff,'CANCELLATION',saved.sale_id);
 assert.equal((await query('SELECT payment_status FROM sales WHERE id=$1',[saved.sale_id])).rows[0].payment_status,'PARTIALLY_REFUNDED');
 assert.equal((await query('SELECT refund_status FROM storefront_cancellations WHERE sale_id=$1',[saved.sale_id])).rows[0].refund_status,'REFUNDED');
 assert.equal((await query("SELECT COUNT(*)::int AS count FROM reward_point_transactions WHERE transaction_type='REFUNDED'")).rows[0].count,1);
});
test('return inspection restocks only sellable goods once and COD refund stays separate from receipt',async()=>{
 const saved=await place('COD',100);await delivered(saved);
 const item=(await query('SELECT id FROM sale_items WHERE sale_id=$1',[saved.sale_id])).rows[0];
 const result=await returnPolicy.createReturn(pool,saved.sale_id,{reason:'Wrong size clothing received',items:[{sale_item_id:item.id,qty:1}]});
 const id=result.request.id;
 await query("UPDATE return_requests SET status='APPROVED',refund_status='PENDING_REFUND' WHERE id=$1",[id]);
 await assert.rejects(refundService.receiveReturn({...staff,role:'BRANCH_ADMIN',branch_id:8},id,{restock:true,inspection_notes:'Shirt checked and sellable'}),/access/);
 await refundService.receiveReturn(staff,id,{restock:true,inspection_notes:'Shirt checked and sellable'});
 await refundService.receiveReturn(staff,id,{restock:true,inspection_notes:'Duplicate receipt must not restore twice'});
 assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand,10);
 assert.equal((await query('SELECT refund_status FROM return_requests WHERE id=$1',[id])).rows[0].refund_status,'PENDING_REFUND');
 await refundService.completeReturn(staff,id,{amount_paise:44000,reference:'BANK_RESTOCK_001',transfer_confirmed:true});
 assert.equal((await query('SELECT points_remaining FROM reward_point_lots')).rows[0].points_remaining,100);
});
test('gateway refunds require return receipt and failed refunds cannot create a second key',async()=>{
 const saved=await paid();await delivered(saved);
 const item=(await query('SELECT id FROM sale_items WHERE sale_id=$1',[saved.sale_id])).rows[0];
 const result=await returnPolicy.createReturn(pool,saved.sale_id,{reason:'Wrong clothing size received',items:[{sale_item_id:item.id,qty:1}]});
 await query("UPDATE return_requests SET status='APPROVED',refund_status='PENDING_REFUND' WHERE id=$1",[result.request.id]);
 const operations=require('../services/refundOperations');
 await assert.rejects(operations.initiate(staff,'RETURN',result.request.id,{amount_paise:54000}),/inspect/);
 await refundService.receiveReturn(staff,result.request.id,{restock:false,inspection_notes:'Damaged fabric. Keep out of sellable stock.'});
 refundMode='failed';const response=await operations.initiate(staff,'RETURN',result.request.id,{amount_paise:54000});
 assert.equal(response.operation.status,'FAILED');assert.equal(refundCreates,1);
 await assert.rejects(operations.initiate(staff,'RETURN',result.request.id,{amount_paise:54000}),/failed/);
 assert.equal(refundCreates,1);assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand,9);
});
test('signed refund webhooks reconcile authoritative status and repeated or reordered deliveries stay idempotent',async()=>{
 process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET='refund-webhook-test-secret';
 const saved=await paid();await cancellations.requestCancellation(user,saved.sale_id,{reason:'Please cancel the order'});await cancellations.processCancellation(staff,saved.sale_id);
 const op=await require('../services/refundOperations').initiate(staff,'CANCELLATION',saved.sale_id,{amount_paise:54000});
 const entity=refunds[op.operation.reference];entity.status='processed';
 const body=JSON.stringify({event:'refund.processed',payload:{refund:{entity}}});
 const signature=crypto.createHmac('sha256',process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
 const send=()=>http.post('/api/mobile/payments/webhook').set('Content-Type','application/json').set('x-razorpay-signature',signature).send(body);
 await http.post('/api/mobile/payments/webhook').set('Content-Type','application/json').send(body).expect(400);
 await send().expect(200);await send().expect(200);
 assert.equal((await query('SELECT status FROM order_refund_operations')).rows[0].status,'PROCESSED');
 assert.equal((await query("SELECT COUNT(*)::int AS count FROM order_events WHERE source='order_refund_operations' AND status='PROCESSED'")).rows[0].count,1);
});
test('operation migration is repeatable and pending orders support filters and legacy branch roles',async()=>{
 const saved=await place();
 await pg.exec(fs.readFileSync(path.join(__dirname,'../migrations/20261003_order_operations.sql'),'utf8'));
 await pg.exec(fs.readFileSync(path.join(__dirname,'../migrations/20261003_order_operations.sql'),'utf8'));
 const management=require('../services/orderManagement');
 assert.equal((await management.list({id:9,role:'BRANCH3',branch_id:3},{q:'Test Customer'})).total,1);
 assert.equal((await management.list(staff,{q:'%'})).total,0);
 assert.equal((await management.detail(staff,saved.sale_id)).timeline.filter(e=>e.event_type==='ORDER_PLACED').length,1);
});
test('legacy carrier endpoints reject customer and cross-branch access while old refund lists include cancellations',async()=>{
  const saved=await paid();await cancellations.requestCancellation(user,saved.sale_id,{reason:'Ordered a wrong clothing size'});await cancellations.processCancellation(staff,saved.sale_id);
  const admin=jwt.sign(staff,process.env.JWT_SECRET),branch=jwt.sign({id:88,role:'BRANCH_ADMIN',branch_id:8},process.env.JWT_SECRET);
  await http.get(`/api/shipments/by-sale/${saved.sale_id}`).expect(401);
  await auth(http.get(`/api/shipments/by-sale/${saved.sale_id}`)).expect(403);
  await http.get(`/api/shipments/by-sale/${saved.sale_id}`).set('Authorization',`Bearer ${branch}`).expect(403);
  await auth(http.get('/api/orders')).expect(403);
  await http.get('/api/shiprocket/my-orders').expect(401);
  await http.post('/api/shiprocket/warehouses/import').set('Authorization',`Bearer ${branch}`).send({}).expect(403);
  const listed=await http.get('/api/returns/admin/refunds').set('Authorization',`Bearer ${admin}`).expect(200);
  assert.equal(listed.body.rows.length,1);assert.equal(listed.body.rows[0].type,'CANCELLATION');assert.equal(Number(listed.body.rows[0].amount),540);
});
test('return courier webhooks update only the reverse shipment and cannot receive items or restore stock',async()=>{
  const saved=await place();await delivered(saved);
  const item=(await query('SELECT id FROM sale_items WHERE sale_id=$1',[saved.sale_id])).rows[0];
  const returned=await returnPolicy.createReturn(pool,saved.sale_id,{reason:'Wrong size delivered',items:[{sale_item_id:item.id,qty:1}]});
  await query("UPDATE return_requests SET status='APPROVED' WHERE id=$1",[returned.request.id]);
  await query("INSERT INTO reverse_shipments(request_id,shiprocket_order_id,shiprocket_shipment_id,awb,status)VALUES($1,'9191','9292','RETURNTRACK','NEW')",[returned.request.id]);
  process.env.SHIPROCKET_WEBHOOK_TOKEN='carrier-webhook-fixture';
  const payload={is_return:1,sr_order_id:9191,order_id:saved.sale_id,awb:'RETURNTRACK',current_status:'RETURN DELIVERED',current_timestamp:'03 10 2026 15:00:00'};
  const send=body=>http.post('/api/webhooks/orders').set('x-api-key',process.env.SHIPROCKET_WEBHOOK_TOKEN).send(body);
  await http.post('/api/webhooks/orders').send(payload).expect(401);
  await send(payload).expect(200);await send(payload).expect(200);
  await send({...payload,current_status:'IN TRANSIT',current_timestamp:'03 10 2026 10:00:00'}).expect(200);
  assert.equal((await query('SELECT status FROM reverse_shipments')).rows[0].status,'RETURN DELIVERED');
  assert.equal((await query('SELECT status FROM sales')).rows[0].status,'DELIVERED');
  assert.equal((await query('SELECT items_received_at FROM return_requests')).rows[0].items_received_at,null);
  assert.equal((await query('SELECT on_hand FROM branch_variant_stock')).rows[0].on_hand,9);
});

test('legacy cart, wishlist and profile routes require the owning customer session',async()=>{
  for(const path of ['/api/cart/1','/api/wishlist/1','/api/user/by-email/customer@example.test'])await http.get(path).expect(401);
  for(const path of ['/api/cart/2','/api/wishlist/2'])await http.get(path).set('Authorization',`Bearer ${token}`).expect(403);
  await http.delete('/api/cart/vandana-cart').set('Authorization',`Bearer ${token}`).send({user_id:2,cart_item_id:1}).expect(403);
  await http.post('/api/wishlist').set('Authorization',`Bearer ${token}`).send({user_id:2,variant_id:11}).expect(403);
  const count=await http.get('/api/cart/count/1').set('Authorization',`Bearer ${token}`).expect(200);assert.equal(count.body.count,1);
  const profile=await http.get('/api/user/by-email/customer@example.test').set('Authorization',`Bearer ${token}`).expect(200);assert.equal(profile.body.id,1);
  await http.get('/api/user/by-email/other@example.test').set('Authorization',`Bearer ${token}`).expect(404);
  await http.post('/api/user/update-mobile').set('Authorization',`Bearer ${token}`).send({email:'other@example.test',mobile:'9777777777'}).expect(404);
  assert.equal((await query('SELECT mobile FROM vandana_users WHERE id=2')).rows[0].mobile,'9888888888');
});
test('legacy sales admin displays requested cancellations and blocks customer or cross-branch access',async()=>{
  const saved=await place();await cancellations.requestCancellation(user,saved.sale_id,{reason:'Wrong shirt size selected'});
  const admin=jwt.sign(staff,process.env.JWT_SECRET),branch=jwt.sign({id:88,role:'BRANCH_ADMIN',branch_id:8},process.env.JWT_SECRET);
  await http.get('/api/sales/web').expect(401);
  await http.get('/api/sales/admin').set('Authorization',`Bearer ${token}`).expect(403);
  const own=await http.get('/api/sales/admin').set('Authorization',`Bearer ${admin}`).expect(200);
  assert.equal(own.body[0].cancellation_status,'REQUESTED');assert.equal(own.body[0].display_status,'CANCELLATION REQUESTED');
  const otherBranch=await http.get('/api/sales/admin').set('Authorization',`Bearer ${branch}`).expect(200);assert.deepEqual(otherBranch.body,[]);
  await http.get(`/api/sales/web/${saved.sale_id}`).set('Authorization',`Bearer ${other}`).expect(404);
  await http.post('/api/sales/web/b2b-update-status').set('Authorization',`Bearer ${token}`).send({sale_id:saved.sale_id,new_status:'DELIVERED'}).expect(403);
  await http.post('/api/sales/web/b2b-update-status').set('Authorization',`Bearer ${branch}`).send({sale_id:saved.sale_id,new_status:'DELIVERED'}).expect(403);
});
