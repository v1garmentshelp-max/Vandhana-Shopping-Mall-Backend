const Shiprocket = require('./shiprocketService');

class ReturnsService {
  constructor({ pool }) {
    this.pool = pool;
    this.sr = new Shiprocket({ pool });
  }

  async init() { await this.sr.init(); }

  // Creates a reverse pickup: customer → branch (is_return: true)
  async createReversePickup({ request, sale, items, branch }) {
    const wh = (await this.pool.query('SELECT * FROM shiprocket_warehouses WHERE branch_id=$1', [branch.id])).rows[0];
    if (!wh) throw new Error(`No pickup mapped for branch ${branch.id}`);

    const customer = {
      name: sale.customer_name || 'Customer',
      email: sale.customer_email || 'na@example.com',
      phone: sale.customer_mobile || '9999999999',
      address: {
        line1: sale.shipping_address?.line1 || sale.shipping_address || '',
        line2: sale.shipping_address?.line2 || '',
        city:  sale.shipping_address?.city || '',
        state: sale.shipping_address?.state || '',
        pincode: sale.shipping_address?.pincode || sale.pincode || ''
      }
    };

    // Use the same adhoc create, but flip addresses and set is_return
    const payload = {
      order_id: `RET-${request.id}`,
      order_date: new Date().toISOString(),
      pickup_location: `${wh.name}`,
      // bill to branch (where item will be returned)
      billing_customer_name: branch.name || 'Warehouse',
      billing_last_name: '',
      billing_address: wh.address,
      billing_address_2: '',
      billing_city: wh.city,
      billing_pincode: wh.pincode,
      billing_state: wh.state,
      billing_country: 'India',
      billing_email: sale.customer_email || 'na@example.com',
      billing_phone: sale.customer_mobile || '9999999999',

      // ship-from customer (reverse)
      shipping_is_billing: false,
      shipping_customer_name: customer.name,
      shipping_last_name: '',
      shipping_address: customer.address.line1,
      shipping_address_2: customer.address.line2 || '',
      shipping_city: customer.address.city,
      shipping_pincode: customer.address.pincode,
      shipping_state: customer.address.state,
      shipping_country: 'India',
      shipping_email: customer.email,
      shipping_phone: customer.phone,

      order_items: items.map(it => ({
        name: `Return ${it.variant_id}`,
        sku: String(it.variant_id),
        units: it.qty,
        selling_price: 0
      })),

      payment_method: 'Prepaid',
      sub_total: 0,
      length: 10, breadth: 10, height: 5, weight: 0.5,
      is_return: true
    };

    const { data } = await this.sr.api('post', '/orders/create/adhoc', payload);
    const shipmentId = Array.isArray(data?.shipment_id) ? data.shipment_id[0] : data?.shipment_id || null;

    let awb = null, labelUrl = null;
    if (shipmentId) {
      const res = await this.sr.assignAWBAndLabel({ shipment_id: shipmentId });
      awb = res.awb?.response?.data?.awb_code || null;
      labelUrl = res.label?.label_url || null;
    }

    const ins = await this.pool.query(
      `INSERT INTO reverse_shipments (request_id, shiprocket_order_id, shiprocket_shipment_id, awb, label_url, tracking_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        request.id,
        data?.order_id || null,
        shipmentId,
        awb,
        labelUrl,
        data?.tracking_url || null,
        'CREATED'
      ]
    );

    return ins.rows[0];
  }
}

module.exports = ReturnsService;
