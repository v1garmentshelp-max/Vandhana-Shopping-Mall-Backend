const { randomUUID } = require('crypto')
const Shiprocket = require('./shiprocketService')

const FORCE_BRANCH_ID =
  process.env.SHIPROCKET_FORCE_BRANCH_ID != null && String(process.env.SHIPROCKET_FORCE_BRANCH_ID).trim() !== ''
    ? Number(process.env.SHIPROCKET_FORCE_BRANCH_ID)
    : null

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180
  const R = 6371
  const dLat = toRad((b.lat || 0) - (a.lat || 0))
  const dLon = toRad((b.lng || 0) - (a.lng || 0))
  const lat1 = toRad(a.lat || 0)
  const lat2 = toRad(b.lat || 0)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

async function customerLocFromSale(sale, db) {
  if (sale.shipping_address?.lat && sale.shipping_address?.lng) {
    return {
      lat: Number(sale.shipping_address.lat),
      lng: Number(sale.shipping_address.lng)
    }
  }
  const pc = sale.shipping_address?.pincode || sale.pincode || null
  if (!pc) return { lat: null, lng: null }
  const { rows } = await db.query(
    'SELECT AVG(latitude)::float lat, AVG(longitude)::float lng FROM branches WHERE pincode=$1',
    [pc]
  )
  return { lat: rows[0]?.lat || null, lng: rows[0]?.lng || null }
}

async function candidateBranches(db, variantId, qty) {
  const { rows } = await db.query(
    `SELECT
       b.id,
       b.latitude::float AS lat,
       b.longitude::float AS lng,
       b.pincode,
       s.on_hand::int AS on_hand,
       s.reserved::int AS reserved
     FROM branch_variant_stock s
     JOIN branches b ON b.id = s.branch_id
     WHERE s.variant_id=$1
       AND (s.on_hand - s.reserved) >= $2
       AND EXISTS (SELECT 1 FROM shiprocket_warehouses w WHERE w.branch_id = b.id)`,
    [variantId, qty]
  )
  return rows
}

function pickBestBranch(rows, sale, customerLoc) {
  if (!rows.length) return null

  if (FORCE_BRANCH_ID != null) {
    const forced = rows.find((r) => Number(r.id) === Number(FORCE_BRANCH_ID))
    if (forced) return forced.id
    return null
  }

  if (sale.branch_id) {
    const exact = rows.find((r) => Number(r.id) === Number(sale.branch_id))
    if (exact) return exact.id
  }

  const pincode = sale.shipping_address?.pincode || sale.pincode || null
  const samePin = pincode ? rows.filter((r) => String(r.pincode) === String(pincode)) : []
  const poolRows = samePin.length ? samePin : rows

  if (customerLoc.lat != null && customerLoc.lng != null) {
    const sorted = poolRows
      .map((r) => ({
        r,
        d: haversineKm({ lat: r.lat, lng: r.lng }, customerLoc)
      }))
      .sort((a, b) => a.d - b.d)
    return sorted[0].r.id
  }

  return poolRows[0].id
}

function normalizeShipItem(it) {
  const variantId = Number(it.variant_id ?? it.product_id)
  const qty = Number(it.qty ?? it.quantity ?? 1)
  return {
    variant_id: variantId,
    qty,
    price: Number(it.price ?? it.final_price ?? it.final_price_b2c ?? it.final_price_b2b ?? 0),
    mrp: it.mrp != null ? Number(it.mrp) : it.original_price != null ? Number(it.original_price) : null,
    size: it.size ?? it.selected_size ?? null,
    colour: it.colour ?? it.color ?? it.selected_color ?? it.selected_colour ?? null,
    image_url: it.image_url ?? null,
    ean_code: it.ean_code ?? it.ean ?? it.barcode_value ?? null,
    name: it.name ?? it.product_name ?? null
  }
}

async function planShipmentsAndDecrementStock(sale, pool) {
  const client = await pool.connect()
  const decremented = []
  try {
    await client.query('BEGIN')

    const loc = await customerLocFromSale(sale, client)
    const groups = {}

    for (const rawIt of sale.items || []) {
      const it = normalizeShipItem(rawIt)
      const variantId = Number(it.variant_id)
      const qty = Number(it.qty)

      if (!variantId || qty <= 0) throw new Error(`Invalid item for variant ${rawIt?.variant_id ?? rawIt?.product_id}`)

      const rows = await candidateBranches(client, variantId, qty)
      const branchId = pickBestBranch(rows, sale, loc)
      if (!branchId) throw new Error(`Out of stock for variant ${variantId}`)

      const stockQ = await client.query(
        `SELECT on_hand, reserved
         FROM branch_variant_stock
         WHERE branch_id=$1 AND variant_id=$2
         FOR UPDATE`,
        [branchId, variantId]
      )
      if (!stockQ.rowCount) throw new Error(`Stock row missing for variant ${variantId} in branch ${branchId}`)

      const onHand = Number(stockQ.rows[0].on_hand || 0)
      const reserved = Number(stockQ.rows[0].reserved || 0)
      if (onHand - reserved < qty) throw new Error(`Out of stock for variant ${variantId}`)

      await client.query(
        `UPDATE branch_variant_stock
         SET on_hand = GREATEST(on_hand - $3, 0)
         WHERE branch_id=$1 AND variant_id=$2`,
        [branchId, variantId, qty]
      )

      decremented.push({ branch_id: Number(branchId), variant_id: Number(variantId), qty: Number(qty) })

      if (!groups[branchId]) groups[branchId] = []
      groups[branchId].push(it)
    }

    await client.query('COMMIT')

    return {
      groups: Object.entries(groups).map(([branch_id, items]) => ({
        branch_id: Number(branch_id),
        items
      })),
      decremented
    }
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw e
  } finally {
    try {
      client.release()
    } catch {}
  }
}

async function restoreStock(pool, decremented) {
  if (!Array.isArray(decremented) || !decremented.length) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const d of decremented) {
      await client.query(
        `UPDATE branch_variant_stock
         SET on_hand = on_hand + $3
         WHERE branch_id=$1 AND variant_id=$2`,
        [Number(d.branch_id), Number(d.variant_id), Number(d.qty)]
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw e
  } finally {
    try {
      client.release()
    } catch {}
  }
}

async function fulfillOrderWithShiprocket(sale, pool) {
  const sr = new Shiprocket({ pool })
  await sr.init()

  let planned = null
  let decremented = []
  try {
    planned = await planShipmentsAndDecrementStock(sale, pool)
    decremented = planned.decremented || []

    const groups = planned.groups || []
    const created = []
    const manifestShipmentIds = []

    const payable =
      typeof sale.totals === 'object' && sale.totals !== null ? Number(sale.totals.payable || 0) : 0

    const paymentMethodForShiprocket =
      String(sale.payment_status || '').toUpperCase() === 'COD' && payable > 0 ? 'COD' : 'Prepaid'

    for (const group of groups) {
      const wh = (await pool.query('SELECT * FROM shiprocket_warehouses WHERE branch_id=$1', [group.branch_id])).rows[0]
      if (!wh) throw new Error(`No pickup mapped for branch ${group.branch_id}`)

      const channelOrderId = `${sale.id}-${group.branch_id}`

      const data = await sr.createOrderShipment({
        channel_order_id: channelOrderId,
        pickup_location: wh.name,
        order: {
          items: group.items,
          payment_method: paymentMethodForShiprocket
        },
        customer: {
          name: sale.customer_name || 'Customer',
          email: sale.customer_email || null,
          phone: sale.customer_mobile || null,
          address: {
            line1: sale.shipping_address?.line1 || sale.shipping_address || '',
            line2: sale.shipping_address?.line2 || '',
            city: sale.shipping_address?.city || '',
            state: sale.shipping_address?.state || '',
            pincode: sale.shipping_address?.pincode || sale.pincode || ''
          }
        }
      })

      const shipmentId = Array.isArray(data?.shipment_id) ? data.shipment_id[0] : data?.shipment_id || null

      let awb = null
      let labelUrl = null

      if (shipmentId) {
        try {
          const res = await sr.assignAWBAndLabel({ shipment_id: shipmentId })
          awb = res.awb?.response?.data?.awb_code || null
          labelUrl = res.label?.label_url || null
          manifestShipmentIds.push(shipmentId)
          await sr.requestPickup({ shipment_id: shipmentId })
        } catch {
          awb = null
          labelUrl = null
        }
      }

      const sid = randomUUID()

      await pool.query(
        `INSERT INTO shipments(
           id,
           sale_id,
           branch_id,
           shiprocket_order_id,
           shiprocket_shipment_id,
           awb,
           label_url,
           tracking_url,
           status
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [sid, sale.id, group.branch_id, data?.order_id || null, shipmentId, awb, labelUrl, data?.tracking_url || null, 'CREATED']
      )

      created.push({
        branch_id: group.branch_id,
        shipment_id: shipmentId,
        awb,
        label_url: labelUrl
      })
    }

    if (manifestShipmentIds.length) {
      await sr.generateManifest({ shipment_ids: manifestShipmentIds })
    }

    return created
  } catch (e) {
    try {
      await restoreStock(pool, decremented)
    } catch {}
    throw e
  }
}

module.exports = { fulfillOrderWithShiprocket }
