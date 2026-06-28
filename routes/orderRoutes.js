const router = require('express').Router()
const crypto = require('crypto')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { getTracking } = require('../controllers/orderController')
const Shiprocket = require('../services/shiprocketService')

const toNumber = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const uuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const s = b.toString('hex')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

const cleanPhone = (value) => {
  const v = String(value || '').replace(/\D/g, '')
  return v || '9999999999'
}

const normalizeAddress = (address) => {
  const a = address && typeof address === 'object' ? address : {}

  return {
    line1: String(a.line1 || a.address_line1 || a.address1 || a.street || '').trim(),
    line2: String(a.line2 || a.address_line2 || a.address2 || a.landmark || '').trim(),
    city: String(a.city || '').trim(),
    state: String(a.state || '').trim(),
    pincode: String(a.pincode || a.pin_code || '').trim()
  }
}

const createShiprocketOrder = async ({
  saleId,
  branchId,
  customerName,
  customerEmail,
  customerMobile,
  shippingAddress,
  totals,
  paymentStatus,
  items
}) => {
  const whQ = await pool.query(
    `SELECT *
     FROM shiprocket_warehouses
     WHERE branch_id = $1
     LIMIT 1`,
    [branchId]
  )

  const warehouse = whQ.rows?.[0] || null

  if (!warehouse) {
    throw new Error(`No Shiprocket pickup warehouse mapped for branch ${branchId}`)
  }

  const sr = new Shiprocket({ pool })
  await sr.init()

  const address = normalizeAddress(shippingAddress)
  const payable = Number(totals?.payable || totals?.total || 0)
  const payStatus = String(paymentStatus || '').toUpperCase()
  const shiprocketPaymentMethod = payStatus === 'COD' && payable > 0 ? 'COD' : 'Prepaid'

  const shiprocketItems = items.map((it) => ({
    variant_id: it.variant_id,
    qty: it.qty,
    price: it.price,
    mrp: it.mrp,
    size: it.size,
    colour: it.colour,
    image_url: it.image_url,
    ean_code: it.ean_code,
    name: it.name || `Variant ${it.variant_id}`
  }))

  const data = await sr.createOrderShipment({
    channel_order_id: String(saleId),
    pickup_location: warehouse.name,
    order: {
      items: shiprocketItems,
      payment_method: shiprocketPaymentMethod,
      weight: 0.5,
      dimensions: {
        length: 10,
        breadth: 10,
        height: 5
      }
    },
    customer: {
      name: customerName || 'Customer',
      email: customerEmail || 'na@example.com',
      phone: cleanPhone(customerMobile),
      address
    }
  })

  const shipmentId = Array.isArray(data?.shipment_id) ? data.shipment_id[0] : data?.shipment_id || null
  const shiprocketOrderId = data?.order_id || data?.data?.order_id || null
  const trackingUrl = data?.tracking_url || data?.data?.tracking_url || null

  await pool.query(
    `INSERT INTO shipments
       (id, sale_id, branch_id, shiprocket_order_id, shiprocket_shipment_id, awb, label_url, tracking_url, status)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      uuid(),
      saleId,
      branchId,
      shiprocketOrderId,
      shipmentId,
      null,
      null,
      trackingUrl,
      'CREATED'
    ]
  )

  return {
    order_id: shiprocketOrderId,
    shipment_id: shipmentId,
    tracking_url: trackingUrl,
    pickup_location: warehouse.name,
    status: 'CREATED',
    raw: data
  }
}

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
  const requestedBranchId = toNumber(body.branch_id) || 3

  if (!items.length) return res.status(400).json({ message: 'Items required' })
  if (!shipping_address) return res.status(400).json({ message: 'shipping_address required' })

  const normalizedItems = items.map((it) => {
    const productId = toNumber(it.product_id)
    const variantId = toNumber(it.variant_id != null ? it.variant_id : it.product_id)

    return {
      product_id: productId,
      variant_id: variantId,
      qty: Math.max(1, Number(it.qty || it.quantity || 1) || 1),
      price: Number(it.price || 0) || 0,
      mrp: Number(it.mrp || it.original_price || it.price || 0) || 0,
      size: it.size != null ? String(it.size) : it.selected_size != null ? String(it.selected_size) : null,
      colour: it.colour != null ? String(it.colour) : it.selected_color != null ? String(it.selected_color) : null,
      image_url: it.image_url != null ? String(it.image_url) : null,
      ean_code: it.ean_code != null ? String(it.ean_code) : it.barcode_value != null ? String(it.barcode_value) : null,
      name:
        it.name != null
          ? String(it.name)
          : it.product_name != null
            ? String(it.product_name)
            : it.title != null
              ? String(it.title)
              : variantId
                ? `Variant ${variantId}`
                : 'Product'
    }
  })

  if (normalizedItems.some((it) => !it.variant_id || it.qty <= 0)) {
    return res.status(400).json({ message: 'Invalid items (variant_id/qty)' })
  }

  const stockMap = new Map()

  for (const item of normalizedItems) {
    stockMap.set(item.variant_id, (stockMap.get(item.variant_id) || 0) + item.qty)
  }

  const stockJson = JSON.stringify(
    Array.from(stockMap.entries()).map(([variant_id, qty]) => ({ variant_id, qty }))
  )

  const client = await pool.connect()

  let saleId = null
  let chosenBranchId = null

  try {
    await client.query('BEGIN')

    const branchQ = await client.query(
      `
      WITH cart AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x(variant_id int, qty int)
      )
      SELECT bvs.branch_id
      FROM branch_variant_stock bvs
      JOIN cart c ON c.variant_id = bvs.variant_id
      WHERE bvs.branch_id = $2
        AND COALESCE(bvs.on_hand, 0) >= c.qty
      GROUP BY bvs.branch_id
      HAVING COUNT(*) = (SELECT COUNT(*) FROM cart)
      LIMIT 1
      `,
      [stockJson, requestedBranchId]
    )

    chosenBranchId = branchQ.rows?.[0]?.branch_id || null

    if (!chosenBranchId) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        message: `Stock not available in branch ${requestedBranchId} for all items`
      })
    }

    for (const [variantId, qty] of stockMap.entries()) {
      const upd = await client.query(
        `
        UPDATE branch_variant_stock
        SET on_hand = COALESCE(on_hand, 0) - $3
        WHERE branch_id = $1
          AND variant_id = $2
          AND COALESCE(on_hand, 0) >= $3
        RETURNING on_hand
        `,
        [chosenBranchId, variantId, qty]
      )

      if (!upd.rowCount) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          message: `Insufficient stock for variant ${variantId} in branch ${chosenBranchId}`
        })
      }
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

    saleId = saleQ.rows?.[0]?.id || null

    if (!saleId) {
      await client.query('ROLLBACK')
      return res.status(500).json({ message: 'Failed to create order' })
    }

    for (const it of normalizedItems) {
      await client.query(
        `
        INSERT INTO sale_items
          (sale_id, product_id, variant_id, qty, price, mrp, size, colour, image_url, ean_code, created_at)
        VALUES
          ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
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
          it.image_url,
          it.ean_code
        ]
      )
    }

    await client.query('COMMIT')
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {}

    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? e.message : 'Server error'
    })
  } finally {
    client.release()
  }

  let shiprocket = null
  let shiprocket_error = null

  try {
    shiprocket = await createShiprocketOrder({
      saleId,
      branchId: chosenBranchId,
      customerName: customer_name,
      customerEmail: customer_email,
      customerMobile: customer_mobile,
      shippingAddress: shipping_address,
      totals,
      paymentStatus: payment_status,
      items: normalizedItems
    })
  } catch (e) {
    shiprocket_error = e?.message || String(e)
  }

  return res.json({
    id: saleId,
    status: 'PLACED',
    payment_status,
    branch_id: chosenBranchId,
    shiprocket,
    shiprocket_error
  })
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