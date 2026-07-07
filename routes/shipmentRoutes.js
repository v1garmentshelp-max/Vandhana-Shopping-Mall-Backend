const express = require('express')
const pool = require('../db')
const { trackByOrderId } = require('../services/shiprocketClient')

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

const extractTrackingData = (tracking) => {
  if (!tracking) return null
  if (tracking.tracking_data) return tracking.tracking_data
  if (tracking.data?.tracking_data) return tracking.data.tracking_data
  if (tracking.data?.data?.tracking_data) return tracking.data.data.tracking_data
  if (tracking.data) return tracking.data
  return tracking
}

const pickLocation = (td, sh) => {
  let location =
    td?.current_location ||
    td?.current_city ||
    td?.destination_city ||
    sh?.current_location ||
    null

  const rawEvents =
    (Array.isArray(td?.shipment_track) && td.shipment_track) ||
    (Array.isArray(td?.shipment_track_activities) && td.shipment_track_activities) ||
    (Array.isArray(td?.track_data) && td.track_data) ||
    (Array.isArray(td?.scans) && td.scans) ||
    (Array.isArray(td?.track_activities) && td.track_activities) ||
    []

  if (!location && rawEvents.length) {
    const ev = rawEvents[0]
    location =
      ev.location ||
      ev.location_city ||
      ev.city ||
      ev.scan_location ||
      ev.scanned_location ||
      null
  }

  return location
}

router.get('/shipments/by-sale/:id', async (req, res) => {
  const id = req.params.id

  try {
    const { rows } = await pool.query(
      'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC',
      [id]
    )

    const enriched = await Promise.all(
      rows.map(async (sh) => {
        if (!sh.shiprocket_order_id) {
          return {
            ...sh,
            status: bestOrderStatus([sh.status, sh.awb ? 'PACKED' : ''], sh.status || 'CONFIRMED')
          }
        }

        try {
          const tracking = await trackByOrderId(sh.shiprocket_order_id)
          const td = extractTrackingData(tracking)

          if (!td) {
            return {
              ...sh,
              status: bestOrderStatus([sh.status, sh.awb ? 'PACKED' : ''], sh.status || 'CONFIRMED')
            }
          }

          const status = bestOrderStatus(
            [
              sh.status,
              td.shipment_status,
              td.current_status,
              tracking.current_status,
              tracking.status,
              sh.awb ? 'PACKED' : '',
              ...collectStatusValues(td)
            ],
            sh.status || 'CONFIRMED'
          )

          const location = pickLocation(td, sh)
          const trackingUrl = td.track_url || tracking.track_url || sh.tracking_url || null

          if (status && normalizeOrderStatus(status) !== normalizeOrderStatus(sh.status)) {
            await pool.query(
              'UPDATE shipments SET status=$2, tracking_url=COALESCE($3, tracking_url) WHERE id=$1',
              [sh.id, status, trackingUrl]
            )
          }

          return {
            ...sh,
            status: status || sh.status,
            current_location: location || sh.current_location || null,
            tracking_url: trackingUrl || sh.tracking_url
          }
        } catch (err) {
          console.error('shipments/by-sale track error', sh.id, err.message || err)
          return {
            ...sh,
            status: bestOrderStatus([sh.status, sh.awb ? 'PACKED' : ''], sh.status || 'CONFIRMED')
          }
        }
      })
    )

    const finalStatus = bestOrderStatus(
      enriched.flatMap((sh) => [sh.status, sh.current_status, sh.shipment_status, sh.awb ? 'PACKED' : '']),
      rows.length ? 'CONFIRMED' : 'PLACED'
    )

    await syncSaleStatus(id, finalStatus)

    res.json(enriched)
  } catch (err) {
    console.error('shipments/by-sale error', err.message || err)
    res.status(500).json({ error: 'Failed to fetch shipments' })
  }
})

module.exports = router