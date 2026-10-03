const { requireAuth } = require('./auth');
const { branchScope } = require('../services/orderManagement');
const pool = require('../db');

function requireOrderStaff(req, res, next) {
  if (!process.env.JWT_SECRET || ['dev_secret','change-me-in-env'].includes(process.env.JWT_SECRET)) return res.status(503).json({ message: 'Store authentication is unavailable.' });
  return requireAuth(req, res, () => {
    try { branchScope(req.user); next(); }
    catch (e) { res.status(e.status || 403).json({ message: e.message }); }
  });
}
function requireOrderBranch(parameter) {
  return async (req, res, next) => {
    try {
      const id = req.params[parameter];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) return res.status(400).json({ message: 'Invalid order ID.' });
      const sale = (await pool.query('SELECT branch_id FROM sales WHERE id=$1', [id])).rows[0];
      if (!sale) return res.status(404).json({ message: 'Order not found.' });
      const branch = branchScope(req.user);
      if (branch !== null && Number(sale.branch_id) !== branch) return res.status(403).json({ message: 'This order belongs to another branch.' });
      next();
    } catch (e) { next(e); }
  };
}
module.exports = { requireOrderStaff, requireOrderBranch };
