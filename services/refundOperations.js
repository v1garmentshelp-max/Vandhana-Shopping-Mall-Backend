const crypto = require('node:crypto');
const pool = require('../db');
const Razorpay = require('./razorpayService');
const refunds = require('./storeRefunds');
const { locked, transaction, staffAccess } = require('./orderCancellation');
const { error } = require('./commercePolicy');

function kindOf(value) {
  const kind = String(value).toUpperCase();
  if (!['RETURN','CANCELLATION'].includes(kind)) throw error('Unknown refund type.', 400);
  return kind;
}
async function context(db, kind, id) {
  const request = (await db.query(kind === 'RETURN' ? 'SELECT * FROM return_requests WHERE id=$1'
    : 'SELECT * FROM storefront_cancellations WHERE sale_id=$1', [id])).rows[0];
  if (!request) throw error('Refund request not found.', 404);
  const sale = (await db.query('SELECT * FROM sales WHERE id=$1', [request.sale_id])).rows[0];
  return { request, sale };
}
function publicOperation(row) {
  if (!row) return null;
  return { id: row.id, kind: row.kind, request_id: row.request_id, status: row.status, amount_paise: Number(row.amount_paise),
    amount: Number(row.amount_paise)/100, provider: row.provider, reference: row.provider_refund_id,
    created_at: row.created_at, updated_at: row.updated_at, processed_at: row.processed_at,
    message: row.status === 'PROCESSED' ? 'The refund has been processed.' : row.status === 'FAILED'
      ? 'The refund failed. The store is reviewing it.' : row.status === 'REVIEW_REQUIRED'
      ? 'The store is checking the refund with the payment provider.' : 'The refund is awaiting payment provider confirmation.' };
}
function assertReady(kind, request) {
  if (kind === 'CANCELLATION' && request.status !== 'COMPLETED') throw error('Confirm cancellation before refunding.');
  if (kind === 'RETURN' && (!['APPROVED','RECEIVED','COMPLETED'].includes(String(request.status).toUpperCase())
    || request.type === 'REPLACE' || !request.items_received_at)) throw error('Receive and inspect the approved return before initiating its refund.');
}
async function applyProviderResult(db, op, remote) {
  if (!remote?.id || remote.payment_id !== op.payment_id || remote.currency !== 'INR'
    || Number(remote.amount) !== Number(op.amount_paise) || !['pending','processed','failed'].includes(remote.status)
    || (op.provider_refund_id && remote.id !== op.provider_refund_id)) throw error('The provider refund does not match this payment and amount. Review is required.');
  return transaction(db, async () => {
    const fresh = (await db.query('SELECT * FROM order_refund_operations WHERE id=$1 FOR UPDATE', [op.id])).rows[0];
    if (fresh.status === 'PROCESSED') return publicOperation(fresh);
    const status = remote.status === 'processed' ? 'PROCESSED' : remote.status === 'failed' ? 'FAILED' : 'PENDING';
    const row = (await db.query(`UPDATE order_refund_operations SET status=$2,provider_refund_id=$3,
      last_error=$4,processed_at=CASE WHEN $2='PROCESSED' THEN now() ELSE processed_at END,updated_at=now()
      WHERE id=$1 RETURNING *`, [op.id, status, remote.id, status === 'FAILED' ? 'Payment provider reported a failed refund.' : null])).rows[0];
    if (status === 'PROCESSED') {
      const { request } = await context(db, op.kind, op.request_id);
      if (request.refund_status !== 'REFUNDED') await refunds.finalizeRefund(db, op.kind, op.request_id, remote.id, op.initiated_by);
      else if (request.refund_reference !== remote.id) throw error('A different refund is already recorded. Store reconciliation is required.');
    }
    return publicOperation(row);
  });
}

async function initiate(staff, rawKind, id, body = {}) {
  const kind = kindOf(rawKind), initial = await context(pool, kind, id);
  staffAccess(staff, initial.sale);
  return locked(initial.sale.id, async db => {
    let { request, sale } = await context(db, kind, id);
    if (kind === 'RETURN') request = await transaction(db, () => refunds.prepareReturnRefund(db, id));
    if (request.refund_status === 'REFUNDED' || request.refund_status === 'NOT_DUE') return { ok: true, refund: refunds.publicRefund(request) };
    assertReady(kind, request);
    const amount = Number(request.refund_amount_paise);
    if (!Number.isSafeInteger(amount) || amount < 0 || Number(body.amount_paise) !== amount) throw error('Confirm the exact refund amount shown by the store.', 400);
    const previous = (await db.query('SELECT * FROM order_refund_operations WHERE kind=$1 AND request_id=$2', [kind, String(id)])).rows[0];
    if (previous?.status === 'PROCESSED') return { ok: true, operation: publicOperation(previous) };
    if (previous?.status === 'FAILED') throw error('This refund failed. Reconcile it with Razorpay support before creating any replacement refund.');
    if (amount > 0 && String(sale.payment_method).toUpperCase() === 'COD') throw error('Send the approved COD refund by bank or UPI, then record its transfer reference.');
    if (amount > 0 && !['PAID','PARTIALLY_REFUNDED','REFUNDED'].includes(String(sale.payment_status).toUpperCase())) throw error('A captured payment must be reconciled before refunding.');
    if (amount > 0 && (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)) throw error('Configure the payment provider before initiating a refund.', 503);
    const gateway = new Razorpay({});
    let payment = null;
    if (amount > 0) {
      payment = (await db.query('SELECT * FROM payments WHERE sale_id=$1 AND razorpay_payment_id IS NOT NULL ORDER BY id DESC LIMIT 1', [sale.id])).rows[0];
      if (!payment) throw error('The original payment reference is missing. Review this order.');
      const { data: remote } = await gateway.client.get(`/payments/${encodeURIComponent(payment.razorpay_payment_id)}`);
      if (remote?.id !== payment.razorpay_payment_id || remote.order_id !== payment.razorpay_order_id
        || remote.currency !== 'INR' || Number(remote.amount) !== Math.round(Number(sale.total)*100)
        || !['captured','refunded'].includes(remote.status)) throw error('The saved order and captured payment do not match.');
      if (!previous && amount > Number(remote.amount)-Number(remote.amount_refunded || 0)) throw error('The payment has already been refunded. Reconcile its refunds before continuing.');
    }
    // Commit the same immutable key and amount before making any gateway call.
    const op = previous || (await db.query(`INSERT INTO order_refund_operations(id,sale_id,kind,request_id,amount_paise,
      payment_id,idempotency_key,provider,status,initiated_by) VALUES($1::uuid,$2,$3,$4,$5,$6,$1::text,$7,'REQUESTED',$8) RETURNING *`,
      [crypto.randomUUID(),sale.id,kind,String(id),amount,payment?.razorpay_payment_id || null,amount ? 'RAZORPAY' : 'REWARDS',staff.id])).rows[0];
    if (Number(op.amount_paise) !== amount || (amount && op.payment_id !== payment.razorpay_payment_id)) throw error('This refund changed after initiation. Review it before continuing.');
    if (amount === 0) return transaction(db, async () => {
      await refunds.finalizeRefund(db, kind, id, null, staff.id);
      const row = (await db.query("UPDATE order_refund_operations SET status='PROCESSED',processed_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [op.id])).rows[0];
      return { ok: true, operation: publicOperation(row) };
    });
    try {
      const remote = op.provider_refund_id ? (await gateway.client.get(`/payments/${encodeURIComponent(op.payment_id)}/refunds/${encodeURIComponent(op.provider_refund_id)}`)).data
        : (await gateway.client.post(`/payments/${encodeURIComponent(op.payment_id)}/refund`, {
          amount: Number(op.amount_paise), speed: 'normal', receipt: op.id,
          notes: { sale_id: op.sale_id, kind: op.kind, request_id: op.request_id }
        }, { headers: { 'X-Refund-Idempotency': op.idempotency_key } })).data;
      return { ok: true, operation: await applyProviderResult(db, op, remote) };
    } catch (e) {
      await db.query("UPDATE order_refund_operations SET status='REVIEW_REQUIRED',last_error=$2,updated_at=now() WHERE id=$1 AND status NOT IN ('PROCESSED','FAILED')", [op.id, String(e.message).slice(0,1000)]);
      throw error('Refund confirmation is pending. Check refund status or retry with the saved request. The same refund key will be used.');
    }
  });
}
async function reconcile(staff, rawKind, id) {
  const kind = kindOf(rawKind), initial = await context(pool, kind, id);
  staffAccess(staff, initial.sale);
  return locked(initial.sale.id, async db => {
    const op = (await db.query('SELECT * FROM order_refund_operations WHERE kind=$1 AND request_id=$2', [kind, String(id)])).rows[0];
    if (!op) return { ok: true, refund: refunds.publicRefund(initial.request), operation: null };
    if (op.status === 'PROCESSED' || op.provider !== 'RAZORPAY') return { ok: true, operation: publicOperation(op) };
    if (!op.provider_refund_id) throw error('The refund reference is awaiting confirmation. Retry initiation to recover the same idempotent request.');
    const { data } = await new Razorpay({}).client.get(`/payments/${encodeURIComponent(op.payment_id)}/refunds/${encodeURIComponent(op.provider_refund_id)}`);
    return { ok: true, operation: await applyProviderResult(db, op, data) };
  });
}
async function processWebhook(entity) {
  if (!entity?.id || !entity.payment_id) throw error('Invalid refund event.',400);
  const op = (await pool.query('SELECT * FROM order_refund_operations WHERE provider_refund_id=$1 OR (payment_id=$2 AND id=$3::uuid)',
    [entity.id, entity.payment_id, /^[0-9a-f-]{36}$/i.test(String(entity.receipt)) ? entity.receipt : null])).rows[0];
  if (!op) return { matched: false };
  return locked(op.sale_id, async db => {
    // Fetch the authoritative refund to handle reordered webhook deliveries.
    const { data } = await new Razorpay({}).client.get(`/payments/${encodeURIComponent(op.payment_id)}/refunds/${encodeURIComponent(entity.id)}`);
    return { matched: true, operation: await applyProviderResult(db, op, data) };
  });
}
module.exports = { initiate, reconcile, processWebhook, publicOperation, kindOf };
