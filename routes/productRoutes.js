const express = require('express')
const pool = require('../db')

const router = express.Router()

const WEB_BRANCH_ID = (() => {
  const v = parseInt(process.env.WEB_BRANCH_ID || '', 10)
  return Number.isFinite(v) && v > 0 ? v : null
})()

const toGender = v => {
  const s = String(v || '').trim().toUpperCase()
  if (s === 'MEN' || s === 'WOMEN' || s === 'KIDS') return s
  if (s === 'MAN' || s === 'MALE' || s === 'MENS' || s === "MEN'S") return 'MEN'
  if (s === 'WOMAN' || s === 'FEMALE' || s === 'LADIES' || s === 'WOMENS' || s === "WOMEN'S") return 'WOMEN'
  if (s === 'CHILD' || s === 'CHILDREN' || s === 'BOYS' || s === 'GIRLS' || s === 'KID' || s === 'KIDS') return 'KIDS'
  return ''
}

const cleanValue = v => String(v ?? '').replace(/\s+/g, ' ').trim()

const normalizeDesignCode = value => cleanValue(value).toUpperCase()

const normalizePatternType = value => cleanValue(value).toUpperCase()

const normalizeBarcodeForWrite = v =>
  String(v ?? '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, '')

const hasGroupedVariantValue = v => {
  const s = cleanValue(v)
  if (!s) return false
  return s.includes(',')
}

const toNumber = v => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const parsePositiveInt = v => {
  const n = parseInt(v, 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

const clampDiscount = v => {
  const n = toNumber(v)
  if (n < 0) return 0
  if (n > 100) return 100
  return n
}

const calcDiscountedPrice = (price, discount) => {
  const p = toNumber(price)
  const d = clampDiscount(discount)
  return Number((p - (p * d) / 100).toFixed(2))
}

const uniqueValues = arr => {
  const seen = new Set()
  const out = []

  for (const item of arr) {
    const value = String(item || '').trim()
    if (!value) continue
    const key = value.toLowerCase()

    if (!seen.has(key)) {
      seen.add(key)
      out.push(value)
    }
  }

  return out
}

const sortVariantValues = arr => {
  return uniqueValues(arr).sort((a, b) => {
    const na = parseFloat(String(a).replace(/[^\d.]/g, ''))
    const nb = parseFloat(String(b).replace(/[^\d.]/g, ''))

    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return String(a).localeCompare(String(b), undefined, { numeric: true })
  })
}

const normalizeText = str =>
  String(str || '')
    .toLowerCase()
    .replace(/₹/g, ' ')
    .replace(/rs\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const STOPWORDS = new Set([
  'for',
  'and',
  'with',
  'in',
  'the',
  'a',
  'an',
  'of',
  'to',
  'on',
  'from',
  'at',
  'by',
  'rs',
  'rupees',
  'below',
  'under',
  'upto',
  'up',
  'between',
  'above',
  'over',
  'less',
  'more',
  'than',
  'price'
])

const getBranchIdFromReq = req => {
  let branchId = WEB_BRANCH_ID
  const branchFromQuery = req.query.branch_id || req.query.branchId

  if (branchFromQuery) {
    const parsed = parseInt(branchFromQuery, 10)
    if (Number.isFinite(parsed) && parsed > 0) branchId = parsed
  }

  return branchId
}

const noStore = res => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
}


const ACTIVE_CATEGORY_PATHS_CTE = `
  WITH RECURSIVE category_paths AS (
    SELECT
      c.id,
      c.parent_id,
      c.gender,
      c.name,
      c.slug,
      c.level,
      c.name::text AS category_path
    FROM product_categories c
    WHERE c.parent_id IS NULL
      AND c.is_active = TRUE

    UNION ALL

    SELECT
      c.id,
      c.parent_id,
      c.gender,
      c.name,
      c.slug,
      c.level,
      category_paths.category_path || ' > ' || c.name
    FROM product_categories c
    JOIN category_paths
      ON category_paths.id = c.parent_id
    WHERE c.is_active = TRUE
  )
`

const priceSql = () => `
  CASE
    WHEN COALESCE(v.b2c_discount_pct, 0) > 0
      THEN ROUND(COALESCE(NULLIF(v.mrp, 0), NULLIF(v.sale_price, 0), 0)::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2)
    ELSE COALESCE(NULLIF(v.sale_price, 0), NULLIF(v.mrp, 0), 0)::numeric
  END
`

const productWhere = ({ includeGroupedValues = false, includeOutOfStock = false } = {}) => `
  v.is_active = TRUE
  AND c.is_active = TRUE
  ${includeOutOfStock ? '' : `
  AND COALESCE(bvs.is_active, FALSE) = TRUE
  AND GREATEST(COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0), 0) > 0
  `}
  ${includeGroupedValues ? '' : `
  AND COALESCE(v.size, '') NOT LIKE '%,%'
  AND COALESCE(v.colour, '') NOT LIKE '%,%'
  `}
`

const fallbackImageSql = () => `
  CASE
    WHEN p.gender = 'WOMEN' THEN '/images/women/women20.jpeg'
    WHEN p.gender = 'MEN' THEN '/images/men/default.jpg'
    WHEN p.gender = 'KIDS' THEN '/images/kids/default.jpg'
    ELSE '/images/placeholder.jpg'
  END
`

const generatedImageSql = cloudIdx => `
  CASE
    WHEN COALESCE(bc_self.ean_code, '') <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}::text, '/image/upload/f_auto,q_auto/products/', COALESCE(bc_self.ean_code, ''))
    ELSE NULL
  END
`

const frontImageSql = cloudIdx => `
  COALESCE(
    NULLIF(v.image_url, ''),
    NULLIF(pi_front.image_url, ''),
    ${generatedImageSql(cloudIdx)},
    ${fallbackImageSql()}
  )
`

const backImageSql = () => `
  COALESCE(NULLIF(pi_back.image_url, ''), '')
`

const buildProductSelectSql = ({ where, branchIdx, cloudIdx }) => {
  const frontImage = frontImageSql(cloudIdx)
  const backImage = backImageSql()

  return `
  ${ACTIVE_CATEGORY_PATHS_CTE}
  SELECT
    p.id AS product_id,
    p.name AS product_name,
    p.name AS name,
    p.brand_name AS brand,
    p.brand_name AS brand_name,
    p.gender,
    p.gender AS category,
    p.design_code,
    p.pattern_type,
    p.pattern_code,
    p.fit_type,
    p.mark_code,
    p.category_id,
    c.name AS category_name,
    c.slug AS category_slug,
    c.level AS category_level,
    pc.id AS parent_category_id,
    pc.name AS parent_category_name,
    pc.slug AS parent_category_slug,
    cp.category_path,
    v.id AS variant_id,
    v.id AS id,
    v.size,
    v.colour AS color,
    v.colour,
    COALESCE(NULLIF(v.mrp, 0), NULLIF(v.sale_price, 0), 0)::numeric AS mrp,
    COALESCE(NULLIF(v.mrp, 0), NULLIF(v.sale_price, 0), 0)::numeric AS original_price,
    COALESCE(NULLIF(v.mrp, 0), NULLIF(v.sale_price, 0), 0)::numeric AS original_price_b2c,
    COALESCE(NULLIF(v.cost_price, 0), NULLIF(v.mrp, 0), NULLIF(v.sale_price, 0), 0)::numeric AS original_price_b2b,
    COALESCE(NULLIF(v.sale_price, 0), NULLIF(v.mrp, 0), 0)::numeric AS base_sale_price,
    COALESCE(NULLIF(v.sale_price, 0), NULLIF(v.mrp, 0), 0)::numeric AS original_sale_price,
    COALESCE(NULLIF(v.cost_price, 0), 0)::numeric AS cost_price,
    COALESCE(v.b2c_discount_pct, 0)::numeric AS b2c_discount_pct,
    COALESCE(v.b2c_discount_pct, 0)::numeric AS discount_b2c,
    COALESCE(v.b2c_discount_pct, 0)::numeric AS discount,
    COALESCE(v.b2c_discount_pct, 0)::numeric AS discount_percentage,
    COALESCE(v.b2c_discount_pct, 0)::numeric AS discount_percent,
    COALESCE(v.b2b_discount_pct, 0)::numeric AS b2b_discount_pct,
    COALESCE(v.b2b_discount_pct, 0)::numeric AS discount_b2b,
    ${priceSql()} AS final_price_b2c,
    ${priceSql()} AS b2c_final_price,
    ${priceSql()} AS sale_price,
    ${priceSql()} AS price,
    ${priceSql()} AS selling_price,
    ${priceSql()} AS final_price,
    ${priceSql()} AS discounted_price,
    ${priceSql()} AS mahaveer_price,
    CASE
      WHEN COALESCE(v.b2b_discount_pct, 0) > 0
        THEN ROUND(COALESCE(NULLIF(v.cost_price, 0), NULLIF(v.mrp, 0), NULLIF(v.sale_price, 0), 0)::numeric * (100 - COALESCE(v.b2b_discount_pct, 0)) / 100, 2)
      ELSE COALESCE(NULLIF(v.cost_price, 0), NULLIF(v.sale_price, 0), NULLIF(v.mrp, 0), 0)::numeric
    END AS final_price_b2b,
    CASE
      WHEN COALESCE(v.b2b_discount_pct, 0) > 0
        THEN ROUND(COALESCE(NULLIF(v.cost_price, 0), NULLIF(v.mrp, 0), NULLIF(v.sale_price, 0), 0)::numeric * (100 - COALESCE(v.b2b_discount_pct, 0)) / 100, 2)
      ELSE COALESCE(NULLIF(v.cost_price, 0), NULLIF(v.sale_price, 0), NULLIF(v.mrp, 0), 0)::numeric
    END AS b2b_final_price,
    COALESCE(bvs.on_hand, 0)::int AS on_hand,
    COALESCE(bvs.reserved, 0)::int AS reserved,
    GREATEST(COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0), 0)::int AS available_qty,
    COALESCE(bvs.on_hand, 0)::int AS total_count,
    CASE
      WHEN COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0) > 0 AND bvs.is_active IS TRUE THEN TRUE
      ELSE FALSE
    END AS in_stock,
    COALESCE(bc_self.ean_code, '') AS barcode,
    COALESCE(bc_self.ean_code, '') AS ean_code,
    ${frontImage} AS image_url,
    ${frontImage} AS front_image_url,
    ${frontImage} AS "frontImageUrl",
    ${backImage} AS back_image_url,
    ${backImage} AS "backImageUrl",
    ${frontImage} AS main_image_url,
    ${frontImage} AS "mainImageUrl",
    jsonb_build_array(${frontImage}, NULLIF(${backImage}, '')) AS images
  FROM products p
  JOIN product_variants v ON v.product_id = p.id
  JOIN product_categories c
    ON c.id = p.category_id
   AND c.is_active = TRUE
  JOIN category_paths cp
    ON cp.id = c.id
  LEFT JOIN product_categories pc
    ON pc.id = c.parent_id
  LEFT JOIN LATERAL (
    SELECT ean_code
    FROM barcodes b
    WHERE b.variant_id = v.id
    ORDER BY id ASC
    LIMIT 1
  ) bc_self ON TRUE
  LEFT JOIN LATERAL (
    SELECT image_url
    FROM product_images pi
    WHERE pi.ean_code = bc_self.ean_code
      AND COALESCE(pi.image_url, '') <> ''
      AND pi.image_url NOT ILIKE '%__back__%'
      AND pi.image_url NOT ILIKE '%/back/%'
      AND pi.image_url NOT ILIKE '%back_%'
      AND pi.image_url NOT ILIKE '%back-%'
    ORDER BY uploaded_at DESC
    LIMIT 1
  ) pi_front ON TRUE
  LEFT JOIN LATERAL (
    SELECT image_url
    FROM product_images pi
    WHERE pi.ean_code = bc_self.ean_code
      AND COALESCE(pi.image_url, '') <> ''
      AND (
        pi.image_url ILIKE '%__back__%'
        OR pi.image_url ILIKE '%/back/%'
        OR pi.image_url ILIKE '%back_%'
        OR pi.image_url ILIKE '%back-%'
      )
    ORDER BY uploaded_at DESC
    LIMIT 1
  ) pi_back ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      SUM(on_hand) FILTER (WHERE is_active = TRUE) AS on_hand,
      SUM(reserved) FILTER (WHERE is_active = TRUE) AS reserved,
      BOOL_OR(is_active) AS is_active
    FROM branch_variant_stock bvs
    WHERE bvs.variant_id = v.id
      AND ($${branchIdx}::int IS NULL OR bvs.branch_id = $${branchIdx}::int)
  ) bvs ON TRUE
  WHERE ${where}
`
}

const makeVariantPayload = row => ({
  id: row.variant_id,
  variant_id: row.variant_id,
  variantId: row.variant_id,
  product_id: row.product_id,
  productId: row.product_id,
  design_code: row.design_code || '',
  designCode: row.design_code || '',
  pattern_type: row.pattern_type || '',
  patternType: row.pattern_type || '',
  pattern_code: row.pattern_code || '',
  patternCode: row.pattern_code || '',
  category_id: row.category_id,
  categoryId: row.category_id,
  category_name: row.category_name,
  categoryName: row.category_name,
  category_slug: row.category_slug,
  categorySlug: row.category_slug,
  parent_category_id: row.parent_category_id,
  parentCategoryId: row.parent_category_id,
  parent_category_name: row.parent_category_name,
  parentCategoryName: row.parent_category_name,
  parent_category_slug: row.parent_category_slug,
  parentCategorySlug: row.parent_category_slug,
  category_path: row.category_path,
  categoryPath: row.category_path,
  size: cleanValue(row.size),
  color: cleanValue(row.color || row.colour),
  colour: cleanValue(row.colour || row.color),
  barcode: row.barcode || '',
  ean_code: row.ean_code || row.barcode || '',
  eanCode: row.ean_code || row.barcode || '',
  mrp: row.mrp,
  original_price: row.original_price,
  original_price_b2c: row.original_price_b2c,
  original_price_b2b: row.original_price_b2b,
  base_sale_price: row.base_sale_price,
  original_sale_price: row.original_sale_price,
  sale_price: row.sale_price,
  price: row.price,
  selling_price: row.selling_price,
  final_price: row.final_price,
  discounted_price: row.discounted_price,
  mahaveer_price: row.mahaveer_price,
  cost_price: row.cost_price,
  b2c_discount_pct: row.b2c_discount_pct,
  b2cDiscountPct: row.b2c_discount_pct,
  b2b_discount_pct: row.b2b_discount_pct,
  b2bDiscountPct: row.b2b_discount_pct,
  discount_b2c: row.discount_b2c,
  discount_b2b: row.discount_b2b,
  discount: row.discount,
  discount_percentage: row.discount_percentage,
  discount_percent: row.discount_percent,
  final_price_b2c: row.final_price_b2c,
  final_price_b2b: row.final_price_b2b,
  b2c_final_price: row.b2c_final_price,
  b2b_final_price: row.b2b_final_price,
  on_hand: row.on_hand,
  onHand: row.on_hand,
  reserved: row.reserved,
  available_qty: row.available_qty,
  availableQty: row.available_qty,
  total_count: row.total_count,
  totalCount: row.total_count,
  in_stock: row.in_stock,
  inStock: row.in_stock,
  image_url: row.image_url,
  imageUrl: row.image_url,
  front_image_url: row.front_image_url || row.image_url || '',
  frontImageUrl: row.front_image_url || row.image_url || '',
  back_image_url: row.back_image_url || '',
  backImageUrl: row.back_image_url || '',
  main_image_url: row.main_image_url || row.image_url || '',
  mainImageUrl: row.main_image_url || row.image_url || '',
  images: Array.isArray(row.images) ? row.images.filter(Boolean) : [row.front_image_url || row.image_url, row.back_image_url].filter(Boolean)
})

const groupProductRows = (rows, { includeGroupedValues = false } = {}) => {
  const groups = new Map()

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!includeGroupedValues && (hasGroupedVariantValue(row.size) || hasGroupedVariantValue(row.color || row.colour))) continue

    const key = normalizeDesignCode(row.design_code) || `PRODUCT-${row.product_id}`

    if (!groups.has(key)) {
      groups.set(key, {
        product_id: row.product_id,
        product_name: row.product_name,
        brand: row.brand,
        brand_name: row.brand_name || row.brand,
        gender: row.gender,
        design_code: row.design_code || '',
        pattern_type: row.pattern_type || '',
        pattern_code: row.pattern_code || '',
        fit_type: row.fit_type || null,
        mark_code: row.mark_code || null,
        category_id: row.category_id,
        category_name: row.category_name,
        category_slug: row.category_slug,
        parent_category_id: row.parent_category_id,
        parent_category_name: row.parent_category_name,
        parent_category_slug: row.parent_category_slug,
        category_path: row.category_path,
        variants: [],
        _rows: []
      })
    }

    const group = groups.get(key)

    if (!group.variants.some(v => String(v.variant_id) === String(row.variant_id))) {
      group.variants.push(makeVariantPayload(row))
    }

    group._rows.push(row)
  }

  const out = []

  for (const group of groups.values()) {
    group.variants.sort((a, b) => {
      const colorCompare = String(a.color || '').localeCompare(String(b.color || ''), undefined, { numeric: true })
      if (colorCompare !== 0) return colorCompare
      return String(a.size || '').localeCompare(String(b.size || ''), undefined, { numeric: true })
    })

    const rowsSorted = group._rows.slice().sort((a, b) => {
      const aq = toNumber(a.available_qty)
      const bq = toNumber(b.available_qty)

      if (bq !== aq) return bq - aq

      return String(a.variant_id).localeCompare(String(b.variant_id), undefined, { numeric: true })
    })

    const selected = rowsSorted[0] || group._rows[0] || {}
    const imageRow = selected || group._rows.find(r => r.image_url) || {}
    const sizes = sortVariantValues(group.variants.map(v => v.size))
    const colors = sortVariantValues(group.variants.map(v => v.color))
    const barcodes = uniqueValues(group.variants.map(v => v.barcode || v.ean_code))
    const totalOnHand = group.variants.reduce((sum, v) => sum + toNumber(v.on_hand), 0)
    const totalReserved = group.variants.reduce((sum, v) => sum + toNumber(v.reserved), 0)
    const totalAvailable = group.variants.reduce((sum, v) => sum + toNumber(v.available_qty), 0)
    const selectedVariant = group.variants.find(v => String(v.variant_id) === String(selected.variant_id)) || group.variants[0] || {}

    out.push({
      id: group.product_id,
      product_id: group.product_id,
      productId: group.product_id,
      primary_variant_id: selectedVariant.variant_id,
      primaryVariantId: selectedVariant.variant_id,
      variant_id: selectedVariant.variant_id,
      variantId: selectedVariant.variant_id,
      product_name: group.product_name,
      productName: group.product_name,
      name: group.product_name,
      title: group.product_name,
      brand: group.brand,
      brand_name: group.brand_name,
      brandName: group.brand_name,
      gender: group.gender,
      category: group.gender,
      category_id: group.category_id,
      categoryId: group.category_id,
      category_name: group.category_name,
      categoryName: group.category_name,
      category_slug: group.category_slug,
      categorySlug: group.category_slug,
      parent_category_id: group.parent_category_id,
      parentCategoryId: group.parent_category_id,
      parent_category_name: group.parent_category_name,
      parentCategoryName: group.parent_category_name,
      parent_category_slug: group.parent_category_slug,
      parentCategorySlug: group.parent_category_slug,
      category_path: group.category_path,
      categoryPath: group.category_path,
      design_code: group.design_code,
      designCode: group.design_code,
      group_key: group.design_code || `PRODUCT-${group.product_id}`,
      groupKey: group.design_code || `PRODUCT-${group.product_id}`,
      pattern_type: group.pattern_type,
      patternType: group.pattern_type,
      pattern_code: group.pattern_code,
      patternCode: group.pattern_code,
      fit_type: group.fit_type,
      fitType: group.fit_type,
      mark_code: group.mark_code,
      markCode: group.mark_code,
      size: selectedVariant.size || '',
      color: selectedVariant.color || '',
      colour: selectedVariant.color || '',
      size_summary: sizes.join(', '),
      color_summary: colors.join(', '),
      colour_summary: colors.join(', '),
      display_size: sizes.join(', '),
      display_color: colors.join(', '),
      sizes,
      colors,
      colours: colors,
      barcodes,
      ean_codes: barcodes,
      eanCodes: barcodes,
      barcode: selectedVariant.barcode || '',
      ean_code: selectedVariant.ean_code || selectedVariant.barcode || '',
      eanCode: selectedVariant.ean_code || selectedVariant.barcode || '',
      mrp: selectedVariant.mrp,
      original_price: selectedVariant.original_price,
      original_price_b2c: selectedVariant.original_price_b2c,
      original_price_b2b: selectedVariant.original_price_b2b,
      base_sale_price: selectedVariant.base_sale_price,
      original_sale_price: selectedVariant.original_sale_price,
      sale_price: selectedVariant.sale_price,
      price: selectedVariant.price,
      selling_price: selectedVariant.selling_price,
      final_price: selectedVariant.final_price,
      discounted_price: selectedVariant.discounted_price,
      mahaveer_price: selectedVariant.mahaveer_price,
      cost_price: selectedVariant.cost_price,
      b2c_discount_pct: selectedVariant.b2c_discount_pct,
      b2b_discount_pct: selectedVariant.b2b_discount_pct,
      discount_b2c: selectedVariant.discount_b2c,
      discount_b2b: selectedVariant.discount_b2b,
      discount: selectedVariant.discount,
      discount_percentage: selectedVariant.discount_percentage,
      discount_percent: selectedVariant.discount_percent,
      final_price_b2c: selectedVariant.final_price_b2c,
      final_price_b2b: selectedVariant.final_price_b2b,
      b2c_final_price: selectedVariant.b2c_final_price,
      b2b_final_price: selectedVariant.b2b_final_price,
      on_hand: totalOnHand,
      reserved: totalReserved,
      available_qty: totalAvailable,
      total_count: totalOnHand,
      in_stock: totalAvailable > 0,
      image_url: selectedVariant.image_url || imageRow.image_url || '',
      imageUrl: selectedVariant.image_url || imageRow.image_url || '',
      front_image_url: selectedVariant.front_image_url || selectedVariant.image_url || imageRow.front_image_url || imageRow.image_url || '',
      frontImageUrl: selectedVariant.front_image_url || selectedVariant.image_url || imageRow.front_image_url || imageRow.image_url || '',
      back_image_url: selectedVariant.back_image_url || imageRow.back_image_url || '',
      backImageUrl: selectedVariant.back_image_url || imageRow.back_image_url || '',
      main_image_url: selectedVariant.main_image_url || selectedVariant.image_url || imageRow.main_image_url || imageRow.image_url || '',
      mainImageUrl: selectedVariant.main_image_url || selectedVariant.image_url || imageRow.main_image_url || imageRow.image_url || '',
      images: Array.isArray(selectedVariant.images) ? selectedVariant.images.filter(Boolean) : [selectedVariant.front_image_url || selectedVariant.image_url || imageRow.image_url, selectedVariant.back_image_url || imageRow.back_image_url].filter(Boolean),
      variant_count: group.variants.length,
      variantCount: group.variants.length,
      variants: group.variants
    })
  }

  return out
}

const addCategoryFilter = ({ req, params, where }) => {
  const categoryId = parsePositiveInt(req.query.category_id || req.query.categoryId)
  const categoryPath = cleanValue(req.query.category_path || req.query.categoryPath || '')
  const categorySlug = cleanValue(req.query.category_slug || req.query.categorySlug || '')

  if (categoryId) {
    params.push(categoryId)
    const categoryIndex = params.length

    where += ` AND p.category_id IN (
      WITH RECURSIVE cats AS (
        SELECT id
        FROM product_categories
        WHERE id = $${categoryIndex}
          AND is_active = TRUE

        UNION ALL

        SELECT pc.id
        FROM product_categories pc
        JOIN cats c
          ON pc.parent_id = c.id
        WHERE pc.is_active = TRUE
      )
      SELECT id
      FROM cats
    )`
  } else if (categoryPath) {
    params.push(categoryPath)
    const categoryPathIndex = params.length

    where += ` AND p.category_id IN (
      WITH RECURSIVE filter_paths AS (
        SELECT
          c.id,
          c.parent_id,
          c.name::text AS category_path
        FROM product_categories c
        WHERE c.parent_id IS NULL
          AND c.is_active = TRUE

        UNION ALL

        SELECT
          c.id,
          c.parent_id,
          filter_paths.category_path || ' > ' || c.name
        FROM product_categories c
        JOIN filter_paths
          ON filter_paths.id = c.parent_id
        WHERE c.is_active = TRUE
      ),
      matched AS (
        SELECT id
        FROM filter_paths
        WHERE LOWER(category_path) = LOWER($${categoryPathIndex})
      ),
      cats AS (
        SELECT id
        FROM matched

        UNION ALL

        SELECT pc.id
        FROM product_categories pc
        JOIN cats c
          ON pc.parent_id = c.id
        WHERE pc.is_active = TRUE
      )
      SELECT id
      FROM cats
    )`
  } else if (categorySlug) {
    params.push(categorySlug)
    const categorySlugIndex = params.length

    where += ` AND p.category_id IN (
      WITH RECURSIVE cats AS (
        SELECT id
        FROM product_categories
        WHERE LOWER(slug) = LOWER($${categorySlugIndex})
          AND is_active = TRUE

        UNION

        SELECT pc.id
        FROM product_categories pc
        JOIN cats c
          ON pc.parent_id = c.id
        WHERE pc.is_active = TRUE
      )
      SELECT id
      FROM cats
    )`
  }

  return where
}

const fetchProducts = async ({ req, gender, category, brand, q, id, productId, variantId, limit, offset, random, hasImage }) => {
  const params = []
  const includeGroupedValues = String(req.query.include_grouped_values || req.query.includeGroupedValues || '').trim().toLowerCase() === 'true'
  const includeOutOfStock = String(req.query.include_out_of_stock || req.query.includeOutOfStock || '').trim().toLowerCase() === 'true'
  let where = productWhere({ includeGroupedValues, includeOutOfStock })
  const genderQ = toGender(gender || category || '')

  if (genderQ) {
    params.push(genderQ)
    where += ` AND p.gender = $${params.length}`
  }

  where = addCategoryFilter({ req, params, where })

  if (brand) {
    params.push(`%${String(brand).trim()}%`)
    where += ` AND p.brand_name ILIKE $${params.length}`
  }

  if (id) {
    params.push(id)
    where += ` AND (p.id = $${params.length} OR v.id = $${params.length})`
  }

  if (productId) {
    params.push(productId)
    where += ` AND p.id = $${params.length}`
  }

  if (variantId) {
    params.push(variantId)
    where += ` AND v.id = $${params.length}`
  }

  const qRaw = String(q || '').trim()
  const tokens = normalizeText(qRaw).split(' ').filter(t => t && !STOPWORDS.has(t))

  if (tokens.length) {
    const parts = []

    for (const t of tokens) {
      params.push(`%${t}%`)
      const idx = params.length
      parts.push(`(p.name ILIKE $${idx} OR p.brand_name ILIKE $${idx} OR p.design_code ILIKE $${idx} OR p.pattern_type ILIKE $${idx} OR p.pattern_code ILIKE $${idx} OR v.colour ILIKE $${idx} OR p.gender ILIKE $${idx} OR c.name ILIKE $${idx} OR pc.name ILIKE $${idx} OR cp.category_path ILIKE $${idx})`)
    }

    where += ` AND (${parts.join(' OR ')})`
  }

  const designCodeFilter = normalizeDesignCode(req.query.design_code || req.query.designCode || '')
  const patternTypeFilter = normalizePatternType(req.query.pattern_type || req.query.patternType || '')

  if (designCodeFilter) {
    params.push(designCodeFilter)
    where += ` AND UPPER(TRIM(COALESCE(p.design_code, ''))) = $${params.length}`
  }

  if (patternTypeFilter) {
    params.push(patternTypeFilter)
    where += ` AND UPPER(TRIM(COALESCE(p.pattern_type, ''))) = $${params.length}`
  }

  if (hasImage) {
    where = `(${where}) AND ((NULLIF(v.image_url,'') IS NOT NULL AND v.image_url NOT LIKE '/images/%') OR (NULLIF(pi_front.image_url,'') IS NOT NULL AND pi_front.image_url NOT LIKE '/images/%') OR COALESCE(bc_self.ean_code, '') <> '')`
  }

  const branchId = getBranchIdFromReq(req)
  params.push(branchId)
  const branchIdx = params.length

  const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'digu2krba'
  params.push(cloud)
  const cloudIdx = params.length

  const requestedLimit = String(req.query.all || '').toLowerCase() === 'true' ? '50000' : String(limit || '200')
  const safeLimit = Math.max(1, Math.min(50000, parseInt(requestedLimit, 10)))
  const safeOffset = Math.max(0, parseInt(offset || '0', 10))
  const orderBy = random ? 'ORDER BY RANDOM()' : 'ORDER BY p.id DESC, v.id ASC'

  params.push(safeLimit, safeOffset)
  const limIdx = params.length - 1
  const offIdx = params.length

  const sql = `
    ${buildProductSelectSql({ where, branchIdx, cloudIdx })}
    ${orderBy}
    LIMIT $${limIdx} OFFSET $${offIdx}
  `

  const { rows } = await pool.query(sql, params)
  return groupProductRows(rows, { includeGroupedValues })
}

const resolveVariantForWrite = async ({ client, id, variantIdFromBody, barcodeFromBody, mode = 'auto' }) => {
  const numericId = parseInt(id, 10)
  const bodyVariantId = parseInt(variantIdFromBody || '', 10)
  const barcode = normalizeBarcodeForWrite(barcodeFromBody)

  if (Number.isFinite(bodyVariantId) && bodyVariantId > 0) {
    const byBodyVariant = await client.query(
      `SELECT v.id AS variant_id, v.product_id
       FROM product_variants v
       WHERE v.id = $1
       LIMIT 1`,
      [bodyVariantId]
    )

    if (byBodyVariant.rows.length) return byBodyVariant.rows[0]
  }

  if (barcode) {
    const byBarcode = await client.query(
      `SELECT v.id AS variant_id, v.product_id
       FROM barcodes b
       JOIN product_variants v ON v.id = b.variant_id
       WHERE REGEXP_REPLACE(UPPER(TRIM(b.ean_code)), '[^A-Z0-9._-]', '', 'g') = $1
       ORDER BY b.id ASC
       LIMIT 1`,
      [barcode]
    )

    if (byBarcode.rows.length) return byBarcode.rows[0]
  }

  if (mode === 'variant') {
    const byVariant = await client.query(
      `SELECT v.id AS variant_id, v.product_id
       FROM product_variants v
       WHERE v.id = $1
       LIMIT 1`,
      [numericId]
    )

    if (byVariant.rows.length) return byVariant.rows[0]
  }

  if (mode === 'product' || mode === 'auto') {
    const byProduct = await client.query(
      `SELECT v.id AS variant_id, v.product_id
       FROM product_variants v
       LEFT JOIN barcodes b ON b.variant_id = v.id
       WHERE v.product_id = $1
         AND v.is_active = TRUE
       ORDER BY
         CASE WHEN $2::text <> '' AND REGEXP_REPLACE(UPPER(TRIM(COALESCE(b.ean_code, ''))), '[^A-Z0-9._-]', '', 'g') = $2 THEN 0 ELSE 1 END,
         v.id ASC
       LIMIT 1`,
      [numericId, barcode]
    )

    if (byProduct.rows.length) return byProduct.rows[0]
  }

  return null
}

const getProductCategoryId = async (client, productId) => {
  const { rows } = await client.query(`SELECT category_id FROM products WHERE id = $1 LIMIT 1`, [productId])
  return rows[0]?.category_id || null
}

const validateCategoryForWrite = async (client, categoryId, gender, fallbackProductId) => {
  let id = parsePositiveInt(categoryId)

  if (!id) {
    id = parsePositiveInt(await getProductCategoryId(client, fallbackProductId))
  }

  if (!id) return null

  const { rows } = await client.query(
    `WITH RECURSIVE category_tree AS (
       SELECT
         c.id,
         c.parent_id,
         c.gender,
         c.name,
         c.slug,
         c.level
       FROM product_categories c
       WHERE c.parent_id IS NULL
         AND c.is_active = TRUE

       UNION ALL

       SELECT
         c.id,
         c.parent_id,
         c.gender,
         c.name,
         c.slug,
         c.level
       FROM product_categories c
       JOIN category_tree
         ON category_tree.id = c.parent_id
       WHERE c.is_active = TRUE
     )
     SELECT c.id
     FROM category_tree c
     WHERE c.id = $1
       AND c.gender = $2
       AND NOT EXISTS (
         SELECT 1
         FROM product_categories child
         WHERE child.parent_id = c.id
           AND child.is_active = TRUE
       )
     LIMIT 1`,
    [id, gender]
  )

  return rows[0]?.id || null
}

const saveProductImage = async (client, eanCode, imageUrl, imageType = 'front') => {
  const code = normalizeBarcodeForWrite(eanCode)
  const url = cleanValue(imageUrl)
  const type = cleanValue(imageType) || 'front'

  if (!code || !url || url.startsWith('/images/')) return

  try {
    await client.query(
      `INSERT INTO product_images (ean_code, image_type, image_url, public_id, uploaded_at)
       VALUES ($1, $2, $3, NULL, NOW())
       ON CONFLICT (ean_code, image_type)
       DO UPDATE SET image_url = EXCLUDED.image_url,
                     uploaded_at = NOW()`,
      [code, type, url]
    )
  } catch {}
}

const updateVariantRecord = async ({ client, req, id, body, mode = 'auto' }) => {
  const nextCategory = body?.category || body?.gender
  const nextBrand = cleanValue(body?.brand || body?.brand_name)
  const nextName = cleanValue(body?.product_name || body?.name || body?.title)
  const nextColor = cleanValue(body?.color || body?.colour)
  const nextSize = cleanValue(body?.size)

  const resolved = await resolveVariantForWrite({
    client,
    id,
    variantIdFromBody: body?.variant_id || body?.variantId || body?.product_variant_id,
    barcodeFromBody: body?.ean_code || body?.eanCode || body?.barcode,
    mode
  })

  if (!resolved) return { status: 404, payload: { message: 'Product not found' } }

  const productId = resolved.product_id
  const variantId = resolved.variant_id
  const gender = toGender(nextCategory)

  if (!gender) return { status: 400, payload: { message: 'Invalid category. Use Men, Women, or Kids' } }

  const categoryId = await validateCategoryForWrite(client, body?.category_id || body?.categoryId, gender, productId)

  if (!categoryId) return { status: 400, payload: { message: 'Valid active leaf sub-category is required' } }

  if (!nextName || !nextBrand || !nextSize || !nextColor) {
    return { status: 400, payload: { message: 'Product name, brand, color and size are required' } }
  }

  if (hasGroupedVariantValue(nextSize) || hasGroupedVariantValue(nextColor)) {
    return { status: 400, payload: { message: 'Size and color must be one value only. Do not send grouped summary values.' } }
  }

  const originalB2C = toNumber(body?.original_price_b2c ?? body?.b2c_original_price ?? body?.original_price ?? body?.mrp ?? body?.price)
  const originalB2B = toNumber(body?.original_price_b2b ?? body?.b2b_original_price ?? body?.cost_price ?? originalB2C)
  const b2cDiscount = clampDiscount(body?.discount_b2c ?? body?.b2c_discount ?? body?.b2c_discount_pct ?? body?.discount_percentage ?? body?.discount_percent ?? body?.discount)
  const b2bDiscount = clampDiscount(body?.discount_b2b ?? body?.b2b_discount ?? body?.b2b_discount_pct ?? body?.discount_percentage_b2b)
  const finalB2C = calcDiscountedPrice(originalB2C, b2cDiscount)
  const stockCount = Math.max(0, parseInt(body?.total_count ?? body?.stock ?? body?.quantity ?? body?.on_hand ?? 0, 10) || 0)
  const imageUrl = cleanValue(body?.front_image_url || body?.frontImageUrl || body?.image_url || body?.image || body?.imageUrl) || null
  const backImageUrl = cleanValue(body?.back_image_url || body?.backImageUrl) || null

  const barcodeRow = await client.query(
    `SELECT ean_code
     FROM barcodes
     WHERE variant_id = $1
     ORDER BY id ASC
     LIMIT 1`,
    [variantId]
  )

  const eanCode = normalizeBarcodeForWrite(body?.ean_code || body?.eanCode || body?.barcode || barcodeRow.rows[0]?.ean_code || '')

  const productMetadata = await client.query(
    `SELECT design_code, pattern_type, pattern_code
     FROM products
     WHERE id = $1
     LIMIT 1`,
    [productId]
  )

  const existingMetadata = productMetadata.rows[0] || {}
  const requestedDesignCode = normalizeDesignCode(body?.design_code || body?.designCode || '')
  const existingDesignCode = normalizeDesignCode(existingMetadata.design_code || '')

  if (requestedDesignCode && requestedDesignCode !== existingDesignCode) {
    return { status: 409, payload: { message: 'design_code cannot be changed through the product update endpoint' } }
  }

  const hasPatternType = Object.prototype.hasOwnProperty.call(body || {}, 'pattern_type') || Object.prototype.hasOwnProperty.call(body || {}, 'patternType')
  const nextPatternType = hasPatternType
    ? normalizePatternType(body?.pattern_type ?? body?.patternType) || null
    : existingMetadata.pattern_type || null

  await client.query(
    `UPDATE products
     SET name = $1,
         brand_name = $2,
         gender = $3,
         category_id = $4,
         pattern_type = $5,
         updated_at = NOW()
     WHERE id = $6`,
    [nextName, nextBrand, gender, categoryId, nextPatternType, productId]
  )

  await client.query(
    `UPDATE product_variants
     SET colour = $1,
         size = $2,
         mrp = $3,
         sale_price = $4,
         cost_price = $5,
         b2b_discount_pct = $6,
         b2c_discount_pct = $7,
         image_url = $8,
         is_active = TRUE,
         updated_at = NOW()
     WHERE id = $9`,
    [nextColor, nextSize, originalB2C, finalB2C, originalB2B, b2bDiscount, b2cDiscount, imageUrl, variantId]
  )

  if (eanCode) {
    await client.query(
      `INSERT INTO barcodes (variant_id, ean_code)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1
         FROM barcodes
         WHERE REGEXP_REPLACE(UPPER(TRIM(ean_code)), '[^A-Z0-9._-]', '', 'g') = $2
       )`,
      [variantId, eanCode]
    )
  }

  const branchId = getBranchIdFromReq(req)

  if (branchId) {
    await client.query(
      `INSERT INTO branch_variant_stock (variant_id, branch_id, on_hand, reserved, is_active)
       VALUES ($1, $2, $3, 0, TRUE)
       ON CONFLICT (branch_id, variant_id)
       DO UPDATE SET on_hand = EXCLUDED.on_hand,
                     is_active = TRUE,
                     updated_at = NOW()`,
      [variantId, branchId, stockCount]
    )
  }

  await saveProductImage(client, eanCode, imageUrl, 'front')
  await saveProductImage(client, eanCode, backImageUrl, 'back')

  return {
    status: 200,
    productId,
    variantId,
    fallback: {
      id: productId,
      product_id: productId,
      variant_id: variantId,
      barcode: eanCode,
      ean_code: eanCode,
      category: gender,
      gender,
      category_id: categoryId,
      design_code: existingMetadata.design_code || '',
      designCode: existingMetadata.design_code || '',
      pattern_type: nextPatternType || '',
      patternType: nextPatternType || '',
      pattern_code: existingMetadata.pattern_code || '',
      patternCode: existingMetadata.pattern_code || '',
      brand: nextBrand,
      brand_name: nextBrand,
      product_name: nextName,
      name: nextName,
      color: nextColor,
      colour: nextColor,
      size: nextSize,
      mrp: originalB2C,
      sale_price: finalB2C,
      price: finalB2C,
      final_price_b2c: finalB2C,
      discount_b2c: b2cDiscount,
      b2c_discount_pct: b2cDiscount,
      discount_b2b: b2bDiscount,
      b2b_discount_pct: b2bDiscount,
      total_count: stockCount,
      available_qty: stockCount,
      image_url: imageUrl,
      back_image_url: backImageUrl,
      images: [imageUrl, backImageUrl].filter(Boolean)
    }
  }
}

const deleteVariantById = async ({ client, req, variantId }) => {
  const branchId = getBranchIdFromReq(req)

  const existingVariant = await client.query(
    `SELECT id, product_id, size, colour
     FROM product_variants
     WHERE id = $1
     LIMIT 1`,
    [variantId]
  )

  if (!existingVariant.rows.length) return { status: 404, payload: { message: 'Variant not found' } }

  if (branchId) {
    await client.query(
      `UPDATE branch_variant_stock
       SET is_active = FALSE,
           on_hand = 0,
           updated_at = NOW()
       WHERE variant_id = $1
         AND branch_id = $2`,
      [variantId, branchId]
    )

    const activeStock = await client.query(
      `SELECT 1
       FROM branch_variant_stock
       WHERE variant_id = $1
         AND is_active = TRUE
         AND on_hand > 0
       LIMIT 1`,
      [variantId]
    )

    if (!activeStock.rows.length) {
      await client.query(`UPDATE product_variants SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [variantId])
    }
  } else {
    await client.query(`UPDATE product_variants SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [variantId])
    await client.query(
      `UPDATE branch_variant_stock
       SET is_active = FALSE,
           on_hand = 0,
           updated_at = NOW()
       WHERE variant_id = $1`,
      [variantId]
    )
  }

  return {
    status: 200,
    payload: {
      message: 'Variant deleted successfully',
      variant_id: variantId,
      product_id: existingVariant.rows[0].product_id,
      size: existingVariant.rows[0].size,
      colour: existingVariant.rows[0].colour
    }
  }
}

router.get('/', async (req, res) => {
  try {
    noStore(res)

    const rows = await fetchProducts({
      req,
      gender: req.query.gender,
      category: req.query.category,
      brand: req.query.brand,
      q: req.query.q,
      limit: req.query.all === 'true' ? '50000' : req.query.limit || '200',
      offset: req.query.offset || '0',
      random: String(req.query.random || '').trim() === '1',
      hasImage: String(req.query.hasImage || '').toLowerCase() === 'true'
    })

    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/suggest', async (req, res) => {
  try {
    noStore(res)

    const qRaw = String(req.query.q || '').trim()
    if (!qRaw || qRaw.length < 1) return res.json([])

    const rows = await fetchProducts({
      req,
      gender: req.query.gender,
      category: req.query.category,
      q: qRaw,
      limit: '1000',
      offset: '0',
      random: false,
      hasImage: false
    })

    const suggestions = []
    const seen = new Set()

    for (const row of rows) {
      const values = [
        row.product_name,
        row.brand,
        row.color,
        row.category_name,
        row.parent_category_name,
        row.category_path,
        row.gender ? `${row.gender} ${row.product_name}` : ''
      ]

      for (const value of values) {
        const v = cleanValue(value)
        const k = v.toLowerCase()

        if (v && !seen.has(k)) {
          seen.add(k)
          suggestions.push(v)
        }

        if (suggestions.length >= 12) break
      }

      if (suggestions.length >= 12) break
    }

    res.json(suggestions)
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/category/:category', async (req, res) => {
  try {
    noStore(res)

    const rows = await fetchProducts({
      req,
      category: req.params.category,
      limit: req.query.limit || '50000',
      offset: req.query.offset || '0',
      random: String(req.query.random || '').trim() === '1',
      hasImage: String(req.query.hasImage || '').toLowerCase() === 'true'
    })

    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/gender/:gender', async (req, res) => {
  try {
    noStore(res)

    const rows = await fetchProducts({
      req,
      gender: req.params.gender,
      limit: req.query.limit || '50000',
      offset: req.query.offset || '0',
      random: String(req.query.random || '').trim() === '1',
      hasImage: String(req.query.hasImage || '').toLowerCase() === 'true'
    })

    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/search', async (req, res) => {
  try {
    noStore(res)

    const queryRaw = req.query.q || req.query.query
    if (!queryRaw || !String(queryRaw).trim()) return res.status(400).json({ message: 'Search query is required' })

    const rows = await fetchProducts({
      req,
      gender: req.query.gender,
      category: req.query.category,
      q: queryRaw,
      limit: req.query.limit || '2000',
      offset: req.query.offset || '0',
      random: false,
      hasImage: false
    })

    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: 'Error searching products', error: err.message })
  }
})

router.get('/hero-images', async (req, res) => {
  try {
    noStore(res)

    const rows = await fetchProducts({
      req,
      limit: req.query.limit || '60',
      offset: '0',
      random: true,
      hasImage: true
    })

    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/section-images', async (req, res) => {
  try {
    noStore(res)

    const limitHero = Math.max(1, Math.min(120, parseInt(req.query.limitHero || '30', 10)))
    const limitGender = Math.max(1, Math.min(80, parseInt(req.query.limitGender || '40', 10)))

    const hero = await fetchProducts({ req, limit: String(limitHero), offset: '0', random: true, hasImage: true })
    const women = await fetchProducts({ req, gender: 'WOMEN', limit: String(limitGender), offset: '0', random: true, hasImage: true })
    const men = await fetchProducts({ req, gender: 'MEN', limit: String(limitGender), offset: '0', random: true, hasImage: true })
    const kids = await fetchProducts({ req, gender: 'KIDS', limit: String(limitGender), offset: '0', random: true, hasImage: true })

    res.json({ hero, women, men, kids })
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.delete('/variant/:variantId(\\d+)', async (req, res) => {
  const client = await pool.connect()

  try {
    noStore(res)

    const variantId = parseInt(req.params.variantId, 10)
    if (!Number.isFinite(variantId) || variantId <= 0) return res.status(400).json({ message: 'Invalid variant id' })

    await client.query('BEGIN')
    const result = await deleteVariantById({ client, req, variantId })

    if (result.status !== 200) {
      await client.query('ROLLBACK')
      return res.status(result.status).json(result.payload)
    }

    await client.query('COMMIT')
    return res.json(result.payload)
  } catch (err) {
    await client.query('ROLLBACK')
    return res.status(500).json({ message: 'Error deleting variant', error: err.message })
  } finally {
    client.release()
  }
})

const updateVariantHandler = async (req, res) => {
  const client = await pool.connect()

  try {
    noStore(res)

    const variantId = parseInt(req.params.variantId, 10)
    if (!Number.isFinite(variantId) || variantId <= 0) return res.status(400).json({ message: 'Invalid variant id' })

    await client.query('BEGIN')

    const result = await updateVariantRecord({
      client,
      req,
      id: variantId,
      body: { ...(req.body || {}), variant_id: variantId },
      mode: 'variant'
    })

    if (result.status !== 200) {
      await client.query('ROLLBACK')
      return res.status(result.status).json(result.payload)
    }

    await client.query('COMMIT')

    const rows = await fetchProducts({
      req,
      productId: result.productId,
      variantId: result.variantId,
      limit: '500',
      offset: '0',
      random: false,
      hasImage: false
    })

    return res.json(rows[0] || result.fallback)
  } catch (err) {
    await client.query('ROLLBACK')
    return res.status(500).json({ message: 'Error updating variant', error: err.message })
  } finally {
    client.release()
  }
}

router.put('/variant/:variantId(\\d+)', updateVariantHandler)
router.patch('/variant/:variantId(\\d+)', updateVariantHandler)

const updateBarcodeHandler = async (req, res) => {
  const client = await pool.connect()

  try {
    noStore(res)

    const barcode = normalizeBarcodeForWrite(req.params.barcode)
    if (!barcode) return res.status(400).json({ message: 'Invalid barcode' })

    await client.query('BEGIN')

    const result = await updateVariantRecord({
      client,
      req,
      id: 0,
      body: { ...(req.body || {}), barcode, ean_code: barcode },
      mode: 'auto'
    })

    if (result.status !== 200) {
      await client.query('ROLLBACK')
      return res.status(result.status).json(result.payload)
    }

    await client.query('COMMIT')

    const rows = await fetchProducts({
      req,
      productId: result.productId,
      variantId: result.variantId,
      limit: '500',
      offset: '0',
      random: false,
      hasImage: false
    })

    return res.json(rows[0] || result.fallback)
  } catch (err) {
    await client.query('ROLLBACK')
    return res.status(500).json({ message: 'Error updating barcode product', error: err.message })
  } finally {
    client.release()
  }
}

router.put('/barcode/:barcode', updateBarcodeHandler)
router.patch('/barcode/:barcode', updateBarcodeHandler)

router.get('/:id(\\d+)', async (req, res) => {
  try {
    noStore(res)

    const rows = await fetchProducts({
      req,
      id: req.params.id,
      limit: '500',
      offset: '0',
      random: false,
      hasImage: false
    })

    if (!rows.length) return res.status(404).json({ message: 'Not found' })

    res.json(rows[0])
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

const updateProductHandler = async (req, res) => {
  const client = await pool.connect()

  try {
    noStore(res)

    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'Invalid product id' })

    await client.query('BEGIN')

    const result = await updateVariantRecord({
      client,
      req,
      id,
      body: req.body || {},
      mode: 'product'
    })

    if (result.status !== 200) {
      await client.query('ROLLBACK')
      return res.status(result.status).json(result.payload)
    }

    await client.query('COMMIT')

    const rows = await fetchProducts({
      req,
      productId: result.productId,
      variantId: result.variantId,
      limit: '500',
      offset: '0',
      random: false,
      hasImage: false
    })

    return res.json(rows[0] || result.fallback)
  } catch (err) {
    await client.query('ROLLBACK')
    return res.status(500).json({ message: 'Error updating product', error: err.message })
  } finally {
    client.release()
  }
}

router.put('/:id(\\d+)', updateProductHandler)
router.patch('/:id(\\d+)', updateProductHandler)

router.delete('/:id(\\d+)', async (req, res) => {
  const client = await pool.connect()

  try {
    noStore(res)

    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'Invalid product id' })

    const scope = String(req.query.scope || req.query.type || '').trim().toLowerCase()

    await client.query('BEGIN')

    if (scope === 'variant') {
      const result = await deleteVariantById({ client, req, variantId: id })

      if (result.status !== 200) {
        await client.query('ROLLBACK')
        return res.status(result.status).json(result.payload)
      }

      await client.query('COMMIT')
      return res.json(result.payload)
    }

    const product = await client.query(`SELECT id FROM products WHERE id = $1 LIMIT 1`, [id])

    if (product.rows.length) {
      const variants = await client.query(`SELECT id FROM product_variants WHERE product_id = $1`, [id])
      const variantIds = variants.rows.map(r => r.id)

      await client.query(`UPDATE product_variants SET is_active = FALSE, updated_at = NOW() WHERE product_id = $1`, [id])

      if (variantIds.length) {
        await client.query(
          `UPDATE branch_variant_stock
           SET is_active = FALSE,
               on_hand = 0,
               updated_at = NOW()
           WHERE variant_id = ANY($1::int[])`,
          [variantIds]
        )
      }

      await client.query('COMMIT')

      return res.json({
        message: 'Product deleted successfully',
        id,
        product_id: id,
        deleted_variants: variantIds
      })
    }

    const result = await deleteVariantById({ client, req, variantId: id })

    if (result.status !== 200) {
      await client.query('ROLLBACK')
      return res.status(result.status).json({ message: 'Product not found' })
    }

    await client.query('COMMIT')
    return res.json(result.payload)
  } catch (err) {
    await client.query('ROLLBACK')
    return res.status(500).json({ message: 'Error deleting product', error: err.message })
  } finally {
    client.release()
  }
})

module.exports = router
