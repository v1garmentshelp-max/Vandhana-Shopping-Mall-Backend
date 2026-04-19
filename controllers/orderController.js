const { listOrders, trackByOrderId } = require('../services/shiprocketClient');
function toUiOrder(o) {
  const p = (o.products && o.products[0]) || {};
  return {
    id: o.id,
    name: p.name || o.channel_order_id || 'Order',
    brand: p.brand || o.channel || 'Shiprocket',
    image: p.image || '/images/placeholder.png',
    offerPrice: Number(o.total) || 0,
    originalPrice: o.sub_total ? Number(o.sub_total) : undefined,
    date: o.created_at ? new Date(o.created_at).toLocaleDateString('en-IN') : '',
    status: o.status || 'Order Placed'
  };
}

exports.getMyOrders = async (req, res) => {
  try {
    const { email, phone } = req.query;

    const all = [];
    for (let page = 1; page <= 5; page++) {
      const resp = await listOrders(page);
      const rows = Array.isArray(resp?.data) ? resp.data : [];
      if (!rows.length) break;
      all.push(...rows);
    }

    const filtered = all.filter(o => {
      const ce = (o.customer_email || '').toLowerCase();
      const cp = (o.customer_phone || '').replace(/\D/g, '');
      const okE = email ? ce === String(email).toLowerCase() : true;
      const okP = phone ? cp.endsWith(String(phone).replace(/\D/g, '')) : true;
      return okE && okP;
    });

    res.json({ count: filtered.length, items: filtered.map(toUiOrder) });
  } catch (err) {
    console.error('getMyOrders error', err?.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch orders from Shiprocket' });
  }
};

exports.getTracking = async (req, res) => {
  try {
    const { orderId, channelId } = req.params;
    const data = await trackByOrderId(orderId, channelId);
    res.json(data);
  } catch (err) {
    console.error('getTracking error', err?.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch tracking' });
  }
};
