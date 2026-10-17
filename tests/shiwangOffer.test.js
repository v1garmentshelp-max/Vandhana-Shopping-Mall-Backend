const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeQuote } = require('../services/mobileRules');
const { eligible, campaign, OFFER } = require('../services/shiwangOffer');
const now = Date.parse('2026-10-16T12:00:00+05:30');
const row = (qty = 1, extra = {}) => ({ cart_item_id: 1, variant_id: 11, product_id: 1, quantity: qty,
  brand_name: 'SHIWANG', gender: 'WOMEN', category_names: ['Women', 'Kurthi Pant Set'], name: 'Kurthi Pant Set',
  mrp: 1190, sale_price: 990, b2c_discount_pct: 0, variant_active: true, product_active: true,
  stock_active: true, on_hand: 100, reserved: 0, ...extra });
const quote = (rows, time = now, points = 0, method = 'ONLINE') => makeQuote(rows, points, { now: time }, method);
test('1–12 eligible sets follow the exact repeating pair rule, without rounding drift', () => {
  for (let qty = 1; qty <= 12; qty++) {
    const q = quote([row(qty)]);
    assert.equal(q.subtotal, Math.floor(qty / 2) * 1599 + qty % 2 * 990);
    assert.equal(q.items.reduce((sum, i) => sum + Math.round(i.price * 100) * i.qty, 0), q.subtotal * 100);
    assert.equal(q.items.reduce((sum, i) => sum + i.qty, 0), qty);
    assert.equal(q.offer_discount, Math.floor(qty / 2) * 381);
  }
});
test('pairs mix products and variants while unrelated/custom products retain their prices', () => {
  const rows = [row(1), row(2, { cart_item_id: 2, variant_id: 12, product_id: 2, size: 'XL', colour: 'Red' }),
    row(1, { cart_item_id: 3, variant_id: 13, brand_name: 'Other', sale_price: 500 }),
    { cart_item_id: 4, is_custom: true, quantity: 1, server_custom: { name: 'Custom', price: 800, mrp: 800 } }];
  const q = quote(rows);
  assert.equal(q.subtotal, 2589 + 500 + 800);
  assert.equal(q.offers[0].quantity, 3);
  assert.equal(q.fingerprint, quote([...rows].reverse()).fingerprint);
});
test('eligibility requires the exact brand, women and an actual qualifying category', () => {
  assert.ok(eligible(row(1, { brand_name: ' Shiwang ', category_names: ['Women', 'Kurti Pant Set', 'Printed'] })));
  for (const extra of [{ brand_name: 'Shiwang Plus' }, { gender: 'MEN' }, { is_custom: true },
    { category_names: ['Women', 'Pant'] }, { category_names: ['Women', 'Kurthi'] }, { category_names: [] }]) assert.equal(eligible(row(1, extra)), false);
  assert.equal(quote([row(2, { category_names: ['Women', 'Pant'] })]).subtotal, 1980);
});
test('India-time start is inclusive and midnight after October 20 is exclusive', () => {
  assert.equal(campaign(Date.parse(OFFER.starts_at) - 1).active, false);
  assert.equal(campaign(Date.parse(OFFER.starts_at)).active, true);
  assert.equal(quote([row(2)], Date.parse(OFFER.ends_at) - 1).subtotal, 1599);
  const expired = quote([row(2)], Date.parse(OFFER.ends_at));
  assert.equal(expired.subtotal, 1980);
  assert.deepEqual(expired.offers, []);
  assert.notEqual(expired.fingerprint, quote([row(2)]).fingerprint);
});
test('delivery, COD and rewards use the discounted subtotal; catalogue discount is not stacked', () => {
  const single = quote([row()], now, 0, 'COD');
  assert.equal(single.delivery_fee, 30); assert.equal(single.cod_fee, 10); assert.equal(single.payable, 1030);
  const pair = quote([row(2, { b2c_discount_pct: 20 })], now, 20, 'COD');
  assert.equal(pair.subtotal, 1599); assert.equal(pair.cod_fee, 30); assert.equal(pair.delivery_fee, 0); assert.equal(pair.payable, 1609);
  assert.equal(pair.discount, 781);
});
test('stock checks still prevent overselling eligible sets', () => {
  assert.throws(() => quote([row(4, { on_hand: 3 })]), /no longer available/);
});

test('shipping keeps paired and single price lines distinct with unique SKUs', async () => {
  const Shiprocket = require('../services/shiprocketService');
  const shipping = new Shiprocket({ pool: null });
  let payload;
  shipping.api = async (_method, _path, data) => { payload = data; return { data: { order_id: 1 } }; };
  await shipping.createOrderShipment({ channel_order_id: 'test-sale', pickup_location: 'test',
    customer: { name: 'Test', address: { line1: '12 Test Street', city: 'Tirupati', state: 'AP', pincode: '517501' } },
    order: { items: [{ id: 'paired', variant_id: 11, qty: 2, price: 799.5 }, { id: 'single', variant_id: 11, qty: 1, price: 990 }], payment_method: 'COD', shipping_charges: 30 } });
  assert.equal(payload.sub_total, 2589);
  assert.equal(payload.order_items[0].selling_price, 799.5);
  assert.notEqual(payload.order_items[0].sku, payload.order_items[1].sku);
});
