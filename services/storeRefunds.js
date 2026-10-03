const pool = require('../db');
const Razorpay = require('./razorpayService');
const rewards = require('./rewardPointsService');
const {
  orderRefundBasis,
  selectedRefund,
  error
} = require('./commercePolicy');
const {
  staffAccess,
  transaction,
  locked
} = require('./orderCancellation');
async function prepareReturnRefund(db, id) {
  const request = (await db.query('SELECT * FROM return_requests WHERE id=$1', [id])).rows[0];
  if (!request) throw error('Return request not found.', 404);
  if (request.refund_amount_paise != null) return request;
  const sale = (await db.query('SELECT * FROM sales WHERE id=$1', [request.sale_id])).rows[0];
  const items = (await db.query('SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY id', [request.sale_id])).rows;
  const selected = (await db.query('SELECT * FROM return_items WHERE request_id=$1 ORDER BY id', [id])).rows;
  if (!selected.length) throw error('This older request has no selected items. Review the original invoice before refunding.');
  const previous = (await db.query(`SELECT i.* FROM return_items i JOIN return_requests r ON r.id=i.request_id
    WHERE r.sale_id=$1 AND r.id<>$2 AND (r.created_at<$3 OR (r.created_at=$3 AND r.id<$2))
    AND upper(r.status::text) NOT IN ('REJECTED','CANCELLED')`, [request.sale_id, id, request.created_at])).rows;
  const result = selectedRefund(orderRefundBasis(sale, items), selected, previous);
  for (let index = 0; index < selected.length; index++) {
    await db.query('UPDATE return_items SET refund_cash_paise=$2,refund_points=$3 WHERE id=$1', [selected[index].id, result.lines[index].cash_paise, result.lines[index].points]);
  }
  return (await db.query(`UPDATE return_requests SET refund_amount_paise=$2,refund_points=$3,excluded_fees_paise=$4
    WHERE id=$1 RETURNING *`, [id, result.amount_paise, result.reward_points, result.excluded_fees_paise])).rows[0];
}
function publicRefund(request) {
  return {
    amount: Number(request.refund_amount_paise || 0) / 100,
    amount_paise: Number(request.refund_amount_paise || 0),
    reward_points: Number(request.refund_points || 0),
    excluded_delivery_and_cod: Number(request.excluded_fees_paise || 0) / 100,
    currency: 'INR',
    status: request.refund_status,
    reference: request.refund_reference || null,
    processed_at: request.refund_received_at || null,
    items_received_at: request.items_received_at || null
  };
}
async function verifyRefund(db, sale, amount, body, kind, id) {
  if (Number(body.amount_paise) !== amount) throw error('The refund amount must exactly match the product-only refund shown by the store.');
  if (amount === 0) return null;
  const reference = String(body.reference || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{5,99}$/.test(reference)) throw error('Enter the processed refund ID or bank transfer reference.', 400);
  const initiated = (await db.query('SELECT provider_refund_id FROM order_refund_operations WHERE kind=$1 AND request_id=$2 AND provider=$3', [kind,String(id),'RAZORPAY'])).rows[0];
  if (initiated && initiated.provider_refund_id !== reference) throw error('A gateway refund has already been initiated. Reconcile that saved refund before recording another reference.');
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`refund-reference:${reference}`]);
  const duplicate = await db.query(`SELECT refund_reference FROM return_requests WHERE refund_reference=$1
    UNION ALL SELECT refund_reference FROM storefront_cancellations WHERE refund_reference=$1`, [reference]);
  if (duplicate.rowCount) throw error('This refund reference is already recorded against another request.');
  if (String(sale.payment_method).toUpperCase() === 'COD') {
    if (body.transfer_confirmed !== true) throw error('Confirm that the product-only bank or UPI refund has been sent.');
  } else {
    const payment = (await db.query('SELECT * FROM payments WHERE sale_id=$1 AND razorpay_payment_id IS NOT NULL ORDER BY id DESC LIMIT 1', [sale.id])).rows[0];
    if (!payment) throw error('The original online payment needs reconciliation before a refund can be confirmed.');
    const {
      data
    } = await new Razorpay({}).client.get(`/payments/${encodeURIComponent(payment.razorpay_payment_id)}/refunds/${encodeURIComponent(reference)}`);
    if (data?.id !== reference || data.payment_id !== payment.razorpay_payment_id || data.status !== 'processed' || data.currency !== 'INR' || Number(data.amount) !== amount) throw error('Razorpay has not confirmed a processed refund for this exact payment and product amount.');
  }
  return reference;
}
async function completeReturn(staff, id, body) {
  const initial = (await pool.query('SELECT sale_id FROM return_requests WHERE id=$1', [id])).rows[0];
  if (!initial) throw error('Return request not found.', 404);
  return locked(initial.sale_id, async db => transaction(db, async () => {
    const sale = (await db.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE', [initial.sale_id])).rows[0];
    staffAccess(staff, sale);
    const request = await prepareReturnRefund(db, id);
    if (request.refund_status === 'REFUNDED') return {
      ok: true,
      refund: publicRefund(request)
    };
    if (!['APPROVED', 'RECEIVED', 'COMPLETED'].includes(String(request.status).toUpperCase()) || request.type === 'REPLACE') throw error('Approve a return for refund before completing it.');
    if (!request.items_received_at && body.items_received !== true) throw error('Confirm that the returned items have been received and checked.');
    if (String(sale.payment_method).toUpperCase() !== 'COD' && !['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(String(sale.payment_status).toUpperCase())) throw error('No captured payment is recorded for this order.');
    const reference = await verifyRefund(db, sale, Number(request.refund_amount_paise), body, 'RETURN', id);
    if (!request.items_received_at) await db.query('UPDATE return_requests SET items_received_at=now(),received_by=$2 WHERE id=$1', [id, staff.id]);
    const result = await finalizeRefund(db, 'RETURN', id, reference, staff.id);
    return {
      ok: true,
      refund: publicRefund(result)
    };
  }));
}
async function completeCancellation(staff, id, body) {
  return locked(id, async db => transaction(db, async () => {
    const sale = (await db.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!sale) throw error('Order not found.', 404);
    staffAccess(staff, sale);
    const request = (await db.query('SELECT * FROM storefront_cancellations WHERE sale_id=$1 FOR UPDATE', [id])).rows[0];
    if (!request || request.status !== 'COMPLETED') throw error('Confirm cancellation before completing a refund.');
    if (request.refund_status === 'REFUNDED' || request.refund_status === 'NOT_DUE') return {
      ok: true,
      refund: publicRefund(request)
    };
    const reference = await verifyRefund(db, sale, Number(request.refund_amount_paise), body, 'CANCELLATION', id);
    const result = await finalizeRefund(db, 'CANCELLATION', id, reference, staff.id);
    return {
      ok: true,
      refund: publicRefund(result)
    };
  }));
}
async function finalizeRefund(db, kind, id, reference, actor) {
  const returning = kind === 'RETURN';
  const result = (await db.query(returning ? `UPDATE return_requests SET refund_status='REFUNDED',refund_reference=$2,
    refund_received_at=COALESCE(refund_received_at,now()),refund_processed_by=$3,updated_at=now() WHERE id=$1 RETURNING *`
    : `UPDATE storefront_cancellations SET refund_status='REFUNDED',refund_reference=$2,refund_processed_by=$3,
      refund_received_at=COALESCE(refund_received_at,now()),updated_at=now() WHERE sale_id=$1 RETURNING *`, [id, reference, actor])).rows[0];
  if (returning) {
    const restored = (await db.query("SELECT COALESCE(SUM(refund_points),0)::int AS points FROM return_requests WHERE sale_id=$1 AND refund_status='REFUNDED'", [result.sale_id])).rows[0];
    await rewards.releaseRewardsForSale(db, result.sale_id, Number(restored.points));
  }
  if (reference) await db.query(`UPDATE order_refund_operations SET status='PROCESSED',provider_refund_id=$3,
    processed_at=COALESCE(processed_at,now()),updated_at=now() WHERE kind=$1 AND request_id=$2 AND provider_refund_id=$3`, [kind,String(id),reference]);
  const paid = (await db.query(`SELECT COALESCE(SUM(amount),0)::bigint AS amount FROM (
    SELECT refund_amount_paise AS amount FROM return_requests WHERE sale_id=$1 AND refund_status='REFUNDED'
    UNION ALL SELECT refund_amount_paise FROM storefront_cancellations WHERE sale_id=$1 AND refund_status='REFUNDED'
    ) r`, [result.sale_id])).rows[0];
  if (Number(paid.amount) > 0) {
    const fully = (await db.query('SELECT round(total*100)<=$2 AS fully_refunded FROM sales WHERE id=$1', [result.sale_id,paid.amount])).rows[0]?.fully_refunded;
    await db.query(`UPDATE sales SET payment_status='${fully?'REFUNDED':'PARTIALLY_REFUNDED'}',updated_at=now() WHERE id=$1`, [result.sale_id]);
  }
  return result;
}

async function receiveReturn(staff, id, body = {}) {
  const found = (await pool.query('SELECT sale_id FROM return_requests WHERE id=$1', [id])).rows[0];
  if (!found) throw error('Return request not found.', 404);
  return locked(found.sale_id, db => transaction(db, async () => {
    const sale = (await db.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE', [found.sale_id])).rows[0];
    staffAccess(staff, sale);
    const request = (await db.query('SELECT * FROM return_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!['APPROVED','RECEIVED','COMPLETED'].includes(String(request.status).toUpperCase())) throw error('Approve the return before recording receipt.');
    if (body.restock !== false && body.restock !== true) throw error('Choose whether the inspected items can be returned to sellable stock.', 400);
    const notes = String(body.inspection_notes || '').trim().slice(0, 1000);
    if (notes.length < 5) throw error('Record an inspection note of at least 5 characters.', 400);
    if (request.items_received_at) return { ok: true, request, already_received: true };
    if (body.restock === true) {
      const items = (await db.query(`SELECT ri.id AS return_item_id,si.variant_id,si.is_custom,ri.qty FROM return_items ri JOIN sale_items si
        ON si.sale_id=$2 AND (ri.sale_item_id=si.id OR (ri.sale_item_id IS NULL AND ri.variant_id=si.variant_id))
        WHERE ri.request_id=$1 ORDER BY si.variant_id`, [id, sale.id])).rows;
      if (!items.length) throw error('The selected return items need store review.');
      if (new Set(items.map(item=>String(item.return_item_id))).size !== items.length) throw error('An older return contains an ambiguous invoice item. Match each return item to its original sale item before restoring stock.');
      for (const item of items) {
        if (item.is_custom || !item.variant_id) continue;
        const updated = await db.query(`UPDATE branch_variant_stock SET on_hand=COALESCE(on_hand,0)+$3,updated_at=now()
          WHERE branch_id=$1 AND variant_id=$2 RETURNING variant_id`, [sale.branch_id, item.variant_id, item.qty]);
        if (!updated.rowCount) throw error('The original stock record is missing. Review it before receiving the return.');
      }
    }
    const requestRow = (await db.query(`UPDATE return_requests SET items_received_at=now(),received_by=$2,inspection_notes=$3,
      inventory_restocked_at=CASE WHEN $4 THEN now() ELSE NULL END,status='RECEIVED',updated_at=now() WHERE id=$1 RETURNING *`, [id, staff.id, notes, body.restock])).rows[0];
    return { ok: true, request: requestRow };
  }));
}
module.exports = {
  prepareReturnRefund,
  publicRefund,
  completeReturn,
  completeCancellation,
  finalizeRefund,
  receiveReturn
};
