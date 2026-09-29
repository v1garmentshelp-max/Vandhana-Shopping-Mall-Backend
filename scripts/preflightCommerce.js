require('dotenv').config();
const pool = require('../db');
const {
  policy
} = require('../services/commercePolicy');
async function preflight(db = pool) {
  const fields = {
    storefront_cancellations: 'sale_id user_id reason source requested_by status carrier_attempted refund_amount_paise refund_points excluded_fees_paise refund_status refund_reference processed_by last_error created_at updated_at',
    return_requests: 'id sale_id status refund_status refund_amount_paise refund_points excluded_fees_paise refund_reference refund_received_at refund_processed_by bank_upi updated_at reverse_pickup_attempted reverse_pickup_error',
    return_items: 'sale_item_id variant_id refund_cash_paise refund_points',
    order_cancellations: 'sale_id payment_type reason cancellation_source created_at',
    reward_point_lots: 'id user_id source_type source_ref points_granted points_remaining created_at updated_at',
    shipments: 'shiprocket_order_id shiprocket_shipment_id delivered_at raw_status updated_at'
  };
  for (const [table, columns] of Object.entries(fields)) await db.query(`SELECT ${columns.split(' ').join(',')} FROM ${table} LIMIT 0`);
  console.log('Commerce database preflight passed. Delivery policy:', JSON.stringify(policy()));
}
if (require.main === module) preflight().catch(e => {
  console.error('Commerce preflight failed:', e.message);
  process.exitCode = 1;
}).finally(() => pool.end());
module.exports = {
  preflight
};
