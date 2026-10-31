const text = value => String(value || '').trim().toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
const status = value => text(value).replace(/^RETURN\s+/, '');
const cancelled = value => ['CANCELLED', 'CANCELED', 'CANCELLED BEFORE DISPATCHED'].includes(status(value));
const waiting = new Set(['NEW', 'CREATED', 'APPROVED', 'RETURN INITIATED', 'INITIATED', 'AWB ASSIGNED', 'READY TO SHIP', 'PICKUP SCHEDULED', 'PICKUP GENERATED', 'PICKUP REQUESTED', 'PICKUP BOOKED', 'PICKUP QUEUE', 'PICKUP RESCHEDULED', 'PICKUP ERROR', 'PICKUP EXCEPTION', 'PICKUP FAILED', 'PICKUP NOT DONE', 'PICKUP NOT ATTEMPTED']);
function editable(value) { return waiting.has(status(value)); }
function movement(value) {
  const s = status(value);
  if (cancelled(s)) return 4;
  if (['DELIVERED', 'REACHED WAREHOUSE'].includes(s)) return 3;
  if (/PICKED UP|TRANSIT|SHIPPED|OUT FOR DELIVERY|HANDOVER|LOST|DAMAGED|DESTROYED|RTO/.test(s)) return 2;
  if (s === 'OUT FOR PICKUP') return 1;
  return 0;
}
function acceptsStatus(current, next, eventAt, currentAt) {
  if (!String(next || '').trim()) return false;
  if (eventAt && currentAt && new Date(eventAt) < new Date(currentAt)) return false;
  if (cancelled(current)) return cancelled(next);
  if (movement(current) >= 2 && movement(next) < movement(current)) return false;
  if (movement(current) >= 2 && cancelled(next)) return false;
  if (!eventAt && movement(current) > movement(next)) return false;
  return true;
}
function actions(row) {
  if (!row) return {};
  const pending = !!row.operation || !!(row.awb_attempted && !row.awb);
  return {
    can_assign: !!row.shiprocket_order_id && !row.awb && editable(row.status) && !pending,
    can_reassign: !!row.awb && editable(row.status) && !pending && (!row.reassigned_at || Date.now() - new Date(row.reassigned_at).getTime() >= 86400000),
    can_cancel: !!row.shiprocket_order_id && editable(row.status) && !pending,
    can_rebook: !!row.cancelled_at && !pending,
    can_pickup: !!row.awb && editable(row.status) && !row.pickup_requested_at && !row.pickup_attempted && !pending,
    needs_reconciliation: pending || (!row.shiprocket_order_id && row.status !== 'BOOKING_FAILED')
  };
}
module.exports = { text, status, cancelled, editable, movement, acceptsStatus, actions };
