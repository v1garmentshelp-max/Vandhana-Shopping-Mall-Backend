const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()

router.get('/scan', requireAuth, async (req, res) => {
  const branchId = Number(req.query.branch_id || req.query.branchId || req.user?.branch_id || 0)
  const eanCode = String(req.query.ean_code || req.query.ean || req.query.barcode || '').trim()

  if (!branchId || !eanCode) {
    return res.status(400).json({ message: 'branch_id and ean_code required' })
  }

  try {
    const q = await pool.query(
      `
      SELECT
        b.variant_id,
        b.ean_code,
        p.name AS product_name,
        p.brand_name,
        v.size,
        v.colour,
        v.mrp,
        COALESCE(v.sale_price, v.final_price_b2c, v.price, v.mrp, 0) AS sale_price,
        COALESCE(bvs.on_hand, 0) AS on_hand,
        COALESCE(bvs.reserved, 0) AS reserved,
        pi.image_url
      FROM barcodes b
      JOIN product_variants v ON v.id = b.variant_id
      LEFT JOIN products p ON p.id = v.product_id
      LEFT JOIN branch_variant_stock bvs
        ON bvs.variant_id = v.id
       AND bvs.branch_id = $2
      LEFT JOIN LATERAL (
        SELECT pix.image_url
        FROM product_images pix
        WHERE pix.ean_code = b.ean_code
        ORDER BY
          CASE
            WHEN LOWER(COALESCE(pix.image_type, '')) = 'front' THEN 0
            WHEN LOWER(COALESCE(pix.image_type, '')) = 'main' THEN 1
            WHEN LOWER(COALESCE(pix.image_type, '')) = 'back' THEN 2
            ELSE 3
          END,
          pix.id ASC
        LIMIT 1
      ) pi ON TRUE
      WHERE b.ean_code = $1
      LIMIT 1
      `,
      [eanCode, branchId]
    )

    if (!q.rowCount) {
      return res.status(404).json({ message: 'Barcode not found' })
    }

    const row = q.rows[0]

    if (Number(row.on_hand || 0) <= 0) {
      return res.status(409).json({ message: 'Insufficient stock' })
    }

    return res.json({
      ok: true,
      variant_id: row.variant_id,
      ean_code: row.ean_code,
      product_name: row.product_name,
      brand_name: row.brand_name,
      size: row.size,
      colour: row.colour,
      mrp: row.mrp,
      sale_price: row.sale_price,
      on_hand: row.on_hand,
      reserved: row.reserved,
      image_url: row.image_url
    })
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.post('/scan', requireAuth, async (req, res) => {
  const branchId = Number(req.body?.branch_id || req.body?.branchId || req.user?.branch_id || 0)
  const eanCode = String(req.body?.ean_code || req.body?.ean || req.body?.barcode || '').trim()
  const qty = Math.max(1, Number(req.body?.qty || 1))

  if (!branchId || !eanCode) {
    return res.status(400).json({ message: 'branch_id and ean_code required' })
  }

  try {
    const q = await pool.query(
      `
      SELECT
        b.variant_id,
        b.ean_code,
        p.name AS product_name,
        p.brand_name,
        v.size,
        v.colour,
        v.mrp,
        COALESCE(v.sale_price, v.final_price_b2c, v.price, v.mrp, 0) AS sale_price,
        COALESCE(bvs.on_hand, 0) AS on_hand,
        COALESCE(bvs.reserved, 0) AS reserved,
        pi.image_url
      FROM barcodes b
      JOIN product_variants v ON v.id = b.variant_id
      LEFT JOIN products p ON p.id = v.product_id
      LEFT JOIN branch_variant_stock bvs
        ON bvs.variant_id = v.id
       AND bvs.branch_id = $2
      LEFT JOIN LATERAL (
        SELECT pix.image_url
        FROM product_images pix
        WHERE pix.ean_code = b.ean_code
        ORDER BY
          CASE
            WHEN LOWER(COALESCE(pix.image_type, '')) = 'front' THEN 0
            WHEN LOWER(COALESCE(pix.image_type, '')) = 'main' THEN 1
            WHEN LOWER(COALESCE(pix.image_type, '')) = 'back' THEN 2
            ELSE 3
          END,
          pix.id ASC
        LIMIT 1
      ) pi ON TRUE
      WHERE b.ean_code = $1
      LIMIT 1
      `,
      [eanCode, branchId]
    )

    if (!q.rowCount) {
      return res.status(404).json({ message: 'Barcode not found' })
    }

    const row = q.rows[0]

    if (Number(row.on_hand || 0) < qty) {
      return res.status(409).json({ message: 'Insufficient stock' })
    }

    return res.json({
      ok: true,
      variant_id: row.variant_id,
      ean_code: row.ean_code,
      product_name: row.product_name,
      brand_name: row.brand_name,
      size: row.size,
      colour: row.colour,
      mrp: row.mrp,
      sale_price: row.sale_price,
      on_hand: row.on_hand,
      reserved: row.reserved,
      image_url: row.image_url
    })
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

module.exports = router