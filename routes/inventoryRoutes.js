const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()

const cleanText = value => String(value ?? '').trim()

const parsePositiveInt = value => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const getBranchId = req => {
  return parsePositiveInt(
    req.query?.branch_id ||
      req.query?.branchId ||
      req.body?.branch_id ||
      req.body?.branchId ||
      req.user?.branch_id
  )
}

const getBarcode = req => {
  return cleanText(
    req.query?.ean_code ||
      req.query?.ean ||
      req.query?.barcode ||
      req.body?.ean_code ||
      req.body?.ean ||
      req.body?.barcode
  )
}

const scanVariant = async ({ branchId, eanCode }) => {
  const result = await pool.query(
    `SELECT
       b.variant_id,
       b.ean_code,
       p.id AS product_id,
       p.name AS product_name,
       p.brand_name,
       p.design_code,
       p.pattern_code,
       p.pattern_type,
       p.gender,
       p.category_id,
       v.size,
       v.colour,
       v.mrp,
       COALESCE(v.sale_price, v.mrp, 0) AS sale_price,
       COALESCE(bvs.on_hand, 0)::int AS on_hand,
       COALESCE(bvs.reserved, 0)::int AS reserved,
       GREATEST(COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0), 0)::int AS available_qty,
       COALESCE(bvs.is_active, FALSE) AS stock_is_active,
       COALESCE(
         NULLIF(v.image_url, ''),
         NULLIF(pi.image_url, '')
       ) AS image_url
     FROM barcodes b
     JOIN product_variants v
       ON v.id = b.variant_id
     JOIN products p
       ON p.id = v.product_id
     LEFT JOIN branch_variant_stock bvs
       ON bvs.variant_id = v.id
      AND bvs.branch_id = $2
     LEFT JOIN LATERAL (
       SELECT pix.image_url
       FROM product_images pix
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
       AND v.is_active = TRUE
       AND p.is_active = TRUE
     LIMIT 1`,
    [eanCode, branchId]
  )

  return result.rows[0] || null
}

const toPayload = row => ({
  ok: true,
  variant_id: Number(row.variant_id),
  variantId: Number(row.variant_id),
  ean_code: row.ean_code,
  eanCode: row.ean_code,
  product_id: Number(row.product_id),
  productId: Number(row.product_id),
  product_name: row.product_name,
  productName: row.product_name,
  brand_name: row.brand_name,
  brandName: row.brand_name,
  design_code: row.design_code || '',
  designCode: row.design_code || '',
  pattern_code: row.pattern_code || '',
  patternCode: row.pattern_code || '',
  pattern_type: row.pattern_type || '',
  patternType: row.pattern_type || '',
  gender: row.gender,
  category_id: row.category_id,
  categoryId: row.category_id,
  size: row.size,
  colour: row.colour,
  color: row.colour,
  mrp: row.mrp,
  sale_price: row.sale_price,
  salePrice: row.sale_price,
  on_hand: row.on_hand,
  onHand: row.on_hand,
  reserved: row.reserved,
  available_qty: row.available_qty,
  availableQty: row.available_qty,
  image_url: row.image_url || '',
  imageUrl: row.image_url || ''
})

router.get('/scan', requireAuth, async (req, res) => {
  const branchId = getBranchId(req)
  const eanCode = getBarcode(req)

  if (!branchId || !eanCode) {
    return res.status(400).json({ message: 'branch_id and ean_code required' })
  }

  try {
    const row = await scanVariant({ branchId, eanCode })

    if (!row) {
      return res.status(404).json({ message: 'Barcode not found' })
    }

    if (!row.stock_is_active || Number(row.available_qty || 0) <= 0) {
      return res.status(409).json({ message: 'Insufficient stock' })
    }

    return res.json(toPayload(row))
  } catch (error) {
    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? error.message : 'Server error'
    })
  }
})

router.post('/scan', requireAuth, async (req, res) => {
  const branchId = getBranchId(req)
  const eanCode = getBarcode(req)
  const qty = parsePositiveInt(req.body?.qty || req.body?.quantity || 1)

  if (!branchId || !eanCode) {
    return res.status(400).json({ message: 'branch_id and ean_code required' })
  }

  if (!qty) {
    return res.status(400).json({ message: 'qty must be a positive integer' })
  }

  try {
    const row = await scanVariant({ branchId, eanCode })

    if (!row) {
      return res.status(404).json({ message: 'Barcode not found' })
    }

    if (!row.stock_is_active || Number(row.available_qty || 0) < qty) {
      return res.status(409).json({ message: 'Insufficient stock' })
    }

    return res.json({
      ...toPayload(row),
      requested_qty: qty,
      requestedQty: qty
    })
  } catch (error) {
    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? error.message : 'Server error'
    })
  }
})

module.exports = router
