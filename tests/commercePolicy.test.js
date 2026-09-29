const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const {
  policy,
  deliveryCharges,
  cancellationEligibility,
  orderRefundBasis,
  selectedRefund
} = require('../services/commercePolicy');
const {
  makeQuote
} = require('../services/mobileRules');
const fixture = {
  cart_item_id: 1,
  variant_id: 11,
  product_id: 1,
  quantity: 1,
  mrp: 1000,
  sale_price: 1000,
  b2c_discount_pct: 0,
  on_hand: 10,
  reserved: 0,
  variant_active: true,
  product_active: true,
  stock_active: true,
  name: 'Shirt'
};
test('shipping threshold includes exactly 1000, and COD fees are method specific', () => {
  for (const [amount, online, cod] of [[999.99, 30, 40], [1000, 0, 30], [1000.01, 0, 30], [5000, 0, 30]]) {
    assert.equal(deliveryCharges(amount, 'ONLINE').shipping, online);
    assert.equal(deliveryCharges(amount, 'COD').shipping, cod);
  }
  assert.equal(deliveryCharges(1500, 'COD', {
    ...policy(),
    cod_at_or_above_threshold: 50
  }).shipping, 50);
  assert.throws(() => deliveryCharges(800, 'FAKE'), /Choose/);
});
test('reward redemption does not move a qualifying order below the threshold or cover shipping', () => {
  const q = makeQuote([fixture], 900, {}, 'COD');
  assert.equal(q.subtotal, 1000);
  assert.equal(q.shipping, 30);
  assert.equal(q.payable, 130);
  assert.throws(() => makeQuote([fixture], 1001, {}, 'COD'), /exceed/);
  assert.notEqual(q.fingerprint, makeQuote([fixture], 900, {}, 'ONLINE').fingerprint);
});
test('cancellation closes after 7 days and after dispatch, independently of payment state', () => {
  const now = Date.parse('2026-09-29T12:00:00Z'),
    created = new Date(now - 7 * 86400000).toISOString();
  const sale = {
    created_at: created,
    status: 'PLACED',
    payment_status: 'PAID'
  };
  assert.equal(cancellationEligibility(sale, [], null, null, now).eligible, true);
  assert.equal(cancellationEligibility(sale, [], null, null, now + 1).eligible, false);
  assert.equal(cancellationEligibility({
    ...sale,
    status: 'SHIPPED'
  }, [], null, null, now).eligible, false);
  assert.equal(cancellationEligibility(sale, [{
    status: 'DELIVERED'
  }], null, null, now).eligible, false);
  assert.equal(cancellationEligibility(sale, [], {
    create_attempted: true
  }, null, now).eligible, false);
});
test('refunds exclude fees and reward discounts and conserve cents across partial returns', () => {
  const items = [{
    id: 'a',
    qty: 3,
    price: 333.33
  }, {
    id: 'b',
    qty: 1,
    price: 499.99
  }];
  const basis = orderRefundBasis({
    total: 1429.98,
    totals: {
      shipping: 30,
      reward_points: 100
    }
  }, items);
  assert.equal(basis.cash_paise, 139998);
  assert.equal(basis.excluded_fees_paise, 3000);
  const previous = [];
  let cash = 0,
    points = 0;
  for (const sale_item_id of ['a', 'b', 'a', 'a']) {
    const result = selectedRefund(basis, [{
      sale_item_id,
      qty: 1
    }], previous);
    cash += result.amount_paise;
    points += result.reward_points;
    previous.push({
      sale_item_id,
      qty: 1,
      refund_cash_paise: result.amount_paise,
      refund_points: result.reward_points
    });
  }
  assert.equal(cash, basis.cash_paise);
  assert.equal(points, 100);
  assert.throws(() => selectedRefund(basis, [{
    sale_item_id: 'a',
    qty: 1
  }], previous), /already/);
});
test('a rejected earlier partial return cannot cause a rounding over-refund', () => {
  const basis = orderRefundBasis({
    total: 10.01,
    totals: {
      shipping: 0,
      reward_points: 0
    }
  }, [{
    id: 'a',
    qty: 3,
    price: 10.01 / 3
  }]);
  const first = selectedRefund(basis, [{
    sale_item_id: 'a',
    qty: 1
  }]);
  const second = selectedRefund(basis, [{
    sale_item_id: 'a',
    qty: 1
  }], [{
    sale_item_id: 'a',
    qty: 1,
    refund_cash_paise: first.amount_paise,
    refund_points: 0
  }]);
  const last = selectedRefund(basis, [{
    sale_item_id: 'a',
    qty: 2
  }], [{
    sale_item_id: 'a',
    qty: 1,
    refund_cash_paise: second.amount_paise,
    refund_points: 0
  }]);
  assert.equal(second.amount_paise + last.amount_paise, basis.cash_paise);
});
test('old orders without recorded delivery costs require manual invoice review', () => {
  assert.throws(() => orderRefundBasis({
    total: 500,
    totals: {}
  }, [{
    id: 'a',
    qty: 1,
    price: 500
  }]), /original invoice/);
  assert.equal(orderRefundBasis({
    total: 40,
    totals: {
      shipping: 40,
      reward_points: 500
    }
  }, [{
    id: 'a',
    qty: 1,
    price: 500
  }]).cash_paise, 0);
});
