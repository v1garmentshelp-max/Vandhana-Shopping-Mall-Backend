const express = require('express')
const pool = require('../db')
const router = express.Router()

const toInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

const toMoney = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const toText = (v) => String(v || '').trim()

const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1'

router.post('/vandana-cart', async (req, res) => {
  const {
    user_id,
    product_id,
    selected_size,
    selected_color,
    quantity,
    is_custom,
    custom_title,
    custom_brand,
    custom_image_url,
    custom_price,
    custom_original_price,
    custom_payload
  } = req.body

  const uid = toInt(user_id)
  const qty = Math.max(1, toInt(quantity) || 1)
  const size = toText(selected_size)
  const color = toText(selected_color)
  const isCustom = toBool(is_custom)

  if (!uid || !size || !color) {
    return res.status(400).json({ message: 'Missing cart fields' })
  }

  try {
    if (isCustom) {
      const title = toText(custom_title) || 'Custom Product'
      const brand = toText(custom_brand) || 'V1Garments'
      const imageUrl = toText(custom_image_url)
      const price = toMoney(custom_price, 0)
      const originalPrice = toMoney(custom_original_price, price)

      if (!title || !imageUrl || price <= 0) {
        return res.status(400).json({ message: 'Missing custom cart fields' })
      }

      const inserted = await pool.query(
        `INSERT INTO vandana_cart (
          user_id,
          product_id,
          selected_size,
          selected_color,
          quantity,
          is_custom,
          custom_title,
          custom_brand,
          custom_image_url,
          custom_price,
          custom_original_price,
          custom_payload,
          created_at,
          updated_at
        )
        VALUES ($1, NULL, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, $10::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id`,
        [
          uid,
          size,
          color,
          qty,
          title,
          brand,
          imageUrl,
          price,
          originalPrice,
          JSON.stringify(custom_payload || {})
        ]
      )

      return res.status(201).json({
        message: 'Added to cart successfully',
        cart_item_id: inserted.rows[0]?.id
      })
    }

    const vid = toInt(product_id)

    if (!vid) {
      return res.status(400).json({ message: 'Missing product_id' })
    }

    const exists = await pool.query(
      `SELECT id FROM product_variants WHERE id=$1 LIMIT 1`,
      [vid]
    )

    if (exists.rowCount === 0) {
      return res.status(404).json({ message: 'Product variant not found' })
    }

    const upsert = await pool.query(
      `INSERT INTO vandana_cart (
        user_id,
        product_id,
        selected_size,
        selected_color,
        quantity,
        is_custom,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, product_id, selected_size, selected_color)
      WHERE is_custom = FALSE AND product_id IS NOT NULL
      DO UPDATE SET
        quantity = COALESCE(vandana_cart.quantity, 0) + EXCLUDED.quantity,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id`,
      [uid, vid, size, color, qty]
    )

    return res.status(201).json({
      message: 'Added to cart successfully',
      cart_item_id: upsert.rows[0]?.id
    })
  } catch (err) {
    return res.status(500).json({ message: 'Error adding to cart', error: err.message })
  }
})

router.put('/vandana-cart', async (req, res) => {
  const {
    cart_item_id,
    user_id,
    product_id,
    selected_size,
    selected_color,
    quantity
  } = req.body

  const uid = toInt(user_id)
  const cartItemId = toInt(cart_item_id)
  const vid = toInt(product_id)
  const qty = toInt(quantity)
  const size = toText(selected_size)
  const color = toText(selected_color)

  if (!uid || !qty || qty < 1) {
    return res.status(400).json({ message: 'Missing fields for update' })
  }

  try {
    let result

    if (cartItemId) {
      result = await pool.query(
        `UPDATE vandana_cart
         SET quantity=$3, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND user_id=$2
         RETURNING id`,
        [cartItemId, uid, qty]
      )
    } else {
      if (!vid || !size || !color) {
        return res.status(400).json({ message: 'Missing cart item identity' })
      }

      result = await pool.query(
        `UPDATE vandana_cart
         SET quantity=$5, updated_at=CURRENT_TIMESTAMP
         WHERE user_id=$1
           AND product_id=$2
           AND selected_size=$3
           AND selected_color=$4
           AND is_custom=FALSE
         RETURNING id`,
        [uid, vid, size, color, qty]
      )
    }

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Cart item not found' })
    }

    return res.json({ message: 'Quantity updated' })
  } catch (err) {
    return res.status(500).json({ message: 'Error updating cart', error: err.message })
  }
})

router.get('/count/:userId', async (req, res) => {
  const uid = toInt(req.params.userId)

  if (!uid) {
    return res.status(400).json({ message: 'Invalid userId' })
  }

  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS count
       FROM vandana_cart
       WHERE user_id=$1`,
      [uid]
    )

    return res.json({ count: rows[0]?.count || 0 })
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching cart count', error: err.message })
  }
})

router.delete('/:userId/clear', async (req, res) => {
  const uid = toInt(req.params.userId)

  if (!uid) {
    return res.status(400).json({ message: 'Invalid userId' })
  }

  try {
    await pool.query(
      `DELETE FROM vandana_cart WHERE user_id=$1`,
      [uid]
    )

    return res.json({ message: 'Cart cleared' })
  } catch (err) {
    return res.status(500).json({ message: 'Error clearing cart', error: err.message })
  }
})

router.get('/:userId', async (req, res) => {
  const uid = toInt(req.params.userId)
  const branchId = toInt(req.query.branch_id) || 3

  if (!uid) {
    return res.status(400).json({ message: 'Invalid userId' })
  }

  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'digu2krba'

    const sql = `
      WITH normal_base AS (
        SELECT
          c.id AS cart_item_id,
          c.user_id,
          c.product_id AS variant_id,
          c.selected_size,
          c.selected_color,
          COALESCE(c.quantity, 1)::int AS quantity,
          v.product_id AS product_id,
          p.name AS product_name,
          p.brand_name AS brand,
          p.gender,
          v.size,
          v.colour AS color,
          v.mrp::numeric AS mrp,
          v.sale_price::numeric AS sale_price,
          COALESCE(NULLIF(v.cost_price,0), 0)::numeric AS cost_price,
          COALESCE(v.b2c_discount_pct, 0)::numeric AS b2c_discount_pct,
          COALESCE(v.b2b_discount_pct, 0)::numeric AS b2b_discount_pct,
          COALESCE(bvs.on_hand, 0)::int AS on_hand,
          COALESCE(bc_self.ean_code, bc_any.ean_code, '') AS ean_code,
          v.image_url AS v_image,
          pi.front_image_url,
          pi.back_image_url,
          pi.main_image_url,
          pi.any_image_url
        FROM vandana_cart c
        JOIN product_variants v ON v.id = c.product_id
        JOIN products p ON p.id = v.product_id
        LEFT JOIN branch_variant_stock bvs ON bvs.variant_id = v.id AND bvs.branch_id = $3
        LEFT JOIN LATERAL (
          SELECT ean_code
          FROM barcodes b
          WHERE b.variant_id = v.id
          ORDER BY id ASC
          LIMIT 1
        ) bc_self ON TRUE
        LEFT JOIN LATERAL (
          SELECT b2.ean_code
          FROM product_variants v2
          JOIN products p2 ON p2.id = v2.product_id
          JOIN barcodes b2 ON b2.variant_id = v2.id
          WHERE p2.name = p.name
            AND p2.brand_name = p.brand_name
            AND v2.size = v.size
            AND v2.colour = v.colour
          ORDER BY b2.id ASC
          LIMIT 1
        ) bc_any ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            MAX(image_url) FILTER (WHERE LOWER(COALESCE(image_type, '')) = 'front') AS front_image_url,
            MAX(image_url) FILTER (WHERE LOWER(COALESCE(image_type, '')) = 'back') AS back_image_url,
            MAX(image_url) FILTER (WHERE LOWER(COALESCE(image_type, '')) = 'main') AS main_image_url,
            MAX(image_url) AS any_image_url
          FROM product_images pix
          WHERE pix.ean_code = COALESCE(bc_self.ean_code, bc_any.ean_code)
        ) pi ON TRUE
        WHERE c.user_id = $1
          AND COALESCE(c.is_custom, FALSE) = FALSE
      ),
      normal_items AS (
        SELECT
          cart_item_id,
          user_id,
          variant_id::text AS id,
          product_id,
          variant_id,
          product_name,
          brand,
          gender,
          color,
          size,
          selected_size,
          selected_color,
          quantity,
          mrp AS original_price_b2c,
          CASE
            WHEN b2c_discount_pct > 0
              THEN ROUND(mrp * (100 - b2c_discount_pct)::numeric / 100, 2)
            ELSE COALESCE(NULLIF(sale_price,0), mrp)
          END AS final_price_b2c,
          mrp AS original_price_b2b,
          CASE
            WHEN b2b_discount_pct > 0
              THEN ROUND(mrp * (100 - b2b_discount_pct)::numeric / 100, 2)
            ELSE COALESCE(NULLIF(cost_price,0), COALESCE(NULLIF(sale_price,0), mrp))
          END AS final_price_b2b,
          COALESCE(
            NULLIF(v_image,''),
            NULLIF(front_image_url,''),
            NULLIF(main_image_url,''),
            NULLIF(any_image_url,''),
            CASE
              WHEN ean_code <> '' THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', ean_code)
              ELSE NULL
            END
          ) AS image_url,
          front_image_url,
          back_image_url,
          main_image_url,
          to_jsonb(
            ARRAY_REMOVE(
              ARRAY[
                COALESCE(
                  NULLIF(v_image,''),
                  NULLIF(front_image_url,''),
                  NULLIF(main_image_url,''),
                  NULLIF(any_image_url,''),
                  CASE
                    WHEN ean_code <> '' THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', ean_code)
                    ELSE NULL
                  END
                ),
                NULLIF(back_image_url,'')
              ],
              NULL
            )
          ) AS images,
          ean_code,
          on_hand,
          FALSE AS is_custom,
          NULL::jsonb AS custom_payload
        FROM normal_base
      ),
      custom_items AS (
        SELECT
          c.id AS cart_item_id,
          c.user_id,
          CONCAT('custom-', c.id)::text AS id,
          NULL::bigint AS product_id,
          NULL::bigint AS variant_id,
          COALESCE(NULLIF(c.custom_title, ''), 'Custom Product') AS product_name,
          COALESCE(NULLIF(c.custom_brand, ''), 'V1Garments') AS brand,
          'Custom' AS gender,
          c.selected_color AS color,
          c.selected_size AS size,
          c.selected_size,
          c.selected_color,
          COALESCE(c.quantity, 1)::int AS quantity,
          COALESCE(c.custom_original_price, c.custom_price, 0)::numeric AS original_price_b2c,
          COALESCE(c.custom_price, 0)::numeric AS final_price_b2c,
          COALESCE(c.custom_original_price, c.custom_price, 0)::numeric AS original_price_b2b,
          COALESCE(c.custom_price, 0)::numeric AS final_price_b2b,
          c.custom_image_url AS image_url,
          c.custom_image_url AS front_image_url,
          NULL::text AS back_image_url,
          NULL::text AS main_image_url,
          to_jsonb(ARRAY_REMOVE(ARRAY[c.custom_image_url], NULL)) AS images,
          NULL::text AS ean_code,
          1::int AS on_hand,
          TRUE AS is_custom,
          c.custom_payload
        FROM vandana_cart c
        WHERE c.user_id = $1
          AND COALESCE(c.is_custom, FALSE) = TRUE
      )
      SELECT *
      FROM normal_items
      UNION ALL
      SELECT *
      FROM custom_items
      ORDER BY cart_item_id DESC
    `

    const { rows } = await pool.query(sql, [uid, cloud, branchId])

    return res.json(rows)
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching cart', error: err.message })
  }
})

router.delete('/vandana-cart', async (req, res) => {
  const {
    cart_item_id,
    user_id,
    product_id,
    selected_size,
    selected_color
  } = req.body

  const uid = toInt(user_id)
  const cartItemId = toInt(cart_item_id)
  const vid = toInt(product_id)
  const size = toText(selected_size)
  const color = toText(selected_color)

  if (!uid) {
    return res.status(400).json({ message: 'Missing user_id' })
  }

  try {
    let result

    if (cartItemId) {
      result = await pool.query(
        `DELETE FROM vandana_cart
         WHERE id=$1 AND user_id=$2
         RETURNING id`,
        [cartItemId, uid]
      )
    } else {
      if (!vid || !size || !color) {
        return res.status(400).json({ message: 'Missing fields for delete' })
      }

      result = await pool.query(
        `DELETE FROM vandana_cart
         WHERE user_id=$1
           AND product_id=$2
           AND selected_size=$3
           AND selected_color=$4
           AND is_custom=FALSE
         RETURNING id`,
        [uid, vid, size, color]
      )
    }

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Cart item not found' })
    }

    return res.json({ message: 'Item removed from cart' })
  } catch (err) {
    return res.status(500).json({ message: 'Error removing from cart', error: err.message })
  }
})

module.exports = router