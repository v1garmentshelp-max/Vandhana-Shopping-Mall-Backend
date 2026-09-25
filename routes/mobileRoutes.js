const express = require('express');
const crypto = require('node:crypto');
const pool = require('../db');
const {
  requireCustomerAuth
} = require('../middleware/customerAuth');
const {
  requireAuth
} = require('../middleware/auth');
const {
  writeStockCart
} = require('../services/cartStockService');
const checkout = require('../services/mobileCheckout');
const {
  createWorkflow
} = require('../services/orderShippingWorkflow');
const {
  integer,
  fail
} = require('../services/mobileRules');
const router = express.Router();
router.use(require('./mobileStoreRoutes'));
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function forward(target, url, method, body, query) {
  return (req, res, next) => {
    req.url = typeof url === 'function' ? url(req) : url;
    req.method = method || req.method;
    if (body) req.body = body(req);
    if (query) req.query = query(req);
    return target(req, res, next);
  };
}
router.get('/config', (_req, res) => res.json({
  version: 1,
  branch_id: checkout.branch(),
  ...checkout.settings(),
  otp: 'email-password-reset',
  checkout: true
}));
router.get('/products/:id(\\d+)', forward(require('./productRoutes'), req => `/by-product/${req.params.id}`, 'GET', null, req => ({
  branch_id: checkout.branch(),
  group_by: 'design',
  include_out_of_stock: 'true'
})));
router.use((req, res, next) => {
  if (!process.env.JWT_SECRET || ['change-me-in-env', 'dev_secret'].includes(process.env.JWT_SECRET)) return res.status(503).json({
    message: 'The store must configure authentication.'
  });
  next();
});
router.get('/admin/account-requests', requireAuth, wrap(async (req, res) => {
  const role = String(req.user?.role_enum || req.user?.role || '');
  if (role !== 'SUPER_ADMIN') throw fail('Forbidden', 403);
  const result = await pool.query(`SELECT r.id,r.user_id,r.type,r.status,r.created_at,u.name,u.email
    FROM mobile_account_requests r JOIN vandana_users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 200`);
  res.json(result.rows);
}));
router.use(requireCustomerAuth);
router.use(wrap(async (req, _res, next) => {
  const q = await pool.query('SELECT id,name,email,mobile,type FROM vandana_users WHERE id=$1', [req.customer.id]);
  if (!q.rowCount || String(q.rows[0].type).toUpperCase() !== 'B2C') throw fail('A customer account is required.', 403);
  req.customer = {
    ...q.rows[0],
    id: Number(q.rows[0].id)
  };
  next();
}));
router.get('/cart', forward(require('./cartRoutes'), req => `/${req.customer.id}`, 'GET', null, () => ({
  branch_id: checkout.branch()
})));
router.post('/cart', wrap(async (req, res) => {
  const row = await writeStockCart({
    userId: req.customer.id,
    variantId: integer(req.body.variant_id, 1, Number.MAX_SAFE_INTEGER),
    quantity: integer(req.body.quantity || 1),
    branchId: checkout.branch(),
    size: '',
    color: '',
    add: true
  });
  res.status(201).json(row);
}));
router.patch('/cart/:id(\\d+)', wrap(async (req, res) => {
  const custom = await pool.query('UPDATE vandana_cart SET quantity=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND is_custom=true RETURNING id,quantity', [req.params.id, req.customer.id, integer(req.body.quantity, 1, 20)]);
  if (custom.rowCount) return res.json(custom.rows[0]);
  const row = await writeStockCart({
    userId: req.customer.id,
    cartItemId: Number(req.params.id),
    quantity: integer(req.body.quantity),
    branchId: checkout.branch(),
    size: '',
    color: '',
    add: false
  });
  res.json(row);
}));
router.delete('/cart/:id(\\d+)', wrap(async (req, res) => {
  await pool.query('DELETE FROM vandana_cart WHERE id=$1 AND user_id=$2', [req.params.id, req.customer.id]);
  res.json({
    ok: true
  });
}));
router.get('/wishlist', forward(require('./wishlistRoutes'), req => `/${req.customer.id}`, 'GET'));
router.post('/wishlist', forward(require('./wishlistRoutes'), '/', 'POST', req => ({
  user_id: req.customer.id,
  variant_id: req.body.variant_id
})));
router.delete('/wishlist', forward(require('./wishlistRoutes'), '/', 'DELETE', req => ({
  user_id: req.customer.id,
  variant_id: req.body.variant_id
})));
router.patch('/profile', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const mobile = String(req.body.mobile || '').trim();
  if (name.length < 2 || !/^[6-9]\d{9}$/.test(mobile)) throw fail('Enter a valid name and 10 digit Indian mobile number.');
  const q = await pool.query('UPDATE vandana_users SET name=$2,mobile=$3,updated_at=now() WHERE id=$1 RETURNING id,name,email,mobile,type', [req.customer.id, name, mobile]);
  res.json(q.rows[0]);
}));
router.post('/account-deletion-request', wrap(async (req, res) => {
  await pool.query(`INSERT INTO mobile_account_requests(id,user_id,type) VALUES($1,$2,'DELETE_ACCOUNT') ON CONFLICT DO NOTHING`, [crypto.randomUUID(), req.customer.id]);
  res.json({
    status: 'REQUESTED',
    message: 'Your account deletion request has been recorded for the store to process.'
  });
}));
router.get('/orders', wrap(async (req, res) => {
  const rows = await pool.query(`SELECT s.id,s.status,s.payment_status,s.payment_method,s.created_at,s.total,s.totals,s.customer_name,
    m.request_key AS checkout_key FROM sales s LEFT JOIN mobile_checkouts m ON m.sale_id=s.id
    WHERE s.source='WEB' AND (lower(s.login_email)=lower($1) OR lower(s.customer_email)=lower($1)) ORDER BY s.created_at DESC LIMIT 200`, [req.customer.email]);
  res.json(rows.rows);
}));
async function ownedSale(req, _res, next) {
  const q = await pool.query(`SELECT s.* FROM sales s WHERE s.id=$1 AND s.source='WEB'
    AND (lower(s.login_email)=lower($2) OR lower(s.customer_email)=lower($2))`, [req.params.id, req.customer.email]);
  if (!q.rowCount) throw fail('Order not found.', 404);
  req.sale = q.rows[0];
  next();
}
router.get('/orders/:id', wrap(ownedSale), wrap(async (req, res) => {
  const [items, shipments, mobile] = await Promise.all([pool.query('SELECT si.*,COALESCE(si.custom_title,p.name) AS product_name FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1', [req.sale.id]), pool.query('SELECT status,awb,created_at FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC', [req.sale.id]), pool.query('SELECT request_key FROM mobile_checkouts WHERE sale_id=$1 AND user_id=$2', [req.sale.id, req.customer.id])]);
  res.json({
    ...req.sale,
    items: items.rows,
    shipments: shipments.rows,
    checkout_key: mobile.rows[0]?.request_key
  });
}));
const returns = require('../services/returnPolicy');
router.get('/orders/:id/return-eligibility', wrap(ownedSale), wrap(async (req, res) => res.json(await returns.eligibility(pool, req.sale.id))));
router.get('/orders/:id/tracking', wrap(ownedSale), wrap(async (req, res) => res.json(await createWorkflow(pool).tracking(req.sale.id))));
router.post('/orders/:id/return', wrap(ownedSale), wrap(async (req, res) => res.json(await returns.createReturn(pool, req.sale.id, req.body))));
router.get('/orders/:id/returns', wrap(ownedSale), wrap(async (req, res) => res.json((await pool.query(`SELECT r.id,r.type,r.reason,r.status,r.refund_status,r.created_at,
  (SELECT json_agg(json_build_object('sale_item_id',i.sale_item_id,'qty',i.qty)) FROM return_items i WHERE i.request_id=r.id) AS items
  FROM return_requests r WHERE r.sale_id=$1 ORDER BY r.created_at DESC`, [req.sale.id])).rows)));
router.post('/checkout/quote', wrap(async (req, res) => res.json(await checkout.quote(pool, req.customer.id, req.body.reward_points))));
router.post('/checkouts', wrap(async (req, res) => res.json(await checkout.create(req.customer, req.body))));
router.post('/checkouts/:key/pay', wrap(async (req, res) => res.json(await checkout.paymentOrder(req.customer, req.params.key))));
router.post('/checkouts/:key/verify', wrap(async (req, res) => res.json(await checkout.verify(req.customer, req.params.key, req.body))));
router.post('/checkouts/:key/reconcile', wrap(async (req, res) => res.json(await checkout.reconcile(req.customer, req.params.key))));
router.use((error, _req, res, _next) => {
  const status = Number(error.status || 500);
  if (status >= 500) console.error('[mobile-api]', error.message);
  res.status(status).json({
    message: status >= 500 && !error.status ? 'The store could not complete this request. Please try again.' : error.message,
    ...(error.code ? {
      code: error.code
    } : {}),
    ...(error.checkout_not_created ? {
      checkout_not_created: true
    } : {})
  });
});
module.exports = router;
