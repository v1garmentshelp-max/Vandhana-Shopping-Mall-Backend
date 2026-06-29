const express = require('express')
const pool = require('../db')

const router = express.Router()

const toInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

router.post('/', async (req, res) => {
  const { user_id, product_id, variant_id } = req.body || {}

  if (user_id === undefined || user_id === null) {
    return res.status(400).json({ message: 'User ID is required' })
  }

  const uid = toInt(user_id)
  const vid = toInt(variant_id || product_id)

  if (!uid || !vid) {
    return res.status(400).json({ message: 'Invalid user_id or variant_id' })
  }

  try {
    const user = await pool.query('SELECT 1 FROM vandana_users WHERE id = $1', [uid])

    if (!user.rowCount) {
      return res.status(400).json({ message: 'Invalid user_id' })
    }

    const variant = await pool.query('SELECT 1 FROM product_variants WHERE id = $1', [vid])

    if (!variant.rowCount) {
      return res.status(400).json({ message: 'Invalid variant_id' })
    }

    await pool.query(
      `INSERT INTO vandana_wishlist (user_id, product_id)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM vandana_wishlist WHERE user_id = $1 AND product_id = $2
       )`,
      [uid, vid]
    )

    return res.json({ message: 'Added to wishlist' })
  } catch (err) {
    return res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/:user_id', async (req, res) => {
  const uid = toInt(req.params.user_id)

  if (!uid) {
    return res.status(400).json({ message: 'Invalid user_id' })
  }

  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'digu2krba'

    const sql = `
      WITH base AS (
        SELECT
          w.user_id,
          w.product_id AS stored_variant_id,
          v.id AS variant_id,
          v.product_id AS actual_product_id,
          p.name AS product_name,
          p.brand_name AS brand,
          p.gender AS gender,
          v.size,
          v.colour AS color,
          v.mrp::numeric AS mrp,
          v.sale_price::numeric AS sale_price,
          COALESCE(NULLIF(v.cost_price,0), 0)::numeric AS cost_price,
          COALESCE(v.b2c_discount_pct, 0)::numeric AS b2c_discount_pct,
          COALESCE(v.b2b_discount_pct, 0)::numeric AS b2b_discount_pct,
          COALESCE(bc_self.ean_code, bc_any.ean_code, '') AS ean_code,
          v.image_url AS v_image,
          pi.front_image_url,
          pi.back_image_url,
          pi.main_image_url,
          pi.any_image_url
        FROM vandana_wishlist w
        JOIN product_variants v ON v.id = w.product_id
        JOIN products p ON p.id = v.product_id
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
        WHERE w.user_id = $2
      )
      SELECT
        user_id,
        variant_id AS id,
        variant_id AS product_id,
        variant_id,
        actual_product_id,
        product_name,
        brand,
        gender,
        size,
        color,
        color AS colour,
        ean_code,
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
            WHEN ean_code <> '' THEN CONCAT('https://res.cloudinary.com/', $1::text, '/image/upload/f_auto,q_auto/products/', ean_code)
            ELSE '/images/placeholder.jpg'
          END
        ) AS image_url,
        front_image_url,
        back_image_url,
        main_image_url
      FROM base
      ORDER BY variant_id DESC
    `

    const { rows } = await pool.query(sql, [cloud, uid])
    return res.json(rows)
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching wishlist', error: err.message })
  }
})

router.delete('/', async (req, res) => {
  const { user_id, product_id, variant_id } = req.body || {}

  if (user_id === undefined || user_id === null) {
    return res.status(400).json({ message: 'User ID is required' })
  }

  const uid = toInt(user_id)
  const vid = toInt(variant_id || product_id)

  if (!uid || !vid) {
    return res.status(400).json({ message: 'Invalid user_id or variant_id' })
  }

  try {
    await pool.query(
      'DELETE FROM vandana_wishlist WHERE user_id = $1 AND product_id = $2',
      [uid, vid]
    )

    return res.json({ message: 'Removed from wishlist' })
  } catch (err) {
    return res.status(500).json({ message: 'Server error', error: err.message })
  }
})

module.exports = router