const express = require('express')
const pool = require('../db')
const Shiprocket = require('../services/shiprocketService')
const { fulfillOrderWithShiprocket } = require('../services/orderFulfillment')

const router = express.Router()

const statusText = (s) => String(s || '').trim().toUpperCase()

const normalizeOrderStatus = (value) => {
  const s = statusText(value)

  if (!s) return ''
  if (s.includes('CANCEL')) return 'CANCELLED'
  if (s.includes('DELIVERED') || s.includes('DELIVERED TO') || s.includes('DELIVER')) return 'DELIVERED'
  if (s.includes('OUT FOR DELIVERY') || s.includes('OUT_FOR_DELIVERY')) return 'SHIPPED'
  if (s.includes('IN TRANSIT') || s.includes('TRANSIT') || s.includes('DISPATCH') || s.includes('DISPATCHED') || s.includes('SHIPPED') || s.includes('PICKED') || s.includes('PICKUP')) return 'SHIPPED'
  if (s.includes('PACKED') || s.includes('MANIFEST') || s.includes('AWB') || s.includes('READY TO SHIP') || s.includes('READY_TO_SHIP')) return 'PACKED'
  if (s.includes('CONFIRMED') || s.includes('PROCESSING') || s.includes('ACCEPTED') || s.includes('CREATED')) return 'CONFIRMED'
  if (s.includes('PLACED') || s.includes('NEW')) return 'PLACED'

  return s
}

const statusRank = (status) => {
  const s = normalizeOrderStatus(status)
  if (s === 'PLACED') return 0
  if (s === 'CONFIRMED') return 1
  if (s === 'PACKED') return 2
  if (s === 'SHIPPED') return 3
  if (s === 'DELIVERED') return 4
  return -1
}

const collectStatusValues = (input, depth = 0, out = []) => {
  if (!input || depth > 6 || out.length > 120) return out

  if (typeof input === 'string' || typeof input === 'number') {
    const v = String(input).trim()
    if (v && v.length <= 200) out.push(v)
    return out
  }

  if (Array.isArray(input)) {
    for (const item of input) collectStatusValues(item, depth + 1, out)
    return out
  }

  if (typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      const k = String(key || '').toLowerCase()
      if (
        k.includes('status') ||
        k.includes('activity') ||
        k.includes('remark') ||
        k.includes('description') ||
        k.includes('event') ||
        k.includes('scan')
      ) {
        if (typeof value === 'string' || typeof value === 'number') out.push(String(value))
        else collectStatusValues(value, depth + 1, out)
      } else if (typeof value === 'object') {
        collectStatusValues(value, depth + 1, out)
      }
    }
  }

  return out
}

const bestOrderStatus = (values, fallback = 'PLACED') => {
  const list = Array.isArray(values) ? values : [values]
  let best = normalizeOrderStatus(fallback) || 'PLACED'
  let bestRank = statusRank(best)

  for (const value of list) {
    const next = normalizeOrderStatus(value)
    if (!next) continue

    if (next === 'CANCELLED') return 'CANCELLED'

    const rank = statusRank(next)
    if (rank > bestRank) {
      best = next
      bestRank = rank
    }
  }

  return best
}

const shouldUpdateSaleStatus = (current, next) => {
  const currentStatus = normalizeOrderStatus(current)
  const nextStatus = normalizeOrderStatus(next)

  if (!nextStatus) return false
  if (currentStatus === 'CANCELLED') return false
  if (nextStatus === 'CANCELLED') return currentStatus !== 'CANCELLED'

  return statusRank(nextStatus) > statusRank(currentStatus)
}

const syncSaleStatus = async (saleId, candidateStatus) => {
  const nextStatus = normalizeOrderStatus(candidateStatus)
  if (!saleId || !nextStatus) return null

  const q = await pool.query('SELECT id, status FROM sales WHERE id=$1::uuid LIMIT 1', [saleId])
  if (!q.rowCount) return null

  const currentStatus = q.rows[0].status
  const finalStatus = bestOrderStatus([currentStatus, nextStatus], currentStatus || 'PLACED')

  if (shouldUpdateSaleStatus(currentStatus, finalStatus)) {
    const upd = await pool.query(
      'UPDATE sales SET status=$2, updated_at=now() WHERE id=$1::uuid RETURNING status',
      [saleId, finalStatus]
    )
    return upd.rows[0]?.status || finalStatus
  }

  return normalizeOrderStatus(currentStatus) || currentStatus
}

const syncShipmentRowsForSale = async (saleId, candidateStatus) => {
  const status = normalizeOrderStatus(candidateStatus)
  if (!saleId || !status) return
  await pool.query('UPDATE shipments SET status=$2 WHERE sale_id=$1', [saleId, status])
  await syncSaleStatus(saleId, status)
}

const extractPayloadStatus = (payload) => {
  return bestOrderStatus(
    [
      payload?.current_status,
      payload?.shipment_status,
      payload?.status,
      payload?.data?.current_status,
      payload?.data?.shipment_status,
      payload?.data?.status,
      payload?.data?.shipment?.current_status,
      payload?.data?.shipment?.shipment_status,
      payload?.data?.shipment?.status,
      ...collectStatusValues(payload)
    ],
    ''
  )
}

const syncWebhookShipment = async (payload) => {
  const status = extractPayloadStatus(payload)
  if (!status) return []

  const shipmentId =
    payload?.shipment_id ||
    payload?.shiprocket_shipment_id ||
    payload?.data?.shipment_id ||
    payload?.data?.shiprocket_shipment_id ||
    payload?.data?.shipment?.shipment_id ||
    null

  const awb =
    payload?.awb ||
    payload?.awb_code ||
    payload?.data?.awb ||
    payload?.data?.awb_code ||
    payload?.data?.shipment?.awb ||
    payload?.data?.shipment?.awb_code ||
    null

  const orderId =
    payload?.order_id ||
    payload?.shiprocket_order_id ||
    payload?.data?.order_id ||
    payload?.data?.shiprocket_order_id ||
    payload?.data?.shipment?.order_id ||
    null

  let rows = []

  if (shipmentId) {
    const q = await pool.query(
      'UPDATE shipments SET status=$1 WHERE shiprocket_shipment_id=$2 RETURNING sale_id',
      [status, shipmentId]
    )
    rows = q.rows
  }

  if (!rows.length && awb) {
    const q = await pool.query(
      'UPDATE shipments SET status=$1 WHERE awb=$2 RETURNING sale_id',
      [status, awb]
    )
    rows = q.rows
  }

  if (!rows.length && orderId) {
    const q = await pool.query(
      'UPDATE shipments SET status=$1 WHERE shiprocket_order_id=$2 RETURNING sale_id',
      [status, orderId]
    )
    rows = q.rows
  }

  const saleIds = Array.from(new Set(rows.map(r => r.sale_id).filter(Boolean).map(String)))

  for (const saleId of saleIds) {
    await syncSaleStatus(saleId, status)
  }

  return saleIds
}

router.get('/shiprocket/warehouses', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, branch_id, warehouse_id, name, pincode, city, state, address, phone, created_at, updated_at FROM shiprocket_warehouses ORDER BY id ASC'
    )
    res.json(rows)
  } catch {
    res.status(500).json({ ok: false, message: 'Failed to fetch warehouses' })
  }
})

router.post('/shiprocket/warehouses/import', async (req, res) => {
  try {
    const sr = new Shiprocket({ pool })
    await sr.init()
    const { data } = await sr.api('get', '/settings/company/pickup')
    const pickups = Array.isArray(data?.data?.shipping_address) ? data.data.shipping_address : []
    const { rows: branches } = await pool.query('SELECT id, name, address, city, state, pincode, phone FROM branches WHERE is_active = true')
    const norm = (s) => String(s ?? '').trim().toLowerCase()
    const results = []

    for (const b of branches) {
      const bpincode = String(b.pincode || '').trim()
      let best = null

      if (bpincode) best = pickups.find((p) => String(p.pin_code || '').trim() === bpincode)

      if (!best && b.city) {
        const cityNorm = norm(b.city)
        best = pickups.find((p) => norm(p.city) === cityNorm)
      }

      if (!best) {
        results.push({ branch_id: b.id, error: 'No matching pickup found in Shiprocket' })
        continue
      }

      const pickupName = best.pickup_location || best.name || b.name
      const pickupId = best.pickup_id || best.id || best.rto_address_id || 0

      await pool.query(
        `INSERT INTO shiprocket_warehouses (branch_id, warehouse_id, name, pincode, city, state, address, phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (branch_id) DO UPDATE
         SET warehouse_id=EXCLUDED.warehouse_id,
             name=EXCLUDED.name,
             pincode=EXCLUDED.pincode,
             city=EXCLUDED.city,
             state=EXCLUDED.state,
             address=EXCLUDED.address,
             phone=EXCLUDED.phone`,
        [
          b.id,
          pickupId,
          pickupName,
          String(best.pin_code || b.pincode || ''),
          best.city || b.city || '',
          best.state || b.state || '',
          best.address || b.address || '',
          b.phone || ''
        ]
      )

      results.push({ branch_id: b.id, mapped_to: pickupName, pickup_id: pickupId })
    }

    res.json({ ok: true, results })
  } catch (e) {
    const msg = e.response?.data || e.message || 'import failed'
    res.status(500).json({ ok: false, message: msg })
  }
})

router.post('/shiprocket/warehouses/sync', async (req, res) => {
  try {
    const sr = new Shiprocket({ pool })
    await sr.init()
    const { rows: branches } = await pool.query('SELECT id, name, address, city, state, pincode, phone, email FROM branches WHERE is_active = true')
    const results = []

    for (const b of branches) {
      try {
        const data = await sr.upsertWarehouseFromBranch(b)
        const pickupName = data?.pickup_location || `${b.name} - ${b.pincode}`

        await pool.query(
          `INSERT INTO shiprocket_warehouses (branch_id, warehouse_id, name, pincode, city, state, address, phone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (branch_id) DO UPDATE 
           SET warehouse_id=EXCLUDED.warehouse_id, name=EXCLUDED.name, pincode=EXCLUDED.pincode, 
               city=EXCLUDED.city, state=EXCLUDED.state, address=EXCLUDED.address, phone=EXCLUDED.phone`,
          [b.id, data?.pickup_id || 0, pickupName, b.pincode, b.city, b.state, b.address, b.phone]
        )

        results.push({ branch_id: b.id, pickup: pickupName })
      } catch (innerErr) {
        results.push({ branch_id: b.id, error: innerErr.response?.data || innerErr.message })
      }
    }

    res.json({ ok: true, results })
  } catch (e) {
    const errData = e.response?.data || e.message || 'sync failed'
    res.status(500).json({ ok: false, message: errData })
  }
})

router.post('/shiprocket/fulfill/:id', async (req, res) => {
  try {
    const id = req.params.id
    const saleRes = await pool.query('SELECT * FROM sales WHERE id=$1', [id])

    if (!saleRes.rows.length) return res.status(404).json({ ok: false, message: 'Sale not found' })

    const sale = saleRes.rows[0]
    const items = (await pool.query('SELECT * FROM sale_items WHERE sale_id=$1', [id])).rows

    sale.items = items

    const shipments = await fulfillOrderWithShiprocket(sale, pool)
    const status = bestOrderStatus(collectStatusValues(shipments), 'CONFIRMED')

    await syncSaleStatus(id, status)

    res.json({ ok: true, status, shipments })
  } catch (e) {
    const errData = e.response?.data || e.message || 'fulfillment failed'
    res.status(500).json({ ok: false, message: errData })
  }
})

router.post('/shiprocket/webhook', async (req, res) => {
  try {
    const payload = req.body || {}
    const saleIds = await syncWebhookShipment(payload)
    res.json({ ok: true, sale_ids: saleIds })
  } catch {
    res.status(200).json({ ok: true })
  }
})

async function computeServiceabilityForSaleId(saleId) {
  const saleRes = await pool.query('SELECT * FROM sales WHERE id=$1', [saleId])
  if (!saleRes.rows.length) return { error: { code: 404, body: { ok: false, message: 'Sale not found' } } }

  const sale = saleRes.rows[0]
  const deliveryPin = String(sale?.shipping_address?.pincode || sale?.pincode || '').trim()

  if (!deliveryPin || deliveryPin.length !== 6) {
    return { error: { code: 400, body: { ok: false, message: 'Invalid delivery pincode' } } }
  }

  let pickupPin = ''

  if (sale?.branch_id) {
    const br = await pool.query('SELECT pincode FROM branches WHERE id=$1 LIMIT 1', [sale.branch_id])
    pickupPin = String(br.rows[0]?.pincode || '').trim()
  }

  if (!pickupPin) {
    const { rows } = await pool.query('SELECT pincode FROM branches WHERE is_active = true AND pincode IS NOT NULL LIMIT 1')
    pickupPin = String(rows[0]?.pincode || '').trim()
  }

  if (!pickupPin || pickupPin.length !== 6) {
    return { error: { code: 500, body: { ok: false, message: 'No pickup pincode configured' } } }
  }

  const payable = typeof sale.totals === 'object' && sale.totals !== null ? Number(sale.totals.payable || 0) : Number(sale.total || 0)
  const cod = String(sale.payment_status || '').toUpperCase() === 'COD' && payable > 0

  const sr = new Shiprocket({ pool })
  await sr.init()

  const data = await sr.checkServiceability({
    pickup_postcode: pickupPin,
    delivery_postcode: deliveryPin,
    cod,
    weight: 0.5
  })

  return { data, meta: { pickup_postcode: pickupPin, delivery_postcode: deliveryPin, cod, weight: 0.5 } }
}

async function getShipmentsForSale(saleId) {
  const { rows } = await pool.query('SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC', [saleId])

  if (!rows.length) return { error: { code: 404, body: { ok: false, message: 'No shipments found for this sale' } } }

  const shipmentIds = rows.map((r) => r.shiprocket_shipment_id).filter((v) => v != null)

  if (!shipmentIds.length) return { error: { code: 404, body: { ok: false, message: 'No Shiprocket shipment ids found' } } }

  return { rows, shipmentIds }
}

async function getLatestShiprocketOrderIdForSale(saleId) {
  const { rows } = await pool.query('SELECT shiprocket_order_id FROM shipments WHERE sale_id=$1 AND shiprocket_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 1', [saleId])
  const orderId = rows?.[0]?.shiprocket_order_id || null

  if (!orderId) return { error: { code: 404, body: { ok: false, message: 'Shiprocket order id not found for this sale' } } }

  return { orderId }
}

router.get('/shiprocket/serviceability/:saleId', async (req, res) => {
  try {
    const out = await computeServiceabilityForSaleId(req.params.saleId)
    if (out.error) return res.status(out.error.code).json(out.error.body)
    res.json({ ok: true, ...out.meta, ...out.data })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch serviceability'
    res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/serviceability/by-sale/:saleId', async (req, res) => {
  try {
    const out = await computeServiceabilityForSaleId(req.params.saleId)
    if (out.error) return res.status(out.error.code).json(out.error.body)
    res.json({ ok: true, ...out.meta, ...out.data })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch serviceability'
    res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/serviceability/sale/:saleId', async (req, res) => {
  try {
    const out = await computeServiceabilityForSaleId(req.params.saleId)
    if (out.error) return res.status(out.error.code).json(out.error.body)
    res.json({ ok: true, ...out.meta, ...out.data })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch serviceability'
    res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/pincode', async (req, res) => {
  try {
    const deliveryPin = String(req.query.pincode || '').trim()
    if (!deliveryPin || deliveryPin.length !== 6) return res.status(400).json({ ok: false, message: 'Invalid pincode' })

    const { rows } = await pool.query('SELECT pincode FROM branches WHERE is_active = true AND pincode IS NOT NULL LIMIT 1')
    const pickupPin = String(rows[0]?.pincode || '').trim()

    if (!pickupPin) return res.status(500).json({ ok: false, message: 'No pickup pincode configured' })

    const sr = new Shiprocket({ pool })
    await sr.init()

    const data = await sr.checkServiceability({
      pickup_postcode: pickupPin,
      delivery_postcode: deliveryPin,
      cod: true,
      weight: 0.5
    })

    const list = Array.isArray(data?.data?.available_courier_companies) ? data.data.available_courier_companies : []
    const serviceable = list.length > 0

    return res.json({
      ok: true,
      serviceable,
      est_delivery: list[0]?.etd || null,
      cod_available: list.some((c) => Number(c.cod) === 1)
    })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to check pincode'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.post('/shiprocket/assign-courier/by-sale/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const courier_company_id = Number(req.body?.courier_company_id || 0)

    if (!courier_company_id) return res.status(400).json({ ok: false, message: 'courier_company_id is required' })

    const out = await getShipmentsForSale(saleId)
    if (out.error) return res.status(out.error.code).json(out.error.body)

    const sr = new Shiprocket({ pool })
    await sr.init()

    const { data } = await sr.api('post', '/courier/assign/awb', {
      shipment_id: out.shipmentIds,
      courier_company_id
    })

    const statusCode = Number(data?.status_code || 0)
    const awbAssignStatus = data?.awb_assign_status != null ? Number(data.awb_assign_status) : null
    const message = data?.message || ''
    const srErr = data?.response?.data?.awb_assign_error || ''

    const walletLow = statusCode === 350 || /recharge/i.test(message) || /recharge/i.test(srErr)
    const success = awbAssignStatus === 1 || statusCode === 200

    if (walletLow || !success) {
      return res.status(400).json({ ok: false, message: srErr || message || 'Unable to assign courier / generate AWB', data })
    }

    await syncShipmentRowsForSale(saleId, 'PACKED')

    return res.json({ ok: true, status: 'PACKED', data })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to assign courier'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.post('/shiprocket/assign-courier', async (req, res) => {
  try {
    const saleId = String(req.body?.saleId || req.body?.sale_id || '').trim()
    const courier_company_id = Number(req.body?.courier_company_id || 0)

    if (!saleId) return res.status(400).json({ ok: false, message: 'saleId is required' })
    if (!courier_company_id) return res.status(400).json({ ok: false, message: 'courier_company_id is required' })

    const out = await getShipmentsForSale(saleId)
    if (out.error) return res.status(out.error.code).json(out.error.body)

    const sr = new Shiprocket({ pool })
    await sr.init()

    const { data } = await sr.api('post', '/courier/assign/awb', {
      shipment_id: out.shipmentIds,
      courier_company_id
    })

    const statusCode = Number(data?.status_code || 0)
    const awbAssignStatus = data?.awb_assign_status != null ? Number(data.awb_assign_status) : null
    const message = data?.message || ''
    const srErr = data?.response?.data?.awb_assign_error || ''

    const walletLow = statusCode === 350 || /recharge/i.test(message) || /recharge/i.test(srErr)
    const success = awbAssignStatus === 1 || statusCode === 200

    if (walletLow || !success) {
      return res.status(400).json({ ok: false, message: srErr || message || 'Unable to assign courier / generate AWB', data })
    }

    await syncShipmentRowsForSale(saleId, 'PACKED')

    return res.json({ ok: true, status: 'PACKED', data })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to assign courier'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.post('/shiprocket/assign-awb/by-sale/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const out = await getShipmentsForSale(saleId)

    if (out.error) return res.status(out.error.code).json(out.error.body)

    const sr = new Shiprocket({ pool })
    await sr.init()

    const result = await sr.assignAWBAndLabel({ shipment_id: out.shipmentIds })

    const statusCode = Number(result?.status_code || result?.data?.status_code || 0)
    const message = result?.message || result?.data?.message || ''
    const srErr = result?.response?.data?.awb_assign_error || result?.data?.response?.data?.awb_assign_error || ''

    const walletLow = statusCode === 350 || /recharge/i.test(message) || /recharge/i.test(srErr)

    if (walletLow || statusCode !== 200) {
      return res.status(400).json({ ok: false, message: srErr || message || 'Unable to generate AWB', result })
    }

    await syncShipmentRowsForSale(saleId, 'PACKED')

    return res.json({ ok: true, status: 'PACKED', result })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to assign AWB'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.post('/shiprocket/assign-awb', async (req, res) => {
  try {
    const saleId = String(req.body?.saleId || req.body?.sale_id || '').trim()

    if (!saleId) return res.status(400).json({ ok: false, message: 'saleId is required' })

    const out = await getShipmentsForSale(saleId)
    if (out.error) return res.status(out.error.code).json(out.error.body)

    const sr = new Shiprocket({ pool })
    await sr.init()

    const result = await sr.assignAWBAndLabel({ shipment_id: out.shipmentIds })

    const statusCode = Number(result?.status_code || result?.data?.status_code || 0)
    const message = result?.message || result?.data?.message || ''
    const srErr = result?.response?.data?.awb_assign_error || result?.data?.response?.data?.awb_assign_error || ''

    const walletLow = statusCode === 350 || /recharge/i.test(message) || /recharge/i.test(srErr)

    if (walletLow || statusCode !== 200) {
      return res.status(400).json({ ok: false, message: srErr || message || 'Unable to generate AWB', result })
    }

    await syncShipmentRowsForSale(saleId, 'PACKED')

    return res.json({ ok: true, status: 'PACKED', result })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to assign AWB'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/tracking/by-sale/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const out = await getLatestShiprocketOrderIdForSale(saleId)

    if (out.error) return res.status(out.error.code).json(out.error.body)

    const sr = new Shiprocket({ pool })
    await sr.init()

    const orderId = out.orderId
    const { data } = await sr.api('get', `/courier/track?order_id=${encodeURIComponent(String(orderId))}`)
    const effectiveStatus = bestOrderStatus(collectStatusValues(data), '')

    if (effectiveStatus) {
      await pool.query(
        'UPDATE shipments SET status=$1 WHERE sale_id=$2 AND shiprocket_order_id=$3',
        [effectiveStatus, saleId, orderId]
      )
      await syncSaleStatus(saleId, effectiveStatus)
    }

    return res.json({ ok: true, effective_status: effectiveStatus || null, data })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch tracking'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/label/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const { rows } = await pool.query('SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC', [saleId])

    if (!rows.length) return res.status(404).json({ ok: false, message: 'No shipments found for this sale' })

    const existingWithLabel = rows.find((r) => r.label_url)
    if (existingWithLabel && existingWithLabel.label_url) return res.redirect(existingWithLabel.label_url)

    const shipmentIds = rows.map((r) => r.shiprocket_shipment_id).filter((v) => v != null)
    if (!shipmentIds.length) return res.status(404).json({ ok: false, message: 'No Shiprocket shipment ids found' })

    const sr = new Shiprocket({ pool })
    await sr.init()

    const result = await sr.assignAWBAndLabel({ shipment_id: shipmentIds })
    const labelUrl = result?.label?.label_url || result?.label_url || null

    if (!labelUrl) return res.status(500).json({ ok: false, message: 'Unable to generate label' })

    await syncShipmentRowsForSale(saleId, 'PACKED')

    return res.redirect(labelUrl)
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch label'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/invoice/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const { rows } = await pool.query('SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC', [saleId])

    if (!rows.length) return res.status(404).json({ ok: false, message: 'No shipments found for this sale' })

    const orderIds = Array.from(new Set(rows.map((r) => r.shiprocket_order_id).filter((v) => v != null)))
    if (!orderIds.length) return res.status(404).json({ ok: false, message: 'No Shiprocket order ids found' })

    const sr = new Shiprocket({ pool })
    await sr.init()

    const { data } = await sr.api('post', '/orders/print/invoice', { ids: orderIds })
    const invoiceUrl = data?.invoice_url || data?.data?.invoice_url || null

    if (!invoiceUrl) return res.status(500).json({ ok: false, message: 'Unable to generate invoice' })

    return res.redirect(invoiceUrl)
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch invoice'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/manifest/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const { rows } = await pool.query('SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC', [saleId])

    if (!rows.length) return res.status(404).json({ ok: false, message: 'No shipments found for this sale' })

    const shipmentIds = rows.map((r) => r.shiprocket_shipment_id).filter((v) => v != null)
    if (!shipmentIds.length) return res.status(404).json({ ok: false, message: 'No Shiprocket shipment ids found' })

    const sr = new Shiprocket({ pool })
    await sr.init()

    const data = await sr.generateManifest({ shipment_ids: shipmentIds })
    const manifestUrl = data?.manifest_url || data?.data?.manifest_url || null

    if (!manifestUrl) return res.status(500).json({ ok: false, message: 'Unable to generate manifest' })

    return res.redirect(manifestUrl)
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch manifest'
    return res.status(500).json({ ok: false, message: msg })
  }
})

module.exports = router