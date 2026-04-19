const express = require('express')
const crypto = require('crypto')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { fulfillOrderWithShiprocket } = require('../services/orderFulfillment')

const router = express.Router()

const isDebug = () => String(process.env.DEBUG_ERRORS || '').trim() === '1'

const uuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const s = b.toString('hex')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

router.post('/web/place', async (req, res) => {
  const {
    customer_email,
    customer_name,
    customer_mobile,
    shipping_address,
    totals,
    items,
    branch_id,
    payment_status,
    login_email,
    payment_method
  } = req.body || {}

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items required' })
  }

  if (!shipping_address || typeof shipping_address !== 'object') {
    return res.status(400).json({ message: 'shipping_address required' })
  }

  const method = String(payment_method || '').toUpperCase().trim()

  let finalPaymentStatus = String(payment_status || '').toUpperCase().trim()
  if (!finalPaymentStatus) finalPaymentStatus = method === 'ONLINE' ? 'PENDING' : 'COD'
  if (!['COD', 'PENDING', 'PAID', 'FAILED'].includes(finalPaymentStatus)) {
    finalPaymentStatus = method === 'ONLINE' ? 'PENDING' : 'COD'
  }

  const agg = new Map()
  for (const it of items) {
    const vId = Number(it?.variant_id ?? it?.product_id)
    const qty = Number(it?.qty ?? 1)
    if (!vId || qty <= 0) continue
    agg.set(vId, (agg.get(vId) || 0) + qty)
  }

  if (agg.size === 0) {
    return res.status(400).json({ message: 'invalid items' })
  }

  const providedBranchId = Number(branch_id || 0) || null

  const client = await pool.connect()
  let saleId = null
  let saleTotals = null
  let resolvedBranchId = null

  try {
    await client.query('BEGIN')

    let bagTotal = 0
    let discountTotal = 0
    for (const it of items) {
      const mrp = Number(it?.mrp ?? it?.price ?? 0) || 0
      const price = Number(it?.price ?? 0) || 0
      const qty = Number(it?.qty ?? 1) || 1
      bagTotal += mrp * qty
      discountTotal += Math.max(mrp - price, 0) * qty
    }

    const couponPct = Number(totals?.couponPct ?? 0) || 0
    const couponDiscount = Math.floor(((bagTotal - discountTotal) * couponPct) / 100)
    const convenience = Number(totals?.convenience ?? 0) || 0
    const giftWrap = Number(totals?.giftWrap ?? 0) || 0
    const payable = bagTotal - discountTotal - couponDiscount + convenience + giftWrap

    saleTotals = {
      bagTotal,
      discountTotal,
      couponPct,
      couponDiscount,
      convenience,
      giftWrap,
      payable
    }

    const baseTotals = JSON.stringify(totals && typeof totals === 'object' ? totals : saleTotals)
    const storedEmail = (login_email || customer_email || null) ? String(login_email || customer_email) : null

    if (providedBranchId) {
      resolvedBranchId = providedBranchId
    } else {
      const pairs = []
      for (const [vId, qty] of agg.entries()) pairs.push({ variant_id: vId, qty })
      const cartJson = JSON.stringify(pairs)

      const branchQ = await client.query(
        `
        WITH cart AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb)
          AS x(variant_id int, qty int)
        )
        SELECT bvs.branch_id
        FROM branch_variant_stock bvs
        JOIN cart c ON c.variant_id = bvs.variant_id
        WHERE COALESCE(bvs.on_hand, 0) >= c.qty
        GROUP BY bvs.branch_id
        HAVING COUNT(*) = (SELECT COUNT(*) FROM cart)
        ORDER BY bvs.branch_id ASC
        LIMIT 1
        `,
        [cartJson]
      )

      resolvedBranchId = branchQ.rows?.[0]?.branch_id ? Number(branchQ.rows[0].branch_id) : null
    }

    if (!resolvedBranchId) {
      await client.query('ROLLBACK')
      return res.status(400).json({ message: 'Stock not available in a single branch for all items' })
    }

    const variantIds = Array.from(agg.keys()).sort((a, b) => a - b)

    for (const vId of variantIds) {
      const qty = Number(agg.get(vId) || 0)
      const upd = await client.query(
        `
        UPDATE branch_variant_stock
        SET on_hand = on_hand - $3
        WHERE branch_id = $1
          AND variant_id = $2
          AND COALESCE(on_hand, 0) >= $3
        RETURNING on_hand
        `,
        [resolvedBranchId, vId, qty]
      )

      if (!upd.rowCount) {
        const existsQ = await client.query(
          'SELECT 1 FROM branch_variant_stock WHERE branch_id=$1 AND variant_id=$2 LIMIT 1',
          [resolvedBranchId, vId]
        )
        await client.query('ROLLBACK')
        if (!existsQ.rowCount) {
          return res.status(400).json({ message: `Stock not found for variant ${vId} in branch ${resolvedBranchId}` })
        }
        return res.status(400).json({ message: `Insufficient stock for variant ${vId} in branch ${resolvedBranchId}` })
      }
    }

    const inserted = await client.query(
      `INSERT INTO sales
       (source, customer_email, customer_name, customer_mobile, shipping_address, status, payment_status, totals, branch_id, total, payment_method)
       VALUES
       ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11)
       RETURNING id`,
      [
        'WEB',
        storedEmail,
        customer_name ? String(customer_name) : null,
        customer_mobile ? String(customer_mobile) : null,
        JSON.stringify(shipping_address),
        'PLACED',
        finalPaymentStatus,
        baseTotals,
        resolvedBranchId,
        payable,
        method || null
      ]
    )

    saleId = inserted.rows?.[0]?.id || null

    if (!saleId) {
      await client.query('ROLLBACK')
      return res.status(500).json({ message: 'Failed to create order' })
    }

    for (const it of items) {
      const vId = Number(it?.variant_id ?? it?.product_id)
      const qty = Number(it?.qty ?? 1) || 1
      await client.query(
        `INSERT INTO sale_items
         (id, sale_id, variant_id, qty, price, mrp, size, colour, image_url, ean_code)
         VALUES
         ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          uuid(),
          saleId,
          vId,
          qty,
          Number(it?.price ?? 0) || 0,
          it?.mrp != null ? Number(it.mrp) : null,
          it?.size ?? it?.selected_size ?? null,
          it?.colour ?? it?.color ?? it?.selected_color ?? null,
          it?.image_url ?? null,
          it?.ean_code ?? it?.barcode_value ?? null
        ]
      )
    }

    await client.query('COMMIT')
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    const msg = isDebug() ? (e?.message || String(e)) : 'Server error'
    return res.status(500).json({ message: msg })
  } finally {
    try {
      client.release()
    } catch {}
  }

  const responseTotals = saleTotals || (totals && typeof totals === 'object' ? totals : null) || null

  let shiprocket = null
  let shiprocket_error = null

  const canFulfill = finalPaymentStatus === 'PAID' || finalPaymentStatus === 'COD'

  if (canFulfill && saleId && responseTotals && Number(responseTotals.payable || 0) > 0) {
    const saleForShiprocket = {
      id: saleId,
      branch_id: resolvedBranchId,
      customer_email: login_email || customer_email || null,
      customer_name: customer_name || null,
      customer_mobile: customer_mobile || null,
      shipping_address,
      totals: responseTotals,
      payment_status: finalPaymentStatus,
      pincode: shipping_address?.pincode || null,
      items: items.map(it => ({
        variant_id: Number(it?.variant_id ?? it?.product_id),
        qty: Number(it?.qty ?? 1),
        price: Number(it?.price ?? 0),
        mrp: it?.mrp != null ? Number(it.mrp) : Number(it?.price ?? 0),
        size: it?.size ?? it?.selected_size ?? null,
        colour: it?.colour ?? it?.color ?? it?.selected_color ?? null,
        image_url: it?.image_url ?? null,
        ean_code: it?.ean_code ?? it?.barcode_value ?? null,
        name: it?.name ?? it?.product_name ?? null
      }))
    }

    try {
      shiprocket = await fulfillOrderWithShiprocket(saleForShiprocket, pool)
    } catch (err) {
      shiprocket_error = err?.response?.data || err?.message || String(err)
    }
  }

  return res.json({
    id: saleId,
    status: 'PLACED',
    payment_status: finalPaymentStatus,
    totals: responseTotals,
    branch_id: resolvedBranchId,
    shiprocket,
    shiprocket_error
  })
})


// ══════════════════════════════════════════════════════════════
// B2B BULK ORDER ROUTE (Bypasses Stock Checks & Shiprocket)
// ══════════════════════════════════════════════════════════════
router.post('/web/b2b-place', async (req, res) => { // FIX 2: Added requireAuth
  const { customer_email, customer_name, shipping_address, items, totals, payment_method } = req.body || {}

    // Validate email is present instead
  if (!customer_email) {
    return res.status(400).json({ message: 'customer_email required' })
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items required' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1. Create the Sale Record as an Inquiry
    const saleQ = await client.query(
      `INSERT INTO sales
       (source, customer_email, customer_name, shipping_address, status, payment_status, totals, total, payment_method, is_b2b, created_at)
       VALUES
       ('B2B', $1, $2, $3::jsonb, 'B2B_PENDING', 'PENDING', $4::jsonb, $5, $6, true, now())
       RETURNING id`,
      [
        customer_email || 'b2b@wholesale.com',
        customer_name || 'B2B User',
        JSON.stringify(shipping_address || {}),
        JSON.stringify(totals || {}),
        totals?.payable || 0,
        payment_method || 'B2B_BULK'
      ]
    )

    const saleId = saleQ.rows[0].id

    // 2. Insert the Bulk Items (No stock decrementing!)
    for (const it of items) {
      
      // FIX 4: Validate variant_id to prevent cryptic DB errors or null inserts
      if (!it.variant_id) {
        await client.query('ROLLBACK')
        return res.status(400).json({ message: 'variant_id is required for all items' })
      }

      await client.query(
        `INSERT INTO sale_items
         (id, sale_id, variant_id, qty, price, mrp, size, colour, image_url)
         VALUES
         ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`,
        [
          uuid(), 
          saleId, 
          it.variant_id, 
          Number(it.qty) || 1, 
          Number(it.price) || 0, 
          Number(it.mrp) || 0, 
          it.size || '', 
          it.colour || '', 
          it.image_url || ''
        ]
      )
    }

    await client.query('COMMIT')
    return res.json({ id: saleId, status: 'B2B_PENDING', message: 'Bulk order submitted successfully' })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('B2B Order Error:', e)
    return res.status(500).json({ message: 'Failed to place B2B order' })
  } finally {
    client.release()
  }
})


router.post('/web/set-payment-status', async (req, res) => {
  const client = await pool.connect()

  try {
    const requestedSaleId = String(req.body.sale_id || '').trim()
    const status = String(req.body.status || '').trim().toUpperCase()
    if (!requestedSaleId || !status) {
      client.release()
      return res.status(400).json({ message: 'sale_id and status required' })
    }
    if (!['COD', 'PENDING', 'PAID', 'FAILED'].includes(status)) {
      client.release()
      return res.status(400).json({ message: 'invalid status' })
    }

    await client.query('BEGIN')

    const saleQ = await client.query(
      `SELECT id, payment_status
       FROM sales
       WHERE id = $1::uuid
       FOR UPDATE`,
      [requestedSaleId]
    )

    if (!saleQ.rowCount) {
      await client.query('ROLLBACK')
      client.release()
      return res.status(404).json({ message: 'Sale not found' })
    }

    const saleRow = saleQ.rows[0]
    const currentStatus = String(saleRow.payment_status || '').toUpperCase()

    if (currentStatus === status) {
      await client.query('COMMIT')
      client.release()
      return res.json({ id: saleRow.id, payment_status: currentStatus })
    }

    const q = await client.query(
      'UPDATE sales SET payment_status=$2, updated_at=now() WHERE id=$1::uuid RETURNING id, payment_status',
      [saleRow.id, status]
    )

    await client.query('COMMIT')
    client.release()

    return res.json({ id: q.rows[0].id, payment_status: q.rows[0].payment_status })
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    try {
      client.release()
    } catch {}
    const msg = isDebug() ? (e?.message || String(e)) : 'Server error'
    return res.status(500).json({ message: msg })
  }
})

router.get('/web', async (_req, res) => {
  try {
    const list = await pool.query(
      `SELECT
         s.*,
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       ORDER BY s.created_at DESC NULLS LAST, s.id DESC
       LIMIT 200`
    )
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    return res.json(list.rows)
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/web/by-user', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim()
    const mobile = String(req.query.mobile || '').trim()
    if (!email && !mobile) {
      return res.status(400).json({ message: 'email or mobile required' })
    }

    const params = []
    const conds = ["s.source = 'WEB'"]
    const ors = []

    if (email) {
      params.push(email)
      ors.push(`LOWER(s.customer_email) = LOWER($${params.length})`)
    }
    if (mobile) {
      params.push(mobile)
      ors.push(`regexp_replace(s.customer_mobile,'\\D','','g') = regexp_replace($${params.length},'\\D','','g')`)
    }
    if (ors.length) conds.push(`(${ors.join(' OR ')})`)

    const salesQ = await pool.query(
      `SELECT
         s.id,
         s.status,
         s.payment_status,
         s.payment_method,
         s.created_at,
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
       WHERE ${conds.join(' AND ')}
       ORDER BY s.created_at DESC NULLS LAST, s.id DESC
       LIMIT 200`,
      params
    )

    if (salesQ.rowCount === 0) return res.json([])

    const ids = salesQ.rows.map(r => r.id)
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'

    const itemsQ = await pool.query(
      `SELECT
         si.sale_id,
         si.variant_id,
         si.qty,
         si.price,
         si.mrp,
         si.size,
         si.colour,
         si.ean_code,
         COALESCE(
           NULLIF(si.image_url,''),
           NULLIF(pi.image_url,''),
           CASE
             WHEN si.ean_code IS NOT NULL AND si.ean_code <> ''
             THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', si.ean_code)
             ELSE NULL
           END
         ) AS image_url,
         p.name  AS product_name,
         p.brand_name
       FROM sale_items si
       LEFT JOIN product_variants v ON v.id = si.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN product_images pi ON pi.ean_code = si.ean_code
       WHERE si.sale_id = ANY($1::uuid[])`,
      [ids, cloud]
    )

    const bySale = new Map()
    for (const s of salesQ.rows) bySale.set(s.id, { ...s, items: [] })
    for (const it of itemsQ.rows) {
      const rec = bySale.get(it.sale_id)
      if (rec) {
        rec.items.push({
          variant_id: it.variant_id,
          qty: Number(it.qty || 0),
          price: Number(it.price || 0),
          mrp: it.mrp != null ? Number(it.mrp) : null,
          size: it.size,
          colour: it.colour,
          ean_code: it.ean_code,
          image_url: it.image_url,
          product_name: it.product_name,
          brand_name: it.brand_name
        })
      }
    }

    res.json(Array.from(bySale.values()))
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/web/:id', async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })

  try {
    const s = await pool.query(
      `SELECT
         s.id,
         s.status,
         s.payment_status,
         s.payment_method,
         s.created_at,
         s.totals,
         s.branch_id,
         s.customer_name,
         s.customer_email,
         s.customer_mobile,
         s.shipping_address,
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       WHERE s.id = $1::uuid`,
      [id]
    )
    if (!s.rowCount) return res.status(404).json({ message: 'Not found' })

    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'

    const itemsQ = await pool.query(
      `SELECT
         si.variant_id,
         si.qty,
         si.price,
         si.mrp,
         si.size,
         si.colour,
         si.ean_code,
         COALESCE(
           NULLIF(si.image_url,''),
           NULLIF(pi.image_url,''),
           CASE
             WHEN si.ean_code IS NOT NULL AND si.ean_code <> ''
             THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', si.ean_code)
             ELSE NULL
           END
         ) AS image_url,
         p.name  AS product_name,
         p.brand_name
       FROM sale_items si
       LEFT JOIN product_variants v ON v.id = si.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN product_images pi ON pi.ean_code = si.ean_code
       WHERE si.sale_id = $1::uuid`,
      [id, cloud]
    )

    const items = itemsQ.rows.map(r => ({
      variant_id: r.variant_id,
      qty: Number(r.qty || 0),
      price: Number(r.price || 0),
      mrp: r.mrp != null ? Number(r.mrp) : null,
      size: r.size,
      colour: r.colour,
      ean_code: r.ean_code,
      image_url: r.image_url,
      product_name: r.product_name,
      brand_name: r.brand_name
    }))

    return res.json({ sale: s.rows[0], items })
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/admin', requireAuth, async (req, res) => {
  try {
    const role = String(req.user?.role_enum || '').toUpperCase()
    const isSuper = role === 'SUPER_ADMIN'
    const branchId = Number(req.user?.branch_id || 0)

    const params = []
    const where = []

    if (!isSuper) {
      if (!branchId) return res.status(403).json({ message: 'Forbidden' })
      params.push(branchId)
       where.push(`(s.branch_id = $${params.length} OR s.is_b2b = true)`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const list = await pool.query(
      `SELECT
         s.*,
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       ${whereSql}
       ORDER BY s.created_at DESC NULLS LAST, s.id DESC
       LIMIT 200`,
      params
    )

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    return res.json(list.rows)
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/admin/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })

  try {
    const role = String(req.user?.role_enum || '').toUpperCase()
    const isSuper = role === 'SUPER_ADMIN'
    const branchId = Number(req.user?.branch_id || 0)

    const params = [id]
    let where = `s.id = $1::uuid`

if (!isSuper) {
  if (!branchId) return res.status(403).json({ message: 'Forbidden' })
  params.push(branchId)
  where += ` AND (s.branch_id = $2 OR s.is_b2b = true)`
}

    const s = await pool.query(
      `SELECT
         s.id,
         s.status,
         s.payment_status,
         s.payment_method,
         s.created_at,
         s.totals,
         s.branch_id,
         s.customer_name,
         s.customer_email,
         s.customer_mobile,
         s.shipping_address,
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       WHERE ${where}`,
      params
    )
    if (!s.rowCount) return res.status(404).json({ message: 'Not found' })

    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'

    const itemsQ = await pool.query(
      `SELECT
         si.variant_id,
         si.qty,
         si.price,
         si.mrp,
         si.size,
         si.colour,
         si.ean_code,
         COALESCE(
           NULLIF(si.image_url,''),
           NULLIF(pi.image_url,''),
           CASE
             WHEN si.ean_code IS NOT NULL AND si.ean_code <> ''
             THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', si.ean_code)
             ELSE NULL
           END
         ) AS image_url,
         p.name  AS product_name,
         p.brand_name
       FROM sale_items si
       LEFT JOIN product_variants v ON v.id = si.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN product_images pi ON pi.ean_code = si.ean_code
       WHERE si.sale_id = $1::uuid`,
      [id, cloud]
    )

    const items = itemsQ.rows.map(r => ({
      variant_id: r.variant_id,
      qty: Number(r.qty || 0),
      price: Number(r.price || 0),
      mrp: r.mrp != null ? Number(r.mrp) : null,
      size: r.size,
      colour: r.colour,
      ean_code: r.ean_code,
      image_url: r.image_url,
      product_name: r.product_name,
      brand_name: r.brand_name
    }))

    return res.json({ sale: s.rows[0], items })
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

// ══════════════════════════════════════════════════════════════
// ADMIN B2B STATUS UPDATE ROUTE
// ══════════════════════════════════════════════════════════════
router.post('/web/b2b-update-status', requireAuth, async (req, res) => {
  const client = await pool.connect()
  try {
    const { sale_id, new_status, new_payment_status } = req.body || {}
    if (!sale_id) return res.status(400).json({ message: 'sale_id required' })

    await client.query('BEGIN')
    
    // Build the dynamic update query
    let updates = []
    let params = [sale_id]
    let paramIndex = 2

    if (new_status) {
      updates.push(`status = $${paramIndex}`)
      params.push(new_status)
      paramIndex++
    }
    if (new_payment_status) {
      updates.push(`payment_status = $${paramIndex}`)
      params.push(new_payment_status)
      paramIndex++
    }

    if (updates.length === 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({ message: 'No valid updates provided' })
    }

    const q = await client.query(
      `UPDATE sales SET ${updates.join(', ')}, updated_at=now() WHERE id=$1::uuid RETURNING id, status, payment_status`,
      params
    )

    await client.query('COMMIT')
    return res.json(q.rows[0])
  } catch (e) {
    await client.query('ROLLBACK')
    return res.status(500).json({ message: 'Server error during B2B update' })
  } finally {
    client.release()
  }
})

// Ensure this stays at the absolute bottom of the file!
module.exports = router