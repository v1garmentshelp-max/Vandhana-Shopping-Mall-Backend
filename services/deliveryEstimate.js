const Shiprocket = require('./shiprocketService');
const { validPin } = require('./indiaLocations');
const unavailable = () => ({ status: 'unavailable', serviceable: null, message: 'Delivery availability and timing cannot be confirmed right now. The store will confirm after reviewing your order.' });
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const flag = value => value === true || value === 1 || value === '1';
function createDeliveryEstimator({ client = new Shiprocket({ pool: null, timeoutMs: 3500 }), env = process.env, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  async function estimate({ db, branchId, pincode, paymentMethod, items }) {
    if (!validPin(pincode) || !['COD', 'ONLINE'].includes(paymentMethod)) throw Object.assign(new Error('Enter a valid PIN code and payment method.'), { status: 400, code: 'INVALID_DELIVERY_REQUEST' });
    if (!env.SHIPROCKET_API_USER_EMAIL || !env.SHIPROCKET_API_USER_PASSWORD) return unavailable();
    try {
      const warehouse = (await db.query('SELECT name,pincode FROM shiprocket_warehouses WHERE branch_id=$1 LIMIT 1', [branchId])).rows[0];
      if (!warehouse?.name || !validPin(warehouse.pincode)) return unavailable();
      const unitWeight = Number(env.STORE_ITEM_WEIGHT_KG || env.SHIPROCKET_DEFAULT_WEIGHT_KG || 0.5);
      const packaging = Number(env.STORE_PACKAGING_WEIGHT_KG || 0);
      const quantity = items.reduce((total, item) => total + Number(item.qty), 0);
      const weight = Math.ceil((unitWeight * quantity + packaging) * 1000) / 1000;
      if (!positive(unitWeight) || !Number.isFinite(packaging) || packaging < 0 || !Number.isSafeInteger(quantity) || quantity < 1 || !positive(weight) || weight > 100) return unavailable();
      const key = `${warehouse.pincode}:${pincode}:${paymentMethod}:${weight}`;
      const saved = cache.get(key);
      if (saved?.until > now()) return saved.data;
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= 30) return unavailable();
      const job = (async () => {
        let result;
        try {
          const response = await client.checkServiceability({ pickup_postcode: String(warehouse.pincode), delivery_postcode: String(pincode), cod: paymentMethod === 'COD', weight });
          const couriers = response?.data?.available_courier_companies;
          if (!Array.isArray(couriers) || response.status && Number(response.status) !== 200) return unavailable();
          const available = couriers.filter(row => positive(row.courier_company_id) && !flag(row.blocked) && (paymentMethod !== 'COD' || flag(row.cod)));
          if (!available.length) result = { status: 'not_serviceable', serviceable: false, message: `Delivery is not currently available to this PIN code with ${paymentMethod === 'COD' ? 'cash on delivery. Try online payment or another address.' : 'online payment. Try another delivery address.'}` };
          else {
            const days = available.map(row => positive(row.estimated_delivery_days) ? Math.ceil(Number(row.estimated_delivery_days)) : positive(row.etd_hours) ? Math.ceil(Number(row.etd_hours) / 24) : null).filter(value => value !== null && value <= 90);
            const min = days.length ? Math.min(...days) : null, max = days.length ? Math.max(...days) : null;
            result = { status: 'available', serviceable: true, min_days: min, max_days: max, message: days.length ? `Estimated transit: ${min === max ? min : `${min}–${max}`} days after dispatch. Packing time is additional; the final courier may vary.` : 'Delivery is available. The courier has not provided a delivery-time estimate.' };
          }
          result = { ...result, pincode: String(pincode), payment_method: paymentMethod, source: 'Shiprocket', checked_at: new Date(now()).toISOString() };
        } catch { result = unavailable(); }
        if (cache.size >= 1000) cache.delete(cache.keys().next().value);
        cache.set(key, { data: result, until: now() + (result.serviceable === null ? 15000 : 300000) });
        return result;
      })();
      pending.set(key, job);
      try { return await job; } finally { pending.delete(key); }
    } catch { return unavailable(); }
  }
  return { estimate };
}
module.exports = { createDeliveryEstimator, ...createDeliveryEstimator() };
