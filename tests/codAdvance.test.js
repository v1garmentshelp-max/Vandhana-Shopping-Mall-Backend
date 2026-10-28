const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeQuote } = require('../services/mobileRules');
const { orderRefundBasis, selectedRefund } = require('../services/commercePolicy');
const { advanceFor, paymentReady, salePayment, assertAdvancePaid, carrierAmounts } = require('../services/codAdvancePolicy');
const item = price => ({ cart_item_id: 1, variant_id: 11, product_id: 1, quantity: 1, mrp: price, sale_price: price, b2c_discount_pct: 0, on_hand: 10, reserved: 0, variant_active: true, product_active: true, stock_active: true, name: 'Dress' });
test('COD threshold is inclusive and uses discounted products before rewards', () => {
  for (const [price, advance] of [[499.99, 0], [500, 150], [999.99, 150], [1000, 150]]) {
    const q = makeQuote([item(price)], Math.floor(price / 10), {}, 'COD');
    assert.equal(q.cod_advance, advance);
    assert.equal(q.pay_now, advance);
    assert.equal(Math.round((q.pay_now + q.balance_on_delivery) * 100), Math.round(q.payable * 100));
  }
  assert.equal(advanceFor(1000, 'ONLINE'), 0);
  const discounted = makeQuote([{ ...item(600), b2c_discount_pct: 20 }], 0, {}, 'COD');
  assert.equal(discounted.subtotal, 480);
  assert.equal(discounted.cod_advance, 0);
});
test('confirmed example totals 1150 with 150 upfront and 1000 at delivery', () => {
  const q = makeQuote([item(1000)], 0, {}, 'COD');
  assert.equal(q.payable, 1150);
  assert.equal(q.pay_now, 150);
  assert.equal(q.balance_on_delivery, 1000);
  assert.equal(q.delivery_fee, 0);
  assert.equal(q.cod_fee, 150);
  const rewardQuote = makeQuote([item(1000)], 100, {}, 'COD');
  assert.equal(rewardQuote.payable, 1050);
  assert.equal(rewardQuote.pay_now, 150);
  assert.equal(rewardQuote.balance_on_delivery, 900);
  assert.throws(() => makeQuote([item(1000)], 101, {}, 'COD'), /10%/);
});
test('a paid-looking status cannot bypass the verified advance or legacy totals', () => {
  const q = makeQuote([item(1000)], 0, {}, 'COD');
  const row = { quote: q, payment_method: 'COD', payment_status: 'PAID', gateway_state: 'NEW' };
  assert.equal(paymentReady(row), false);
  assert.equal(paymentReady({ ...row, gateway_state: 'PAID' }), false);
  assert.equal(paymentReady({ ...row, gateway_state: 'PAID', gateway_payment_id: 'pay_valid' }), true);
  assert.equal(paymentReady({ payment_method: 'COD', payment_status: 'COD', quote: { shipping: 30 } }), true);
  assert.throws(() => assertAdvancePaid({ payment_method: 'COD', total: 1150, totals: q }), /verified/);
});
test('courier collectible excludes the paid advance and reward discount exactly once', () => {
  for (const [price, points, collectible, delivery] of [[1000, 0, 1000, 0], [1000, 100, 900, 0], [500, 50, 480, 30]]) {
    const q = makeQuote([item(price)], points, {}, 'COD');
    const sale = { payment_method: 'COD', total: q.payable, totals: { ...q, cod_advance_paid: 150 } };
    assert.deepEqual(carrierAmounts(sale, price), { shipping_charges: delivery, total_discount: points, collection_amount: collectible });
    assert.equal(salePayment(sale).balance_on_delivery, collectible);
  }
});
test('full and partial refunds never return the advance or turn redeemed points into cash', () => {
  const q = makeQuote([{ ...item(500), quantity: 2 }], 100, {}, 'COD');
  const basis = orderRefundBasis({ total: q.payable, totals: { ...q, cod_advance_paid: 150 } }, [{ id: 'item', qty: 2, price: 500 }]);
  assert.equal(basis.cash_paise, 90000);
  assert.equal(basis.excluded_fees_paise, 15000);
  const first = selectedRefund(basis, [{ sale_item_id: 'item', qty: 1 }]);
  const second = selectedRefund(basis, [{ sale_item_id: 'item', qty: 1 }], [{ sale_item_id: 'item', qty: 1, refund_cash_paise: first.amount_paise, refund_points: first.reward_points }]);
  assert.equal(first.amount_paise, 45000);
  assert.equal(first.reward_points, 50);
  assert.equal(first.amount_paise + second.amount_paise, 90000);
  assert.equal(first.reward_points + second.reward_points, 100);
});
