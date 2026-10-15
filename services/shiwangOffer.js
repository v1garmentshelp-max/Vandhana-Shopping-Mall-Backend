// This campaign changes retail quotes only; catalogue prices are never overwritten.
const OFFER = Object.freeze({
  id: 'SHIWANG_PAIR_OCT2026',
  brand: 'Shiwang',
  category: 'Women Kurthi Pant Set',
  starts_at: '2026-10-15T00:00:00+05:30',
  ends_at: '2026-10-21T00:00:00+05:30', // exclusive: includes all of October 20 in India
  timezone: 'Asia/Kolkata',
  single_price: 990,
  pair_price: 1599,
  currency: 'INR',
  scope: 'B2C',
});
const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const categories = new Set(['kurthipantset', 'kurtipantset', 'kurtapantset', 'kurthipantsets', 'kurtipantsets', 'kurtapantsets']);
function eligible(product) {
  if (product.is_custom || normalize(product.brand_name || product.brand) !== 'shiwang') return false;
  if (!['women', 'womens', 'woman', 'ladies', 'female'].includes(normalize(product.gender))) return false;
  const names = [...(product.category_names || []), product.category_name, product.categoryName,
    ...String(product.category_path || product.categoryPath || '').split('>')];
  return names.some(name => categories.has(normalize(name)));
}
function campaign(now = Date.now()) {
  const time = Number(new Date(now));
  const enabled = process.env.SHIWANG_OFFER_ENABLED !== 'false';
  const status = !enabled ? 'DISABLED' : time < Date.parse(OFFER.starts_at) ? 'SCHEDULED' : time >= Date.parse(OFFER.ends_at) ? 'EXPIRED' : 'ACTIVE';
  return { ...OFFER, enabled, active: status === 'ACTIVE', status };
}
function annotateProduct(product) {
  return { ...product, offer: eligible(product) ? OFFER : null };
}
// Allocate complete pairs first. Splitting an odd line avoids rounding an average
// unit price (e.g. 7 pieces) and keeps payment, invoice and partial refunds exact.
function applyOffer(items, now = Date.now()) {
  const offer = campaign(now);
  const quantity = offer.active ? items.filter(item => item.offer_eligible && !item.is_custom).reduce((sum, item) => sum + item.qty, 0) : 0;
  const pairs = Math.floor(quantity / 2);
  let remainingPairedUnits = pairs * 2;
  const lines = items.flatMap(item => {
    const { offer_eligible, ...base } = item;
    if (!quantity || !offer_eligible || item.is_custom) return [base];
    const paired = Math.min(item.qty, remainingPairedUnits);
    remainingPairedUnits -= paired;
    const single = item.qty - paired;
    const common = { ...base, offer_id: offer.id, regular_price: offer.single_price };
    return [
      ...(paired ? [{ ...common, qty: paired, price: offer.pair_price / 2, offer_part: 'PAIR' }] : []),
      ...(single ? [{ ...common, qty: single, price: offer.single_price, offer_part: 'SINGLE' }] : []),
    ];
  });
  return {
    items: lines,
    offers: quantity ? [{ ...offer, quantity, pairs, singles: quantity % 2,
      subtotal: pairs * offer.pair_price + (quantity % 2) * offer.single_price,
      discount: pairs * (2 * offer.single_price - offer.pair_price) }] : [],
    offer_discount: pairs * (2 * offer.single_price - offer.pair_price),
  };
}
// Only category names from the product's actual database ancestry are trusted.
const CATEGORY_NAMES_SQL = `(WITH RECURSIVE ancestry AS (
  SELECT id, name, parent_id FROM product_categories WHERE id=p.category_id
  UNION SELECT c.id, c.name, c.parent_id FROM product_categories c JOIN ancestry a ON c.id=a.parent_id
) SELECT COALESCE(array_agg(name), ARRAY[]::text[]) FROM ancestry)`;
module.exports = { OFFER, eligible, campaign, annotateProduct, applyOffer, CATEGORY_NAMES_SQL };
