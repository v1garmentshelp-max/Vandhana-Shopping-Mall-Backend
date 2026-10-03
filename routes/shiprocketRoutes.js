const express = require('express')
const pool = require('../db')
const Shiprocket = require('../services/shiprocketService')
const { fulfillOrderWithShiprocket } = require('../services/orderFulfillment')

const router = express.Router()
const { requireOrderStaff, requireOrderBranch } = require('../middleware/orderStaffAuth')
const { requireSuperAdmin } = require('../middleware/auth')
// Public serviceability and authenticated carrier webhooks remain available.
router.use('/shiprocket', (req,res,next) => {
  if (req.path === '/webhook' || req.path === '/pincode') return next()
  return requireOrderStaff(req,res,next)
})
router.use('/shiprocket/warehouses', requireSuperAdmin)

const sharedStatus = require('../services/orderStatusSync')
const { statusText,normalizeOrderStatus,statusRank,collectStatusValues,bestOrderStatus,shouldUpdateStatus } = sharedStatus

const normalizeRemittanceStatus = (value) => {
  const s = statusText(value)

  if (!s) return ''
  if (s.includes('RECEIVED') || s.includes('REMITTED') || s.includes('SETTLED') || s.includes('PAID') || s.includes('TRANSFERRED') || s.includes('CREDITED')) return 'RECEIVED'
  if (s.includes('SCHEDULED') || s.includes('PROCESSING') || s.includes('INITIATED')) return 'REMITTANCE_SCHEDULED'
  if (s.includes('FAILED') || s.includes('REJECTED')) return 'FAILED'
  if (s.includes('HOLD')) return 'ON_HOLD'
  if (s.includes('PENDING')) return 'PENDING'
  if (s.includes('NOT_RECEIVED')) return 'NOT_RECEIVED'

  return s
}

const parseDateValue = (value) => {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

const findFirstByKeys = (input, keys, depth = 0) => {
  if (!input || depth > 8) return null

  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findFirstByKeys(item, keys, depth + 1)
      if (found != null && found !== '') return found
    }
    return null
  }

  if (typeof input !== 'object') return null

  for (const [key, value] of Object.entries(input)) {
    const k = String(key || '').toLowerCase()
    if (keys.some((x) => k === x || k.includes(x))) {
      if (value != null && value !== '') return value
    }
  }

  for (const value of Object.values(input)) {
    if (value && typeof value === 'object') {
      const found = findFirstByKeys(value, keys, depth + 1)
      if (found != null && found !== '') return found
    }
  }

  return null
}

const extractUuid = (value) => {
  const text = String(value || '')
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return m ? m[0] : null
}

const extractTrackingData = (tracking) => {
  if (!tracking) return null

  let data = tracking

  if (Array.isArray(data) && data.length) {
    const first = data[0]
    if (first && typeof first === 'object') {
      const key = Object.keys(first)[0]
      if (key && first[key]?.tracking_data) data = first[key].tracking_data
      else data = first
    }
  }

  if (data?.tracking_data) data = data.tracking_data
  else if (data?.data?.tracking_data) data = data.data.tracking_data
  else if (data?.data?.data?.tracking_data) data = data.data.data.tracking_data
  else if (data?.data) data = data.data

  return data && typeof data === 'object' ? data : tracking
}

const extractShipmentInfo = (raw, fallbackStatus = '') => {
  const data = extractTrackingData(raw) || raw || {}
  const currentInfo = sharedStatus.extractShipmentInfo(raw,fallbackStatus)
  const { statuses, raw_status: rawStatus, status } = currentInfo
  const awb = findFirstByKeys(data, ['awb_code', 'awb_number', 'awb'])
  const trackingUrl = findFirstByKeys(data, ['tracking_url', 'track_url'])
  const labelUrl = findFirstByKeys(data, ['label_url'])
  const currentLocation = currentInfo.current_location
  const deliveredAt = currentInfo.delivered_at
  const shiprocketOrderId = currentInfo.shiprocket_order_id
  const shiprocketShipmentId = findFirstByKeys(data, ['shiprocket_shipment_id', 'shipment_id'])
  const channelOrderId = findFirstByKeys(data, ['channel_order_id'])
  const saleId = currentInfo.sale_id

  const remittanceStatus =
    findFirstByKeys(data, ['remittance_status', 'cod_remittance_status', 'settlement_status', 'payment_remittance_status']) ||
    null

  const remittanceUtr =
    findFirstByKeys(data, ['remittance_utr', 'utr', 'utr_number', 'transaction_reference']) ||
    null

  const remittanceDate =
    findFirstByKeys(data, ['remittance_date', 'settlement_date', 'paid_date', 'payment_date']) ||
    null

  const scheduledFrom =
    findFirstByKeys(data, ['remittance_scheduled_from', 'scheduled_from']) ||
    null

  const scheduledTo =
    findFirstByKeys(data, ['remittance_scheduled_to', 'scheduled_to']) ||
    null

  const codAmount =
    findFirstByKeys(data, ['cod_amount', 'collectable_amount', 'collected_amount', 'remittance_amount', 'amount']) ||
    null

  return {
    raw: data,
    statuses,
    raw_status: rawStatus ? String(rawStatus) : null,
    status: status || null,
    awb: awb != null && awb !== '' ? String(awb) : null,
    tracking_url: trackingUrl != null && trackingUrl !== '' ? String(trackingUrl) : null,
    label_url: labelUrl != null && labelUrl !== '' ? String(labelUrl) : null,
    current_location: currentLocation != null && currentLocation !== '' ? String(currentLocation) : null,
    delivered_at: deliveredAt || null,
    shiprocket_order_id: shiprocketOrderId != null && shiprocketOrderId !== '' ? String(shiprocketOrderId) : null,
    shiprocket_shipment_id: shiprocketShipmentId != null && shiprocketShipmentId !== '' ? String(shiprocketShipmentId) : null,
    sale_id: saleId,
    remittance_status: remittanceStatus ? String(remittanceStatus) : null,
    remittance_utr: remittanceUtr ? String(remittanceUtr) : null,
    remittance_date: remittanceDate || null,
    remittance_scheduled_from: scheduledFrom || null,
    remittance_scheduled_to: scheduledTo || null,
    cod_amount: codAmount != null && codAmount !== '' ? Number(codAmount) : null
  }
}

const getPayableFromSale = (sale) => {
  const totals = sale?.totals && typeof sale.totals === 'object' ? sale.totals : {}
  const n = Number(totals.payable ?? totals.total ?? sale?.total ?? 0)
  return Number.isFinite(n) ? n : 0
}

const syncSaleStatus = async (saleId, candidateStatus) => {
  const nextStatus = normalizeOrderStatus(candidateStatus)
  if (!saleId || !nextStatus) return null

  const q = await pool.query('SELECT id, status FROM sales WHERE id=$1::uuid LIMIT 1', [saleId])
  if (!q.rowCount) return null

  const currentStatus = q.rows[0].status
  const finalStatus = bestOrderStatus([currentStatus, nextStatus], currentStatus || 'PLACED')

  if (shouldUpdateStatus(currentStatus, finalStatus)) {
    const upd = await pool.query(
      'UPDATE sales SET status=$2, updated_at=now() WHERE id=$1::uuid RETURNING status',
      [saleId, finalStatus]
    )
    return upd.rows[0]?.status || finalStatus
  }

  return normalizeOrderStatus(currentStatus) || currentStatus
}

const findShipmentRows = async (identifiers = {}) => {
  const conditions = []
  const params = []

  if (identifiers.shiprocket_shipment_id) {
    params.push(String(identifiers.shiprocket_shipment_id))
    conditions.push(`shiprocket_shipment_id = $${params.length}`)
  }

  if (identifiers.awb) {
    params.push(String(identifiers.awb))
    conditions.push(`awb = $${params.length}`)
  }

  if (identifiers.shiprocket_order_id) {
    params.push(String(identifiers.shiprocket_order_id))
    conditions.push(`shiprocket_order_id = $${params.length}`)
  }

  if (identifiers.sale_id) {
    params.push(String(identifiers.sale_id))
    conditions.push(`sale_id = $${params.length}::uuid`)
  }

  if (!conditions.length) return []

  const q = await pool.query(
    `SELECT *
     FROM shipments
     WHERE ${conditions.join(' OR ')}
     ORDER BY created_at DESC`,
    params
  )

  return q.rows || []
}

const syncCodRemittance = async (saleId, shipment, info, raw) => {
  if (!saleId) return null

  const saleQ = await pool.query(
    'SELECT id, payment_status, payment_method, total, totals FROM sales WHERE id=$1::uuid LIMIT 1',
    [saleId]
  )

  if (!saleQ.rowCount) return null

  const sale = saleQ.rows[0]
  const paymentStatus = statusText(sale.payment_status || sale.payment_method)

  if (paymentStatus !== 'COD') return null

  let remittanceStatus = normalizeRemittanceStatus(info.remittance_status)

  if (!remittanceStatus && normalizeOrderStatus(info.status || shipment?.status) === 'DELIVERED') {
    remittanceStatus = 'NOT_RECEIVED'
  }

  if (!remittanceStatus) return null

  const amount = Number.isFinite(Number(info.cod_amount)) && Number(info.cod_amount) > 0 ? Number(info.cod_amount) : getPayableFromSale(sale)
  const awb = info.awb || shipment?.awb || null
  const shiprocketOrderId = info.shiprocket_order_id || shipment?.shiprocket_order_id || null
  const shiprocketShipmentId = info.shiprocket_shipment_id || shipment?.shiprocket_shipment_id || null
  const remittanceDate = parseDateValue(info.remittance_date)
  const scheduledFrom = parseDateValue(info.remittance_scheduled_from)
  const scheduledTo = parseDateValue(info.remittance_scheduled_to)

  const existing = await pool.query(
    `SELECT id, remittance_status
     FROM cod_remittances
     WHERE sale_id = $1::uuid
        OR ($2::text IS NOT NULL AND awb = $2)
     ORDER BY created_at DESC
     LIMIT 1`,
    [saleId, awb]
  )

  if (existing.rowCount) {
    const q = await pool.query(
      `UPDATE cod_remittances
       SET shipment_id = COALESCE($2::uuid, shipment_id),
           awb = COALESCE(NULLIF($3, ''), awb),
           shiprocket_order_id = COALESCE(NULLIF($4, ''), shiprocket_order_id),
           shiprocket_shipment_id = COALESCE(NULLIF($5, ''), shiprocket_shipment_id),
           cod_amount = COALESCE($6, cod_amount),
           remittance_status = CASE
             WHEN remittance_status = 'RECEIVED' AND $7 <> 'RECEIVED' THEN remittance_status
             ELSE $7
           END,
           remittance_utr = COALESCE(NULLIF($8, ''), remittance_utr),
           remittance_date = COALESCE($9::timestamptz, remittance_date),
           remittance_scheduled_from = COALESCE($10::timestamptz, remittance_scheduled_from),
           remittance_scheduled_to = COALESCE($11::timestamptz, remittance_scheduled_to),
           raw_payload = COALESCE($12::jsonb, raw_payload),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        existing.rows[0].id,
        shipment?.id || null,
        awb || '',
        shiprocketOrderId || '',
        shiprocketShipmentId || '',
        amount,
        remittanceStatus,
        info.remittance_utr || '',
        remittanceDate,
        scheduledFrom,
        scheduledTo,
        JSON.stringify(raw || info.raw || {})
      ]
    )

    return q.rows[0] || null
  }

  const q = await pool.query(
    `INSERT INTO cod_remittances
       (sale_id, shipment_id, awb, shiprocket_order_id, shiprocket_shipment_id, cod_amount, remittance_status, remittance_utr, remittance_date, remittance_scheduled_from, remittance_scheduled_to, raw_payload)
     VALUES
       ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11::timestamptz,$12::jsonb)
     RETURNING *`,
    [
      saleId,
      shipment?.id || null,
      awb,
      shiprocketOrderId,
      shiprocketShipmentId,
      amount,
      remittanceStatus,
      info.remittance_utr || null,
      remittanceDate,
      scheduledFrom,
      scheduledTo,
      JSON.stringify(raw || info.raw || {})
    ]
  )

  return q.rows[0] || null
}

const syncShipmentRows = async (rows,raw,fallbackStatus='') => {
  const info=extractShipmentInfo(raw,fallbackStatus)
  const saved=await sharedStatus.syncShipmentRows(pool,rows,raw,fallbackStatus)
  for(const shipment of saved) if(shipment?.sale_id) await syncCodRemittance(shipment.sale_id,shipment,info,raw)
  return saved
}

const syncShipmentByIdentifiers = async (identifiers = {}, raw = {}, fallbackStatus = '') => {
  const info = extractShipmentInfo(raw, fallbackStatus)

  const merged = {
    sale_id: identifiers.sale_id || info.sale_id || null,
    shiprocket_order_id: identifiers.shiprocket_order_id || info.shiprocket_order_id || null,
    shiprocket_shipment_id: identifiers.shiprocket_shipment_id || info.shiprocket_shipment_id || null,
    awb: identifiers.awb || info.awb || null
  }

  const rows = await findShipmentRows(merged)
  if (!rows.length) return []

  return syncShipmentRows(rows, raw, fallbackStatus || info.status || info.raw_status || '')
}

const syncShipmentRowsForSale = async (saleId, candidateStatus, raw = null) => {
  const status = normalizeOrderStatus(candidateStatus)
  if (!saleId || !status) return []

  const q = await pool.query('SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC', [saleId])
  const rows = q.rows || []

  if (!rows.length) {
    await syncSaleStatus(saleId, status)
    return []
  }

  const updated = await syncShipmentRows(rows, raw || { status }, status)
  await syncSaleStatus(saleId, status)
  return updated
}

const insertWebhookEvent = async ({ payload, info, processed, errorMessage, saleId, shipmentId }) => {
  try {
    await pool.query(
      `INSERT INTO shiprocket_webhook_events
       (sale_id, shipment_id, shiprocket_order_id, shiprocket_shipment_id, awb, raw_status, normalized_status, payload, processed, error_message)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [
        saleId || info.sale_id || null,
        shipmentId || null,
        info.shiprocket_order_id || null,
        info.shiprocket_shipment_id || null,
        info.awb || null,
        info.raw_status || null,
        info.status || null,
        JSON.stringify(payload || {}),
        !!processed,
        errorMessage || null
      ]
    )
  } catch {}
}

const verifyWebhookToken = (req, res, next) => {
  const expected = String(process.env.SHIPROCKET_WEBHOOK_TOKEN || '').trim()
  const received = String(req.headers['x-api-key'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()

  if (!expected) {
    return res.status(500).json({ ok: false, message: 'Webhook token not configured' })
  }

  if (received !== expected) {
    return res.status(401).json({ ok: false, message: 'Invalid webhook token' })
  }

  next()
}

const handleShiprocketWebhook = async (req, res) => {
  const payload = req.body || {}
  const info = extractShipmentInfo(payload)
  let updated = []
  let rows = []
  let processedSaleId = info.sale_id || null
  let processedShipmentId = null
  let errorMessage = null

  try {
    if(payload.is_return===true||Number(payload.is_return)===1){
      const result=await require('../services/returnTracking').syncReturnTracking(pool,payload);
      return res.status(200).json({ok:true,processed:result.matched>0,is_return:true});
    }
    rows = await findShipmentRows({
      sale_id: info.sale_id,
      shiprocket_order_id: info.shiprocket_order_id,
      shiprocket_shipment_id: info.shiprocket_shipment_id,
      awb: info.awb
    })

    if (rows.length) {
      updated = await syncShipmentRows(rows, payload, info.status || info.raw_status || '')
      processedSaleId = updated[0]?.sale_id || rows[0]?.sale_id || processedSaleId
      processedShipmentId = updated[0]?.id || rows[0]?.id || null
    } else if (info.sale_id && info.status) {
      await syncSaleStatus(info.sale_id, info.status)
      processedSaleId = info.sale_id
    }
  } catch (err) {
    errorMessage = err?.message || String(err)
  }

  await insertWebhookEvent({
    payload,
    info,
    processed: updated.length > 0 || !!processedSaleId,
    errorMessage,
    saleId: processedSaleId,
    shipmentId: processedShipmentId
  })

  if (errorMessage) return res.status(503).json({ ok:false,message:'Tracking update could not be recorded. Retry this event.' })
  return res.status(200).json({
    ok: true,
    processed: updated.length > 0 || !!processedSaleId,
    sale_id: processedSaleId,
    shipment_id: processedShipmentId,
    status: info.status || null,
    awb: info.awb || null
  })
}

router.get('/webhooks/orders', (_req, res) => {
  res.json({ ok: true, method: 'POST' })
})

router.post('/webhooks/orders', verifyWebhookToken, handleShiprocketWebhook)

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

router.post('/shiprocket/fulfill/:id', (req, res) => {
  res.status(409).json({ ok: false, message: 'Use Connect order in the updated admin. Legacy fulfillment is disabled to prevent duplicate stock deductions.' })
})

router.post('/shiprocket/webhook', verifyWebhookToken, handleShiprocketWebhook)

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

router.get('/shiprocket/serviceability/:saleId', requireOrderBranch('saleId'), async (req, res) => {
  try {
    const out = await computeServiceabilityForSaleId(req.params.saleId)
    if (out.error) return res.status(out.error.code).json(out.error.body)
    res.json({ ok: true, ...out.meta, ...out.data })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch serviceability'
    res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/serviceability/by-sale/:saleId', requireOrderBranch('saleId'), async (req, res) => {
  try {
    const out = await computeServiceabilityForSaleId(req.params.saleId)
    if (out.error) return res.status(out.error.code).json(out.error.body)
    res.json({ ok: true, ...out.meta, ...out.data })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch serviceability'
    res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/serviceability/sale/:saleId', requireOrderBranch('saleId'), async (req, res) => {
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

router.post('/shiprocket/assign-courier/by-sale/:saleId', (req, res) => res.status(409).json({ message: 'Use the updated order shipping panel to generate AWB safely.' }))
router.post('/shiprocket/assign-courier', (req, res) => res.status(409).json({ message: 'Use the updated order shipping panel to generate AWB safely.' }))
router.post('/shiprocket/assign-awb/by-sale/:saleId', (req, res) => res.status(409).json({ message: 'Use the updated order shipping panel to generate AWB safely.' }))
router.post('/shiprocket/assign-awb', (req, res) => res.status(409).json({ message: 'Use the updated order shipping panel to generate AWB safely.' }))
router.get('/shiprocket/tracking/by-sale/:saleId', requireOrderBranch('saleId'), async (req, res) => {
  try {
    const saleId = req.params.saleId
    const out = await getLatestShiprocketOrderIdForSale(saleId)

    if (out.error) return res.status(out.error.code).json(out.error.body)

    const sr = new Shiprocket({ pool })
    await sr.init()

    const orderId = out.orderId
    const { data } = await sr.api('get', `/courier/track?order_id=${encodeURIComponent(String(orderId))}`)
    const info = extractShipmentInfo(data, '')
    const effectiveStatus = bestOrderStatus([info.status, info.raw_status, ...collectStatusValues(data)], '')

    await syncShipmentByIdentifiers(
      {
        sale_id: saleId,
        shiprocket_order_id: orderId,
        awb: info.awb,
        shiprocket_shipment_id: info.shiprocket_shipment_id
      },
      data,
      effectiveStatus || ''
    )

    if (effectiveStatus) {
      await syncSaleStatus(saleId, effectiveStatus)
    }

    return res.json({ ok: true, effective_status: effectiveStatus || null, awb: info.awb || null, data })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch tracking'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/label/:saleId', requireOrderBranch('saleId'), async (req, res) => {
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

    await syncShipmentRowsForSale(saleId, 'PACKED', result)

    return res.redirect(labelUrl)
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch label'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/invoice/:saleId', requireOrderBranch('saleId'), async (req, res) => {
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

router.get('/shiprocket/manifest/:saleId', requireOrderBranch('saleId'), async (req, res) => {
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
