const MAX_POINTS_PER_PRODUCT = 10;

function redemptionLimit(items, orderSubtotal) {
  if (!Array.isArray(items)) throw new Error('Verified order items are required for reward redemption');
  let itemLimit = 0;
  let subtotalPaise = 0;
  for (const item of items) {
    const qty = Number(item.qty);
    const pricePaise = Math.round(Number(item.price) * 100);
    if (!Number.isSafeInteger(qty) || qty <= 0 || !Number.isSafeInteger(pricePaise) || pricePaise < 0) {
      throw new Error('Invalid order items for reward redemption');
    }
    itemLimit += qty * Math.min(MAX_POINTS_PER_PRODUCT, Math.max(0, Math.floor((pricePaise - 1) / 100)));
    subtotalPaise += qty * pricePaise;
  }
  const orderPaise = orderSubtotal == null ? subtotalPaise : Math.round(Number(orderSubtotal) * 100);
  if (!Number.isSafeInteger(orderPaise) || orderPaise < 0 || !Number.isSafeInteger(subtotalPaise) || !Number.isSafeInteger(itemLimit)) {
    throw new Error('Invalid order subtotal for reward redemption');
  }
  return Math.min(itemLimit, Math.max(0, Math.floor((Math.min(orderPaise, subtotalPaise) - 1) / 100)));
}

function redemptionLimitError(maxRedeemable, status = 409) {
  return Object.assign(new Error(`Redeem up to ${MAX_POINTS_PER_PRODUCT} points per product. The maximum for this order is ${maxRedeemable} points. Rewards cannot cover the full product value or delivery charges.`), {
    status,
    code: 'REWARD_LIMIT_EXCEEDED',
    max_redeemable: maxRedeemable,
    max_points_per_product: MAX_POINTS_PER_PRODUCT
  });
}

module.exports = { MAX_POINTS_PER_PRODUCT, redemptionLimit, redemptionLimitError };
