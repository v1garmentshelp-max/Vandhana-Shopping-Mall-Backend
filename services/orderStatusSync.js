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
  if (!input || depth > 8 || out.length > 180) return out

  if (typeof input === 'string' || typeof input === 'number') {
    const v = String(input).trim()
    if (v && v.length <= 220) out.push(v)
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

const shouldUpdateStatus = (current, next) => {
  const currentStatus = normalizeOrderStatus(current)
  const nextStatus = normalizeOrderStatus(next)

  if (!nextStatus) return false
  if (currentStatus === 'CANCELLED') return false
  if (currentStatus === 'DELIVERED' && nextStatus !== 'DELIVERED') return false
  if (nextStatus === 'CANCELLED') return currentStatus !== 'DELIVERED' && currentStatus !== 'CANCELLED'

  return statusRank(nextStatus) > statusRank(currentStatus)
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

const extractShipmentInfo = (raw, fallbackStatus = '') => {
  const data = extractTrackingData(raw) || raw || {}
  const statuses = collectStatusValues(data)
  const rawStatus =
    findFirstByKeys(data, ['current_status', 'shipment_status', 'status', 'track_status', 'activity']) ||
    statuses[0] ||
    fallbackStatus ||
    ''

  const status = bestOrderStatus([...statuses, rawStatus], fallbackStatus || '')
  const awb = findFirstByKeys(data, ['awb_code', 'awb_number', 'awb'])
  const trackingUrl = findFirstByKeys(data, ['tracking_url', 'track_url'])
  const labelUrl = findFirstByKeys(data, ['label_url'])
  const currentLocation = findFirstByKeys(data, ['current_location', 'current_city', 'destination_city', 'scan_location', 'scanned_location'])
  const deliveredAt = findFirstByKeys(data, ['delivered_at', 'delivered_date', 'delivery_date'])
  const shiprocketOrderId = findFirstByKeys(data, ['shiprocket_order_id', 'order_id'])
  const shiprocketShipmentId = findFirstByKeys(data, ['shiprocket_shipment_id', 'shipment_id'])
  const channelOrderId = findFirstByKeys(data, ['channel_order_id'])
  const saleId = extractUuid(channelOrderId) || extractUuid(findFirstByKeys(data, ['sale_id']))

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
    sale_id: saleId
  }
}

const syncSaleStatus = async (pool, saleId, candidateStatus) => {
  const nextStatus = normalizeOrderStatus(candidateStatus)
  if (!pool || !saleId || !nextStatus) return null

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

const findShipmentRows = async (pool, identifiers = {}) => {
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

const syncShipmentRows = async (pool, rows, raw, fallbackStatus = '') => {
  const info = extractShipmentInfo(raw, fallbackStatus)
  const updated = []

  for (const row of rows || []) {
    const finalStatus = bestOrderStatus(
      [
        row.status,
        info.status,
        info.raw_status,
        info.awb ? 'PACKED' : '',
        ...info.statuses
      ],
      row.status || fallbackStatus || 'CONFIRMED'
    )

    const nextStatus = shouldUpdateStatus(row.status, finalStatus) ? finalStatus : normalizeOrderStatus(row.status) || row.status || finalStatus
    const deliveredAt = info.delivered_at ? new Date(info.delivered_at) : null

    const q = await pool.query(
      `UPDATE shipments
       SET status = COALESCE($2, status),
           raw_status = COALESCE($3, raw_status),
           awb = COALESCE(NULLIF($4, ''), awb),
           tracking_url = COALESCE(NULLIF($5, ''), tracking_url),
           label_url = COALESCE(NULLIF($6, ''), label_url),
           current_location = COALESCE(NULLIF($7, ''), current_location),
           status_synced_at = now(),
           last_tracking_payload = COALESCE($8::jsonb, last_tracking_payload),
           delivered_at = CASE
             WHEN $2 = 'DELIVERED' THEN COALESCE(delivered_at, $9::timestamptz, now())
             ELSE delivered_at
           END,
           awb_assigned_at = CASE
             WHEN COALESCE(NULLIF($4, ''), awb) IS NOT NULL THEN COALESCE(awb_assigned_at, now())
             ELSE awb_assigned_at
           END,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        row.id,
        nextStatus || null,
        info.raw_status || null,
        info.awb || '',
        info.tracking_url || '',
        info.label_url || '',
        info.current_location || '',
        JSON.stringify(info.raw || raw || {}),
        deliveredAt && !Number.isNaN(deliveredAt.getTime()) ? deliveredAt.toISOString() : null
      ]
    )

    const saved = q.rows[0]
    if (saved?.sale_id) await syncSaleStatus(pool, saved.sale_id, saved.status)
    updated.push(saved)
  }

  return updated
}

const syncShipmentByIdentifiers = async (pool, identifiers = {}, raw = {}, fallbackStatus = '') => {
  const info = extractShipmentInfo(raw, fallbackStatus)

  const mergedIdentifiers = {
    sale_id: identifiers.sale_id || info.sale_id || null,
    shiprocket_order_id: identifiers.shiprocket_order_id || info.shiprocket_order_id || null,
    shiprocket_shipment_id: identifiers.shiprocket_shipment_id || info.shiprocket_shipment_id || null,
    awb: identifiers.awb || info.awb || null
  }

  const rows = await findShipmentRows(pool, mergedIdentifiers)
  if (!rows.length) return []

  return syncShipmentRows(pool, rows, raw, fallbackStatus || info.status || info.raw_status || '')
}

module.exports = {
  statusText,
  normalizeOrderStatus,
  statusRank,
  collectStatusValues,
  bestOrderStatus,
  shouldUpdateStatus,
  extractTrackingData,
  findFirstByKeys,
  extractUuid,
  extractShipmentInfo,
  syncSaleStatus,
  syncShipmentRows,
  syncShipmentByIdentifiers,
  findShipmentRows
}