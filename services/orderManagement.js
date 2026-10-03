const pool = require('../db');
const { staffAccess } = require('./orderCancellation');
const { error } = require('./commercePolicy');
const { publicOperation } = require('./refundOperations');
function branchScope(staff, requested) {
  const role = String(staff?.role_enum || staff?.role || '').toUpperCase();
  if (!['SUPER_ADMIN','BRANCH_ADMIN'].includes(role) && !/^BRANCH\d+$/.test(role)) throw error('Staff access required.',403);
  if (role !== 'SUPER_ADMIN') {
    if (!Number.isSafeInteger(Number(staff.branch_id)) || Number(staff.branch_id) <= 0) throw error('Branch access required.',403);
    return Number(staff.branch_id);
  }
  if (!requested) return null;
  if (!Number.isSafeInteger(Number(requested)) || Number(requested) <= 0) throw error('Invalid branch.',400);
  return Number(requested);
}
const fromOrders = `FROM sales s
  LEFT JOIN storefront_cancellations c ON c.sale_id=s.id
  LEFT JOIN order_cancellations oc ON oc.sale_id=s.id
  LEFT JOIN LATERAL (SELECT status,raw_status,awb,current_location,status_synced_at,delivered_at
    FROM shipments WHERE sale_id=s.id ORDER BY created_at DESC NULLS LAST LIMIT 1) sh ON true
  LEFT JOIN LATERAL (SELECT COUNT(*)::int AS return_count,COUNT(*) FILTER (WHERE status='REQUESTED')::int AS open_returns,
    COUNT(*) FILTER (WHERE refund_status='PENDING_REFUND')::int AS pending_refunds FROM return_requests WHERE sale_id=s.id) rr ON true
  LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE status IN ('FAILED','REVIEW_REQUIRED'))::int AS refund_errors
    FROM order_refund_operations WHERE sale_id=s.id) rf ON true`;
async function list(staff, query = {}) {
  const branch = branchScope(staff, query.branch_id);
  const page = Math.max(1,Math.min(100000,Number.parseInt(query.page,10) || 1));
  const limit = Math.max(1,Math.min(100,Number.parseInt(query.limit,10) || 30));
  const params = [branch], where = ['($1::bigint IS NULL OR s.branch_id=$1)'];
  const add = (clause,value) => { params.push(value); where.push(clause.replace('?',`$${params.length}`)); };
  if (query.source) add('s.source=?',String(query.source).toUpperCase());
  if (query.payment_method) add('upper(s.payment_method::text)=?',String(query.payment_method).toUpperCase());
  if (query.status && query.status !== 'ALL') add('upper(s.status::text)=?',String(query.status).toUpperCase());
  if (query.q) add(`(s.id::text||' '||COALESCE(s.customer_name,'')||' '||COALESCE(s.customer_email,'')||' '||COALESCE(s.customer_mobile,'')||' '||COALESCE(sh.awb,'')) ILIKE ?`, `%${String(query.q).trim().slice(0,150).replace(/[\\%_]/g,'\\$&')}%`);
  if (query.queue === 'cancellations') where.push("c.status IN ('REQUESTED','REVIEW_REQUIRED')");
  if (query.queue === 'refunds') where.push("(c.refund_status='PENDING_REFUND' OR rr.pending_refunds>0 OR rf.refund_errors>0)");
  if (query.queue === 'returns') where.push('rr.open_returns>0');
  if (query.queue === 'exceptions') where.push("(s.status='RTO' OR sh.raw_status ~* 'RTO|UNDELIVER|FAILED|LOST|DAMAGED|NDR' OR rf.refund_errors>0 OR c.status='REVIEW_REQUIRED')");
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const counts = await pool.query(`SELECT COUNT(*)::int AS total ${fromOrders} ${whereSql}`,params);
  const rows = await pool.query(`SELECT s.*,c.status AS cancellation_status,c.created_at AS cancellation_requested_at,
    COALESCE(c.reason,oc.reason) AS cancellation_reason,COALESCE(c.source,oc.cancellation_source) AS cancellation_source,
    c.refund_status AS cancellation_refund_status,c.refund_amount_paise AS cancellation_refund_amount_paise,
    c.refund_points AS cancellation_reward_points,sh.raw_status AS carrier_status,sh.awb,sh.current_location,
    sh.status_synced_at,rr.return_count,rr.open_returns,rr.pending_refunds,rf.refund_errors,
    CASE WHEN c.status IN ('REQUESTED','REVIEW_REQUIRED') THEN 'CANCELLATION REQUESTED' ELSE s.status::text END AS display_status
    ${fromOrders} ${whereSql} ORDER BY s.created_at DESC NULLS LAST,s.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
    [...params,limit,(page-1)*limit]);
  return { rows: rows.rows, total: counts.rows[0].total, page, limit, pages: Math.ceil(counts.rows[0].total/limit) };
}
async function summary(staff, query = {}) {
  const branch = branchScope(staff,query.branch_id);
  return (await pool.query(`SELECT COUNT(*)::int AS orders,
    COUNT(*) FILTER (WHERE s.status='CANCELLED')::int AS cancelled,
    COUNT(*) FILTER (WHERE c.status IN ('REQUESTED','REVIEW_REQUIRED'))::int AS cancellation_requests,
    COALESCE(SUM(rr.open_returns),0)::int AS return_requests,
    COUNT(*) FILTER (WHERE c.refund_status='PENDING_REFUND' OR rr.pending_refunds>0)::int AS refunds_pending,
    COUNT(*) FILTER (WHERE s.status='RTO' OR sh.raw_status ~* 'RTO|UNDELIVER|FAILED|LOST|DAMAGED|NDR' OR rf.refund_errors>0)::int AS exceptions
    ${fromOrders} WHERE ($1::bigint IS NULL OR s.branch_id=$1)`,[branch])).rows[0];
}
async function timeline(db, id) {
  const events = (await db.query('SELECT id,event_type,source,reference,status,details,occurred_at FROM order_events WHERE sale_id=$1 ORDER BY occurred_at,id', [id])).rows;
  const sale = (await db.query('SELECT status,payment_status,created_at FROM sales WHERE id=$1', [id])).rows[0];
  if (!sale) throw error('Order not found.',404);
  if (!events.some(e => e.event_type === 'ORDER_PLACED')) events.unshift({ id: 'original',event_type: 'ORDER_PLACED',source: 'original_order',status: 'PLACED',details: {historical:true},occurred_at: sale.created_at });
  // Older records have no reconstructed transition times. Show the saved facts explicitly.
  if (!events.some(e => e.source === 'storefront_cancellations')) {
    const row = (await db.query('SELECT status,reason,created_at,refund_status FROM storefront_cancellations WHERE sale_id=$1',[id])).rows[0];
    if (row) events.push({ id:'historical-cancellation',event_type:'CANCELLATION_UPDATED',source:'original_cancellation',status:row.status,details:{reason:row.reason,refund_status:row.refund_status,historical:true},occurred_at:row.created_at });
  }
  return events.sort((a,b) => new Date(a.occurred_at)-new Date(b.occurred_at));
}
async function detail(staff,id) {
  const sale = (await pool.query('SELECT * FROM sales WHERE id=$1',[id])).rows[0];
  if (!sale) throw error('Order not found.',404);
  staffAccess(staff,sale);
  const [items,shipments,cancellation,returns,operations,events,rewards,workflow] = await Promise.all([
    pool.query('SELECT si.*,COALESCE(si.custom_title,p.name) AS product_name FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1',[id]),
    pool.query('SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC',[id]),
    pool.query('SELECT * FROM storefront_cancellations WHERE sale_id=$1',[id]),
    pool.query(`SELECT r.*,(SELECT json_agg(json_build_object('sale_item_id',i.sale_item_id,'variant_id',i.variant_id,'qty',i.qty)) FROM return_items i WHERE i.request_id=r.id) AS items,
      (SELECT row_to_json(rs) FROM reverse_shipments rs WHERE rs.request_id=r.id ORDER BY id DESC LIMIT 1) AS reverse_shipment
      FROM return_requests r WHERE r.sale_id=$1 ORDER BY created_at DESC`,[id]),
    pool.query('SELECT * FROM order_refund_operations WHERE sale_id=$1 ORDER BY created_at DESC',[id]),
    timeline(pool,id),pool.query('SELECT transaction_type,points,note,created_at,lot_id FROM reward_point_transactions WHERE sale_id=$1 ORDER BY created_at,id',[id]),
    pool.query('SELECT * FROM order_shipping_workflow WHERE sale_id=$1',[id])
  ]);
  return { ...sale,items:items.rows,shipments:shipments.rows,cancellation:cancellation.rows[0] || null,
    returns:returns.rows,refund_operations:operations.rows.map(op=>({...publicOperation(op),last_error:op.last_error})),
    timeline:events,reward_history:rewards.rows,shipping_workflow:workflow.rows[0] || null };
}
module.exports = { list, summary, detail, timeline, branchScope };
