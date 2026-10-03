const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const management = require('../services/orderManagement');
const operations = require('../services/refundOperations');
const refunds = require('../services/storeRefunds');
const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next);
router.use((req,res,next) => {
  if (!process.env.JWT_SECRET || ['dev_secret','change-me-in-env'].includes(process.env.JWT_SECRET)) return res.status(503).json({message:'Staff authentication needs configuration.'});
  requireAuth(req,res,next);
});
router.use((req,res,next) => {
  try { management.branchScope(req.user); next(); } catch(e) { next(e); }
});
router.get('/summary',wrap(async(req,res)=>res.json(await management.summary(req.user,req.query))));
router.get('/orders',wrap(async(req,res)=>res.json(await management.list(req.user,req.query))));
router.get('/orders/:id',wrap(async(req,res)=>res.json(await management.detail(req.user,req.params.id))));
router.post('/returns/:id/receive',wrap(async(req,res)=>res.json(await refunds.receiveReturn(req.user,req.params.id,req.body))));
router.post('/refunds/:kind/:id/initiate',wrap(async(req,res)=>res.json(await operations.initiate(req.user,req.params.kind,req.params.id,req.body))));
router.post('/refunds/:kind/:id/reconcile',wrap(async(req,res)=>res.json(await operations.reconcile(req.user,req.params.kind,req.params.id))));
router.use((err,_req,res,_next)=>res.status(err.status || 500).json({message:err.status ? err.message : 'Order management could not complete this request. Please retry.',code:err.code}));
module.exports=router;
