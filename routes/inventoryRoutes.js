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
       v.mrp::numeric AS mrp,
       CASE
         WHEN COALESCE(v.b2c_discount_pct, 0) > 0
         THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2)
         ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric
       END AS sale_price,
       COALESCE(v.b2c_discount_pct, 0)::numeric AS b2c_discount_pct,
       COALESCE(v.b2b_discount_pct, 0)::numeric AS b2b_discount_pct,
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

const toPayload = row => {
  const availableQty = Number(row.available_qty || 0)
  const stockActive = Boolean(row.stock_is_active)
  const inStock = stockActive && availableQty > 0

  return {
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
    mrp: row.mrp !== null ? Number(row.mrp) : null,
    sale_price: row.sale_price !== null ? Number(row.sale_price) : null,
    salePrice: row.sale_price !== null ? Number(row.sale_price) : null,
    b2c_discount_pct: Number(row.b2c_discount_pct || 0),
    b2b_discount_pct: Number(row.b2b_discount_pct || 0),
    on_hand: Number(row.on_hand || 0),
    onHand: Number(row.on_hand || 0),
    reserved: Number(row.reserved || 0),
    available_qty: availableQty,
    availableQty,
    stock_is_active: stockActive,
    stockIsActive: stockActive,
    in_stock: inStock,
    inStock,
    stock_status: inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
    stockStatus: inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
    image_url: row.image_url || '',
    imageUrl: row.image_url || ''
  }
}

router.get('/product/:productId/availability', requireAuth, async (req, res) => {
  const branchId = getBranchId(req)
  const productId = parsePositiveInt(req.params.productId)

  if (!branchId || !productId) {
    return res.status(400).json({ message: 'branch_id and valid productId required' })
  }

  try {
    const result = await pool.query(
      `SELECT
         p.id AS product_id,
         p.name AS product_name,
         p.brand_name,
         p.design_code,
         p.pattern_code,
         p.pattern_type,
         p.gender,
         p.category_id,
         v.id AS variant_id,
         v.size,
         v.colour,
         v.mrp::numeric AS mrp,
         CASE
           WHEN COALESCE(v.b2c_discount_pct, 0) > 0
           THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2)
           ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric
         END AS sale_price,
         COALESCE(b.ean_code, '') AS ean_code,
         COALESCE(bvs.on_hand, 0)::int AS on_hand,
         COALESCE(bvs.reserved, 0)::int AS reserved,
         GREATEST(COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0), 0)::int AS available_qty,
         COALESCE(bvs.is_active, FALSE) AS stock_is_active,
         COALESCE(NULLIF(v.image_url, ''), NULLIF(pi.image_url, '')) AS image_url
       FROM products p
       JOIN product_variants v
         ON v.product_id = p.id
       LEFT JOIN LATERAL (
         SELECT bc.ean_code
         FROM barcodes bc
         WHERE bc.variant_id = v.id
         ORDER BY bc.id ASC
         LIMIT 1
       ) b ON TRUE
       LEFT JOIN branch_variant_stock bvs
         ON bvs.variant_id = v.id
        AND bvs.branch_id = $2
       LEFT JOIN LATERAL (
         SELECT pix.image_url
         FROM product_images pix
         WHERE UPPER(TRIM(pix.ean_code)) = UPPER(TRIM(COALESCE(b.ean_code, '')))
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
       WHERE p.id = $1
         AND p.is_active = TRUE
         AND v.is_active = TRUE
       ORDER BY v.colour, v.size, v.id`,
      [productId, branchId]
    )

    if (!result.rowCount) {
      return res.status(404).json({ message: 'Product not found' })
    }

    const first = result.rows[0]
    const variants = result.rows.map(row => {
      const availableQty = Number(row.available_qty || 0)
      const stockActive = Boolean(row.stock_is_active)
      const inStock = stockActive && availableQty > 0

      return {
        variant_id: Number(row.variant_id),
        variantId: Number(row.variant_id),
        ean_code: row.ean_code || '',
        eanCode: row.ean_code || '',
        size: row.size,
        colour: row.colour,
        color: row.colour,
        mrp: row.mrp !== null ? Number(row.mrp) : null,
        sale_price: row.sale_price !== null ? Number(row.sale_price) : null,
        salePrice: row.sale_price !== null ? Number(row.sale_price) : null,
        on_hand: Number(row.on_hand || 0),
        onHand: Number(row.on_hand || 0),
        reserved: Number(row.reserved || 0),
        available_qty: availableQty,
        availableQty,
        stock_is_active: stockActive,
        stockIsActive: stockActive,
        in_stock: inStock,
        inStock,
        stock_status: inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
        stockStatus: inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
        image_url: row.image_url || '',
        imageUrl: row.image_url || ''
      }
    })

    const sizeMap = new Map()

    for (const variant of variants) {
      const key = String(variant.size || '').trim() || 'UNSPECIFIED'
      const existing = sizeMap.get(key) || { size: variant.size || '', available_qty: 0, variant_ids: [] }
      existing.available_qty += variant.available_qty
      existing.variant_ids.push(variant.variant_id)
      sizeMap.set(key, existing)
    }

    const sizes = Array.from(sizeMap.values()).map(item => ({
      ...item,
      in_stock: item.available_qty > 0,
      stock_status: item.available_qty > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK'
    }))

    return res.json({
      ok: true,
      branch_id: branchId,
      branchId,
      product_id: Number(first.product_id),
      productId: Number(first.product_id),
      product_name: first.product_name,
      productName: first.product_name,
      brand_name: first.brand_name,
      brandName: first.brand_name,
      design_code: first.design_code || '',
      designCode: first.design_code || '',
      pattern_code: first.pattern_code || '',
      patternCode: first.pattern_code || '',
      pattern_type: first.pattern_type || '',
      patternType: first.pattern_type || '',
      gender: first.gender,
      category_id: first.category_id,
      categoryId: first.category_id,
      variants,
      sizes
    })
  } catch (error) {
    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? error.message : 'Server error'
    })
  }
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
      return res.status(404).json({ message: 'Barcode not found', code: 'BARCODE_NOT_FOUND' })
    }

    const payload = toPayload(row)

    if (!payload.stock_is_active || payload.available_qty <= 0) {
      return res.status(409).json({
        ...payload,
        ok: false,
        code: 'OUT_OF_STOCK',
        message: 'Out of stock'
      })
    }

    return res.json(payload)
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
      return res.status(404).json({ message: 'Barcode not found', code: 'BARCODE_NOT_FOUND' })
    }

    const payload = toPayload(row)

    if (!payload.stock_is_active || payload.available_qty < qty) {
      return res.status(409).json({
        ...payload,
        ok: false,
        code: 'OUT_OF_STOCK',
        requested_qty: qty,
        requestedQty: qty,
        message: 'Insufficient stock'
      })
    }

    return res.json({
      ...payload,
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
