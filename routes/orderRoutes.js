const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../db');
const {
  requireAuth
} = require('../middleware/auth');
const {
  getTracking
} = require('../controllers/orderController');
const Shiprocket = require('../services/shiprocketService');
const {
  bestOrderStatus,
  collectStatusValues,
  extractShipmentInfo,
  syncSaleStatus,
  syncShipmentByIdentifiers
} = require('../services/orderStatusSync');
const toNumber = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const uuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = b[6] & 0x0f | 0x40;
  b[8] = b[8] & 0x3f | 0x80;
  const s = b.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};
const {
  createWorkflow
} = require('../services/orderShippingWorkflow');
const shippingWorkflow = createWorkflow(pool);
router.post('/web/place', (_req, res) => res.status(410).json({
  message: 'Checkout has been updated. Refresh the website and review your order again.'
}));
router.get('/', requireAuth, async (req, res) => {
  try {
    require('../services/orderManagement').branchScope(req.user);
    const role = String(req.user?.role_enum || req.user?.role || '').toUpperCase();
    const isSuper = role === 'SUPER_ADMIN';
    const userBranchId = Number(req.user?.branch_id || 0);
    const requestedBranchIdRaw = String(req.query.branch_id || '').trim();
    const requestedBranchId = requestedBranchIdRaw ? Number(requestedBranchIdRaw) : null;
    const params = [];
    const where = [];
    if (isSuper) {
      if (requestedBranchId && Number.isFinite(requestedBranchId)) {
        params.push(requestedBranchId);
        where.push(`s.branch_id = $${params.length}`);
      }
    } else {
      if (!userBranchId) return res.status(403).json({
        message: 'Forbidden'
      });
      params.push(userBranchId);
      where.push(`s.branch_id = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const q = await pool.query(`SELECT
         s.id,
         s.source,
         s.status,
         s.payment_status,
         s.payment_method,
         s.payment_ref,
         s.created_at,
         s.total,
         s.totals,
         s.branch_id,
         s.customer_name,
         s.customer_email,
         s.customer_mobile,
         COALESCE(oc.payment_type::text,s.payment_method::text) AS cancellation_payment_type,
         COALESCE(c.reason,oc.reason) AS cancellation_reason,
         COALESCE(c.source,oc.cancellation_source) AS cancellation_source,
         COALESCE(c.created_at,oc.created_at) AS cancellation_created_at,
         c.status AS cancellation_status,
         c.refund_status,
         c.refund_amount_paise,
         c.refund_points,
         CASE WHEN c.status IN ('REQUESTED','REVIEW_REQUIRED') THEN 'CANCELLATION REQUESTED' ELSE s.status::text END AS display_status
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       LEFT JOIN storefront_cancellations c ON c.sale_id=s.id
       ${whereSql}
       ORDER BY s.created_at DESC NULLS LAST, s.id DESC
       LIMIT 500`, params);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return res.json(q.rows || []);
  } catch(e) {
    return res.status(e.status || 500).json({
      message: e.status?e.message:'Server error'
    });
  }
});
router.get('/track/:orderId/:channelId?', require('../middleware/orderStaffAuth').requireOrderStaff, require('../middleware/auth').requireSuperAdmin, getTracking);
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const result = await require('../services/orderCancellation').adminCancellation(req.user, req.body?.sale_id, req.body || {});
    res.json({
      ok: true,
      ...result
    });
  } catch (e) {
    res.status(e.status || 500).json({
      message: e.status ? e.message : 'Cancellation could not be completed. Please review the request.'
    });
  }
});
module.exports = router;
