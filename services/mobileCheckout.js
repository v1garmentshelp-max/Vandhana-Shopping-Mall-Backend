const crypto = require('node:crypto');
const pool = require('../db');
const Razorpay = require('./razorpayService');
const rewards = require('./rewardPointsService');
const {
  createWorkflow
} = require('./orderShippingWorkflow');
const {
  fail,
  addressOf,
  makeQuote,
  validSignature,
  capturedPayment
} = require('./mobileRules');
const store = require('./mobileStore');
const branch = () => Number(process.env.MOBILE_BRANCH_ID || 3);
const settings = () => ({
  freeShippingThreshold: process.env.MOBILE_FREE_SHIPPING_THRESHOLD || 1000,
  shippingFee: process.env.MOBILE_SHIPPING_FEE || 75
});
const uuid = value => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))) throw fail('Invalid checkout reference');
  return String(value);
};
async function transaction(fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
async function quote(db, userId, points, lock = false) {
  if (lock) {
    await db.query('SELECT id FROM vandana_users WHERE id=$1 FOR UPDATE', [userId]);
    await db.query('SELECT id FROM vandana_cart WHERE user_id=$1 ORDER BY id FOR UPDATE', [userId]);
    await db.query(`SELECT v.id FROM product_variants v JOIN vandana_cart c ON c.product_id=v.id
      WHERE c.user_id=$1 ORDER BY v.id FOR SHARE OF v`, [userId]);
    await db.query(`SELECT s.variant_id FROM branch_variant_stock s JOIN vandana_cart c ON c.product_id=s.variant_id
      WHERE c.user_id=$1 AND s.branch_id=$2 ORDER BY s.variant_id FOR UPDATE OF s`, [userId, branch()]);
  }
  const result = await db.query(`SELECT c.id AS cart_item_id,c.quantity,c.is_custom,c.custom_payload,c.custom_image_url,c.custom_title,v.id AS variant_id,v.product_id,
    v.size,v.colour,v.mrp,v.sale_price,v.b2c_discount_pct,
    COALESCE(NULLIF(v.image_url,''),(SELECT pi.image_url FROM product_images pi JOIN barcodes ib ON ib.ean_code=pi.ean_code WHERE ib.variant_id=v.id ORDER BY CASE WHEN lower(pi.image_type)='front' THEN 0 ELSE 1 END,pi.image_url LIMIT 1)) AS image_url,v.is_active AS variant_active,p.is_active AS product_active,
    p.name,s.on_hand,s.reserved,s.is_active AS stock_active,
    EXISTS (WITH RECURSIVE inner_categories AS (
      SELECT id FROM product_categories WHERE regexp_replace(lower(name),'[^a-z]','','g') IN ('innerwear','underwear','lingerie','intimates')
      UNION SELECT cat.id FROM product_categories cat JOIN inner_categories parent ON cat.parent_id=parent.id
    ) SELECT 1 FROM inner_categories WHERE id=p.category_id) AS is_innerwear,
    (SELECT b.ean_code FROM barcodes b WHERE b.variant_id=v.id ORDER BY b.id LIMIT 1) AS ean_code
    FROM vandana_cart c LEFT JOIN product_variants v ON v.id=c.product_id LEFT JOIN products p ON p.id=v.product_id
    LEFT JOIN branch_variant_stock s ON s.variant_id=v.id AND s.branch_id=$2 WHERE c.user_id=$1 ORDER BY c.id`, [userId, branch()]);
  const customConfig = result.rows.some(r => r.is_custom) ? await store.config(db) : null;
  for (const row of result.rows) if (row.is_custom) row.server_custom = store.customProduct(row.custom_payload, customConfig);
  const q = makeQuote(result.rows, points, settings());
  if (q.reward_points && !lock) {
    const preview = await rewards.previewRedemption({
      userId,
      requestedPoints: q.reward_points,
      orderSubtotal: q.subtotal + q.shipping
    });
    if (!preview.can_redeem) throw fail(preview.enabled ? 'Insufficient reward points. Update the points to use.' : 'Reward points are currently disabled.', 409, preview.enabled ? 'INSUFFICIENT_REWARD_POINTS' : 'REWARDS_DISABLED');
  }
  return q;
}
async function owned(db, userId, key, lock = false) {
  const q = await db.query(`SELECT m.*,s.payment_status,s.payment_method,s.status AS order_status FROM mobile_checkouts m
    JOIN sales s ON s.id=m.sale_id WHERE m.request_key=$1 AND m.user_id=$2 ${lock ? 'FOR UPDATE OF m,s' : ''}`, [uuid(key), userId]);
  if (!q.rowCount) throw fail('Checkout not found', 404);
  return q.rows[0];
}
function publicCheckout(row) {
  return {
    key: row.request_key,
    sale_id: row.sale_id,
    amount: Number(row.amount_paise),
    payment_status: row.payment_status,
    payment_method: row.payment_method,
    order_status: row.order_status,
    gateway_state: row.gateway_state,
    quote: row.quote,
    fully_paid: row.payment_status === 'PAID'
  };
}
async function clearPurchasedCart(db, row) {
  if (row.cart_cleared) return;
  for (const item of row.quote.items) {
    const cart = await db.query('SELECT id,quantity FROM vandana_cart WHERE id=$1 AND user_id=$2 FOR UPDATE', [item.cart_item_id, row.user_id]);
    if (!cart.rowCount) continue;
    if (Number(cart.rows[0].quantity) <= item.qty) await db.query('DELETE FROM vandana_cart WHERE id=$1 AND user_id=$2', [item.cart_item_id, row.user_id]);else await db.query('UPDATE vandana_cart SET quantity=quantity-$3,updated_at=now() WHERE id=$1 AND user_id=$2', [item.cart_item_id, row.user_id, item.qty]);
  }
  await db.query('UPDATE mobile_checkouts SET cart_cleared=true,updated_at=now() WHERE request_key=$1', [row.request_key]);
}
async function ship(saleId) {
  try {
    await createWorkflow(pool).connect(saleId, {
      fresh: true
    });
    return {
      connected: true
    };
  } catch (e) {
    console.error('[mobile-shipping]', saleId, e.message);
    return {
      connected: false,
      message: 'Your order is saved. The store will arrange dispatch.'
    };
  }
}
async function create(user, body) {
  const key = uuid(body.request_key);
  const address = addressOf(body.address);
  const method = body.payment_method;
  if (!['COD', 'ONLINE'].includes(method)) throw fail('Choose an available payment method.');
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({
    address,
    method,
    fingerprint: body.fingerprint,
    points: body.reward_points || 0
  })).digest('hex');
  let newCheckout = false;
  let readyToCommit = false;
  const row = await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mobile:${key}`]);
    const existing = await db.query('SELECT * FROM mobile_checkouts WHERE request_key=$1', [key]);
    if (existing.rowCount) {
      if (Number(existing.rows[0].user_id) !== user.id) throw fail('Checkout reference unavailable.', 409);
      if (existing.rows[0].request_hash !== requestHash) throw fail('This checkout was already started. Resume it from your orders.', 409);
      return owned(db, user.id, key);
    }
    newCheckout = true;
    if (method === 'ONLINE' && (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)) throw fail('Online payment is temporarily unavailable. Please choose cash on delivery.', 503, 'ONLINE_UNAVAILABLE');
    const q = await quote(db, user.id, body.reward_points, true);
    if (q.fingerprint !== body.fingerprint) throw fail('Your bag or prices changed. Review the updated total before placing your order.', 409, 'QUOTE_CHANGED');
    const saleId = crypto.randomUUID();
    const status = q.payable === 0 ? 'PAID' : method === 'COD' ? 'COD' : 'PENDING';
    const totals = {
      ...q,
      bagTotal: q.mrp,
      discountTotal: q.discount,
      convenience: q.shipping,
      giftWrap: 0,
      couponPct: 0,
      couponDiscount: 0,
      rewardDiscount: q.reward_points,
      rewardPoints: q.reward_points
    };
    await db.query(`INSERT INTO sales(id,source,status,payment_status,payment_method,total,totals,branch_id,customer_name,
      customer_email,customer_mobile,shipping_address,login_email,created_at)
      VALUES($1,'WEB','PLACED',$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$8,now())`, [saleId, status, method, q.payable, JSON.stringify(totals), branch(), address.fullName, user.email, address.mobile, JSON.stringify(address)]);
    for (const item of q.items) {
      if (!item.is_custom) {
        const stock = await db.query(`UPDATE branch_variant_stock SET on_hand=on_hand-$3,updated_at=now()
        WHERE branch_id=$1 AND variant_id=$2 AND is_active=true AND on_hand-COALESCE(reserved,0)>=$3 RETURNING variant_id`, [branch(), item.variant_id, item.qty]);
        if (!stock.rowCount) throw fail('Stock changed while checking out. Please update your bag.', 409);
      }
      await db.query(`INSERT INTO sale_items(id,sale_id,product_id,variant_id,qty,price,mrp,size,colour,image_url,ean_code,is_custom,custom_title,custom_payload,is_innerwear)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`, [crypto.randomUUID(), saleId, item.product_id, item.variant_id, item.qty, item.price, item.mrp, item.size, item.colour, item.image_url, item.ean_code, !!item.is_custom, item.is_custom ? item.name : null, item.is_custom ? JSON.stringify(item.custom_payload) : null, !!item.is_innerwear]);
    }
    if (q.reward_points) await rewards.redeemPoints(db, {
      userId: user.id,
      requestedPoints: q.reward_points,
      saleId,
      orderSubtotal: q.subtotal + q.shipping
    });
    await db.query("INSERT INTO order_shipping_workflow(sale_id,phase) VALUES($1,'NEW') ON CONFLICT DO NOTHING", [saleId]);
    await db.query(`INSERT INTO mobile_checkouts(request_key,user_id,sale_id,fingerprint,request_hash,quote,amount_paise)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [key, user.id, saleId, q.fingerprint, requestHash, JSON.stringify(q), Math.round(q.payable * 100)]);
    const result = await owned(db, user.id, key);
    if (status === 'PAID' || status === 'COD') await clearPurchasedCart(db, result);
    readyToCommit = true;
    return result;
  }).catch(error => {
    if (newCheckout && !readyToCommit && (error.status >= 400 && error.status < 500 || error.code === 'ONLINE_UNAVAILABLE')) error.checkout_not_created = true;
    throw error;
  });
  const result = publicCheckout(row);
  if (row.payment_status === 'PAID' || row.payment_status === 'COD') result.shipping = await ship(row.sale_id);
  return result;
}
async function paymentOrder(user, key) {
  const row = await transaction(async db => {
    const current = await owned(db, user.id, key, true);
    if (current.payment_status === 'PAID') return current;
    if (current.payment_method !== 'ONLINE' || /CANCEL|DELIVER|RETURN/.test(current.order_status)) throw fail('Payment is not available for this order.', 409);
    if (current.gateway_order_id) return current;
    if (current.gateway_state !== 'NEW') throw fail('The payment request needs reconciliation. Your order is saved. Please contact the store with its order ID.', 409, 'PAYMENT_RECONCILIATION');
    await db.query("UPDATE mobile_checkouts SET gateway_state='CREATING',updated_at=now() WHERE request_key=$1", [key]);
    return current;
  });
  if (row.payment_status === 'PAID') return publicCheckout(row);
  if (!row.gateway_order_id) {
    try {
      const gateway = await new Razorpay({}).createOrder({
        amountPaise: Number(row.amount_paise),
        currency: 'INR',
        receipt: row.sale_id,
        notes: {
          sale_id: row.sale_id,
          mobile_checkout: row.request_key
        }
      });
      await transaction(async db => {
        await db.query("UPDATE mobile_checkouts SET gateway_order_id=$2,gateway_state='READY',updated_at=now() WHERE request_key=$1", [key, gateway.id]);
        await db.query(`INSERT INTO payments(sale_id,razorpay_order_id,status,amount_paise,currency,email,phone,notes)
          VALUES($1,$2,'created',$3,'INR',$4,$5,$6::jsonb) ON CONFLICT(razorpay_order_id) DO NOTHING`, [row.sale_id, gateway.id, row.amount_paise, user.email, user.mobile, JSON.stringify({
          mobile_checkout: key
        })]);
      });
      row.gateway_order_id = gateway.id;
    } catch (e) {
      await pool.query("UPDATE mobile_checkouts SET gateway_state='UNKNOWN',updated_at=now() WHERE request_key=$1 AND gateway_order_id IS NULL", [key]);
      throw fail('Payment could not be started safely. Your order is saved for the store to check.', 503, 'PAYMENT_RECONCILIATION');
    }
  }
  return {
    ...publicCheckout(row),
    key_id: process.env.RAZORPAY_KEY_ID,
    order_id: row.gateway_order_id,
    currency: 'INR'
  };
}
async function complete(userId, key, payment) {
  const row = await transaction(async db => {
    const current = await owned(db, userId, key, true);
    if (!capturedPayment(payment, current)) throw fail('Payment has not been captured for this order yet.', 409, 'PAYMENT_PENDING');
    if (/CANCEL|RETURN/.test(current.order_status)) throw fail('This order needs payment reconciliation by the store.', 409);
    if (current.payment_status !== 'PAID') {
      await db.query("UPDATE sales SET payment_status='PAID',updated_at=now() WHERE id=$1", [current.sale_id]);
      await db.query("UPDATE payments SET razorpay_payment_id=$2,status='PAID' WHERE razorpay_order_id=$1", [current.gateway_order_id, payment.id]);
    }
    await db.query("UPDATE mobile_checkouts SET gateway_payment_id=$2,gateway_state='PAID',updated_at=now() WHERE request_key=$1", [key, payment.id]);
    await clearPurchasedCart(db, current);
    return {
      ...current,
      payment_status: 'PAID',
      gateway_state: 'PAID'
    };
  });
  return {
    ...publicCheckout(row),
    shipping: await ship(row.sale_id)
  };
}
async function verify(user, key, body) {
  const row = await owned(pool, user.id, key);
  if (body.razorpay_order_id !== row.gateway_order_id || !validSignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature, process.env.RAZORPAY_KEY_SECRET)) throw fail('Payment verification failed.', 400);
  const {
    data
  } = await new Razorpay({}).client.get(`/payments/${encodeURIComponent(body.razorpay_payment_id)}`);
  return complete(user.id, key, data);
}
async function reconcile(user, key) {
  const row = await owned(pool, user.id, key);
  if (row.gateway_order_id && row.payment_status !== 'COD') {
    const {
      data
    } = await new Razorpay({}).client.get(`/orders/${encodeURIComponent(row.gateway_order_id)}/payments`);
    const payment = (data.items || []).find(p => capturedPayment(p, row));
    if (payment) return complete(user.id, key, payment);
  }
  if (row.payment_status === 'PAID' || row.payment_status === 'COD') {
    await transaction(async db => clearPurchasedCart(db, await owned(db, user.id, key, true)));
    await ship(row.sale_id);
  }
  return publicCheckout(row);
}
module.exports = {
  quote,
  create,
  paymentOrder,
  verify,
  reconcile,
  owned,
  publicCheckout,
  complete,
  branch,
  settings
};
