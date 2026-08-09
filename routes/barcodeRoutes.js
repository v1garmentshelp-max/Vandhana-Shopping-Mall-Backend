const express = require('express')
const pool = require('../db')

const router = express.Router()

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'digu2krba'

router.get('/:ean', async (req, res) => {
  const ean = String(req.params.ean || '').trim()

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
         pv.sale_price::numeric AS sale_price,
         pv.cost_price::numeric AS cost_price,
         p.id AS product_id,
         p.name AS product_name,
         p.brand_name,
         p.design_code,
         p.pattern_code,
         p.pattern_type,
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
       LEFT JOIN LATERAL (
         SELECT pix.image_url
         FROM public.product_images pix
         WHERE pix.ean_code = b.ean_code
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
       WHERE b.ean_code = $1
         AND pv.is_active = TRUE
         AND p.is_active = TRUE
       LIMIT 1`,
      [ean, CLOUD_NAME]
    )

    if (!rows.length) {
      return res.status(404).json({ message: 'Not found' })
    }

    const row = rows[0]
    const designCode = row.design_code || ''
    const patternCode = row.pattern_code || ''
    const patternType = row.pattern_type || ''

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
      size: row.size,
      colour: row.colour,
      color: row.colour,
      mrp: row.mrp !== null ? Number(row.mrp) : null,
      sale_price: row.sale_price !== null ? Number(row.sale_price) : null,
      salePrice: row.sale_price !== null ? Number(row.sale_price) : null,
      cost_price: row.cost_price !== null ? Number(row.cost_price) : null,
      costPrice: row.cost_price !== null ? Number(row.cost_price) : null,
      image_url: row.image_url || '',
      imageUrl: row.image_url || ''
    })
  } catch (err) {
    console.error('GET /api/barcodes/:ean error:', err)
    return res.status(500).json({ message: 'Server error' })
  }
})

module.exports = router
