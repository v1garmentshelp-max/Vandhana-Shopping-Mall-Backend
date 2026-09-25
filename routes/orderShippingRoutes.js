const router = require('express').Router();
const pool = require('../db');
const {
  requireAuth
} = require('../middleware/auth');
const Shiprocket = require('../services/shiprocketService');
const {
  createWorkflow
} = require('../services/orderShippingWorkflow');
const workflow = createWorkflow(pool);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.use(requireAuth);
router.use('/:id', async (req, res, next) => {
  try {
    const role = String(req.user.role || req.user.role_enum || '').toUpperCase();
    if (role !== 'SUPER_ADMIN' && !/^BRANCH\d+$/.test(role)) return res.status(403).json({
      message: 'Admin access required'
    });
    if (!uuidPattern.test(req.params.id)) return res.status(400).json({
      message: 'Invalid order ID'
    });
    const sale = (await pool.query('SELECT id,branch_id FROM sales WHERE id=$1', [req.params.id])).rows[0];
    if (!sale) return res.status(404).json({
      message: 'Order not found'
    });
    if (role !== 'SUPER_ADMIN' && String(req.user.branch_id) !== String(sale.branch_id)) return res.status(403).json({
      message: 'This order belongs to another branch'
    });
    req.shippingSale = sale;
    next();
  } catch (e) {
    next(e);
  }
});
const run = fn => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    const message = e.code === '42P01' ? 'Shipping setup is incomplete. Run migration 20260923_order_shipping.sql on the backend database.' : e.message || 'Shipping action failed';
    res.status(e.status >= 400 && e.status <= 599 ? e.status : 502).json({
      message
    });
  }
};
router.get('/:id', run(req => workflow.state(req.params.id)));
router.post('/:id/connect', run(req => workflow.connect(req.params.id, {
  remote_order_id: req.body.remote_order_id,
  confirmed_absent: req.body.confirmed_absent === true
})));
router.get('/:id/tracking', run(req => workflow.tracking(req.params.id)));
router.get('/:id/couriers', run(req => workflow.couriers(req.params.id)));
router.post('/:id/awb', run(req => workflow.assignAwb(req.params.id, req.body.courier_id)));
router.post('/:id/pickup', run(req => workflow.pickup(req.params.id)));
router.post('/:id/documents/:type', run(req => workflow.document(req.params.id, req.params.type)));
router.get('/:id/pickups', run(async () => {
  const {
    data
  } = await new Shiprocket({
    pool
  }).api('get', '/settings/company/pickup');
  return {
    pickups: data?.data?.shipping_address || []
  };
}));
router.post('/:id/warehouse', run(async req => {
  if ((await workflow.state(req.params.id)).shipment) throw Object.assign(new Error('A shipment already exists. Change its pickup location in Shiprocket, then reconcile it.'), {
    status: 409
  });
  const {
    data
  } = await new Shiprocket({
    pool
  }).api('get', '/settings/company/pickup');
  const pickup = data?.data?.shipping_address?.find(p => String(p.id || p.pickup_id) === String(req.body.pickup_id));
  if (!pickup?.pickup_location || !/^\d{6}$/.test(String(pickup.pin_code || ''))) throw Object.assign(new Error('Select a valid existing Shiprocket pickup location.'), {
    status: 422
  });
  await pool.query(`INSERT INTO shiprocket_warehouses(branch_id,warehouse_id,name,pincode,city,state,address,phone)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(branch_id) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id,name=EXCLUDED.name,pincode=EXCLUDED.pincode,city=EXCLUDED.city,state=EXCLUDED.state,address=EXCLUDED.address,phone=EXCLUDED.phone`, [req.shippingSale.branch_id, pickup.id || pickup.pickup_id, pickup.pickup_location, pickup.pin_code, pickup.city, pickup.state, pickup.address, pickup.phone || '']);
  return workflow.state(req.params.id);
}));
module.exports = router;
