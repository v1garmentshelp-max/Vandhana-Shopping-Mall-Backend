const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')
const { createWorkflow } = require('../services/orderShippingWorkflow')
const { normalizeOrderStatus } = require('../services/orderStatusSync')
let db
const locks = new Set()
const pool = {
  query: (sql, args) => db.query(sql, args),
  connect: async () => ({
    release() {},
    query: async (sql, args) => {
      if (sql.includes('pg_try_advisory_lock')) { const locked = !locks.has(args[0]); if (locked) locks.add(args[0]); return { rows: [{ locked }] } }
      if (sql.includes('pg_advisory_unlock')) { locks.delete(args[0]); return { rows: [{}] } }
      return db.query(sql, args)
    }
  })
}
let creates = 0
let awbs = 0
let pickups = 0
let mode = ''
let remoteAwb = null
let remoteSale
let lastOrder
const sr = {
  init: async () => {},
  createOrderShipment: async payload => {
    creates++
    lastOrder = payload
    if (mode === 'timeout') throw new Error('Timed out waiting for Shiprocket')
    return { order_id: 900, shipment_id: 901 }
  },
  checkServiceability: async () => ({ data: { available_courier_companies: [{ courier_company_id: 12, blocked: false }] } }),
  requestPickup: async () => { pickups++; return { pickup_status: 1 } },
  api: async (method, endpoint, payload) => {
    if (endpoint.startsWith('/orders/show/')) return { data: { data: { id: 900, channel_order_id: remoteSale, shipments: { id: 901, awb: remoteAwb, weight: 0.5 } } } }
    if (endpoint === '/courier/assign/awb') {
      awbs++
      assert.equal(payload.shipment_id, 901)
      assert.equal(payload.courier_id, 12)
      assert.equal(payload.courier_company_id, undefined)
      if (mode === 'awb-timeout') throw new Error('AWB response timed out')
      if (mode === 'wallet') return { data: { awb_assign_status: 0, response: { data: { awb_assign_error: 'Recharge wallet' } } } }
      remoteAwb = 'TEST123456'
      return { data: { awb_assign_status: 1, response: { data: { awb_code: remoteAwb } } } }
    }
    throw new Error(`Unexpected endpoint ${endpoint}`)
  }
}
const flow = createWorkflow(pool, () => sr)
let serial = 0
async function sale() {
  const id = `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`
  await db.query(`INSERT INTO sales(id,source,status,payment_method,payment_status,branch_id,total,customer_name,customer_mobile,shipping_address)
    VALUES($1,'WEB','PLACED','COD','COD',3,545,'Test','9999999999',$2)`, [id, JSON.stringify({ line1: 'Test address', city: 'Test City', state: 'Test State', pincode: '560037' })])
  await db.query('INSERT INTO sale_items(sale_id,product_id,variant_id,qty,price) VALUES($1,1,2,1,470)', [id])
  remoteSale = id
  mode = ''; remoteAwb = null
  return id
}
before(async () => {
  db = new PGlite()
  await db.exec(`CREATE TABLE branches(id bigint PRIMARY KEY); INSERT INTO branches VALUES(3);
    CREATE TABLE sales(id uuid PRIMARY KEY,source text,status text,payment_method text,payment_status text,branch_id bigint,total numeric,customer_name text,customer_mobile text,customer_email text,shipping_address jsonb);
    CREATE TABLE products(id bigint PRIMARY KEY,name text); INSERT INTO products VALUES(1,'Test shirt');
    CREATE TABLE sale_items(sale_id uuid,product_id bigint,variant_id bigint,qty int,price numeric);
    CREATE TABLE shiprocket_warehouses(branch_id bigint PRIMARY KEY,name text,pincode text);
    INSERT INTO shiprocket_warehouses VALUES(3,'home','532001');
    CREATE TABLE shipments(id uuid PRIMARY KEY,sale_id uuid,branch_id bigint,shiprocket_order_id text,shiprocket_shipment_id text,awb text,status text,raw_status text,awb_assigned_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());`)
  await db.exec(fs.readFileSync(path.join(__dirname, '../migrations/20260923_order_shipping.sql'), 'utf8'))
})
after(async () => { await db.close() })
test('connect creates exactly once; retries do not touch inventory; COD total matches saved sale', async () => {
  const id = await sale(); const n = creates
  const s = await flow.connect(id, { fresh: true })
  assert.equal(s.shipment.shiprocket_shipment_id, '901')
  assert.equal(lastOrder.order.shipping_charges, 75)
  assert.equal(lastOrder.order.total_discount, 0)
  await flow.connect(id)
  assert.equal(creates, n + 1)
  await db.query('DELETE FROM shipments WHERE sale_id=$1', [id])
})
test('missing pickup mapping records a visible error without a remote create', async () => {
  const id = await sale(); const n = creates
  await db.query('DELETE FROM shiprocket_warehouses WHERE branch_id=3')
  await assert.rejects(flow.connect(id, { fresh: true }), /pickup location/)
  assert.match((await flow.state(id)).workflow.last_error, /pickup location/)
  assert.equal(creates, n)
  await db.query("INSERT INTO shiprocket_warehouses VALUES(3,'home','532001')")
})
test('a remote timeout blocks subsequent creation, even after reconnect', async () => {
  const id = await sale(); mode = 'timeout'; const n = creates
  await assert.rejects(flow.connect(id, { fresh: true }), /Timed out/)
  mode = ''
  await assert.rejects(flow.connect(id), /previous creation request/)
  assert.equal(creates, n + 1)
})
test('historical orders cannot bypass reconciliation by clicking twice', async () => {
  const id = await sale(); const n = creates
  await assert.rejects(flow.connect(id), /existing order/)
  await assert.rejects(flow.connect(id), /existing order/)
  assert.equal(creates, n)
})
test('linking validates channel order ID and recovers without creating', async () => {
  const id = await sale(); const n = creates
  remoteSale = 'unrelated-order'
  await assert.rejects(flow.connect(id, { remote_order_id: 900 }), /does not match/)
  remoteSale = id
  const result = await flow.connect(id, { remote_order_id: 900 })
  assert.equal(result.shipment.shiprocket_order_id, '900')
  assert.equal(creates, n)
  await db.query('DELETE FROM shipments WHERE sale_id=$1', [id])
})
test('AWB and pickup are idempotent; wallet rejection is visible and retryable', async () => {
  const id = await sale(); await flow.connect(id, { fresh: true })
  mode = 'wallet'
  await assert.rejects(flow.assignAwb(id, 12), /Recharge wallet/)
  assert.equal((await flow.state(id)).workflow.awb_attempted, false)
  mode = ''; const n = awbs
  await flow.assignAwb(id, 12)
  await flow.assignAwb(id, 12)
  assert.equal(awbs, n + 1)
  const p = pickups
  await flow.pickup(id); await flow.pickup(id)
  assert.equal(pickups, p + 1)
  assert.equal((await flow.state(id)).shipment.status, 'CONFIRMED')
  await db.query('DELETE FROM shipments WHERE sale_id=$1', [id])
})
test('an uncertain AWB request is not charged twice and can reconcile later', async () => {
  const id = await sale(); await flow.connect(id, { fresh: true })
  mode = 'awb-timeout'; const n = awbs
  await assert.rejects(flow.assignAwb(id, 12), /timed out/)
  mode = ''
  await assert.rejects(flow.assignAwb(id, 12), /awaiting reconciliation/)
  assert.equal(awbs, n + 1)
  remoteAwb = 'LATER123'
  assert.equal((await flow.assignAwb(id)).shipment.awb, 'LATER123')
  await db.query('DELETE FROM shipments WHERE sale_id=$1', [id])
})
test('cancelled and unpaid orders cannot be shipped', async () => {
  const id = await sale(); const n = creates
  await db.query("UPDATE sales SET status='CANCELLED' WHERE id=$1", [id])
  await assert.rejects(flow.connect(id, { fresh: true }), /closed or cancelled/)
  await db.query("UPDATE sales SET status='PLACED',payment_method='RAZORPAY',payment_status='PENDING' WHERE id=$1", [id])
  await assert.rejects(flow.connect(id, { fresh: true }), /Payment must be confirmed/)
  assert.equal(creates, n)
})
test('concurrent shipping actions acquire only one order lock', async () => {
  const id = await sale(); const n = creates
  const results = await Promise.allSettled([flow.connect(id, { fresh: true }), flow.connect(id, { fresh: true })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(creates, n + 1)
  assert.equal(locks.size, 0)
  await db.query('DELETE FROM shipments WHERE sale_id=$1', [id])
})
test('out-for-delivery, failed delivery, pickup and RTO cannot become delivered', () => {
  assert.equal(normalizeOrderStatus('OUT FOR DELIVERY'), 'SHIPPED')
  assert.equal(normalizeOrderStatus('UNDELIVERED'), 'SHIPPED')
  assert.equal(normalizeOrderStatus('PICKUP SCHEDULED'), 'PACKED')
  assert.equal(normalizeOrderStatus('RTO DELIVERED'), 'RTO')
  assert.equal(normalizeOrderStatus('DELIVERED'), 'DELIVERED')
})
