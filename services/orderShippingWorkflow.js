const crypto = require('crypto')
const Shiprocket = require('./shiprocketService')

const fail = (message, status = 409) => Object.assign(new Error(message), { status })
const positiveId = value => /^\d+$/.test(String(value || '')) && Number(value) > 0 ? String(value) : null
const awbText = value => typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value) && !['null', 'undefined'].includes(value) ? value : null
const addressOf = sale => {
  const a = sale.shipping_address || {}
  return {
    line1: String(a.line1 || a.address_line1 || a.address1 || a.street || '').trim(),
    line2: String(a.line2 || a.address_line2 || a.address2 || a.landmark || '').trim(),
    city: String(a.city || '').trim(), state: String(a.state || '').trim(),
    pincode: String(a.pincode || a.pin_code || sale.pincode || '').trim()
  }
}
const eligible = sale => {
  if (String(sale.source).toUpperCase() !== 'WEB') throw fail('This shipping workflow supports website orders only.')
  if (/CANCEL|DELIVERED|RETURN|RTO/.test(String(sale.status).toUpperCase())) throw fail('This order is closed or cancelled. Shipping actions are disabled.')
  if (String(sale.payment_method).toUpperCase() !== 'COD' && String(sale.payment_status).toUpperCase() !== 'PAID') throw fail('Payment must be confirmed before shipping a prepaid order.')
}
const safeError = error => String(error?.message || 'Shipping operation failed').slice(0, 1200)

function createWorkflow(pool, makeClient = () => new Shiprocket({ pool })) {
  async function state(db, saleId) {
    const sale = (await db.query('SELECT * FROM sales WHERE id=$1', [saleId])).rows[0]
    if (!sale) throw fail('Order not found', 404)
    const workflow = (await db.query('SELECT * FROM order_shipping_workflow WHERE sale_id=$1', [saleId])).rows[0] || null
    const shipments = (await db.query('SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC', [saleId])).rows
    const warehouse = (await db.query('SELECT * FROM shiprocket_warehouses WHERE branch_id=$1 LIMIT 1', [sale.branch_id])).rows[0] || null
    let blocked = null
    try { eligible(sale) } catch (e) { blocked = e.message }
    return { sale, workflow, shipments, shipment: shipments[0] || null, warehouse, blocked,
      credentials_configured: !!(process.env.SHIPROCKET_API_USER_EMAIL && process.env.SHIPROCKET_API_USER_PASSWORD) }
  }
  async function mark(db, id, phase, error = null) {
    await db.query('UPDATE order_shipping_workflow SET phase=$2,last_error=$3,updated_at=now() WHERE sale_id=$1', [id, phase, error])
  }
  async function locked(id, action) {
    const db = await pool.connect()
    let acquired = false
    try {
      acquired = (await db.query('SELECT pg_try_advisory_lock(hashtextextended($1::text,0)) AS locked', [`order-shipping:${id}`])).rows[0].locked
      if (!acquired) throw fail('Another shipping action is running for this order. Refresh in a moment.')
      const before = await state(db, id)
      await db.query("INSERT INTO order_shipping_workflow(sale_id,phase) VALUES($1,'LEGACY_UNKNOWN') ON CONFLICT DO NOTHING", [id])
      try { return await action(db, before) } catch (error) {
        await db.query('UPDATE order_shipping_workflow SET last_error=$2,updated_at=now() WHERE sale_id=$1', [id, safeError(error)]).catch(() => {})
        console.error('[order-shipping]', id, safeError(error))
        throw error
      }
    } finally {
      if (acquired) {
        try { await db.query('SELECT pg_advisory_unlock(hashtextextended($1::text,0))', [`order-shipping:${id}`]) }
        catch (e) { db.release(true); acquired = false; throw e }
      }
      db.release()
    }
  }
  async function persist(db, sale, orderId, shipmentId, awb) {
    if (!positiveId(orderId) || !positiveId(shipmentId)) throw fail('Shiprocket did not return valid order and shipment IDs. Check Shiprocket before retrying.')
    const conflict = (await db.query('SELECT sale_id FROM shipments WHERE shiprocket_order_id=$1 AND sale_id<>$2 LIMIT 1', [String(orderId), sale.id])).rows[0]
    if (conflict) throw fail('This Shiprocket order is already linked to another sale.')
    const existing = (await db.query('SELECT id FROM shipments WHERE sale_id=$1 AND shiprocket_shipment_id=$2 LIMIT 1', [sale.id, String(shipmentId)])).rows[0]
    if (!existing) {
      await db.query(`INSERT INTO shipments(id,sale_id,branch_id,shiprocket_order_id,shiprocket_shipment_id,awb,status,raw_status)
        VALUES($1,$2,$3,$4,$5,$6,'CONFIRMED','NEW')`,
      [crypto.randomUUID(), sale.id, sale.branch_id, String(orderId), String(shipmentId), awbText(awb)])
    } else if (awbText(awb)) {
      await db.query('UPDATE shipments SET awb=$2,awb_assigned_at=COALESCE(awb_assigned_at,now()),updated_at=now() WHERE id=$1', [existing.id, awb])
    }
    await db.query("UPDATE sales SET status='CONFIRMED' WHERE id=$1 AND status='PLACED'", [sale.id])
    await mark(db, sale.id, awbText(awb) ? 'AWB_ASSIGNED' : 'CONNECTED')
    return state(db, sale.id)
  }
  async function remoteDetail(sr, sale, id) {
    if (!positiveId(id)) throw fail('Enter the numeric Shiprocket order ID, not the website order UUID.', 400)
    const { data } = await sr.api('get', `/orders/show/${id}`)
    const remote = data?.data
    if (!remote || ![String(sale.id), `${sale.id}-${sale.branch_id}`].includes(String(remote.channel_order_id))) throw fail('The Shiprocket order does not match this website order.')
    const shipments = Array.isArray(remote.shipments) ? remote.shipments : remote.shipments ? [remote.shipments] : []
    if (shipments.length !== 1) throw fail('This remote order needs manual reconciliation: expected one shipment.')
    return { orderId: remote.id, shipmentId: shipments[0].id, awb: awbText(shipments[0].awb), remote, shipment: shipments[0] }
  }
  async function connect(id, { fresh = false, remote_order_id, confirmed_absent = false } = {}) {
    return locked(id, async (db, s) => {
      eligible(s.sale)
      if (fresh && !s.workflow) await mark(db, id, 'NEW')
      if (s.shipment?.shiprocket_shipment_id && s.shipment?.shiprocket_order_id) return s
      const sr = makeClient()
      if (remote_order_id) {
        const r = await remoteDetail(sr, s.sale, remote_order_id)
        return persist(db, s.sale, r.orderId, r.shipmentId, r.awb)
      }
      if (s.workflow?.create_attempted) throw fail('A previous creation request may have reached Shiprocket. Find this website order there and link its numeric Shiprocket order ID. Do not create it again.')
      if (!fresh && (!s.workflow || s.workflow.phase === 'LEGACY_UNKNOWN') && !confirmed_absent) throw fail('This is an existing order. Search its website order ID in Shiprocket first. Link it if found, or confirm that it is absent before creating it.')
      if (!s.warehouse?.name || !/^\d{6}$/.test(String(s.warehouse.pincode || ''))) throw fail(`No valid Shiprocket pickup location is mapped for branch ${s.sale.branch_id}. Select its existing pickup location below.`, 422)
      const address = addressOf(s.sale)
      if (!address.line1 || !address.city || !address.state || !/^\d{6}$/.test(address.pincode)) throw fail('The saved delivery address is incomplete. Correct it before shipping.', 422)
      const phone = String(s.sale.customer_mobile || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
      if (!/^\d{10}$/.test(phone)) throw fail('The saved customer mobile number is invalid.', 422)
      const items = (await db.query('SELECT si.*,p.name FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE sale_id=$1', [id])).rows
      if (!items.length || items.some(i => !Number.isInteger(Number(i.qty)) || Number(i.qty) <= 0 || !Number.isFinite(Number(i.price)) || Number(i.price) < 0)) throw fail('Saved order items contain invalid quantities or prices.', 422)
      const subtotal = Math.round(items.reduce((sum, i) => sum + Number(i.qty) * Number(i.price), 0) * 100) / 100
      const total = Number(s.sale.total)
      if (!Number.isFinite(total) || total < 0) throw fail('The saved order total is invalid.', 422)
      await sr.init()
      await db.query("UPDATE order_shipping_workflow SET create_attempted=true,phase='CREATING',last_error=NULL,updated_at=now() WHERE sale_id=$1", [id])
      let data
      try {
        data = await sr.createOrderShipment({ channel_order_id: id, pickup_location: s.warehouse.name,
          order: { items, payment_method: String(s.sale.payment_method).toUpperCase() === 'COD' ? 'COD' : 'Prepaid',
            shipping_charges: Math.max(0, Math.round((total - subtotal) * 100) / 100),
            total_discount: Math.max(0, Math.round((subtotal - total) * 100) / 100), weight: 0.5, dimensions: { length: 10, breadth: 10, height: 5 } },
          customer: { name: s.sale.customer_name, email: s.sale.customer_email, phone, address } })
      } catch (error) {
        await mark(db, id, 'RECONCILIATION_REQUIRED', safeError(error))
        throw error
      }
      return persist(db, s.sale, data?.order_id || data?.data?.order_id, data?.shipment_id || data?.data?.shipment_id, null)
    })
  }
  async function couriers(id) {
    const s = await state(pool, id)
    eligible(s.sale)
    if (!s.shipment?.shiprocket_shipment_id) throw fail('Connect the order to Shiprocket first.')
    const sr = makeClient()
    const r = await remoteDetail(sr, s.sale, s.shipment.shiprocket_order_id)
    const weight = Number(r.shipment.weight)
    if (!(weight > 0) || !/^\d{6}$/.test(String(s.warehouse?.pincode))) throw fail('Pickup pincode or package weight is missing.')
    const data = await sr.checkServiceability({ pickup_postcode: s.warehouse.pincode, delivery_postcode: addressOf(s.sale).pincode, cod: String(s.sale.payment_method).toUpperCase() === 'COD', weight })
    return { ...data, weight, pickup_postcode: s.warehouse.pincode, delivery_postcode: addressOf(s.sale).pincode }
  }
  async function assignAwb(id, courierId) {
    return locked(id, async (db, s) => {
      eligible(s.sale)
      if (!s.shipment?.shiprocket_order_id) throw fail('Connect the order first.')
      if (awbText(s.shipment.awb)) return s
      const sr = makeClient()
      const remote = await remoteDetail(sr, s.sale, s.shipment.shiprocket_order_id)
      if (remote.awb) return persist(db, s.sale, remote.orderId, remote.shipmentId, remote.awb)
      if (s.workflow?.awb_attempted) throw fail('An AWB request is awaiting reconciliation. Check Shiprocket and refresh; another charge will not be attempted.')
      if (!positiveId(courierId)) throw fail('Select a courier.', 400)
      const available = await sr.checkServiceability({ pickup_postcode: s.warehouse?.pincode, delivery_postcode: addressOf(s.sale).pincode, cod: String(s.sale.payment_method).toUpperCase() === 'COD', weight: Number(remote.shipment.weight) || 0.5 })
      const chosen = available?.data?.available_courier_companies?.find(c => String(c.courier_company_id) === String(courierId) && !c.blocked)
      if (!chosen) throw fail('This courier is not currently available. Refresh courier options.')
      await db.query("UPDATE order_shipping_workflow SET awb_attempted=true,phase='ASSIGNING_AWB',updated_at=now() WHERE sale_id=$1", [id])
      const { data } = await sr.api('post', '/courier/assign/awb', { shipment_id: Number(remote.shipmentId), courier_id: Number(courierId) })
      const awb = awbText(data?.response?.data?.awb_code)
      if (!awb) {
        if (Number(data?.awb_assign_status) === 0) await db.query('UPDATE order_shipping_workflow SET awb_attempted=false WHERE sale_id=$1', [id])
        throw fail(typeof data?.message === 'string' ? data.message : typeof data?.response?.data?.awb_assign_error === 'string' ? data.response.data.awb_assign_error : 'Shiprocket did not confirm an AWB. Check the wallet and Shiprocket order, then refresh.')
      }
      return persist(db, s.sale, remote.orderId, remote.shipmentId, awb)
    })
  }
  async function pickup(id) {
    return locked(id, async (db, s) => {
      eligible(s.sale)
      if (!awbText(s.shipment?.awb)) throw fail('Generate or reconcile the AWB first.')
      if (s.workflow?.pickup_requested_at) return s
      if (s.workflow?.pickup_attempted) throw fail('A pickup request was already sent. Check its status in Shiprocket before sending another.')
      const sr = makeClient()
      const remote = await remoteDetail(sr, s.sale, s.shipment.shiprocket_order_id)
      const remoteStatus = `${remote.remote.status || ''} ${remote.shipment.status || ''}`.toUpperCase()
      if (/CANCEL|RTO|RETURN|PICKED UP|IN TRANSIT|OUT FOR DELIVERY|SHIPPED|\bDELIVERED\b/.test(remoteStatus)) throw fail('Shiprocket reports that this order is closed or already moving. Refresh tracking instead of requesting pickup.')
      if (/PICKUP SCHEDULED|PICKUP GENERATED|PICKUP REQUESTED/.test(remoteStatus)) throw fail('Shiprocket already has a pickup request. Manage it in Shiprocket.')
      await sr.init()
      await db.query('UPDATE order_shipping_workflow SET pickup_attempted=true,updated_at=now() WHERE sale_id=$1', [id])
      const result = await sr.requestPickup({ shipment_id: Number(s.shipment.shiprocket_shipment_id) })
      if (Number(result?.pickup_status) !== 1) {
        if (Number(result?.pickup_status) === 0) await db.query('UPDATE order_shipping_workflow SET pickup_attempted=false WHERE sale_id=$1', [id])
        throw fail(typeof result?.message === 'string' ? result.message : 'Pickup was not confirmed. Check Shiprocket.')
      }
      await db.query("UPDATE order_shipping_workflow SET phase='PICKUP_REQUESTED',pickup_requested_at=now(),last_error=NULL,updated_at=now() WHERE sale_id=$1", [id])
      return state(db, id)
    })
  }
  async function tracking(id) {
    const s = await state(pool, id)
    if (!s.shipment?.shiprocket_shipment_id) throw fail('Connect the order first.')
    const { data } = await makeClient().api('get', `/courier/track/shipment/${s.shipment.shiprocket_shipment_id}`)
    const core = data?.tracking_data
    const current = core?.shipment_track?.[0]
    if (!current?.current_status) throw fail('Shiprocket has not published tracking events yet.')
    const { syncShipmentByIdentifiers } = require('./orderStatusSync')
    await syncShipmentByIdentifiers(pool, { sale_id: id, shiprocket_shipment_id: s.shipment.shiprocket_shipment_id }, {
      current_status: current.current_status,
      awb_code: current.awb_code,
      tracking_url: core.track_url,
      current_location: current.current_location
    }, s.shipment.status)
    return { status: current.current_status, awb: current.awb_code || s.shipment.awb,
      url: typeof core.track_url === 'string' && core.track_url.startsWith('https://') ? core.track_url : null,
      events: Array.isArray(core.shipment_track_activities) ? core.shipment_track_activities : [] }
  }
  async function document(id, type) {
    const s = await state(pool, id)
    if (!awbText(s.shipment?.awb)) throw fail('Generate the AWB first.')
    const sr = makeClient()
    const routes = { label: ['/courier/generate/label', { shipment_id: [Number(s.shipment.shiprocket_shipment_id)] }, 'label_url'], invoice: ['/orders/print/invoice', { ids: [Number(s.shipment.shiprocket_order_id)] }, 'invoice_url'], manifest: ['/manifests/generate', { shipment_id: [Number(s.shipment.shiprocket_shipment_id)] }, 'manifest_url'] }
    if (!routes[type]) throw fail('Unknown document', 400)
    const [path, body, key] = routes[type]
    const { data } = await sr.api('post', path, body)
    const url = data?.[key] || data?.data?.[key]
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw fail('Shiprocket has not returned this document yet.')
    return { url }
  }
  return { state: id => state(pool, id), connect, couriers, assignAwb, pickup, document, tracking, remoteDetail }
}
module.exports = { createWorkflow, eligible, addressOf, positiveId, awbText }
