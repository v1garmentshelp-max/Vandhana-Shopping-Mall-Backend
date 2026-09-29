const error = (message, status = 409, code = 'POLICY_REVIEW_REQUIRED') => Object.assign(new Error(message), {
  status,
  code
});
const paise = value => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100000000) throw error('The saved amount needs store review.');
  return Math.round(number * 100);
};
function policy() {
  const number = (name, fallback) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value < 0 || value > 100000) throw error('Delivery settings need a store update.', 503);
    return value;
  };
  return {
    version: 2,
    free_shipping_threshold: number('STORE_FREE_SHIPPING_THRESHOLD', 1000),
    delivery_below_threshold: number('STORE_DELIVERY_BELOW_THRESHOLD', 30),
    cod_below_threshold: number('STORE_COD_BELOW_THRESHOLD', 10),
    cod_at_or_above_threshold: number('STORE_COD_AT_OR_ABOVE_THRESHOLD', 30),
    threshold_basis: 'PRODUCT_SUBTOTAL_BEFORE_REWARDS',
    cancellation_days: 7,
    return_days: 7,
    innerwear_returns: false,
    shipping_refundable: false,
    cod_fee_refundable: false
  };
}
function deliveryCharges(subtotal, method, config = policy()) {
  if (!['COD', 'ONLINE'].includes(method)) throw error('Choose cash on delivery or online payment.', 400, 'PAYMENT_METHOD_REQUIRED');
  const below = paise(subtotal) < paise(config.free_shipping_threshold);
  const delivery = below ? paise(config.delivery_below_threshold) : 0;
  const cod = method === 'COD' ? paise(below ? config.cod_below_threshold : config.cod_at_or_above_threshold) : 0;
  return {
    policy_version: 2,
    payment_method: method,
    delivery_fee: delivery / 100,
    cod_fee: cod / 100,
    shipping: (delivery + cod) / 100
  };
}
function cancellationEligibility(sale, shipments = [], workflow = null, request = null, now = Date.now()) {
  const created = new Date(sale.created_at).getTime();
  const deadline = Number.isFinite(created) ? new Date(created + 7 * 86400000).toISOString() : null;
  let reason = null;
  if (request) reason = request.status === 'COMPLETED' ? 'This order is cancelled.' : 'Your cancellation request is already being processed.';else if (!deadline || now < created || now > new Date(deadline).getTime()) reason = 'The 7-day cancellation window has ended.';else if (!['PLACED', 'CONFIRMED', 'PACKED', 'PROCESSING', 'NEW', 'PENDING'].includes(String(sale.status).toUpperCase())) reason = 'Cancellation is unavailable after dispatch. Eligible items can be returned within 7 days of delivery.';else if (shipments.some(s => s.delivered_at || !['NEW', 'CREATED', 'CONFIRMED', 'PACKED', 'AWB_ASSIGNED', 'AWB ASSIGNED', 'PICKUP SCHEDULED', 'PICKUP_SCHEDULED', 'PICKUP GENERATED', 'PICKUP_GENERATED'].includes(String(s.status).toUpperCase()))) reason = 'The shipment has progressed. Contact the store to check the delivery or return options.';else if (workflow?.create_attempted && !shipments.some(s => s.shiprocket_order_id)) reason = 'The carrier booking needs store review before cancellation.';
  return {
    eligible: !reason,
    reason,
    deadline,
    request: request || null
  };
}
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total) || total < 0 || !sum) return weights.map(() => 0);
  const entries = weights.map((weight, index) => ({
    index,
    base: Math.floor(total * weight / sum),
    remainder: total * weight % sum
  }));
  let left = total - entries.reduce((s, e) => s + e.base, 0);
  for (const e of [...entries].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) if (left-- > 0) e.base++;
  return entries.map(e => e.base);
}
function orderRefundBasis(sale, items) {
  const totals = typeof sale.totals === 'string' ? JSON.parse(sale.totals) : sale.totals || {};
  const feeValue = totals.shipping ?? totals.convenience;
  if (feeValue == null) throw error('Delivery charges were not recorded for this older order. The store must verify its original invoice before refunding.');
  const fees = paise(feeValue);
  const total = paise(sale.total ?? totals.payable);
  const ordered = [...items].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!ordered.length || ordered.some(i => !Number.isSafeInteger(Number(i.qty)) || Number(i.qty) <= 0)) throw error('Saved order items need store review.');
  const weights = ordered.map(i => paise(i.price) * Number(i.qty));
  const subtotal = weights.reduce((a, b) => a + b, 0);
  const points = Number(totals.reward_points ?? totals.rewardPoints ?? totals.rewardDiscount ?? 0);
  if (!Number.isSafeInteger(points) || points < 0 || points * 100 > subtotal + fees) throw error('The saved reward discount needs store review.');
  const cash = Math.max(0, Math.min(subtotal - Math.min(subtotal, points * 100), total - fees));
  const cashLines = allocate(cash, weights);
  const pointLines = allocate(points, weights);
  return {
    cash_paise: cash,
    points,
    excluded_fees_paise: fees,
    lines: ordered.map((item, index) => ({
      sale_item_id: item.id,
      variant_id: item.variant_id,
      qty: Number(item.qty),
      cash_paise: cashLines[index],
      points: pointLines[index]
    }))
  };
}
function unitSlice(total, count, start, quantity) {
  const each = Math.floor(total / count);
  const extra = total % count;
  return each * quantity + Math.max(0, Math.min(start + quantity, extra) - Math.min(start, extra));
}
function selectedRefund(basis, selections, previous = []) {
  const seen = new Set();
  const lines = selections.map(selection => {
    const line = basis.lines.find(i => selection.sale_item_id ? String(i.sale_item_id) === String(selection.sale_item_id) : selection.variant_id != null && String(i.variant_id) === String(selection.variant_id));
    const qty = Number(selection.qty);
    if (!line || seen.has(line.sale_item_id) || !Number.isSafeInteger(qty) || qty <= 0) throw error('Select valid order items and quantities.');
    seen.add(line.sale_item_id);
    const prior = previous.filter(p => p.sale_item_id ? String(p.sale_item_id) === String(line.sale_item_id) : p.variant_id != null && String(p.variant_id) === String(line.variant_id)).reduce((sum, p) => sum + Number(p.qty), 0);
    if (prior < 0 || prior + qty > line.qty) throw error('These items have already been included in another return.');
    const previousLines = previous.filter(p => p.sale_item_id ? String(p.sale_item_id) === String(line.sale_item_id) : p.variant_id != null && String(p.variant_id) === String(line.variant_id));
    const allocatedCash = previousLines.every(p => p.refund_cash_paise != null) ? previousLines.reduce((sum, p) => sum + Number(p.refund_cash_paise), 0) : unitSlice(line.cash_paise, line.qty, 0, prior);
    const allocatedPoints = previousLines.every(p => p.refund_points != null) ? previousLines.reduce((sum, p) => sum + Number(p.refund_points), 0) : unitSlice(line.points, line.qty, 0, prior);
    const remainingQty = line.qty - prior;
    if (allocatedCash > line.cash_paise || allocatedPoints > line.points) throw error('Earlier refunds need store reconciliation.');
    return {
      sale_item_id: line.sale_item_id,
      qty,
      cash_paise: unitSlice(line.cash_paise - allocatedCash, remainingQty, 0, qty),
      points: unitSlice(line.points - allocatedPoints, remainingQty, 0, qty)
    };
  });
  return {
    amount_paise: lines.reduce((sum, l) => sum + l.cash_paise, 0),
    reward_points: lines.reduce((sum, l) => sum + l.points, 0),
    excluded_fees_paise: basis.excluded_fees_paise,
    currency: 'INR',
    lines
  };
}
module.exports = {
  policy,
  deliveryCharges,
  cancellationEligibility,
  orderRefundBasis,
  selectedRefund,
  paise,
  error
};
