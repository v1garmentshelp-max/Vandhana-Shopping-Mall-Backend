const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { applyProductDesignReview } = require('../services/productDesignService')

const router = express.Router()

const REVIEW_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'APPLIED'])

const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim()

const parsePositiveInt = value => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const getRole = req => cleanText(req.user?.role_enum || req.user?.role).toUpperCase()

const requireSuperAdmin = (req, res, next) => {
  if (getRole(req) !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'Forbidden' })
  }

  return next()
}

const normalizeStatus = value => {
  const status = cleanText(value).toUpperCase()
  return REVIEW_STATUSES.has(status) ? status : null
}

const normalizeDesignCode = value => {
  if (value === null || value === undefined || cleanText(value) === '') return null

  const code = cleanText(value).toUpperCase()

  if (code.length > 100 || !/^[A-Z0-9][A-Z0-9._-]*$/.test(code)) {
    return undefined
  }

  return code
}

const normalizePatternType = value => {
  if (value === null || value === undefined || cleanText(value) === '') return null

  const patternType = cleanText(value).toUpperCase()

  if (patternType.length > 100) return undefined

  return patternType
}

const noStore = res => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
}

const getReviewProduct = async (db, productId) => {
  const result = await db.query(
    `
      SELECT
        p.id,
        p.name,
        p.brand_name,
        p.gender,
        p.category_id,
        p.design_code,
        p.pattern_code,
        p.pattern_type,
        p.fit_type,
        p.mark_code
      FROM products p
      WHERE p.id = $1
      LIMIT 1
    `,
    [productId]
  )

  return result.rows[0] || null
}

router.get('/summary', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          COUNT(*)::int AS total_rows,
          COUNT(DISTINCT product_id)::int AS total_products,
          COUNT(*) FILTER (WHERE review_status = 'PENDING')::int AS pending_rows,
          COUNT(*) FILTER (WHERE review_status = 'APPROVED')::int AS approved_rows,
          COUNT(*) FILTER (WHERE review_status = 'REJECTED')::int AS rejected_rows,
          COUNT(*) FILTER (WHERE review_status = 'APPLIED')::int AS applied_rows,
          COUNT(*) FILTER (WHERE NULLIF(TRIM(COALESCE(proposed_design_code, '')), '') IS NOT NULL)::int AS mapped_design_rows,
          COUNT(*) FILTER (WHERE NULLIF(TRIM(COALESCE(proposed_pattern_type, '')), '') IS NOT NULL)::int AS mapped_pattern_rows
        FROM product_design_mapping_review
      `
    )

    noStore(res)
    return res.json(result.rows[0])
  } catch (error) {
    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? error.message : 'Server error'
    })
  }
})

router.get('/', requireAuth, requireSuperAdmin, async (req, res) => {
  const statusInput = cleanText(req.query.status).toUpperCase()
  const status = statusInput && statusInput !== 'ALL' ? normalizeStatus(statusInput) : null
  const productId = parsePositiveInt(req.query.product_id || req.query.productId)
  const search = cleanText(req.query.search || req.query.q)
  const limit = Math.min(200, Math.max(1, parsePositiveInt(req.query.limit) || 50))
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0)

  if (statusInput && statusInput !== 'ALL' && !status) {
    return res.status(400).json({ message: 'Invalid review status' })
  }

  try {
    const params = []
    const filters = []

    if (status) {
      params.push(status)
      filters.push(`r.review_status = $${params.length}`)
    }

    if (productId) {
      params.push(productId)
      filters.push(`r.product_id = $${params.length}`)
    }

    if (search) {
      params.push(`%${search}%`)
      filters.push(`(
        p.name ILIKE $${params.length}
        OR p.brand_name ILIKE $${params.length}
        OR p.design_code ILIKE $${params.length}
        OR p.pattern_code ILIKE $${params.length}
        OR p.pattern_type ILIKE $${params.length}
        OR r.ean_code ILIKE $${params.length}
      )`)
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const countParams = [...params]

    params.push(limit)
    const limitIndex = params.length
    params.push(offset)
    const offsetIndex = params.length

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `
          SELECT
            r.product_id,
            p.name AS product_name,
            p.brand_name,
            p.gender,
            p.category_id,
            p.design_code AS product_design_code,
            p.pattern_code,
            p.pattern_type AS product_pattern_type,
            COUNT(*)::int AS variant_count,
            COUNT(*) FILTER (WHERE r.review_status = 'PENDING')::int AS pending_count,
            COUNT(*) FILTER (WHERE r.review_status = 'APPROVED')::int AS approved_count,
            COUNT(*) FILTER (WHERE r.review_status = 'REJECTED')::int AS rejected_count,
            COUNT(*) FILTER (WHERE r.review_status = 'APPLIED')::int AS applied_count,
            COUNT(DISTINCT UPPER(TRIM(COALESCE(NULLIF(r.proposed_design_code, ''), r.current_design_code))))::int AS effective_design_count,
            ARRAY_AGG(DISTINCT r.review_status ORDER BY r.review_status) AS statuses,
            MAX(r.updated_at) AS updated_at
          FROM product_design_mapping_review r
          JOIN products p
            ON p.id = r.product_id
          ${whereSql}
          GROUP BY
            r.product_id,
            p.name,
            p.brand_name,
            p.gender,
            p.category_id,
            p.design_code,
            p.pattern_code,
            p.pattern_type
          ORDER BY MAX(r.updated_at) DESC, r.product_id
          LIMIT $${limitIndex}
          OFFSET $${offsetIndex}
        `,
        params
      ),
      pool.query(
        `
          SELECT COUNT(DISTINCT r.product_id)::int AS total
          FROM product_design_mapping_review r
          JOIN products p
            ON p.id = r.product_id
          ${whereSql}
        `,
        countParams
      )
    ])

    noStore(res)
    return res.json({
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
      limit,
      offset
    })
  } catch (error) {
    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? error.message : 'Server error'
    })
  }
})

router.get('/:productId', requireAuth, requireSuperAdmin, async (req, res) => {
  const productId = parsePositiveInt(req.params.productId)

  if (!productId) {
    return res.status(400).json({ message: 'Invalid productId' })
  }

  try {
    const product = await getReviewProduct(pool, productId)

    if (!product) {
      return res.status(404).json({ message: 'Product not found' })
    }

    const result = await pool.query(
      `
        SELECT
          r.id AS review_id,
          r.product_id,
          r.variant_id,
          r.ean_code,
          r.current_design_code,
          r.proposed_design_code,
          COALESCE(NULLIF(r.proposed_design_code, ''), r.current_design_code) AS effective_design_code,
          r.current_pattern_type,
          r.proposed_pattern_type,
          COALESCE(NULLIF(r.proposed_pattern_type, ''), r.current_pattern_type) AS effective_pattern_type,
          r.review_status,
          r.notes,
          r.created_at,
          r.updated_at,
          v.size,
          v.colour,
          v.mrp,
          v.sale_price,
          v.cost_price,
          v.b2c_discount_pct,
          v.b2b_discount_pct,
          v.is_active,
          COALESCE(images.images, '[]'::jsonb) AS images,
          COALESCE(stock.stock_rows, '[]'::jsonb) AS stock_rows,
          COALESCE(stock.on_hand, 0)::int AS on_hand,
          COALESCE(stock.reserved, 0)::int AS reserved,
          COALESCE(stock.available_qty, 0)::int AS available_qty,
          COALESCE(refs.sale_rows, 0)::int AS sale_rows,
          COALESCE(refs.return_rows, 0)::int AS return_rows,
          COALESCE(refs.cart_rows, 0)::int AS cart_rows,
          COALESCE(refs.wishlist_rows, 0)::int AS wishlist_rows
        FROM product_design_mapping_review r
        JOIN product_variants v
          ON v.id = r.variant_id
        LEFT JOIN LATERAL (
          SELECT JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'id', pi.id,
              'image_type', pi.image_type,
              'image_url', pi.image_url,
              'public_id', pi.public_id,
              'uploaded_at', pi.uploaded_at
            )
            ORDER BY
              CASE
                WHEN LOWER(COALESCE(pi.image_type, '')) = 'front' THEN 0
                WHEN LOWER(COALESCE(pi.image_type, '')) = 'main' THEN 1
                WHEN LOWER(COALESCE(pi.image_type, '')) = 'back' THEN 2
                ELSE 3
              END,
              pi.id
          ) AS images
          FROM product_images pi
          WHERE UPPER(TRIM(pi.ean_code)) = UPPER(TRIM(r.ean_code))
        ) images ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'id', bvs.id,
                'branch_id', bvs.branch_id,
                'on_hand', bvs.on_hand,
                'reserved', bvs.reserved,
                'available_qty', GREATEST(COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0), 0),
                'is_active', bvs.is_active
              )
              ORDER BY bvs.branch_id
            ) AS stock_rows,
            SUM(COALESCE(bvs.on_hand, 0)) AS on_hand,
            SUM(COALESCE(bvs.reserved, 0)) AS reserved,
            SUM(GREATEST(COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0), 0)) AS available_qty
          FROM branch_variant_stock bvs
          WHERE bvs.variant_id = r.variant_id
        ) stock ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            (SELECT COUNT(*) FROM sale_items si WHERE si.variant_id = r.variant_id) AS sale_rows,
            (SELECT COUNT(*) FROM return_items ri WHERE ri.variant_id = r.variant_id) AS return_rows,
            (SELECT COUNT(*) FROM vandana_cart vc WHERE vc.product_id = r.variant_id) AS cart_rows,
            (SELECT COUNT(*) FROM vandana_wishlist vw WHERE vw.product_id = r.variant_id) AS wishlist_rows
        ) refs ON TRUE
        WHERE r.product_id = $1
        ORDER BY
          COALESCE(NULLIF(r.proposed_design_code, ''), r.current_design_code),
          v.colour,
          v.size,
          r.variant_id
      `,
      [productId]
    )

    if (!result.rowCount) {
      return res.status(404).json({ message: 'Review rows not found' })
    }

    noStore(res)
    return res.json({ product, variants: result.rows })
  } catch (error) {
    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? error.message : 'Server error'
    })
  }
})

router.patch('/variant/:variantId', requireAuth, requireSuperAdmin, async (req, res) => {
  const variantId = parsePositiveInt(req.params.variantId)

  if (!variantId) {
    return res.status(400).json({ message: 'Invalid variantId' })
  }

  const hasDesignCode = Object.prototype.hasOwnProperty.call(req.body || {}, 'proposed_design_code') || Object.prototype.hasOwnProperty.call(req.body || {}, 'proposedDesignCode')
  const hasPatternType = Object.prototype.hasOwnProperty.call(req.body || {}, 'proposed_pattern_type') || Object.prototype.hasOwnProperty.call(req.body || {}, 'proposedPatternType')
  const hasStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'review_status') || Object.prototype.hasOwnProperty.call(req.body || {}, 'reviewStatus')
  const hasNotes = Object.prototype.hasOwnProperty.call(req.body || {}, 'notes')

  if (!hasDesignCode && !hasPatternType && !hasStatus && !hasNotes) {
    return res.status(400).json({ message: 'No review fields provided' })
  }

  const designCode = hasDesignCode
    ? normalizeDesignCode(req.body?.proposed_design_code ?? req.body?.proposedDesignCode)
    : null
  const patternType = hasPatternType
    ? normalizePatternType(req.body?.proposed_pattern_type ?? req.body?.proposedPatternType)
    : null
  const status = hasStatus
    ? normalizeStatus(req.body?.review_status ?? req.body?.reviewStatus)
    : null
  const notes = hasNotes ? cleanText(req.body?.notes).slice(0, 2000) || null : null

  if (hasDesignCode && designCode === undefined) {
    return res.status(400).json({ message: 'Invalid proposed_design_code' })
  }

  if (hasPatternType && patternType === undefined) {
    return res.status(400).json({ message: 'Invalid proposed_pattern_type' })
  }

  if (hasStatus && !status) {
    return res.status(400).json({ message: 'Invalid review_status' })
  }

  if (status === 'APPLIED') {
    return res.status(400).json({ message: 'APPLIED status can only be set by the apply operation' })
  }

  try {
    const existing = await pool.query(
      `
        SELECT *
        FROM product_design_mapping_review
        WHERE variant_id = $1
        LIMIT 1
      `,
      [variantId]
    )

    if (!existing.rowCount) {
      return res.status(404).json({ message: 'Review row not found' })
    }

    if (existing.rows[0].review_status === 'APPLIED') {
      return res.status(409).json({ message: 'Applied review rows cannot be edited' })
    }

    const result = await pool.query(
      `
        UPDATE product_design_mapping_review
        SET proposed_design_code = CASE WHEN $2::boolean THEN $3 ELSE proposed_design_code END,
            proposed_pattern_type = CASE WHEN $4::boolean THEN $5 ELSE proposed_pattern_type END,
            review_status = CASE WHEN $6::boolean THEN $7 ELSE review_status END,
            notes = CASE WHEN $8::boolean THEN $9 ELSE notes END,
            updated_at = NOW()
        WHERE variant_id = $1
        RETURNING *
      `,
      [
        variantId,
        hasDesignCode,
        designCode,
        hasPatternType,
        patternType,
        hasStatus,
        status,
        hasNotes,
        notes
      ]
    )

    return res.json(result.rows[0])
  } catch (error) {
    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? error.message : 'Server error'
    })
  }
})

router.post('/:productId/approve', requireAuth, requireSuperAdmin, async (req, res) => {
  const productId = parsePositiveInt(req.params.productId)

  if (!productId) {
    return res.status(400).json({ message: 'Invalid productId' })
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const rowsResult = await client.query(
      `
        SELECT *
        FROM product_design_mapping_review
        WHERE product_id = $1
        ORDER BY variant_id
        FOR UPDATE
      `,
      [productId]
    )

    if (!rowsResult.rowCount) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Review rows not found' })
    }

    if (rowsResult.rows.some(row => row.review_status === 'APPLIED')) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: 'Product review has already been applied' })
    }

    const effectiveDesignCodes = rowsResult.rows.map(row =>
      normalizeDesignCode(row.proposed_design_code || row.current_design_code)
    )

    if (effectiveDesignCodes.some(code => !code || code === undefined)) {
      await client.query('ROLLBACK')
      return res.status(422).json({ message: 'Every variant requires a valid design code before approval' })
    }

    const uniqueDesignCodes = [...new Set(effectiveDesignCodes)]
    const conflictResult = await client.query(
      `
        SELECT id, design_code
        FROM products
        WHERE id <> $1
          AND UPPER(TRIM(design_code)) = ANY($2::text[])
      `,
      [productId, uniqueDesignCodes]
    )

    if (conflictResult.rowCount) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        message: 'One or more proposed design codes already belong to another product',
        conflicts: conflictResult.rows
      })
    }

    const result = await client.query(
      `
        UPDATE product_design_mapping_review
        SET proposed_design_code = UPPER(TRIM(COALESCE(NULLIF(proposed_design_code, ''), current_design_code))),
            proposed_pattern_type = NULLIF(UPPER(TRIM(COALESCE(NULLIF(proposed_pattern_type, ''), current_pattern_type, ''))), ''),
            review_status = 'APPROVED',
            updated_at = NOW()
        WHERE product_id = $1
        RETURNING *
      `,
      [productId]
    )

    await client.query('COMMIT')

    return res.json({
      message: 'Product design review approved',
      product_id: productId,
      variant_count: result.rowCount,
      design_codes: uniqueDesignCodes
    })
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {}

    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? error.message : 'Server error'
    })
  } finally {
    client.release()
  }
})

router.post('/:productId/reject', requireAuth, requireSuperAdmin, async (req, res) => {
  const productId = parsePositiveInt(req.params.productId)
  const reason = cleanText(req.body?.reason || req.body?.notes).slice(0, 2000) || null

  if (!productId) {
    return res.status(400).json({ message: 'Invalid productId' })
  }

  try {
    const result = await pool.query(
      `
        UPDATE product_design_mapping_review
        SET review_status = 'REJECTED',
            notes = CASE
              WHEN $2::text IS NULL THEN notes
              WHEN NULLIF(TRIM(COALESCE(notes, '')), '') IS NULL THEN $2
              ELSE notes || E'\n' || $2
            END,
            updated_at = NOW()
        WHERE product_id = $1
          AND review_status <> 'APPLIED'
        RETURNING variant_id
      `,
      [productId, reason]
    )

    if (!result.rowCount) {
      return res.status(404).json({ message: 'Review rows not found or already applied' })
    }

    return res.json({
      message: 'Product design review rejected',
      product_id: productId,
      variant_count: result.rowCount
    })
  } catch (error) {
    return res.status(500).json({
      message: process.env.DEBUG_ERRORS === '1' ? error.message : 'Server error'
    })
  }
})

router.post('/:productId/apply', requireAuth, requireSuperAdmin, async (req, res) => {
  const productId = parsePositiveInt(req.params.productId)

  if (!productId) {
    return res.status(400).json({ message: 'Invalid productId' })
  }

  try {
    const result = await applyProductDesignReview({
      pool,
      productId,
      actor: {
        userId: req.user?.id || null,
        role: getRole(req)
      }
    })

    return res.json(result)
  } catch (error) {
    const status = Number(error?.statusCode || error?.status || 500)

    return res.status(status >= 400 && status <= 599 ? status : 500).json({
      message: error?.message || 'Server error',
      details: error?.details || undefined
    })
  }
})

module.exports = router
