const express = require('express')
const pool = require('../db')

const router = express.Router()

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'digu2krba'

const parsePositiveInt = value => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

router.get('/:ean', async (req, res) => {
  const ean = String(req.params.ean || '').trim()
  const branchId = parsePositiveInt(req.query?.branch_id ?? req.query?.branchId)

  if (!ean) {
    return res.status(400).json({ message: 'ean required' })
  }

  try {
    const { rows } = await pool.query(
      `SELECT
         b.ean_code,
         pv.id AS variant_id,
         pv.size,
         pv.colour,
         pv.mrp::numeric AS mrp,
         pv.sale_price::numeric AS base_sale_price,
         CASE
           WHEN COALESCE(pv.b2c_discount_pct, 0) > 0
           THEN ROUND(pv.mrp::numeric * (100 - COALESCE(pv.b2c_discount_pct, 0)) / 100, 2)
           ELSE COALESCE(NULLIF(pv.sale_price, 0), pv.mrp)::numeric
         END AS sale_price,
         pv.cost_price::numeric AS cost_price,
         COALESCE(pv.b2c_discount_pct, 0)::numeric AS b2c_discount_pct,
         COALESCE(pv.b2b_discount_pct, 0)::numeric AS b2b_discount_pct,
         p.id AS product_id,
         p.name AS product_name,
         p.brand_name,
         p.design_code,
         p.pattern_code,
         p.pattern_type,
         p.gender,
         p.category_id,
         $3::bigint AS branch_id,
         CASE WHEN $3::bigint IS NULL THEN NULL ELSE COALESCE(bvs.on_hand, 0)::int END AS on_hand,
         CASE WHEN $3::bigint IS NULL THEN NULL ELSE COALESCE(bvs.reserved, 0)::int END AS reserved,
         CASE
           WHEN $3::bigint IS NULL THEN NULL
           ELSE GREATEST(COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0), 0)::int
         END AS available_qty,
         CASE WHEN $3::bigint IS NULL THEN NULL ELSE COALESCE(bvs.is_active, FALSE) END AS stock_is_active,
         COALESCE(
           NULLIF(pv.image_url, ''),
           NULLIF(pi.image_url, ''),
           CONCAT(
             'https://res.cloudinary.com/',
             $2::text,
             '/image/upload/f_auto,q_auto/products/',
             b.ean_code
           )
         ) AS image_url
       FROM public.barcodes b
       JOIN public.product_variants pv
         ON pv.id = b.variant_id
       JOIN public.products p
         ON p.id = pv.product_id
       LEFT JOIN public.branch_variant_stock bvs
         ON bvs.variant_id = pv.id
        AND bvs.branch_id = $3::bigint
       LEFT JOIN LATERAL (
         SELECT pix.image_url
         FROM public.product_images pix
         WHERE UPPER(TRIM(pix.ean_code)) = UPPER(TRIM(b.ean_code))
           AND COALESCE(pix.image_url, '') <> ''
         ORDER BY
           CASE
             WHEN LOWER(COALESCE(pix.image_type, '')) = 'front' THEN 0
             WHEN LOWER(COALESCE(pix.image_type, '')) = 'main' THEN 1
             WHEN LOWER(COALESCE(pix.image_type, '')) = 'back' THEN 2
             ELSE 3
           END,
           pix.uploaded_at DESC NULLS LAST,
           pix.id ASC
         LIMIT 1
       ) pi ON TRUE
       WHERE UPPER(TRIM(b.ean_code)) = UPPER(TRIM($1))
         AND pv.is_active = TRUE
         AND p.is_active = TRUE
       LIMIT 1`,
      [ean, CLOUD_NAME, branchId]
    )

    if (!rows.length) {
      return res.status(404).json({ message: 'Not found' })
    }

    const row = rows[0]
    const designCode = row.design_code || ''
    const patternCode = row.pattern_code || ''
    const patternType = row.pattern_type || ''
    const stockChecked = branchId !== null
    const availableQty = stockChecked ? Number(row.available_qty || 0) : null
    const stockActive = stockChecked ? Boolean(row.stock_is_active) : null
    const inStock = stockChecked ? stockActive && availableQty > 0 : null

    return res.json({
      ean_code: row.ean_code,
      eanCode: row.ean_code,
      variant_id: Number(row.variant_id),
      variantId: Number(row.variant_id),
      product_id: Number(row.product_id),
      productId: Number(row.product_id),
      product_name: row.product_name,
      productName: row.product_name,
      brand_name: row.brand_name,
      brandName: row.brand_name,
      design_code: designCode,
      designCode,
      pattern_code: patternCode,
      patternCode,
      pattern_type: patternType,
      patternType,
      gender: row.gender,
      category_id: row.category_id,
      categoryId: row.category_id,
      size: row.size,
      colour: row.colour,
      color: row.colour,
      mrp: row.mrp !== null ? Number(row.mrp) : null,
      sale_price: row.sale_price !== null ? Number(row.sale_price) : null,
      salePrice: row.sale_price !== null ? Number(row.sale_price) : null,
      base_sale_price: row.base_sale_price !== null ? Number(row.base_sale_price) : null,
      cost_price: row.cost_price !== null ? Number(row.cost_price) : null,
      costPrice: row.cost_price !== null ? Number(row.cost_price) : null,
      b2c_discount_pct: Number(row.b2c_discount_pct || 0),
      b2b_discount_pct: Number(row.b2b_discount_pct || 0),
      branch_id: branchId,
      branchId,
      stock_checked: stockChecked,
      stockChecked,
      stock_is_active: stockActive,
      stockIsActive: stockActive,
      on_hand: stockChecked ? Number(row.on_hand || 0) : null,
      onHand: stockChecked ? Number(row.on_hand || 0) : null,
      reserved: stockChecked ? Number(row.reserved || 0) : null,
      available_qty: availableQty,
      availableQty,
      in_stock: inStock,
      inStock,
      stock_status: stockChecked ? (inStock ? 'IN_STOCK' : 'OUT_OF_STOCK') : 'NOT_CHECKED',
      stockStatus: stockChecked ? (inStock ? 'IN_STOCK' : 'OUT_OF_STOCK') : 'NOT_CHECKED',
      image_url: row.image_url || '',
      imageUrl: row.image_url || ''
    })
  } catch (err) {
    console.error('GET /api/barcodes/:ean error:', err)
    return res.status(500).json({ message: 'Server error' })
  }
})

module.exports = router
