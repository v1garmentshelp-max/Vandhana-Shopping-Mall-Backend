const crypto = require('node:crypto');
const fail = (message, status = 400, code) => Object.assign(new Error(message), {
  status,
  code
});
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
function integer(value, min = 1, max = 99) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw fail('Invalid quantity or points');
  return n;
}
function priceOf(row) {
  const mrp = Number(row.mrp) || Number(row.sale_price);
  const pct = Number(row.b2c_discount_pct || 0);
  const price = money(pct > 0 ? mrp * (1 - Math.min(pct, 100) / 100) : Number(row.sale_price) || mrp);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(mrp)) throw fail('This item needs a price update before checkout.', 409);
  return {
    price,
    mrp: money(mrp)
  };
}
function addressOf(value) {
  const clean = key => String(value?.[key] || '').trim().slice(0, 250);
  const a = Object.fromEntries(['fullName', 'mobile', 'line1', 'line2', 'city', 'state', 'pincode'].map(k => [k, clean(k)]));
  if (a.fullName.length < 2 || a.line1.length < 5 || !a.city || !a.state || !/^[1-9]\d{5}$/.test(a.pincode) || !/^[6-9]\d{9}$/.test(a.mobile)) throw fail('Enter a complete delivery address and valid Indian mobile number.');
  return a;
}
function makeQuote(rows, requestedPoints, settings = {}) {
  if (!rows.length) throw fail('Your bag is empty.', 409);
  const points = integer(requestedPoints || 0, 0, 1000000);
  const items = rows.map(row => {
    if (row.is_custom) {
      if (!row.server_custom) throw fail('Custom garment pricing is unavailable.', 409);
      return {
        cart_item_id: Number(row.cart_item_id),
        variant_id: null,
        product_id: null,
        qty: integer(row.quantity, 1, 20),
        ...row.server_custom,
        is_custom: true,
        custom_payload: row.custom_payload,
        image_url: row.custom_image_url,
        ean_code: null
      };
    }
    const qty = integer(row.quantity);
    if (!row.variant_active || !row.product_active || !row.stock_active || Number(row.on_hand) - Number(row.reserved || 0) < qty) throw fail(`${row.name || 'An item'} is no longer available in this quantity. Update your bag.`, 409, 'OUT_OF_STOCK');
    return {
      cart_item_id: Number(row.cart_item_id),
      variant_id: Number(row.variant_id),
      product_id: Number(row.product_id),
      qty,
      ...priceOf(row),
      name: row.name,
      size: row.size,
      colour: row.colour,
      image_url: row.image_url,
      ean_code: row.ean_code,
      is_innerwear: !!row.is_innerwear
    };
  }).sort((a, b) => a.variant_id - b.variant_id || a.cart_item_id - b.cart_item_id);
  const subtotal = money(items.reduce((sum, i) => sum + i.price * i.qty, 0));
  const mrp = money(items.reduce((sum, i) => sum + i.mrp * i.qty, 0));
  const threshold = Number(settings.freeShippingThreshold ?? 1000);
  const fee = Number(settings.shippingFee ?? 75);
  if (!Number.isFinite(threshold) || !Number.isFinite(fee) || threshold < 0 || fee < 0) throw fail('Shipping settings need an update.', 503);
  const shipping = subtotal >= threshold ? 0 : fee;
  if (points > Math.floor(subtotal + shipping)) throw fail('Reward points exceed this order total.', 409);
  const quote = {
    items,
    subtotal,
    mrp,
    discount: money(mrp - subtotal),
    shipping,
    reward_points: points,
    payable: money(subtotal + shipping - points)
  };
  return {
    ...quote,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(quote)).digest('hex')
  };
}
function validSignature(order, payment, signature, secret) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(String(signature))) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${order}|${payment}`).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
function capturedPayment(payment, checkout) {
  return payment?.status === 'captured' && payment.order_id === checkout.gateway_order_id && Number(payment.amount) === Number(checkout.amount_paise) && payment.currency === 'INR';
}
module.exports = {
  fail,
  money,
  integer,
  priceOf,
  addressOf,
  makeQuote,
  validSignature,
  capturedPayment
};
