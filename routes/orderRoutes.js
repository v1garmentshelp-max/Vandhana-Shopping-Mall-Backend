const router = require('express').Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { getTracking } = require('../controllers/orderController')
const Shiprocket = require('../services/shiprocketService')

router.post('/web/place', async (req, res) => {
  const body = req.body || {}
  const items = Array.isArray(body.items) ? body.items : []
  const totals = body.totals && typeof body.totals === 'object' ? body.totals : null
  const shipping_address =
    body.shipping_address && typeof body.shipping_address === 'object'
      ? body.shipping_address
      : null

  const customer_name = body.customer_name ? String(body.customer_name) : null
  const customer_email = body.customer_email ? String(body.customer_email) : null
  const customer_mobile = body.customer_mobile ? String(body.customer_mobile) : null
  const payment_method = body.payment_method ? String(body.payment_method) : 'COD'
  const payment_status = body.payment_status ? String(body.payment_status) : 'COD'
  const login_email = body.login_email ? String(body.login_email) : null

  if (!items.length) return res.status(400).json({ message: 'Items required' })
  if (!shipping_address) return res.status(400).json({ message: 'shipping_address required' })

  const normalizedItems = items.map((it) => ({
    product_id: it.product_id != null ? Number(it.product_id) : null,
    variant_id: it.variant_id != null ? Number(it.variant_id) : null,
    qty: Number(it.qty || 1) || 1,
    price: Number(it.price || 0) || 0,
    mrp: Number(it.mrp || it.price || 0) || 0,
    size: it.size != null ? String(it.size) : null,
    colour: it.colour != null ? String(it.colour) : null,
    image_url: it.image_url != null ? String(it.image_url) : null
  }))

  if (normalizedItems.some((it) => !it.variant_id || it.qty <= 0)) {
    return res.status(400).json({ message: 'Invalid items (variant_id/qty)' })
  }

  const cartJson = JSON.stringify(
    normalizedItems.map((i) => ({ variant_id: i.variant_id, qty: i.qty }))
  )

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const branchQ = await client.query(
      `
      WITH cart AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x(variant_id int, qty int)
      )
      SELECT s.branch_id
      FROM stocks s
      JOIN cart c ON c.variant_id = s.variant_id
      WHERE s.qty >= c.qty
      GROUP BY s.branch_id
      HAVING COUNT(*) = (SELECT COUNT(*) FROM cart)
      ORDER BY s.branch_id ASC
      LIMIT 1
      `,
      [cartJson]
    )

    const chosenBranchId = branchQ.rows?.[0]?.branch_id || null
    if (!chosenBranchId) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        message: 'Stock not available in a single branch for all items'
      })
    }

    for (const it of normalizedItems) {
      const lockQ = await client.query(
        `
        SELECT qty
        FROM stocks
        WHERE branch_id = $1 AND variant_id = $2
        FOR UPDATE
        `,
        [chosenBranchId, it.variant_id]
      )

      const available = Number(lockQ.rows?.[0]?.qty || 0)
      if (available < it.qty) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          message: `Insufficient stock for variant ${it.variant_id} in branch ${chosenBranchId}`
        })
      }

      await client.query(
        `
        UPDATE stocks
        SET qty = qty - $1
        WHERE branch_id = $2 AND variant_id = $3
        `,
        [it.qty, chosenBranchId, it.variant_id]
      )
    }

    const totalPayable =
      totals && totals.payable != null ? Number(totals.payable) : null

    const saleQ = await client.query(
      `
      INSERT INTO sales
        (source, status, payment_status, payment_method, total, totals, branch_id,
         customer_name, customer_email, customer_mobile, shipping_address, login_email, created_at)
      VALUES
        ('WEB', 'PLACED', $1, $2, $3, $4::jsonb, $5,
         $6, $7, $8, $9::jsonb, $10, now())
      RETURNING id
      `,
      [
        payment_status,
        payment_method,
        Number.isFinite(totalPayable) ? totalPayable : 0,
        JSON.stringify(totals || {}),
        chosenBranchId,
        customer_name,
        customer_email,
        customer_mobile,
        JSON.stringify(shipping_address || {}),
        login_email
      ]
    )

    const saleId = saleQ.rows?.[0]?.id || null
    if (!saleId) {
      await client.query('ROLLBACK')
      return res.status(500).json({ message: 'Failed to create order' })
    }

    for (const it of normalizedItems) {
      await client.query(
        `
        INSERT INTO sale_items
          (sale_id, product_id, variant_id, qty, price, mrp, size, colour, image_url, created_at)
        VALUES
          ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, now())
        `,
        [
          saleId,
          it.product_id,
          it.variant_id,
          it.qty,
          it.price,
          it.mrp,
          it.size,
          it.colour,
          it.image_url
        ]
      )
    }

    await client.query('COMMIT')
    return res.json({ id: saleId, branch_id: chosenBranchId })
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    return res.status(500).json({ message: 'Server error' })
  } finally {
    client.release()
  }
})

router.get('/', requireAuth, async (req, res) => {
  try {
    const role = String(req.user?.role_enum || req.user?.role || '').toUpperCase()
    const isSuper = role === 'SUPER_ADMIN'
    const userBranchId = Number(req.user?.branch_id || 0)

    const requestedBranchIdRaw = String(req.query.branch_id || '').trim()
    const requestedBranchId = requestedBranchIdRaw ? Number(requestedBranchIdRaw) : null

    const params = []
    const where = []

    if (isSuper) {
      if (requestedBranchId && Number.isFinite(requestedBranchId)) {
        params.push(requestedBranchId)
        where.push(`s.branch_id = $${params.length}`)
      }
    } else {
      if (!userBranchId) return res.status(403).json({ message: 'Forbidden' })
      params.push(userBranchId)
      where.push(`s.branch_id = $${params.length}`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const q = await pool.query(
      `SELECT
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
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       ${whereSql}
       ORDER BY s.created_at DESC NULLS LAST, s.id DESC
       LIMIT 500`,
      params
    )

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')

    return res.json(q.rows || [])
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/track/:orderId/:channelId?', getTracking)

router.post('/cancel', async (req, res) => {
  const { sale_id, payment_type, reason, cancellation_source } = req.body || {}

  if (!sale_id) {
    return res.status(400).json({ ok: false, message: 'sale_id required' })
  }

  const client = await pool.connect()
  let shiprocketOrderIds = []
  let salePaymentStatus = null

  try {
    await client.query('BEGIN')

    const orderQ = await client.query(
      `SELECT id, status, payment_status
       FROM sales
       WHERE id = $1::uuid
       FOR UPDATE`,
      [sale_id]
    )

    if (!orderQ.rowCount) {
      await client.query('ROLLBACK')
      client.release()
      return res.status(404).json({ ok: false, message: 'Order not found' })
    }

    const sale = orderQ.rows[0]
    salePaymentStatus = sale.payment_status || null
    const currentStatus = String(sale.status || '').toUpperCase()

    if (currentStatus === 'CANCELLED') {
      await client.query('ROLLBACK')
      client.release()
      return res.status(400).json({ ok: false, message: 'Order already cancelled' })
    }

    if (currentStatus === 'DELIVERED' || currentStatus === 'RTO') {
      await client.query('ROLLBACK')
      client.release()
      return res.status(400).json({ ok: false, message: 'Order cannot be cancelled' })
    }

    const shipQ = await client.query(
      `SELECT DISTINCT shiprocket_order_id
       FROM shipments
       WHERE sale_id = $1
         AND shiprocket_order_id IS NOT NULL`,
      [sale_id]
    )

    shiprocketOrderIds = shipQ.rows.map(r => r.shiprocket_order_id).filter(Boolean)

    await client.query(`UPDATE sales SET status = 'CANCELLED' WHERE id = $1::uuid`, [sale_id])
    await client.query(`UPDATE shipments SET status = 'CANCELLED' WHERE sale_id = $1`, [sale_id])

    await client.query(
      `INSERT INTO order_cancellations (sale_id, payment_type, reason, cancellation_source, created_at)
       VALUES ($1::uuid,$2,$3,$4,now())
       ON CONFLICT DO NOTHING`,
      [sale_id, payment_type || salePaymentStatus, reason || null, cancellation_source || null]
    )

    await client.query('COMMIT')
    client.release()
  } catch {
    try { await client.query('ROLLBACK') } catch {}
    try { client.release() } catch {}
    return res.status(500).json({ ok: false, message: 'Failed to cancel order' })
  }

  if (shiprocketOrderIds.length) {
    try {
      const sr = new Shiprocket({ pool })
      await sr.init()
      await sr.cancelOrders({ order_ids: shiprocketOrderIds })
    } catch {}
  }

  return res.json({ ok: true, id: sale_id, status: 'CANCELLED' })
})

module.exports = router
