const crypto = require('node:crypto');
const pool = require('../db');
const checkout = require('../services/mobileCheckout');
module.exports = async function mobileWebhook(req, res) {
  const signature = String(req.headers['x-razorpay-signature'] || '');
  const secret = process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !Buffer.isBuffer(req.body) || !/^[a-f0-9]{64}$/i.test(signature)) return res.sendStatus(400);
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return res.sendStatus(400);
  try {
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event !== 'payment.captured') return res.json({
      ok: true
    });
    const payment = event.payload?.payment?.entity;
    if (!payment?.order_id) return res.sendStatus(400);
    const q = await pool.query('SELECT request_key,user_id FROM mobile_checkouts WHERE gateway_order_id=$1', [payment.order_id]);
    if (!q.rowCount) return res.json({
      ok: true
    });
    await checkout.complete(Number(q.rows[0].user_id), q.rows[0].request_key, payment);
    return res.json({
      ok: true
    });
  } catch (e) {
    console.error('[mobile-webhook]', e.message);
    return res.sendStatus(500);
  }
};
