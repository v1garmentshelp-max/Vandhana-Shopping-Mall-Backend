const express = require('express')
const pool = require('../db')
const RazorpayService = require('../services/razorpayService')

const router = express.Router()

function payableFromTotals(t) {
  if (!t) return null
  if (typeof t === 'object' && t.payable != null) return Number(t.payable)
  try {
    const o = typeof t === 'string' ? JSON.parse(t) : t
    if (o && o.payable != null) return Number(o.payable)
  } catch {}
  return null
}

router.post('/payments/create-order', async (req, res) => {
  try {
    const saleId = String(req.body.sale_id || '').trim()
    if (!saleId) return res.status(400).json({ message: 'sale_id required' })

    const s = await pool.query(
      `SELECT id, total, totals, customer_email, customer_mobile, payment_status FROM sales WHERE id=$1::uuid`,
      [saleId]
    )
    if (!s.rowCount) return res.status(404).json({ message: 'Sale not found' })

    const sale = s.rows[0]
    const amount = payableFromTotals(sale.totals) ?? Number(sale.total || 0)
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Invalid amount' })

    const currentPay = String(sale.payment_status || '').toUpperCase()
    if (currentPay !== 'PAID') {
      await pool.query(`UPDATE sales SET payment_status='PENDING', payment_method='ONLINE', updated_at=now() WHERE id=$1::uuid`, [saleId])
    }

    const svc = new RazorpayService({})
    const order = await svc.createOrder({
      amountPaise: Math.round(Number(amount) * 100),
      currency: 'INR',
      receipt: saleId,
      notes: { sale_id: saleId }
    })

    await pool.query(
      `INSERT INTO payments (sale_id, razorpay_order_id, status, amount_paise, currency, email, phone, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (razorpay_order_id) DO NOTHING`,
      [
        saleId,
        order.id,
        order.status || 'created',
        order.amount,
        order.currency,
        sale.customer_email || null,
        sale.customer_mobile || null,
        JSON.stringify(order.notes || {})
      ]
    )

    res.json({
      key_id: process.env.RAZORPAY_KEY_ID,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      sale_id: saleId
    })
  } catch (e) {
    res.status(500).json({ message: e.message || 'create failed' })
  }
})

router.post('/payments/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {}
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: 'razorpay_order_id, razorpay_payment_id, razorpay_signature required' })
    }

    const svc = new RazorpayService({})
    const ok = svc.verifyPaymentSignature({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature
    })

    const status = ok ? 'PAID' : 'FAILED'

    const p = await pool.query(
      `UPDATE payments
       SET razorpay_payment_id=$2, razorpay_signature=$3, status=$4
       WHERE razorpay_order_id=$1
       RETURNING sale_id`,
      [razorpay_order_id, razorpay_payment_id, razorpay_signature, status]
    )

    if (p.rowCount) {
      const saleId = p.rows[0].sale_id
      if (ok) {
        await pool.query(`UPDATE sales SET payment_status='PAID', updated_at=now() WHERE id=$1::uuid`, [saleId])
      } else {
        await pool.query(`UPDATE sales SET payment_status='FAILED', updated_at=now() WHERE id=$1::uuid AND payment_status <> 'PAID'`, [saleId])
      }
    }

    res.json({ ok, status })
  } catch (e) {
    res.status(500).json({ message: e.message || 'verify failed' })
  }
})

router.post('/payments/mark-failed', async (req, res) => {
  try {
    const saleId = String(req.body.sale_id || '').trim()
    if (!saleId) return res.status(400).json({ message: 'sale_id required' })

    const q = await pool.query(
      `UPDATE sales
       SET payment_status='FAILED', updated_at=now()
       WHERE id=$1::uuid AND payment_status <> 'PAID'
       RETURNING id, payment_status`,
      [saleId]
    )

    if (!q.rowCount) return res.status(404).json({ message: 'Sale not found' })
    res.json({ id: q.rows[0].id, payment_status: q.rows[0].payment_status })
  } catch (e) {
    res.status(500).json({ message: e.message || 'failed' })
  }
})

router.get('/payments/by-sale/:id', async (req, res) => {
  try {
    const saleId = String(req.params.id || '').trim()
    if (!saleId) return res.status(400).json({ message: 'id required' })
    const q = await pool.query(
      `SELECT * FROM payments WHERE sale_id=$1::uuid ORDER BY created_at DESC`,
      [saleId]
    )
    res.json(q.rows)
  } catch (e) {
    res.status(500).json({ message: e.message || 'list failed' })
  }
})

router.post('/razorpay/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['x-razorpay-signature']
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET
    const bodyRaw = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body || {})
    const svc = new RazorpayService({})
    const ok = svc.verifyWebhookSignature({ bodyRaw, signature: sig, secret })

    if (!ok) return res.status(400).json({ message: 'invalid signature' })

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    const eventId = payload?.payload?.payment?.entity?.id || payload?.id || null
    const eventType = payload?.event || null

    if (eventId) {
      await pool.query(
        `INSERT INTO razorpay_webhook_events (event_id, event_type, payload)
         VALUES ($1,$2,$3)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, eventType, JSON.stringify(payload)]
      )
    }

    const paymentEntity = payload?.payload?.payment?.entity || null
    if (paymentEntity?.order_id) {
      const status = String(paymentEntity.status || '').toUpperCase() === 'CAPTURED' ? 'PAID' : String(paymentEntity.status || '').toUpperCase()
      await pool.query(
        `UPDATE payments
         SET razorpay_payment_id=$2,
             status=COALESCE($3,status),
             method=$4,
             email=COALESCE($5,email),
             phone=COALESCE($6,phone)
         WHERE razorpay_order_id=$1`,
        [
          paymentEntity.order_id,
          paymentEntity.id || null,
          status,
          paymentEntity.method || null,
          paymentEntity.email || null,
          paymentEntity.contact || null
        ]
      )

      if (status === 'PAID') {
        const s = await pool.query(`SELECT sale_id FROM payments WHERE razorpay_order_id=$1`, [paymentEntity.order_id])
        if (s.rowCount) {
          await pool.query(`UPDATE sales SET payment_status='PAID', updated_at=now() WHERE id=$1::uuid`, [s.rows[0].sale_id])
        }
      } else if (status === 'FAILED') {
        const s = await pool.query(`SELECT sale_id FROM payments WHERE razorpay_order_id=$1`, [paymentEntity.order_id])
        if (s.rowCount) {
          await pool.query(`UPDATE sales SET payment_status='FAILED', updated_at=now() WHERE id=$1::uuid AND payment_status <> 'PAID'`, [s.rows[0].sale_id])
        }
      }
    }

    res.json({ ok: true })
  } catch (e) {
    res.status(200).json({ ok: true })
  }
})

module.exports = router
