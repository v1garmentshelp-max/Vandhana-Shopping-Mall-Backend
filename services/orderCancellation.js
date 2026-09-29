const pool = require('../db');
const Shiprocket = require('./shiprocketService');
const Razorpay = require('./razorpayService');
const rewards = require('./rewardPointsService');
const {
  cancellationEligibility,
  orderRefundBasis,
  error
} = require('./commercePolicy');
const reference = value => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))) throw error('Invalid order reference.', 400);
  return String(value);
};
async function locked(saleId, fn) {
  reference(saleId);
  const db = await pool.connect();
  let acquired = false;
  try {
    acquired = (await db.query('SELECT pg_try_advisory_lock(hashtextextended($1::text,0)) AS locked', [`order-shipping:${saleId}`])).rows[0].locked;
    if (!acquired) throw error('This order is being updated. Please try again in a moment.');
    return await fn(db);
  } finally {
    if (acquired) {
      try {
        await db.query('SELECT pg_advisory_unlock(hashtextextended($1::text,0))', [`order-shipping:${saleId}`]);
      } catch (e) {
        db.release(true);
        throw e;
      }
    }
    db.release();
  }
}
async function transaction(db, fn) {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}
async function state(db, id) {
  const sale = (await db.query('SELECT * FROM sales WHERE id=$1', [reference(id)])).rows[0];
  if (!sale) throw error('Order not found.', 404);
  const items = (await db.query('SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY id', [id])).rows;
  const shipments = (await db.query('SELECT * FROM shipments WHERE sale_id=$1', [id])).rows;
  const workflow = (await db.query('SELECT * FROM order_shipping_workflow WHERE sale_id=$1', [id])).rows[0];
  const request = (await db.query('SELECT * FROM storefront_cancellations WHERE sale_id=$1', [id])).rows[0];
  return {
    sale,
    items,
    shipments,
    workflow,
    request
  };
}
function publicRequest(row) {
  if (!row) return null;
  return {
    status: row.status,
    reason: row.reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    refund_status: row.refund_status,
    refund_amount: Number(row.refund_amount_paise) / 100,
    reward_points: Number(row.refund_points),
    excluded_fees: Number(row.excluded_fees_paise) / 100,
    message: row.status === 'COMPLETED' ? 'Cancellation confirmed.' : row.status === 'REJECTED' ? `The store could not cancel this shipment. ${row.last_error || 'Contact support for the next step.'}` : 'Cancellation requested. Dispatch is paused while the store verifies the carrier and payment.'
  };
}
async function eligibility(id) {
  const s = await state(pool, id);
  const result = cancellationEligibility(s.sale, s.shipments, s.workflow, s.request);
  let refund = null;
  try {
    const basis = orderRefundBasis(s.sale, s.items);
    const paid = String(s.sale.payment_status).toUpperCase() === 'PAID';
    refund = {
      product_amount: paid ? basis.cash_paise / 100 : 0,
      reward_points: basis.points,
      excluded_fees: basis.excluded_fees_paise / 100,
      note: paid ? 'Only the product amount paid is refundable. Delivery and COD charges are excluded.' : 'No cash refund is due for an unpaid order. Redeemed points are restored after cancellation is confirmed.'
    };
  } catch (e) {
    refund = {
      review_required: true,
      note: e.message
    };
  }
  return {
    ...result,
    request: publicRequest(s.request),
    refund
  };
}
async function requestCancellation(user, id, body, staff = null) {
  const reason = String(body.reason || '').trim().slice(0, 1000);
  if (reason.length < 5) throw error('Please enter a cancellation reason of at least 5 characters.', 400);
  return locked(id, async db => transaction(db, async () => {
    const s = await state(db, id);
    if (s.sale.source !== 'WEB' || ![s.sale.login_email, s.sale.customer_email].some(email => String(email).toLowerCase() === String(user.email).toLowerCase())) throw error('Order not found.', 404);
    if (staff) staffAccess(staff, s.sale);
    if (s.request) return publicRequest(s.request);
    const allowed = cancellationEligibility(s.sale, s.shipments, s.workflow);
    if (!allowed.eligible) throw error(allowed.reason);
    const basis = orderRefundBasis(s.sale, s.items);
    const paid = String(s.sale.payment_status).toUpperCase() === 'PAID';
    const row = (await db.query(`INSERT INTO storefront_cancellations(sale_id,user_id,reason,refund_amount_paise,refund_points,excluded_fees_paise,source,requested_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, user.id, reason, paid ? basis.cash_paise : 0, basis.points, basis.excluded_fees_paise, staff ? 'ADMIN' : 'CUSTOMER', staff?.id || null])).rows[0];
    return publicRequest(row);
  }));
}
function staffAccess(staff, sale) {
  const role = String(staff?.role_enum || staff?.role || '').toUpperCase();
  if (role !== 'SUPER_ADMIN' && !(role === 'BRANCH_ADMIN' && Number(staff.branch_id) === Number(sale.branch_id))) throw error('You do not have access to this order.', 403);
}
async function verifyCarrier(db, s) {
  if (s.workflow?.create_attempted && !s.shipments.some(x => x.shiprocket_order_id)) throw error('Find and link the existing Shiprocket booking before processing cancellation.');
  const ids = [...new Set(s.shipments.map(x => x.shiprocket_order_id).filter(Boolean).map(String))];
  if (!ids.length) return;
  const sr = new Shiprocket({
    pool
  });
  await sr.init();
  const remote = async id => {
    const result = await sr.api('get', `/orders/show/${encodeURIComponent(id)}`);
    const order = result.data?.data;
    if (!order || ![s.sale.id, `${s.sale.id}-${s.sale.branch_id}`].includes(String(order.channel_order_id))) throw error('The carrier booking does not match this order. Store review is required.');
    return String(order.status || '').trim().toUpperCase();
  };
  const cancelled = value => ['CANCELED', 'CANCELLED'].includes(value);
  const current = await Promise.all(ids.map(remote));
  if (current.every(cancelled)) return;
  if (current.some(value => !cancelled(value) && !['NEW', 'AWB ASSIGNED', 'AWB_ASSIGNED', 'PICKUP SCHEDULED', 'PICKUP GENERATED', 'READY TO SHIP', 'CANCELLATION REQUESTED'].includes(value))) throw error('The carrier status needs manual review. Cancellation has not been confirmed.');
  if (!s.request.carrier_attempted) {
    await db.query('UPDATE storefront_cancellations SET carrier_attempted=true,updated_at=now() WHERE sale_id=$1', [s.sale.id]);
    await sr.cancelOrders({
      order_ids: ids.filter((id, index) => !cancelled(current[index])).map(Number)
    });
  }
  const verified = await Promise.all(ids.map(remote));
  if (!verified.every(cancelled)) throw error('Carrier cancellation is awaiting confirmation. Check again later; the cancellation will not be sent twice.');
}
async function processCancellation(staff, id) {
  return locked(id, async db => {
    const s = await state(db, id);
    staffAccess(staff, s.sale);
    if (!s.request) throw error('A customer cancellation request is required.', 404);
    if (s.request.status === 'COMPLETED') return publicRequest(s.request);
    if (s.request.status === 'REJECTED') throw error('This cancellation request was rejected.');
    const check = cancellationEligibility({
      ...s.sale,
      status: s.sale.status === 'CANCELLED' ? 'PLACED' : s.sale.status
    }, s.shipments.map(row => ({
      ...row,
      status: row.status === 'CANCELLED' ? 'CONFIRMED' : row.status
    })), s.workflow, null, new Date(s.request.created_at).getTime());
    if (!check.eligible) throw error(check.reason);
    try {
      if (String(s.sale.payment_method).toUpperCase() !== 'COD' && Number(s.sale.total) > 0) {
        const payment = (await db.query('SELECT * FROM payments WHERE sale_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0];
        const checkout = (await db.query('SELECT * FROM mobile_checkouts WHERE sale_id=$1', [id])).rows[0];
        if (!payment?.razorpay_order_id && checkout?.gateway_state && checkout.gateway_state !== 'NEW') throw error('The gateway order reference is uncertain. Link the original payment order before confirming cancellation.');
        if (payment?.razorpay_order_id && checkout) {
          const {
            data
          } = await new Razorpay({}).client.get(`/orders/${encodeURIComponent(payment.razorpay_order_id)}/payments`);
          const captured = (data.items || []).filter(p => p.status === 'captured');
          if (captured.length > 1 || captured.some(p => p.order_id !== payment.razorpay_order_id || p.currency !== 'INR' || Number(p.amount) !== Number(checkout.amount_paise))) throw error('The payment amounts need reconciliation before cancellation.');
          if (captured.length === 1) await require('./mobileCheckout').complete(Number(checkout.user_id), checkout.request_key, captured[0]);else if (String(s.sale.payment_status).toUpperCase() === 'PAID') throw error('The saved paid status does not match the gateway. Review before refunding.');
        } else if (payment?.razorpay_payment_id && String(s.sale.payment_status).toUpperCase() === 'PAID') {
          const {
            data
          } = await new Razorpay({}).client.get(`/payments/${encodeURIComponent(payment.razorpay_payment_id)}`);
          if (!['captured', 'refunded'].includes(data?.status) || Number(data.amount) !== Math.round(Number(s.sale.total) * 100) || data.currency !== 'INR' || data.order_id !== payment.razorpay_order_id) throw error('The captured payment needs reconciliation before cancellation.');
        } else if (String(s.sale.payment_status).toUpperCase() === 'PAID') throw error('The original payment record is missing. Review it before refunding.');
      }
      await verifyCarrier(db, s);
      return await transaction(db, async () => {
        await db.query('SELECT id FROM vandana_users WHERE id=$1 FOR UPDATE', [s.request.user_id]);
        await db.query('SELECT id FROM sales WHERE id=$1 FOR UPDATE', [id]);
        const fresh = await state(db, id);
        if (fresh.request.status === 'COMPLETED') return publicRequest(fresh.request);
        const basis = orderRefundBasis(fresh.sale, fresh.items);
        for (const item of [...fresh.items].sort((a, b) => Number(a.variant_id) - Number(b.variant_id))) {
          if (item.is_custom || !item.variant_id) continue;
          const updated = await db.query('UPDATE branch_variant_stock SET on_hand=COALESCE(on_hand,0)+$3,updated_at=now() WHERE branch_id=$1 AND variant_id=$2 RETURNING variant_id', [fresh.sale.branch_id, item.variant_id, Number(item.qty)]);
          if (!updated.rowCount) throw error('The original stock record is missing. Store review is required before cancellation.');
        }
        await rewards.releaseRewardsForSale(db, id);
        await db.query("UPDATE sales SET status='CANCELLED',updated_at=now() WHERE id=$1", [id]);
        await db.query("UPDATE shipments SET status='CANCELLED',raw_status='CANCELLED',updated_at=now() WHERE sale_id=$1", [id]);
        await db.query("INSERT INTO order_cancellations(sale_id,payment_type,reason,cancellation_source,created_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING", [id, fresh.sale.payment_method, fresh.request.reason, String(fresh.request.source || 'CUSTOMER').toLowerCase()]);
        const cash = String(fresh.sale.payment_status).toUpperCase() === 'PAID' ? basis.cash_paise : 0;
        const row = (await db.query(`UPDATE storefront_cancellations SET status='COMPLETED',refund_amount_paise=$2,refund_status=$3,processed_by=$4,last_error=NULL,updated_at=now() WHERE sale_id=$1 RETURNING *`, [id, cash, cash ? 'PENDING_REFUND' : 'NOT_DUE', staff.id])).rows[0];
        return publicRequest(row);
      });
    } catch (e) {
      await db.query("UPDATE storefront_cancellations SET status='REVIEW_REQUIRED',last_error=$2,updated_at=now() WHERE sale_id=$1 AND status<>'COMPLETED'", [id, String(e.message).slice(0, 1000)]);
      throw e;
    }
  });
}
async function adminCancellation(staff, id, body) {
  const s = await state(pool, id);
  staffAccess(staff, s.sale);
  if (!s.request) {
    const customer = (await pool.query("SELECT id,email FROM vandana_users WHERE lower(email)=lower($1) AND upper(type)='B2C' LIMIT 1", [s.sale.login_email || s.sale.customer_email])).rows[0];
    if (!customer) throw error('The original customer account needs review before cancellation.');
    await requestCancellation(customer, id, body, staff);
  }
  return processCancellation(staff, id);
}
module.exports = {
  adminCancellation,
  eligibility,
  requestCancellation,
  processCancellation,
  publicRequest,
  staffAccess,
  locked,
  transaction,
  state
};
