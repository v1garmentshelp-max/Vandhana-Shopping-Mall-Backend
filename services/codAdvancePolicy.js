const COD_ADVANCE_THRESHOLD = 500;
const COD_ADVANCE_FEE = 150;
const money = value => Math.round(Number(value) * 100) / 100;
const totalsOf = sale => typeof sale.totals === 'string' ? JSON.parse(sale.totals) : sale.totals || {};
function advanceFor(subtotal, method) {
  return method === 'COD' && Math.round(Number(subtotal) * 100) >= COD_ADVANCE_THRESHOLD * 100 ? COD_ADVANCE_FEE : 0;
}
function hasAdvance(checkout) {
  return checkout.payment_method === 'COD' && Number(checkout.quote?.cod_advance || 0) > 0;
}
function paymentReady(checkout) {
  if (checkout.payment_method === 'COD') return !hasAdvance(checkout) || checkout.gateway_state === 'PAID' && !!checkout.gateway_payment_id;
  return ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(checkout.payment_status);
}
function salePayment(sale) {
  const totals = totalsOf(sale);
  const required = sale.payment_method === 'COD' ? Number(totals.cod_advance || 0) : 0;
  const paid = Number(totals.cod_advance_paid || 0);
  if (![required, paid].every(value => Number.isFinite(value) && value >= 0) || paid > required) throw Object.assign(new Error('The saved COD payment needs store review.'), { status: 409 });
  return {
    advance_required: required,
    advance_paid: paid,
    advance_pending: required > paid,
    balance_on_delivery: sale.payment_method === 'COD' ? money(Math.max(0, Number(sale.total) - required)) : 0
  };
}
function assertAdvancePaid(sale) {
  if (salePayment(sale).advance_pending) throw Object.assign(new Error('The COD advance payment must be verified before dispatch.'), { status: 409, code: 'COD_ADVANCE_PENDING' });
}
function carrierAmounts(sale, subtotal) {
  assertAdvancePaid(sale);
  const totals = totalsOf(sale);
  const paid = salePayment(sale).advance_paid;
  const shipping = Number(totals.shipping ?? totals.convenience ?? Math.max(0, Number(sale.total) - subtotal));
  const charges = money(Math.max(0, shipping - paid));
  const collect = money(Number(sale.total) - paid);
  const discount = money(subtotal + charges - collect);
  if (![charges, collect, discount].every(value => Number.isFinite(value) && value >= 0)) throw Object.assign(new Error('The shipment payment amounts need store review.'), { status: 409 });
  return { shipping_charges: charges, total_discount: discount, collection_amount: collect };
}
module.exports = { COD_ADVANCE_THRESHOLD, COD_ADVANCE_FEE, advanceFor, hasAdvance, paymentReady, salePayment, assertAdvancePaid, carrierAmounts };
