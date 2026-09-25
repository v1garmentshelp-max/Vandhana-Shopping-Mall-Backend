const {
  fail,
  integer
} = require('./mobileRules');
const {
  policy
} = require('./mobileStore');
async function eligibility(db, saleId, now = Date.now()) {
  const sale = (await db.query('SELECT * FROM sales WHERE id=$1', [saleId])).rows[0];
  if (!sale) throw fail('Order not found.', 404);
  const deliveries = (await db.query("SELECT delivered_at FROM shipments WHERE sale_id=$1 AND upper(status)='DELIVERED' ORDER BY delivered_at DESC NULLS LAST", [saleId])).rows;
  const deliveredAt = deliveries[0]?.delivered_at;
  const deliveredTime = deliveredAt ? new Date(deliveredAt).getTime() : NaN;
  const deadline = Number.isFinite(deliveredTime) ? new Date(deliveredTime + policy.window_days * 86400000).toISOString() : null;
  let reason = deliveries.length ? 'Delivery date is awaiting confirmation. Please contact the store.' : 'Order not delivered yet.';
  const within = !!deadline && now >= deliveredTime && now <= new Date(deadline).getTime();
  if (deadline && !within) reason = 'The 7-day return window has ended.';
  const rows = (await db.query(`WITH RECURSIVE inner_categories AS (
    SELECT id FROM product_categories WHERE regexp_replace(lower(name),'[^a-z]','','g') IN ('innerwear','underwear','lingerie','intimates')
    UNION SELECT c.id FROM product_categories c JOIN inner_categories p ON c.parent_id=p.id
  ) SELECT si.*,COALESCE(si.custom_title,p.name,'Clothing') AS product_name,
    (si.is_innerwear OR p.category_id IN (SELECT id FROM inner_categories)) AS blocked,
    COALESCE((SELECT SUM(ri.qty) FROM return_items ri JOIN return_requests r ON r.id=ri.request_id
      WHERE r.sale_id=si.sale_id AND (ri.sale_item_id=si.id OR (ri.sale_item_id IS NULL AND ri.variant_id=si.variant_id))
      AND upper(r.status) NOT IN ('REJECTED','CANCELLED')),0) AS requested_qty
    FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1`, [saleId])).rows;
  const items = rows.map(i => ({
    sale_item_id: i.id,
    variant_id: i.variant_id,
    product_name: i.product_name,
    size: i.size,
    colour: i.colour,
    image_url: i.image_url,
    qty: Number(i.qty),
    remaining_qty: Math.max(0, Number(i.qty) - Number(i.requested_qty)),
    is_innerwear: !!i.blocked,
    eligible: within && !i.blocked && Number(i.qty) > Number(i.requested_qty),
    reason: i.blocked ? 'Innerwear cannot be returned.' : Number(i.qty) <= Number(i.requested_qty) ? 'A return has already been requested.' : within ? null : reason
  }));
  const ok = items.some(i => i.eligible);
  return {
    ok,
    reason: ok ? null : items.every(i => i.is_innerwear) ? 'Innerwear cannot be returned.' : items.some(i => i.remaining_qty === 0) && within ? 'A return has already been requested.' : reason,
    policy,
    delivered_at: deliveredAt || null,
    deadline,
    items
  };
}
function selectedItems(el, input) {
  if (!el.ok) throw fail(el.reason || 'Return unavailable.', 409);
  const items = Array.isArray(input) && input.length ? input : el.items.filter(i => i.eligible).map(i => ({
    sale_item_id: i.sale_item_id,
    qty: i.remaining_qty
  }));
  const seen = new Set();
  return items.map(i => {
    const item = el.items.find(x => i.sale_item_id ? x.sale_item_id === i.sale_item_id : i.variant_id != null && Number(x.variant_id) === Number(i.variant_id));
    if (!item || !item.eligible || seen.has(item.sale_item_id)) throw fail(item?.reason || 'Select eligible items from this order.', 409);
    seen.add(item.sale_item_id);
    const qty = integer(i.qty, 1, item.remaining_qty);
    return {
      ...item,
      qty,
      reason_code: String(i.reason_code || '').slice(0, 80),
      condition_note: String(i.condition_note || '').slice(0, 500)
    };
  });
}
async function createReturn(pool, saleId, body) {
  const reason = String(body.reason || '').trim().slice(0, 1500);
  if (reason.length < 10) throw fail('Describe the reason in at least 10 characters.');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM sales WHERE id=$1 FOR UPDATE', [saleId]);
    const items = selectedItems(await eligibility(db, saleId), body.items);
    const sale = (await db.query('SELECT * FROM sales WHERE id=$1', [saleId])).rows[0];
    const result = await db.query(`INSERT INTO return_requests(sale_id,customer_email,customer_mobile,type,reason,notes,status)
      VALUES($1,$2,$3,$4,$5,$6,'REQUESTED') RETURNING id,status,created_at`, [saleId, sale.customer_email, sale.customer_mobile, body.type === 'REPLACE' ? 'REPLACE' : 'RETURN', reason, String(body.notes || 'Requested from the store app').slice(0, 1000)]);
    for (const i of items) await db.query('INSERT INTO return_items(request_id,sale_item_id,variant_id,qty,reason_code,condition_note) VALUES($1,$2,$3,$4,$5,$6)', [result.rows[0].id, i.sale_item_id, i.variant_id, i.qty, i.reason_code, i.condition_note]);
    await db.query('COMMIT');
    return {
      ok: true,
      request: result.rows[0]
    };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
module.exports = {
  eligibility,
  selectedItems,
  createReturn
};
