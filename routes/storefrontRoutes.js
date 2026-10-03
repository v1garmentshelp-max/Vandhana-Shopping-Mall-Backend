const router = require('express').Router();
const pool = require('../db');
const {
  requireCustomerAuth
} = require('../middleware/customerAuth');
const {
  requireAuth
} = require('../middleware/auth');
const cancellations = require('../services/orderCancellation');
const refunds = require('../services/storeRefunds');
const {
  policy,
  error
} = require('../services/commercePolicy');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.get('/policy', (_req, res) => res.json(policy()));
router.use((_req, res, next) => {
  if (!process.env.JWT_SECRET || ['dev_secret', 'change-me-in-env'].includes(process.env.JWT_SECRET)) return res.status(503).json({
    message: 'Store authentication needs configuration.'
  });
  next();
});
router.use('/admin', requireAuth, (req, res, next) => {
  if (!['SUPER_ADMIN', 'BRANCH_ADMIN'].includes(String(req.user?.role_enum || req.user?.role)) && !/^BRANCH\d+$/.test(String(req.user?.role_enum || req.user?.role))) return res.status(403).json({
    message: 'Staff access required.'
  });
  next();
});
router.get('/admin/cancellations', wrap(async (req, res) => {
  const branch = String(req.user.role_enum || req.user.role) === 'SUPER_ADMIN' ? null : Number(req.user.branch_id || 0);
  const rows = await pool.query(`SELECT c.*,s.branch_id,s.customer_name,s.customer_email,s.payment_method,s.status AS order_status
    FROM storefront_cancellations c JOIN sales s ON s.id=c.sale_id
    WHERE ($1::bigint IS NULL OR s.branch_id=$1) ORDER BY c.created_at DESC LIMIT 200`, [branch]);
  res.json(rows.rows);
}));
router.post('/admin/cancellations/:id/process', wrap(async (req, res) => res.json(await cancellations.processCancellation(req.user, req.params.id))));
router.post('/admin/cancellations/:id/reject', wrap(async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  if (reason.length < 5) throw error('Enter the reason for rejecting this request.', 400);
  await cancellations.locked(req.params.id, async db => cancellations.transaction(db, async () => {
    const s = await cancellations.state(db, req.params.id);
    cancellations.staffAccess(req.user, s.sale);
    if (!s.request || !['REQUESTED', 'REVIEW_REQUIRED'].includes(s.request.status) || s.request.carrier_attempted) throw error('A carrier cancellation or completed request cannot be rejected here. Reconcile it first.');
    await db.query("UPDATE storefront_cancellations SET status='REJECTED',last_error=$2,processed_by=$3,updated_at=now() WHERE sale_id=$1", [req.params.id, reason, req.user.id]);
  }));
  res.json({
    message: 'Cancellation rejected. The recorded reason is visible to the customer.'
  });
}));
router.post('/admin/cancellations/:id/refund-complete', wrap(async (req, res) => res.json(await refunds.completeCancellation(req.user, req.params.id, req.body))));
router.use(requireCustomerAuth);
router.use(wrap(async (req, _res, next) => {
  const user = (await pool.query('SELECT id,name,email,mobile,type FROM vandana_users WHERE id=$1', [req.customer.id])).rows[0];
  if (!user || String(user.type).toUpperCase() !== 'B2C') throw error('A retail customer account is required.', 403);
  req.customer = {
    ...user,
    id: Number(user.id)
  };
  next();
}));
const owner = wrap(async (req, _res, next) => {
  const row = (await pool.query(`SELECT s.id FROM sales s WHERE s.id=$1 AND s.source='WEB'
    AND (lower(s.login_email)=lower($2) OR lower(s.customer_email)=lower($2))`, [req.params.id, req.customer.email])).rows[0];
  if (!row) throw error('Order not found.', 404);
  next();
});
router.get('/orders/:id/cancellation', owner, wrap(async (req, res) => res.json(await cancellations.eligibility(req.params.id))));
router.post('/orders/:id/cancel', owner, wrap(async (req, res) => res.status(202).json(await cancellations.requestCancellation(req.customer, req.params.id, req.body))));
router.use((req, _res, next) => {
  if (req.method === 'POST' && ['/checkout/quote', '/checkouts'].includes(req.path)) req.body.quote_version = 2;
  next();
});
router.use(require('./mobileRoutes'));
router.use((err, _req, res, _next) => {
  const status = Number(err.status || 500);
  if (status >= 500) console.error('[storefront]', err.message);
  res.status(status).json({
    message: status >= 500 && !err.status ? 'The store could not complete this request. Please try again.' : err.message,
    code: err.code
  });
});
module.exports = router;
