const pool = require('../db');
const failure = (message, status = 409, available = 0) => Object.assign(new Error(message), {
  status,
  available
});
async function writeStockCart({
  userId,
  variantId,
  cartItemId,
  quantity,
  branchId,
  size,
  color,
  add
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM vandana_users WHERE id = $1 FOR UPDATE', [userId]);
    let target;
    if (!add) {
      const q = cartItemId ? await client.query('SELECT * FROM vandana_cart WHERE id = $1 AND user_id = $2 FOR UPDATE', [cartItemId, userId]) : await client.query('SELECT * FROM vandana_cart WHERE user_id = $1 AND product_id = $2 AND selected_size = $3 AND selected_color = $4 AND is_custom = FALSE FOR UPDATE', [userId, variantId, size, color]);
      target = q.rows[0];
      if (!target) throw failure('Cart item not found', 404);
      variantId = target.product_id;
      if (target.is_custom) {
        await client.query('UPDATE vandana_cart SET quantity = $2, updated_at = NOW() WHERE id = $1', [target.id, quantity]);
        await client.query('COMMIT');
        return {
          id: target.id,
          quantity
        };
      }
    }
    const stock = await client.query(`SELECT v.size, v.colour,
      GREATEST(COALESCE(s.on_hand,0) - COALESCE(s.reserved,0),0)::int AS available
      FROM branch_variant_stock s JOIN product_variants v ON v.id = s.variant_id
      JOIN products p ON p.id = v.product_id
      WHERE s.branch_id = $1 AND s.variant_id = $2
      AND s.is_active = TRUE AND v.is_active = TRUE AND p.is_active = TRUE FOR UPDATE OF s`, [branchId, variantId]);
    const available = Number(stock.rows[0]?.available || 0);
    const current = await client.query(`SELECT COALESCE(SUM(quantity),0)::int AS quantity FROM vandana_cart
      WHERE user_id = $1 AND product_id = $2 AND COALESCE(is_custom,FALSE) = FALSE`, [userId, variantId]);
    const total = Number(current.rows[0].quantity) + quantity - (add ? 0 : Number(target.quantity));
    if (total > available) throw failure(`Only ${available} available for this size and colour. Update your cart quantity.`, 409, available);
    let result;
    if (add) {
      result = await client.query(`INSERT INTO vandana_cart
        (user_id, product_id, selected_size, selected_color, quantity, is_custom, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,FALSE,NOW(),NOW())
        ON CONFLICT (user_id, product_id, selected_size, selected_color)
        WHERE is_custom = FALSE AND product_id IS NOT NULL
        DO UPDATE SET quantity = COALESCE(vandana_cart.quantity,0) + EXCLUDED.quantity, updated_at = NOW()
        RETURNING id, quantity`, [userId, variantId, stock.rows[0].size, stock.rows[0].colour, quantity]);
    } else {
      result = await client.query('UPDATE vandana_cart SET quantity = $2, updated_at = NOW() WHERE id = $1 RETURNING id, quantity', [target.id, quantity]);
    }
    await client.query('COMMIT');
    return {
      ...result.rows[0],
      available
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
module.exports = {
  writeStockCart
};
