const crypto = require('node:crypto')
const pool = require('../db')
const checkout = require('../services/mobileCheckout')
module.exports = async function mobileWebhook(req, res) {
  const signature = String(req.headers['x-razorpay-signature'] || '')
  const secret = process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET
  if (!secret) return res.status(503).json({ message: 'Payment webhook is not configured.' })
  if (!Buffer.isBuffer(req.body) || !/^[a-f0-9]{64}$/i.test(signature)) return res.sendStatus(400)
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest()
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return res.sendStatus(400)
  let event
  try { event = JSON.parse(req.body.toString('utf8')) } catch { return res.sendStatus(400) }
  if (!event || typeof event !== 'object') return res.sendStatus(400)
  try {
    if (['refund.created','refund.processed','refund.failed'].includes(event.event)) {
      await require('../services/refundOperations').processWebhook(event.payload?.refund?.entity)
      return res.json({ ok: true })
    }
    if (!['payment.captured', 'order.paid'].includes(event.event)) return res.json({ ok: true })
    const payment = event.payload?.payment?.entity
    if (!payment?.id || !payment.order_id) return res.sendStatus(400)
    const q = await pool.query('SELECT request_key,user_id FROM mobile_checkouts WHERE gateway_order_id=$1', [payment.order_id])
    if (!q.rowCount) return res.json({ ok: true })
    await checkout.complete(Number(q.rows[0].user_id), q.rows[0].request_key, payment, { connectShipping: false })
    return res.json({ ok: true })
  } catch (e) { console.error('[mobile-webhook]', e.message); return res.sendStatus(e.status === 400 ? 400 : 500) }
}
