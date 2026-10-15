require('dotenv').config();
const { campaign, eligible, CATEGORY_NAMES_SQL } = require('../services/shiwangOffer');
async function preflight(db, logger = console) {
  const branch = Number(process.env.MOBILE_BRANCH_ID || 3);
  const { rows } = await db.query(`SELECT p.id AS product_id,p.name,p.brand_name,p.gender,
    ${CATEGORY_NAMES_SQL} AS category_names,v.id AS variant_id,v.size,v.colour,v.mrp,v.sale_price,v.b2c_discount_pct,
    GREATEST(0,COALESCE(s.on_hand,0)-COALESCE(s.reserved,0)) AS available,
    (p.is_active AND v.is_active AND COALESCE(s.is_active,false)) AS active
    FROM products p JOIN product_variants v ON v.product_id=p.id
    LEFT JOIN branch_variant_stock s ON s.variant_id=v.id AND s.branch_id=$1
    WHERE lower(trim(p.brand_name))='shiwang' ORDER BY p.id,v.id`, [branch]);
  const products = rows.filter(eligible);
  logger.log('Campaign:', campaign());
  logger.log(`Branch ${branch}: ${products.length} eligible variants; ${products.filter(p => p.active && Number(p.available)>0).length} in stock.`);
  if (!products.length) throw new Error('No matching Shiwang / Women / Kurthi Pant Set products found. Check catalogue classification.');
  logger.table(products.map(p => ({ product_id:p.product_id,variant_id:p.variant_id,size:p.size,colour:p.colour,
    saved_price:Number(p.b2c_discount_pct)>0 ? Number(p.mrp)*(1-Number(p.b2c_discount_pct)/100) : Number(p.sale_price || p.mrp),
    offer_single:990,available:p.active ? p.available : 0 })));
  logger.log('Read-only check complete. No product prices or schema were changed.');
  return products;
}
if (require.main === module) {
  let pool;
  (async () => { pool=require('../db'); await preflight(pool); })()
    .catch(e => { console.error(e.message); process.exitCode=1; }).finally(() => pool?.end());
}
module.exports = { preflight };
