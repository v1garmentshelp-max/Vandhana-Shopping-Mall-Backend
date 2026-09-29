const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()

const getUserRole = (req) => {
  return String(req.user?.role_enum || req.user?.role || '').toUpperCase()
}

const statusText = (v) => String(v || '').trim().toUpperCase()

const toNumber = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const parseTotals = (v) => {
  if (!v) return {}
  if (typeof v === 'object') return v
  try {
    return JSON.parse(v)
  } catch {
    return {}
  }
}

const getPayable = (sale) => {
  const totals = parseTotals(sale?.totals)
  return toNumber(totals.payable ?? totals.total ?? totals.subtotal ?? totals.bagTotal ?? sale?.total ?? 0)
}

const normalizeOrderStatus = (value) => {
  const s = statusText(value)

  if (!s) return ''
  if (s.includes('CANCEL')) return 'CANCELLED'
  if (s.includes('RTO')) return 'RTO'
  if (s.includes('DELIVER')) return 'DELIVERED'
  if (s.includes('OUT FOR DELIVERY') || s.includes('OUT_FOR_DELIVERY')) return 'SHIPPED'
  if (s.includes('IN TRANSIT') || s.includes('TRANSIT') || s.includes('DISPATCH') || s.includes('SHIPPED') || s.includes('PICKED') || s.includes('PICKUP')) return 'SHIPPED'
  if (s.includes('PACKED') || s.includes('MANIFEST') || s.includes('AWB') || s.includes('READY TO SHIP')) return 'PACKED'
  if (s.includes('CONFIRM') || s.includes('PROCESSING') || s.includes('ACCEPTED') || s.includes('CREATED')) return 'CONFIRMED'
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
  if (s === 'RTO') return 5
  if (s === 'CANCELLED') return 6
  return -1
}

const bestOrderStatus = (values, fallback = 'PLACED') => {
  const list = Array.isArray(values) ? values : [values]
  let best = normalizeOrderStatus(fallback) || 'PLACED'
  let bestRank = statusRank(best)

  for (const value of list) {
    const next = normalizeOrderStatus(value)
    if (!next) continue

    if (next === 'CANCELLED') return 'CANCELLED'
    if (next === 'RTO') return 'RTO'

    const rank = statusRank(next)
    if (rank > bestRank) {
      best = next
      bestRank = rank
    }
  }

  return best
}

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

const deriveCodStatus = (sale, shipment, remittance) => {
  const paymentStatus = statusText(sale.payment_status || sale.payment_method)
  const orderStatus = normalizeOrderStatus(sale.effective_status || sale.status)
  const remittanceStatus = normalizeRemittanceStatus(remittance?.remittance_status)

  if (paymentStatus !== 'COD') return null
  if (remittanceStatus) return remittanceStatus
  if (orderStatus === 'DELIVERED' || normalizeOrderStatus(shipment?.status) === 'DELIVERED') return 'NOT_RECEIVED'

  return 'PENDING'
}

const mapTransactionRow = (row) => {
  const latestShipment = row.latest_shipment || null
  const latestCodRemittance = row.latest_cod_remittance || null
  const codRemittances = Array.isArray(row.cod_remittances) ? row.cod_remittances : []
  const effectiveStatus = bestOrderStatus(
    [
      row.status,
      row.effective_status,
      latestShipment?.status,
      latestShipment?.raw_status,
      latestShipment?.awb ? 'PACKED' : ''
    ],
    row.status || 'PLACED'
  )

  const codStatus = deriveCodStatus(
    { ...row, effective_status: effectiveStatus },
    latestShipment,
    latestCodRemittance
  )

  return {
    ...row,
    stored_status: row.status || null,
    status: effectiveStatus,
    effective_status: effectiveStatus,
    latest_shipment: latestShipment,
    cod_remittances: codRemittances,
    latest_cod_remittance: latestCodRemittance,
    cod_remittance_status: codStatus,
    remittance_status: latestCodRemittance?.remittance_status || codStatus || null,
    remittance_utr: latestCodRemittance?.remittance_utr || null,
    remittance_date: latestCodRemittance?.remittance_date || null,
    remittance_scheduled_from: latestCodRemittance?.remittance_scheduled_from || null,
    remittance_scheduled_to: latestCodRemittance?.remittance_scheduled_to || null,
    cod_amount: latestCodRemittance?.cod_amount || null,
    awb: latestShipment?.awb || latestCodRemittance?.awb || row.awb || null,
    shipment_status: latestShipment?.status || null,
    shiprocket_order_id: latestShipment?.shiprocket_order_id || latestCodRemittance?.shiprocket_order_id || null,
    shiprocket_shipment_id: latestShipment?.shiprocket_shipment_id || latestCodRemittance?.shiprocket_shipment_id || null
  }
}

router.get('/admin', requireAuth, async (req, res) => {
  try {
    const role = getUserRole(req)
    const isSuper = role === 'SUPER_ADMIN'
    const userBranchId = Number(req.user?.branch_id || 0)
    const requestedBranchId = Number(req.query.branch_id || 0)

    const params = []
    const where = []

    if (isSuper) {
      if (requestedBranchId) {
        params.push(requestedBranchId)
        where.push(`s.branch_id = $${params.length}`)
      }
    } else {
      if (!userBranchId) return res.status(403).json({ message: 'Forbidden' })
      params.push(userBranchId)
      where.push(`(s.branch_id = $${params.length} OR s.is_b2b = true)`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const q = await pool.query(
      `SELECT
         s.*,
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at,
         CASE WHEN sh.id IS NULL THEN NULL ELSE row_to_json(sh) END AS latest_shipment,
         COALESCE(cr_list.cod_remittances, '[]'::json) AS cod_remittances,
         CASE WHEN cr_latest.id IS NULL THEN NULL ELSE row_to_json(cr_latest) END AS latest_cod_remittance,
         sh.status AS shipment_status,
         sh.awb AS awb,
         sh.shiprocket_order_id AS shiprocket_order_id,
         sh.shiprocket_shipment_id AS shiprocket_shipment_id
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       LEFT JOIN LATERAL (
         SELECT *
         FROM shipments
         WHERE sale_id = s.id
         ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT 1
       ) sh ON TRUE
       LEFT JOIN LATERAL (
         SELECT json_agg(cr_row ORDER BY cr_row.updated_at DESC NULLS LAST, cr_row.created_at DESC NULLS LAST) AS cod_remittances
         FROM (
           SELECT cr.*
           FROM cod_remittances cr
           WHERE cr.sale_id = s.id
              OR (sh.awb IS NOT NULL AND sh.awb <> '' AND cr.awb = sh.awb)
         ) cr_row
       ) cr_list ON TRUE
       LEFT JOIN LATERAL (
         SELECT cr.*
         FROM cod_remittances cr
         WHERE cr.sale_id = s.id
            OR (sh.awb IS NOT NULL AND sh.awb <> '' AND cr.awb = sh.awb)
         ORDER BY cr.updated_at DESC NULLS LAST, cr.created_at DESC NULLS LAST
         LIMIT 1
       ) cr_latest ON TRUE
       ${whereSql}
       ORDER BY s.created_at DESC NULLS LAST, s.id DESC
       LIMIT 500`,
      params
    )

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')

    return res.json(q.rows.map(mapTransactionRow))
  } catch (err) {
    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? err.message : 'Server error'
    })
  }
})

router.get('/admin/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    const role = getUserRole(req)
    const isSuper = role === 'SUPER_ADMIN'
    const userBranchId = Number(req.user?.branch_id || 0)

    if (!id) return res.status(400).json({ message: 'id required' })

    const params = [id]
    let accessSql = ''

    if (!isSuper) {
      if (!userBranchId) return res.status(403).json({ message: 'Forbidden' })
      params.push(userBranchId)
      accessSql = `AND (s.branch_id = $2 OR s.is_b2b = true)`
    }

    const q = await pool.query(
      `SELECT
         s.*,
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at,
         CASE WHEN sh.id IS NULL THEN NULL ELSE row_to_json(sh) END AS latest_shipment,
         COALESCE(cr_list.cod_remittances, '[]'::json) AS cod_remittances,
         CASE WHEN cr_latest.id IS NULL THEN NULL ELSE row_to_json(cr_latest) END AS latest_cod_remittance,
         sh.status AS shipment_status,
         sh.awb AS awb,
         sh.shiprocket_order_id AS shiprocket_order_id,
         sh.shiprocket_shipment_id AS shiprocket_shipment_id
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       LEFT JOIN LATERAL (
         SELECT *
         FROM shipments
         WHERE sale_id = s.id
         ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT 1
       ) sh ON TRUE
       LEFT JOIN LATERAL (
         SELECT json_agg(cr_row ORDER BY cr_row.updated_at DESC NULLS LAST, cr_row.created_at DESC NULLS LAST) AS cod_remittances
         FROM (
           SELECT cr.*
           FROM cod_remittances cr
           WHERE cr.sale_id = s.id
              OR (sh.awb IS NOT NULL AND sh.awb <> '' AND cr.awb = sh.awb)
         ) cr_row
       ) cr_list ON TRUE
       LEFT JOIN LATERAL (
         SELECT cr.*
         FROM cod_remittances cr
         WHERE cr.sale_id = s.id
            OR (sh.awb IS NOT NULL AND sh.awb <> '' AND cr.awb = sh.awb)
         ORDER BY cr.updated_at DESC NULLS LAST, cr.created_at DESC NULLS LAST
         LIMIT 1
       ) cr_latest ON TRUE
       WHERE s.id = $1::uuid
       ${accessSql}
       LIMIT 1`,
      params
    )

    if (!q.rowCount) return res.status(404).json({ message: 'Transaction not found' })

    return res.json(mapTransactionRow(q.rows[0]))
  } catch (err) {
    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? err.message : 'Server error'
    })
  }
})

router.post('/cod-remittance/manual-settle', requireAuth, async (req, res) => {
  const client = await pool.connect()

  try {
    const role = getUserRole(req)
    const isSuper = role === 'SUPER_ADMIN'
    const userBranchId = Number(req.user?.branch_id || 0)

    const saleId = String(req.body?.sale_id || '').trim()
    const requestedStatus = normalizeRemittanceStatus(req.body?.remittance_status || req.body?.status || 'RECEIVED')
    const utr = String(req.body?.remittance_utr || req.body?.utr || '').trim() || null
    const remittanceDate = req.body?.remittance_date || null
    const scheduledFrom = req.body?.remittance_scheduled_from || null
    const scheduledTo = req.body?.remittance_scheduled_to || null
    const requestedAmount = req.body?.cod_amount ?? req.body?.amount ?? null

    if (!saleId) return res.status(400).json({ message: 'sale_id required' })
    if (!requestedStatus) return res.status(400).json({ message: 'remittance_status required' })

    await client.query('BEGIN')

    const params = [saleId]
    let accessSql = ''

    if (!isSuper) {
      if (!userBranchId) {
        await client.query('ROLLBACK')
        return res.status(403).json({ message: 'Forbidden' })
      }

      params.push(userBranchId)
      accessSql = `AND (branch_id = $2 OR is_b2b = true)`
    }

    const saleQ = await client.query(
      `SELECT *
       FROM sales
       WHERE id = $1::uuid
       ${accessSql}
       FOR UPDATE`,
      params
    )

    if (!saleQ.rowCount) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Sale not found' })
    }

    const sale = saleQ.rows[0]
    const paymentType = statusText(sale.payment_status || sale.payment_method)

    if (paymentType !== 'COD') {
      await client.query('ROLLBACK')
      return res.status(400).json({ message: 'Manual COD remittance is allowed only for COD orders' })
    }

    const shipmentQ = await client.query(
      `SELECT *
       FROM shipments
       WHERE sale_id = $1::uuid
       ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
       LIMIT 1`,
      [saleId]
    )

    const shipment = shipmentQ.rows[0] || null
    const amount = requestedAmount != null && Number.isFinite(Number(requestedAmount)) ? Number(requestedAmount) : getPayable(sale)

    const existingQ = await client.query(
      `SELECT id
       FROM cod_remittances
       WHERE sale_id = $1::uuid
          OR ($2::text IS NOT NULL AND awb = $2)
       ORDER BY created_at DESC
       LIMIT 1`,
      [saleId, shipment?.awb || null]
    )

    let out = null

    if (existingQ.rowCount) {
      const upd = await client.query(
        `UPDATE cod_remittances
         SET shipment_id = COALESCE($2::uuid, shipment_id),
             awb = COALESCE(NULLIF($3, ''), awb),
             shiprocket_order_id = COALESCE(NULLIF($4, ''), shiprocket_order_id),
             shiprocket_shipment_id = COALESCE(NULLIF($5, ''), shiprocket_shipment_id),
             cod_amount = $6,
             remittance_status = $7,
             remittance_utr = COALESCE(NULLIF($8, ''), remittance_utr),
             remittance_date = COALESCE($9::timestamptz, remittance_date),
             remittance_scheduled_from = COALESCE($10::timestamptz, remittance_scheduled_from),
             remittance_scheduled_to = COALESCE($11::timestamptz, remittance_scheduled_to),
             raw_payload = COALESCE($12::jsonb, raw_payload),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          existingQ.rows[0].id,
          shipment?.id || null,
          shipment?.awb || '',
          shipment?.shiprocket_order_id || '',
          shipment?.shiprocket_shipment_id || '',
          amount,
          requestedStatus,
          utr || '',
          remittanceDate,
          scheduledFrom,
          scheduledTo,
          JSON.stringify({
            source: 'manual_admin',
            user_id: req.user?.id || null,
            body: req.body || {}
          })
        ]
      )

      out = upd.rows[0]
    } else {
      const ins = await client.query(
        `INSERT INTO cod_remittances
           (sale_id, shipment_id, awb, shiprocket_order_id, shiprocket_shipment_id, cod_amount, remittance_status, remittance_utr, remittance_date, remittance_scheduled_from, remittance_scheduled_to, raw_payload)
         VALUES
           ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11::timestamptz,$12::jsonb)
         RETURNING *`,
        [
          saleId,
          shipment?.id || null,
          shipment?.awb || null,
          shipment?.shiprocket_order_id || null,
          shipment?.shiprocket_shipment_id || null,
          amount,
          requestedStatus,
          utr,
          remittanceDate,
          scheduledFrom,
          scheduledTo,
          JSON.stringify({
            source: 'manual_admin',
            user_id: req.user?.id || null,
            body: req.body || {}
          })
        ]
      )

      out = ins.rows[0]
    }

    await client.query('COMMIT')

    return res.json({
      ok: true,
      remittance: out
    })
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {}

    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? err.message : 'Server error'
    })
  } finally {
    client.release()
  }
})

module.exports = router