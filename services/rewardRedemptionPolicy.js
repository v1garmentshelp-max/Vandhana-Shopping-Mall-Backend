const MAX_REDEMPTION_PERCENT = 10;

function redemptionLimit(items, orderSubtotal) {
  if (!Array.isArray(items)) throw new Error('Verified order items are required for reward redemption');
  let subtotalPaise = 0;
  for (const item of items) {
    const qty = Number(item.qty);
    const pricePaise = Math.round(Number(item.price) * 100);
    if (!Number.isSafeInteger(qty) || qty <= 0 || !Number.isSafeInteger(pricePaise) || pricePaise < 0) {
      throw new Error('Invalid order items for reward redemption');
    }
    subtotalPaise += qty * pricePaise;
  }
  const orderPaise = orderSubtotal == null ? subtotalPaise : Math.round(Number(orderSubtotal) * 100);
  if (!Number.isSafeInteger(orderPaise) || orderPaise < 0 || !Number.isSafeInteger(subtotalPaise)) {
    throw new Error('Invalid order subtotal for reward redemption');
  }
  return Number(BigInt(Math.min(orderPaise, subtotalPaise)) * BigInt(MAX_REDEMPTION_PERCENT) / 10000n);
}

function redemptionLimitError(maxRedeemable, status = 409) {
  return Object.assign(new Error(`Redeem up to ${MAX_REDEMPTION_PERCENT}% of the product subtotal after discounts. The maximum for this order is ${maxRedeemable} points. Delivery and COD charges are excluded.`), {
    status,
    code: 'REWARD_LIMIT_EXCEEDED',
    max_redeemable: maxRedeemable,
    max_redemption_percent: MAX_REDEMPTION_PERCENT
  });
}

module.exports = { MAX_REDEMPTION_PERCENT, redemptionLimit, redemptionLimitError };
