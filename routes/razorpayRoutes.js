const express = require('express');
const pool = require('../db');
const RazorpayService = require('../services/razorpayService');
const {
  releaseRewardsForSaleWithTransaction
} = require('../services/rewardPointsService');
const router = express.Router();
router.use('/payments', async (req, res, next) => {
  try {
    if (req.method === 'POST' && !req.path.includes('webhook')) {
      const sale = req.body?.sale_id,
        gateway = req.body?.razorpay_order_id;
      if (sale || gateway) {
        const managed = await pool.query('SELECT sale_id FROM mobile_checkouts WHERE sale_id::text=$1 OR gateway_order_id=$2', [sale || null, gateway || null]);
        if (managed.rowCount) return res.status(409).json({
          message: 'Resume this payment from your saved order. This checkout uses verified payment processing.'
        });
      }
    }
    next();
  } catch (e) {
    res.status(500).json({
      message: 'Payment could not be checked. Please try again.'
    });
  }
});
function payableFromTotals(t) {
  if (!t) return null;
  if (typeof t === 'object' && t.payable != null) {
    return Number(t.payable);
  }
  try {
    const o = typeof t === 'string' ? JSON.parse(t) : t;
    if (o && o.payable != null) {
      return Number(o.payable);
    }
  } catch {}
  return null;
}
async function markSaleFailedAndReleaseRewards(saleId) {
  const q = await pool.query(`UPDATE sales
       SET
         payment_status = 'FAILED',
         updated_at = now()
       WHERE id = $1::uuid
         AND payment_status <> 'PAID'
       RETURNING id`, [saleId]);
  if (q.rowCount) {
    await releaseRewardsForSaleWithTransaction(saleId);
    return true;
  }
  return false;
}
router.post('/payments/create-order', async (req, res) => {
  try {
    const saleId = String(req.body.sale_id || '').trim();
    if (!saleId) {
      return res.status(400).json({
        message: 'sale_id required'
      });
    }
    const s = await pool.query(`SELECT
             id,
             total,
             totals,
             customer_email,
             customer_mobile,
             payment_status
           FROM sales
           WHERE id = $1::uuid`, [saleId]);
    if (!s.rowCount) {
      return res.status(404).json({
        message: 'Sale not found'
      });
    }
    const sale = s.rows[0];
    const amount = payableFromTotals(sale.totals) ?? Number(sale.total || 0);
    if (!Number.isFinite(amount) || !Number.isSafeInteger(Math.round(amount * 100)) || Math.round(amount * 100) < 100) {
      return res.status(400).json({
        message: 'Payment amount must be at least 100 paise'
      });
    }
    if (String(sale.payment_status).toUpperCase() === 'PAID') {
      return res.json({
        ok: true,
        fully_paid: true,
        sale_id: saleId,
        amount: Math.round(amount * 100),
        currency: 'INR'
      });
    }
    const currentPay = String(sale.payment_status || '').toUpperCase();
    if (currentPay !== 'PAID') {
      await pool.query(`UPDATE sales
           SET
             payment_status = 'PENDING',
             payment_method = 'ONLINE',
             updated_at = now()
           WHERE id = $1::uuid`, [saleId]);
    }
    const svc = new RazorpayService({});
    const order = await svc.createOrder({
      amountPaise: Math.round(Number(amount) * 100),
      currency: 'INR',
      receipt: saleId,
      notes: {
        sale_id: saleId
      }
    });
    await pool.query(`INSERT INTO payments
         (
           sale_id,
           razorpay_order_id,
           status,
           amount_paise,
           currency,
           email,
           phone,
           notes
         )
         VALUES
         (
           $1,
           $2,
           $3,
           $4,
           $5,
           $6,
           $7,
           $8
         )
         ON CONFLICT
           (razorpay_order_id)
         DO NOTHING`, [saleId, order.id, order.status || 'created', order.amount, order.currency, sale.customer_email || null, sale.customer_mobile || null, JSON.stringify(order.notes || {})]);
    return res.json({
      key_id: process.env.RAZORPAY_KEY_ID,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      sale_id: saleId
    });
  } catch (e) {
    return res.status(e.status || 500).json({
      message: e.status ? e.message : 'Payment could not be created. Please try again.',
      ...(e.code ? { code: e.code } : {})
    });
  }
});
router.post('/payments/verify', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body || {};
    if ([razorpay_order_id, razorpay_payment_id, razorpay_signature].some(value => typeof value !== 'string' || !value)) {
      return res.status(400).json({
        message: 'razorpay_order_id, razorpay_payment_id, razorpay_signature required'
      });
    }
    const existing = await pool.query('SELECT sale_id,razorpay_order_id,amount_paise,currency FROM payments WHERE razorpay_order_id=$1', [razorpay_order_id]);
    if (!existing.rowCount) return res.status(404).json({ message: 'Payment order not found' });
    const payment = existing.rows[0];
    const svc = new RazorpayService({});
    const ok = svc.verifyPaymentSignature({
      orderId: payment.razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature
    });
    if (!ok) return res.status(400).json({ ok: false, message: 'Payment signature verification failed' });
    const { data: captured } = await svc.client.get(`/payments/${encodeURIComponent(razorpay_payment_id)}`);
    if (captured?.id !== razorpay_payment_id || captured.order_id !== payment.razorpay_order_id || captured.status !== 'captured' || Number(captured.amount) !== Number(payment.amount_paise) || captured.currency !== payment.currency) return res.status(409).json({ ok: false, message: 'Payment capture is pending or does not match this order' });
    const p = await pool.query(`UPDATE payments
           SET
             razorpay_payment_id = $2,
             razorpay_signature = $3,
             status = CASE WHEN status IN ('REFUNDED','PARTIALLY_REFUNDED') THEN status ELSE 'PAID' END
           WHERE razorpay_order_id = $1
           RETURNING sale_id`, [razorpay_order_id, razorpay_payment_id, razorpay_signature]);
    if (p.rowCount) {
      const saleId = p.rows[0].sale_id;
        await pool.query(`UPDATE sales
             SET
               payment_status = CASE WHEN payment_status IN ('REFUNDED','PARTIALLY_REFUNDED') THEN payment_status ELSE 'PAID' END,
               updated_at = now()
             WHERE id = $1::uuid`, [saleId]);
    }
    return res.json({
      ok,
      status: 'PAID'
    });
  } catch (e) {
    return res.status(e.status || 500).json({
      message: e.status ? e.message : 'Payment verification could not be completed. Check your saved order.',
      ...(e.code ? { code: e.code } : {})
    });
  }
});
router.post('/payments/mark-failed', async (req, res) => {
  try {
    const saleId = String(req.body.sale_id || '').trim();
    if (!saleId) {
      return res.status(400).json({
        message: 'sale_id required'
      });
    }
    const existing = await pool.query(`SELECT
             id,
             payment_status
           FROM sales
           WHERE id = $1::uuid
           LIMIT 1`, [saleId]);
    if (!existing.rowCount) {
      return res.status(404).json({
        message: 'Sale not found'
      });
    }
    const currentStatus = String(existing.rows[0].payment_status || '').toUpperCase();
    if (currentStatus === 'PAID') {
      return res.status(409).json({
        message: 'Paid sale cannot be marked failed'
      });
    }
    await markSaleFailedAndReleaseRewards(saleId);
    return res.json({
      id: saleId,
      payment_status: 'FAILED'
    });
  } catch (e) {
    return res.status(500).json({
      message: e.message || 'failed'
    });
  }
});
router.get('/payments/by-sale/:id', async (req, res) => {
  try {
    const saleId = String(req.params.id || '').trim();
    if (!saleId) {
      return res.status(400).json({
        message: 'id required'
      });
    }
    const q = await pool.query(`SELECT *
           FROM payments
           WHERE sale_id = $1::uuid
           ORDER BY created_at DESC`, [saleId]);
    return res.json(q.rows);
  } catch (e) {
    return res.status(500).json({
      message: e.message || 'list failed'
    });
  }
});
router.post('/razorpay/webhook', express.raw({
  type: 'application/json'
}), async (req, res) => {
  try {
    const sig = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.sendStatus(503);
    const bodyRaw = Buffer.isBuffer(req.rawBody) ? req.rawBody : req.body;
    if (!Buffer.isBuffer(bodyRaw)) return res.sendStatus(400);
    const svc = new RazorpayService({});
    const ok = svc.verifyWebhookSignature({
      bodyRaw,
      signature: sig,
      secret
    });
    if (!ok) {
      return res.status(400).json({
        message: 'invalid signature'
      });
    }
    const payload = JSON.parse(bodyRaw);
    const managedPayment = payload?.payload?.payment?.entity;
    if (managedPayment?.order_id) {
      const managed = (await pool.query('SELECT request_key,user_id FROM mobile_checkouts WHERE gateway_order_id=$1', [managedPayment.order_id])).rows[0];
      if (managed) {
        if (['payment.captured', 'order.paid'].includes(payload.event)) await require('../services/mobileCheckout').complete(Number(managed.user_id), managed.request_key, managedPayment, { connectShipping: false });
        return res.json({ ok: true });
      }
    }
    if (['refund.created', 'refund.processed', 'refund.failed'].includes(payload.event)) {
      await require('../services/refundOperations').processWebhook(payload.payload?.refund?.entity);
      return res.json({ ok: true });
    }
    if (!['payment.captured', 'order.paid'].includes(payload.event)) return res.json({ ok: true });
    const paymentEntity = payload?.payload?.payment?.entity;
    if (!paymentEntity?.id || !paymentEntity.order_id) return res.sendStatus(400);
    const saved = (await pool.query('SELECT sale_id,amount_paise,currency FROM payments WHERE razorpay_order_id=$1', [paymentEntity.order_id])).rows[0];
    if (!saved) return res.json({ ok: true });
    if (paymentEntity.status !== 'captured' || Number(paymentEntity.amount) !== Number(saved.amount_paise) || paymentEntity.currency !== saved.currency) return res.sendStatus(400);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(`UPDATE payments SET razorpay_payment_id=$2,
        status=CASE WHEN status IN ('REFUNDED','PARTIALLY_REFUNDED') THEN status ELSE 'PAID' END,
        method=$3,email=COALESCE($4,email),phone=COALESCE($5,phone)
        WHERE razorpay_order_id=$1`, [paymentEntity.order_id, paymentEntity.id, paymentEntity.method || null, paymentEntity.email || null, paymentEntity.contact || null]);
      await db.query(`UPDATE sales SET payment_status=CASE WHEN payment_status IN ('REFUNDED','PARTIALLY_REFUNDED')
        THEN payment_status ELSE 'PAID' END,updated_at=now() WHERE id=$1`, [saved.sale_id]);
      const eventId = req.headers['x-razorpay-event-id'];
      if (eventId) await db.query(`INSERT INTO razorpay_webhook_events(event_id,event_type,payload)
        VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING`, [eventId, payload.event, JSON.stringify(payload)]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
    return res.json({
      ok: true
    });
  } catch (error) {
    return res.status(error instanceof SyntaxError || error.status === 400 ? 400 : 500).json({ ok: false });
  }
});
module.exports = router;
