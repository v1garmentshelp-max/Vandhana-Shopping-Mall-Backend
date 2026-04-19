const axios = require('axios')

const ROOT = process.env.SHIPROCKET_API_BASE || 'https://apiv2.shiprocket.in'
const BASE = `${ROOT.replace(/\/+$/, '')}/v1/external`

class Shiprocket {
  constructor({ pool }) {
    this.pool = pool
    this.token = null
    this.fetchedAt = 0
    this.ttlMs = 25 * 60 * 1000
  }

  async login() {
    const email = process.env.SHIPROCKET_API_USER_EMAIL
    const password = process.env.SHIPROCKET_API_USER_PASSWORD
    if (!email || !password) throw new Error('Missing Shiprocket API creds')

    const { data } = await axios.post(`${ROOT.replace(/\/+$/, '')}/v1/external/auth/login`, {
      email,
      password
    })

    if (!data || !data.token) throw new Error('Shiprocket login failed')
    this.token = data.token
    this.fetchedAt = Date.now()
  }

  async ensureToken() {
    if (this.token && Date.now() - this.fetchedAt < this.ttlMs) return
    await this.login()
  }

  async init() {
    await this.ensureToken()
  }

  async api(method, path, payload) {
    await this.ensureToken()

    const config = {
      method,
      url: `${BASE}${path}`,
      headers: { Authorization: `Bearer ${this.token}` }
    }

    if (method.toLowerCase() === 'get') {
      if (payload) config.params = payload
    } else {
      if (payload) config.data = payload
    }

    try {
      return await axios(config)
    } catch (err) {
      const msg = err?.response?.data ? JSON.stringify(err.response.data) : err?.message || String(err)
      throw new Error(msg)
    }
  }

  async upsertWarehouseFromBranch(branch) {
    const payload = {
      pickup_location: branch.name,
      name: branch.name,
      email: branch.email || 'support@example.com',
      phone: branch.phone || '9999999999',
      address: branch.address,
      address_2: '',
      city: branch.city,
      state: branch.state,
      country: 'India',
      pin_code: branch.pincode
    }

    const { data } = await this.api('post', '/settings/company/addpickup', payload)
    return data
  }

  async createOrderShipment({ channel_order_id, pickup_location, order, customer }) {
    const payload = {
      order_id: channel_order_id,
      order_date: new Date().toISOString(),
      pickup_location,
      billing_customer_name: customer.name || 'Customer',
      billing_last_name: '',
      billing_address: customer.address.line1 || '',
      billing_address_2: customer.address.line2 || '',
      billing_city: customer.address.city || '',
      billing_pincode: customer.address.pincode || '',
      billing_state: customer.address.state || '',
      billing_country: 'India',
      billing_email: customer.email || 'na@example.com',
      billing_phone: customer.phone || '9999999999',
      shipping_is_billing: true,
      order_items: (order.items || []).map(it => ({
        name: it.name || `Variant ${it.variant_id}`,
        sku: String(it.variant_id),
        units: Number(it.qty || 0),
        selling_price: Number(it.price || 0)
      })),
      payment_method: order.payment_method === 'COD' ? 'COD' : 'Prepaid',
      sub_total: (order.items || []).reduce(
        (a, it) => a + Number(it.price || 0) * Number(it.qty || 0),
        0
      ),
      length: order.dimensions?.length || 10,
      breadth: order.dimensions?.breadth || 10,
      height: order.dimensions?.height || 5,
      weight: order.weight || 0.5
    }

    const { data } = await this.api('post', '/orders/create/adhoc', payload)
    return data
  }

  async assignAWBAndLabel({ shipment_id }) {
    const ids = Array.isArray(shipment_id) ? shipment_id : [shipment_id]
    const { data: awb } = await this.api('post', '/courier/assign/awb', { shipment_id: ids })
    const { data: label } = await this.api('post', '/courier/generate/label', { shipment_id: ids })
    return { awb, label }
  }

  async requestPickup({ shipment_id, pickup_date, status }) {
    const ids = Array.isArray(shipment_id) ? shipment_id : [shipment_id]
    const payload = { shipment_id: ids }

    if (pickup_date) payload.pickup_date = Array.isArray(pickup_date) ? pickup_date : [pickup_date]
    if (status) payload.status = status

    const { data } = await this.api('post', '/courier/generate/pickup', payload)
    return data
  }

  async generateManifest({ shipment_ids }) {
    const ids = Array.isArray(shipment_ids) ? shipment_ids : [shipment_ids]
    const { data } = await this.api('post', '/manifests/generate', { shipment_id: ids })
    return data
  }

  async checkServiceability({ pickup_postcode, delivery_postcode, cod = false, weight = 0.5 }) {
    const params = {
      pickup_postcode: String(pickup_postcode),
      delivery_postcode: String(delivery_postcode),
      cod: cod ? 1 : 0,
      weight: Number(weight || 0.5)
    }
    const { data } = await this.api('get', '/courier/serviceability', params)
    return data
  }

  async cancelOrders({ order_ids }) {
    const ids = Array.isArray(order_ids) ? order_ids : [order_ids]
    if (!ids.length) return null
    const { data } = await this.api('post', '/orders/cancel', { ids })
    return data
  }
}

module.exports = Shiprocket



