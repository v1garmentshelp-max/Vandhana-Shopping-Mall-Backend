require('dotenv').config();
const pool = require('../db');
const required = {
  vandana_users: 'id name email mobile type password updated_at',
  products: 'id name gender category_id is_active',
  product_variants: 'id product_id size colour mrp sale_price b2c_discount_pct image_url is_active',
  branch_variant_stock: 'branch_id variant_id on_hand reserved is_active updated_at',
  barcodes: 'id variant_id ean_code',
  product_images: 'ean_code image_type image_url',
  product_categories: 'id name parent_id',
  vandana_cart: 'id user_id product_id selected_size selected_color quantity is_custom custom_title custom_brand custom_image_url custom_price custom_original_price custom_payload created_at updated_at',
  vandana_wishlist: 'user_id product_id',
  sales: 'id source status payment_status payment_method total totals branch_id customer_name customer_email customer_mobile shipping_address login_email created_at updated_at',
  sale_items: 'id sale_id product_id variant_id qty price mrp size colour image_url ean_code',
  payments: 'sale_id razorpay_order_id razorpay_payment_id status amount_paise currency email phone notes',
  shipments: 'id sale_id status awb created_at',
  return_requests: 'id sale_id type reason notes status refund_status created_at',
  return_items: 'request_id variant_id qty reason_code condition_note',
  reward_settings: 'setting_key setting_value',
  reward_point_lots: 'id user_id source_type points_granted points_remaining granted_at expires_at status updated_at',
  reward_point_transactions: 'user_id lot_id sale_id transaction_type points note metadata created_at'
};
async function preflight(db) {
  if (!process.env.JWT_SECRET || ['change-me-in-env', 'dev_secret'].includes(process.env.JWT_SECRET)) throw new Error('Set a production JWT_SECRET before deploying mobile APIs.');
  for (const [table, fields] of Object.entries(required)) {
    await db.query(`SELECT ${fields.split(' ').map(x => `"${x}"`).join(',')} FROM "${table}" LIMIT 0`);
  }
  const types = await db.query(`SELECT c.relname AS table_name,a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 WHERE c.oid=ANY(ARRAY['vandana_users'::regclass,'sales'::regclass,'sale_items'::regclass,'vandana_cart'::regclass])
 AND a.attname IN ('id','product_id','variant_id') AND a.attnum>0 AND NOT a.attisdropped`);
  const type = (table, col) => types.rows.find(x => x.table_name === table && x.column_name === col);
  if (!['bigint', 'integer'].includes(type('vandana_users', 'id')?.type) || type('sales', 'id')?.type !== 'uuid' || type('sale_items', 'id')?.type !== 'uuid') throw new Error('Database primary key types differ from the supplied application schema.');
  if (type('sale_items', 'product_id')?.not_null || type('sale_items', 'variant_id')?.not_null || type('vandana_cart', 'product_id')?.not_null) throw new Error('Custom orders require nullable product/variant IDs. Review existing constraints before migration.');
  console.log('Mobile preflight: existing catalogue, cart, customer, rewards, return and order columns verified; key types compatible.');
  return types.rows;
}
if (require.main === module) preflight(pool).then(() => console.log('Read-only preflight passed. No customer or order records changed.')).catch(e => {
  console.error('Mobile preflight failed:', e.message);
  process.exitCode = 1;
}).finally(() => pool.end());
module.exports = {
  preflight
};
