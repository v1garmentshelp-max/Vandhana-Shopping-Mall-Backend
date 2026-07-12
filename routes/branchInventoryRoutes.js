const express = require('express')
const multer = require('multer')
const XLSX = require('xlsx')
const pool = require('../db')

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } })
const PROCESS_MAX_LIMIT = 250
const INSERT_CHUNK_SIZE = 500

const HEADER_ALIASES = {
  productname: ['product', 'product name', 'item', 'item name', 'productname'],
  brandname: ['brand', 'brand name', 'brandname'],
  costprice: ['cost', 'purchase cost', 'costprice'],
  purchaseqty: ['clqty', 'qty', 'quantity', 'purchase qty', 'purchaseqty'],
  barcode: ['barcode', 'bar code', 'bar-code', 'barcode number', 'barcode no', 'sku', 'sku code', 'ean', 'ean code', 'eancode'],
  mrp: ['mrp', '   mrp', 'mrp ', ' retail mrp ', 'mrp'],
  rsaleprice: ['retailprice', 'saleprice', 'sale price', 'retail price', 'rsp', 'rsaleprice'],
  markcode: ['mark code', 'mark', 'marking', 'markcode'],
  size: ['size', 'size '],
  colour: ['colour', 'color', 'colour ', 'color '],
  pattern: ['pattern code', 'style', 'style code', 'pattern'],
  fitt: ['fit', 'fit type', 'fitt'],
  b2cdiscount: ['b2cdiscount', 'b2c discount', 'discount_b2c', 'b2c disc', 'b2c_disc'],
  b2bdiscount: ['b2bdiscount', 'b2b discount', 'discount_b2b', 'b2b disc', 'b2b_disc']
}

function parseBranchId(req) {
  const n = parseInt(req.params.branchId, 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

function parsePositiveInt(v) {
  const n = parseInt(v, 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function ensureBranchExists(branchId) {
  const { rows } = await pool.query('SELECT id FROM branches WHERE id = $1 LIMIT 1', [branchId])
  return rows.length > 0
}

function cleanText(v) {
  if (v == null) return ''
  return String(v).replace(/\s+/g, ' ').trim()
}

function normalizeBarcode(v) {
  return String(v ?? '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, '')
}

function normalizeImageType(v) {
  const s = String(v || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '')
  if (s.includes('front')) return 'front'
  if (s.includes('back')) return 'back'
  if (s.includes('main')) return 'main'
  return s || 'main'
}

function baseNameNoExt(name) {
  const n = String(name || '').split('/').pop() || String(name || '')
  const i = n.lastIndexOf('.')
  return i > 0 ? n.slice(0, i) : n
}

function extractBarcodeFromName(name) {
  const base = baseNameNoExt(name)
  if (base.includes('__')) return normalizeBarcode(base.split('__')[0])
  const dotMatch = base.match(/^(.+)\.(front|back|main)$/i)
  if (dotMatch) return normalizeBarcode(dotMatch[1])
  return normalizeBarcode(base)
}

function extractImageTypeFromName(name) {
  const base = baseNameNoExt(name)
  if (base.includes('__')) return normalizeImageType(base.split('__').slice(1).join('__'))
  const dotMatch = base.match(/^(.+)\.(front|back|main)$/i)
  if (dotMatch) return normalizeImageType(dotMatch[2])
  return 'main'
}

function normalizeRow(raw) {
  const out = {}

  for (const [k, v] of Object.entries(raw || {})) {
    const key = String(k).trim().toLowerCase()
    out[key] = v
  }

  for (const canon of Object.keys(HEADER_ALIASES)) {
    if (out[canon] != null && out[canon] !== '') continue

    for (const alias of HEADER_ALIASES[canon]) {
      const a = String(alias).trim().toLowerCase()

      if (out[a] != null && out[a] !== '') {
        out[canon] = out[a]
        break
      }
    }
  }

  if (!out.productname && raw && raw.__EMPTY) out.productname = raw.__EMPTY
  if (!out.brandname && raw && raw.__EMPTY_1) out.brandname = raw.__EMPTY_1
  if (out.purchaseqty == null && raw && raw.__EMPTY_2 != null) out.purchaseqty = raw.__EMPTY_2
  if (!out.barcode && raw && raw.__EMPTY_3) out.barcode = raw.__EMPTY_3
  if (out.mrp == null && raw && raw.__EMPTY_4 != null) out.mrp = raw.__EMPTY_4
  if (!out.size && raw && raw.__EMPTY_5) out.size = raw.__EMPTY_5
  if (!out.colour && raw && raw.__EMPTY_6) out.colour = raw.__EMPTY_6
  if (!out.pattern && raw && raw.__EMPTY_7) out.pattern = raw.__EMPTY_7

  return out
}

function toNumOrNull(v) {
  if (v === '' || v == null) return null
  const n = parseFloat(String(v).replace(/[₹, ]+/g, ''))
  return Number.isFinite(n) ? n : null
}

function toIntOrZero(v) {
  const n = parseInt(String(v).replace(/[₹, ]+/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}

function normGender(v) {
  const s = String(v || '').trim().toUpperCase()
  if (s === 'MEN' || s === 'WOMEN' || s === 'KIDS') return s
  if (s === 'MAN' || s === 'MALE' || s === 'MENS' || s === "MEN'S") return 'MEN'
  if (s === 'WOMAN' || s === 'FEMALE' || s === 'LADIES' || s === 'WOMENS' || s === "WOMEN'S") return 'WOMEN'
  if (s === 'CHILD' || s === 'CHILDREN' || s === 'BOYS' || s === 'GIRLS' || s === 'KID') return 'KIDS'
  return ''
}

function isSummaryOrBlankRow(raw, ProductName, BrandName, SIZE, COLOUR, row) {
  const summary = cleanText((raw && (raw['Stock Summary'] || raw['stock summary'])) || '')
  const allMainEmpty = !ProductName && !BrandName && !SIZE && !COLOUR
  const hasAnyDataField = cleanText(row.barcode) || toNumOrNull(row.mrp) != null || toNumOrNull(row.rsaleprice) != null || toIntOrZero(row.purchaseqty) !== 0

  if (allMainEmpty && !hasAnyDataField) return true

  const s = summary.toLowerCase()
  if (!summary) return false
  if (s.startsWith('date between')) return true
  if (s.startsWith('| branchs')) return true

  return false
}

function isDefaultText(v) {
  const t = cleanText(v).toLowerCase()
  if (!t) return true

  const badExact = new Set(['brand', 'product', 'new in', 'inclusive of all taxes', '₹0.00', '0', '0.00', '₹0', '₹0.0', '₹0.00'])

  if (badExact.has(t)) return true

  const badContains = ['inclusive of all taxes', 'new in']
  return badContains.some(x => t.includes(x))
}

function shouldSkipBusinessRow(ProductName, BrandName, MRP, RSalePrice) {
  const mrp0 = MRP == null ? null : Number(MRP)
  const sale0 = RSalePrice == null ? null : Number(RSalePrice)
  const bothZero = (mrp0 === 0 || mrp0 === null) && (sale0 === 0 || sale0 === null)

  if (!bothZero) return false
  return isDefaultText(ProductName) || isDefaultText(BrandName)
}

async function ensureImportRowsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_rows (
      id BIGSERIAL PRIMARY KEY,
      import_job_id BIGINT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
      raw_row_json JSONB NOT NULL,
      status_enum TEXT,
      error_msg TEXT
    )
  `)

  await pool.query(`ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await pool.query(`ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS raw_row_json JSONB`)
  await pool.query(`ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS error_msg TEXT`)
  await pool.query(`ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES product_categories(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES product_categories(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES product_categories(id) ON DELETE SET NULL`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_rows_job_status_id ON import_rows(import_job_id, status_enum, id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_jobs_branch_uploaded_id ON import_jobs(branch_id, id DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_jobs_category_id ON import_jobs(category_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_barcodes_variant_id ON barcodes(variant_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_branch_variant_stock_branch_active ON branch_variant_stock(branch_id, is_active, variant_id)`)
}

async function ensureProductImagesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_images (
      id BIGSERIAL PRIMARY KEY,
      ean_code TEXT NOT NULL,
      image_type TEXT NOT NULL,
      image_url TEXT NOT NULL,
      public_id TEXT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS ean_code TEXT`)
  await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS image_type TEXT NOT NULL DEFAULT 'main'`)
  await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS image_url TEXT`)
  await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS public_id TEXT`)
  await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ DEFAULT NOW()`)
  await pool.query(`
    DELETE FROM product_images a
    USING product_images b
    WHERE a.ctid < b.ctid
      AND a.ean_code = b.ean_code
      AND a.image_type = b.image_type
  `)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS product_images_ean_code_image_type_key ON product_images(ean_code, image_type)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_images_ean_code ON product_images(ean_code)`)
}

async function validateCategory(categoryId, gender) {
  const id = parsePositiveInt(categoryId)

  if (!id) return null

  const { rows } = await pool.query(
    `SELECT
       c.id,
       c.parent_id,
       c.gender,
       c.name,
       c.slug,
       c.level,
       CASE
         WHEN p2.id IS NOT NULL THEN p2.name || ' > ' || p.name || ' > ' || c.name
         WHEN p.id IS NOT NULL THEN p.name || ' > ' || c.name
         ELSE c.name
       END AS category_path
     FROM product_categories c
     LEFT JOIN product_categories p ON p.id = c.parent_id
     LEFT JOIN product_categories p2 ON p2.id = p.parent_id
     WHERE c.id = $1
       AND c.is_active = TRUE
       AND c.gender = $2
     LIMIT 1`,
    [id, gender]
  )

  return rows[0] || null
}

function rowToPreparedRecord(raw) {
  const row = normalizeRow(raw)
  const ProductName = cleanText(row.productname)
  const BrandName = cleanText(row.brandname)
  const SIZE = cleanText(row.size)
  const COLOUR = cleanText(row.colour)
  const PATTERN = cleanText(row.pattern) || ''
  const FITT = cleanText(row.fitt) || null
  const MarkCode = cleanText(row.markcode) || null
  const MRP = toNumOrNull(row.mrp)
  const RSalePrice = toNumOrNull(row.rsaleprice)
  const CostPrice = toNumOrNull(row.costprice) ?? 0
  const PurchaseQty = toIntOrZero(row.purchaseqty)
  const B2CDiscount = toNumOrNull(row.b2cdiscount) ?? 0
  const B2BDiscount = toNumOrNull(row.b2bdiscount) ?? 0
  const Barcode = normalizeBarcode(row.barcode)

  return {
    raw,
    ProductName,
    BrandName,
    SIZE,
    COLOUR,
    PATTERN,
    FITT,
    MarkCode,
    MRP,
    RSalePrice,
    CostPrice,
    PurchaseQty,
    B2CDiscount,
    B2BDiscount,
    Barcode
  }
}

function shouldQueueRow(prepared) {
  if (isSummaryOrBlankRow(prepared.raw, prepared.ProductName, prepared.BrandName, prepared.SIZE, prepared.COLOUR, normalizeRow(prepared.raw))) return false
  if (shouldSkipBusinessRow(prepared.ProductName, prepared.BrandName, prepared.MRP, prepared.RSalePrice)) return false
  return true
}

async function getAllowedImportRowStatuses() {
  const sql = `
    SELECT enumlabel
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'import_row_status'
    ORDER BY enumsortorder
  `
  const { rows } = await pool.query(sql)
  return rows.map(r => r.enumlabel)
}

function resolveCreatedStatus(enumValues) {
  if (enumValues.includes('CREATED')) return 'CREATED'
  return null
}

function resolveOkStatus(enumValues) {
  if (enumValues.includes('OK')) return 'OK'
  return null
}

function resolveErrorStatus(enumValues) {
  if (enumValues.includes('ERROR')) return 'ERROR'
  return null
}

async function insertImportRowsInBatches(client, jobId, rows, createdStatus, categoryId) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE)
    const values = []
    const params = []
    let p = 1

    for (const item of chunk) {
      values.push(`($${p++}, $${p++}::jsonb, $${p++}, $${p++}, $${p++})`)
      params.push(jobId, JSON.stringify(item.raw), item.status_enum || createdStatus, item.error_msg || null, categoryId)
    }

    await client.query(
      `INSERT INTO import_rows (import_job_id, raw_row_json, status_enum, error_msg, category_id)
       VALUES ${values.join(',')}`,
      params
    )
  }
}

function toNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function uniqueValues(arr) {
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

function sortVariantValues(arr) {
  return uniqueValues(arr).sort((a, b) => {
    const na = parseFloat(String(a).replace(/[^\d.]/g, ''))
    const nb = parseFloat(String(b).replace(/[^\d.]/g, ''))

    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return String(a).localeCompare(String(b), undefined, { numeric: true })
  })
}

function normalizeImages(images) {
  if (Array.isArray(images)) return images
  if (!images) return []

  try {
    const parsed = JSON.parse(images)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeGroupColour(v) {
  return String(v || '').trim().toUpperCase()
}

function normalizeGroupSize(v) {
  return String(v || '').trim().toUpperCase()
}

function sortRowsForCardSets(rows) {
  return rows.slice().sort((a, b) => {
    const av = toNumber(a.variant_id)
    const bv = toNumber(b.variant_id)

    if (av !== bv) return av - bv

    return String(a.ean_code || a.barcode || '').localeCompare(String(b.ean_code || b.barcode || ''), undefined, { numeric: true })
  })
}

function splitColourRowsIntoCardSets(rows) {
  const bySize = new Map()

  for (const row of rows) {
    const sizeKey = normalizeGroupSize(row.size) || 'NO_SIZE'
    if (!bySize.has(sizeKey)) bySize.set(sizeKey, [])
    bySize.get(sizeKey).push(row)
  }

  for (const [sizeKey, sizeRows] of bySize.entries()) {
    bySize.set(sizeKey, sortRowsForCardSets(sizeRows))
  }

  let maxSetCount = 0

  for (const sizeRows of bySize.values()) {
    if (sizeRows.length > maxSetCount) maxSetCount = sizeRows.length
  }

  const sets = Array.from({ length: Math.max(maxSetCount, 1) }, () => [])

  const orderedSizes = Array.from(bySize.keys()).sort((a, b) => {
    const na = parseFloat(String(a).replace(/[^\d.]/g, ''))
    const nb = parseFloat(String(b).replace(/[^\d.]/g, ''))

    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return String(a).localeCompare(String(b), undefined, { numeric: true })
  })

  for (const sizeKey of orderedSizes) {
    const sizeRows = bySize.get(sizeKey) || []

    for (let i = 0; i < sizeRows.length; i += 1) {
      sets[i].push(sizeRows[i])
    }
  }

  return sets.filter(set => set.length)
}

function makeVariantPayload(row) {
  return {
    id: row.variant_id,
    variant_id: row.variant_id,
    variantId: row.variant_id,
    product_id: row.product_id,
    productId: row.product_id,
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
    size: row.size || '',
    colour: row.colour || '',
    color: row.colour || '',
    barcode: row.barcode || '',
    ean_code: row.ean_code || row.barcode || '',
    eanCode: row.ean_code || row.barcode || '',
    mrp: row.mrp,
    base_sale_price: row.base_sale_price,
    original_sale_price: row.original_sale_price,
    sale_price: row.sale_price,
    price: row.price,
    selling_price: row.selling_price,
    discounted_price: row.discounted_price,
    mahaveer_price: row.mahaveer_price,
    cost_price: row.cost_price,
    b2c_discount_pct: row.b2c_discount_pct,
    b2cDiscountPct: row.b2c_discount_pct,
    b2b_discount_pct: row.b2b_discount_pct,
    b2bDiscountPct: row.b2b_discount_pct,
    discount_b2c: row.b2c_discount_pct,
    discountB2c: row.b2c_discount_pct,
    discount_b2b: row.b2b_discount_pct,
    discountB2b: row.b2b_discount_pct,
    original_price_b2c: row.original_price_b2c,
    originalPriceB2c: row.original_price_b2c,
    final_price_b2c: row.final_price_b2c,
    finalPriceB2c: row.final_price_b2c,
    original_price_b2b: row.original_price_b2b,
    originalPriceB2b: row.original_price_b2b,
    final_price_b2b: row.final_price_b2b,
    finalPriceB2b: row.final_price_b2b,
    on_hand: row.on_hand,
    onHand: row.on_hand,
    reserved: row.reserved,
    available_qty: row.available_qty,
    availableQty: row.available_qty,
    in_stock: row.in_stock,
    inStock: row.in_stock,
    image_url: row.image_url,
    imageUrl: row.image_url,
    front_image_url: row.front_image_url,
    frontImageUrl: row.front_image_url,
    back_image_url: row.back_image_url,
    backImageUrl: row.back_image_url,
    main_image_url: row.main_image_url,
    mainImageUrl: row.main_image_url,
    images: normalizeImages(row.images)
  }
}

function groupStockRows(rows) {
  const productGroups = new Map()

  for (const row of Array.isArray(rows) ? rows : []) {
    const productKey = String(row.product_id)

    if (!productGroups.has(productKey)) {
      productGroups.set(productKey, {
        product_id: row.product_id,
        product_name: row.product_name,
        brand_name: row.brand_name,
        pattern_code: row.pattern_code || '',
        fit_type: row.fit_type || null,
        mark_code: row.mark_code || null,
        gender: row.gender,
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

    const group = productGroups.get(productKey)

    if (!group.variants.some(v => String(v.variant_id) === String(row.variant_id))) {
      group.variants.push(makeVariantPayload(row))
    }

    group._rows.push(row)
  }

  const out = []

  for (const group of productGroups.values()) {
    group.variants.sort((a, b) => {
      const colourCompare = String(a.colour || '').localeCompare(String(b.colour || ''), undefined, { numeric: true })
      if (colourCompare !== 0) return colourCompare
      const sizeCompare = String(a.size || '').localeCompare(String(b.size || ''), undefined, { numeric: true })
      if (sizeCompare !== 0) return sizeCompare
      return String(a.variant_id || '').localeCompare(String(b.variant_id || ''), undefined, { numeric: true })
    })

    const allSizes = sortVariantValues(group.variants.map(v => v.size))
    const allColours = sortVariantValues(group.variants.map(v => v.colour))
    const allBarcodes = uniqueValues(group.variants.map(v => v.barcode || v.ean_code))
    const colourGroups = new Map()

    for (const row of group._rows) {
      const colourKey = normalizeGroupColour(row.colour) || 'NO_COLOUR'

      if (!colourGroups.has(colourKey)) {
        colourGroups.set(colourKey, {
          colour: row.colour || '',
          rows: []
        })
      }

      colourGroups.get(colourKey).rows.push(row)
    }

    for (const colourGroup of colourGroups.values()) {
      const cardSets = splitColourRowsIntoCardSets(colourGroup.rows)

      for (let cardIndex = 0; cardIndex < cardSets.length; cardIndex += 1) {
        const cardRows = cardSets[cardIndex].slice().sort((a, b) => {
          const aq = toNumber(a.available_qty)
          const bq = toNumber(b.available_qty)

          if (bq !== aq) return bq - aq

          return String(a.variant_id).localeCompare(String(b.variant_id), undefined, { numeric: true })
        })

        const selected = cardRows[0] || {}
        const imageRow = cardRows.find(r => r.front_image_url || r.main_image_url || r.image_url) || selected
        const cardVariantIds = new Set(cardRows.map(r => String(r.variant_id)))
        const cardVariants = group.variants.filter(v => cardVariantIds.has(String(v.variant_id)))
        const cardSizes = sortVariantValues(cardVariants.map(v => v.size))
        const cardBarcodes = uniqueValues(cardVariants.map(v => v.barcode || v.ean_code))
        const totalOnHand = cardVariants.reduce((sum, v) => sum + toNumber(v.on_hand), 0)
        const totalReserved = cardVariants.reduce((sum, v) => sum + toNumber(v.reserved), 0)
        const totalAvailable = cardVariants.reduce((sum, v) => sum + toNumber(v.available_qty), 0)
        const selectedColour = colourGroup.colour || selected.colour || ''
        const selectedImages = normalizeImages(imageRow.images)

        out.push({
          id: selected.variant_id || group.product_id,
          product_id: group.product_id,
          productId: group.product_id,
          primary_variant_id: selected.variant_id,
          primaryVariantId: selected.variant_id,
          variant_id: selected.variant_id,
          variantId: selected.variant_id,
          product_name: group.product_name,
          productName: group.product_name,
          name: group.product_name,
          title: group.product_name,
          brand_name: group.brand_name,
          brandName: group.brand_name,
          brand: group.brand_name,
          pattern_code: group.pattern_code,
          patternCode: group.pattern_code,
          fit_type: group.fit_type,
          fitType: group.fit_type,
          mark_code: group.mark_code,
          markCode: group.mark_code,
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
          size: cardSizes.join(', '),
          size_summary: allSizes.join(', '),
          sizeSummary: allSizes.join(', '),
          display_size: cardSizes.join(', '),
          displaySize: cardSizes.join(', '),
          colour: selectedColour,
          color: selectedColour,
          selected_colour: selectedColour,
          selectedColor: selectedColour,
          colour_summary: allColours.join(', '),
          color_summary: allColours.join(', '),
          colourSummary: allColours.join(', '),
          colorSummary: allColours.join(', '),
          display_color: selectedColour,
          displayColor: selectedColour,
          sizes: cardSizes,
          all_sizes: allSizes,
          allSizes,
          colours: allColours,
          colors: allColours,
          barcodes: cardBarcodes,
          ean_codes: cardBarcodes,
          eanCodes: cardBarcodes,
          all_barcodes: allBarcodes,
          allBarcodes,
          barcode: selected.barcode || '',
          ean_code: selected.ean_code || selected.barcode || '',
          eanCode: selected.ean_code || selected.barcode || '',
          mrp: selected.mrp,
          original_price: selected.original_price_b2c,
          originalPrice: selected.original_price_b2c,
          base_sale_price: selected.base_sale_price,
          baseSalePrice: selected.base_sale_price,
          original_sale_price: selected.original_sale_price,
          originalSalePrice: selected.original_sale_price,
          sale_price: selected.sale_price,
          salePrice: selected.sale_price,
          price: selected.price,
          selling_price: selected.selling_price,
          sellingPrice: selected.selling_price,
          discounted_price: selected.discounted_price,
          discountedPrice: selected.discounted_price,
          mahaveer_price: selected.mahaveer_price,
          mahaveerPrice: selected.mahaveer_price,
          cost_price: selected.cost_price,
          costPrice: selected.cost_price,
          b2c_discount_pct: selected.b2c_discount_pct,
          b2cDiscountPct: selected.b2c_discount_pct,
          b2b_discount_pct: selected.b2b_discount_pct,
          b2bDiscountPct: selected.b2b_discount_pct,
          discount_b2c: selected.b2c_discount_pct,
          discountB2c: selected.b2c_discount_pct,
          discount_b2b: selected.b2b_discount_pct,
          discountB2b: selected.b2b_discount_pct,
          discount: selected.b2c_discount_pct,
          discount_percentage: selected.b2c_discount_pct,
          discountPercentage: selected.b2c_discount_pct,
          discount_percent: selected.b2c_discount_pct,
          discountPercent: selected.b2c_discount_pct,
          original_price_b2c: selected.original_price_b2c,
          originalPriceB2c: selected.original_price_b2c,
          final_price_b2c: selected.final_price_b2c,
          finalPriceB2c: selected.final_price_b2c,
          original_price_b2b: selected.original_price_b2b,
          originalPriceB2b: selected.original_price_b2b,
          final_price_b2b: selected.final_price_b2b,
          finalPriceB2b: selected.final_price_b2b,
          b2c_final_price: selected.final_price_b2c,
          b2cFinalPrice: selected.final_price_b2c,
          b2b_final_price: selected.final_price_b2b,
          b2bFinalPrice: selected.final_price_b2b,
          final_price: selected.final_price_b2c,
          finalPrice: selected.final_price_b2c,
          on_hand: totalOnHand,
          onHand: totalOnHand,
          reserved: totalReserved,
          available_qty: totalAvailable,
          availableQty: totalAvailable,
          total_count: totalOnHand,
          totalCount: totalOnHand,
          in_stock: totalAvailable > 0,
          inStock: totalAvailable > 0,
          image_url: imageRow.image_url || '',
          imageUrl: imageRow.image_url || '',
          front_image_url: imageRow.front_image_url || '',
          frontImageUrl: imageRow.front_image_url || '',
          back_image_url: imageRow.back_image_url || '',
          backImageUrl: imageRow.back_image_url || '',
          main_image_url: imageRow.main_image_url || '',
          mainImageUrl: imageRow.main_image_url || '',
          images: selectedImages,
          variant_count: group.variants.length,
          variantCount: group.variants.length,
          color_variant_count: cardVariants.length,
          colorVariantCount: cardVariants.length,
          card_group_index: cardIndex,
          cardGroupIndex: cardIndex,
          variants: group.variants,
          color_variants: cardVariants,
          colorVariants: cardVariants
        })
      }
    }
  }

  out.sort((a, b) => {
    const brandCompare = String(a.brand_name || '').localeCompare(String(b.brand_name || ''), undefined, { numeric: true })
    if (brandCompare !== 0) return brandCompare
    const nameCompare = String(a.product_name || '').localeCompare(String(b.product_name || ''), undefined, { numeric: true })
    if (nameCompare !== 0) return nameCompare
    const colourCompare = String(a.colour || '').localeCompare(String(b.colour || ''), undefined, { numeric: true })
    if (colourCompare !== 0) return colourCompare
    const cardCompare = toNumber(a.card_group_index) - toNumber(b.card_group_index)
    if (cardCompare !== 0) return cardCompare
    return String(a.variant_id || '').localeCompare(String(b.variant_id || ''), undefined, { numeric: true })
  })

  return out
}

router.get('/:branchId/import-jobs', async (req, res) => {
  const branchId = parseBranchId(req)
  if (!branchId) return res.status(400).json({ message: 'Invalid branchId' })

  try {
    const exists = await ensureBranchExists(branchId)
    if (!exists) return res.status(404).json({ message: 'Branch not found' })

    await ensureImportRowsTable()

    const { rows } = await pool.query(
      `SELECT
         ij.id,
         ij.file_name,
         ij.file_url,
         ij.uploaded_by,
         ij.status_enum,
         ij.rows_total,
         ij.rows_success,
         ij.rows_error,
         ij.uploaded_at,
         ij.completed_at,
         ij.branch_id,
         ij.gender,
         ij.category_id,
         c.name AS category_name,
         c.slug AS category_slug,
         pc.id AS parent_category_id,
         pc.name AS parent_category_name,
         pc.slug AS parent_category_slug
       FROM import_jobs ij
       LEFT JOIN product_categories c ON c.id = ij.category_id
       LEFT JOIN product_categories pc ON pc.id = c.parent_id
       WHERE ij.branch_id = $1
       ORDER BY ij.id DESC
       LIMIT 100`,
      [branchId]
    )

    res.json(rows)
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.get('/:branchId/import-rows', async (req, res) => {
  const branchId = parseBranchId(req)
  if (!branchId) return res.status(400).json({ message: 'Invalid branchId' })

  const jobId = req.query.jobId ? parseInt(req.query.jobId, 10) : null
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10))
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '200', 10)))
  const status = String(req.query.status || '').trim()

  try {
    const exists = await ensureBranchExists(branchId)
    if (!exists) return res.status(404).json({ message: 'Branch not found' })

    await ensureImportRowsTable()

    let job

    if (jobId) {
      const r = await pool.query(
        `SELECT
           ij.*,
           c.name AS category_name,
           c.slug AS category_slug,
           pc.name AS parent_category_name
         FROM import_jobs ij
         LEFT JOIN product_categories c ON c.id = ij.category_id
         LEFT JOIN product_categories pc ON pc.id = c.parent_id
         WHERE ij.id = $1 AND ij.branch_id = $2`,
        [jobId, branchId]
      )
      if (!r.rows.length) return res.status(404).json({ message: 'Job not found' })
      job = r.rows[0]
    } else {
      const r = await pool.query(
        `SELECT
           ij.*,
           c.name AS category_name,
           c.slug AS category_slug,
           pc.name AS parent_category_name
         FROM import_jobs ij
         LEFT JOIN product_categories c ON c.id = ij.category_id
         LEFT JOIN product_categories pc ON pc.id = c.parent_id
         WHERE ij.branch_id = $1
         ORDER BY ij.id DESC
         LIMIT 1`,
        [branchId]
      )
      if (!r.rows.length) return res.json({ job: null, rows: [], nextOffset: offset, total: 0 })
      job = r.rows[0]
    }

    const params = [job.id]
    let where = `import_job_id = $1`

    if (status) {
      params.push(status)
      where += ` AND status_enum = $${params.length}`
    }

    const totalQ = await pool.query(`SELECT COUNT(*)::int AS c FROM import_rows WHERE ${where}`, params)

    params.push(limit, offset)

    const rowsQ = await pool.query(
      `SELECT id, status_enum, error_msg, raw_row_json, category_id
       FROM import_rows
       WHERE ${where}
       ORDER BY id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const nextOffset = offset + rowsQ.rows.length

    res.json({
      job: {
        id: job.id,
        file_name: job.file_name,
        status_enum: job.status_enum,
        rows_total: job.rows_total,
        rows_success: job.rows_success,
        rows_error: job.rows_error,
        uploaded_at: job.uploaded_at,
        completed_at: job.completed_at,
        gender: job.gender,
        category_id: job.category_id,
        category_name: job.category_name,
        category_slug: job.category_slug,
        parent_category_name: job.parent_category_name
      },
      rows: rowsQ.rows,
      nextOffset,
      total: totalQ.rows[0].c
    })
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.post('/:branchId/import', upload.single('file'), async (req, res) => {
  const branchId = parseBranchId(req)
  if (!branchId) return res.status(400).json({ message: 'Invalid branchId' })
  if (!req.file) return res.status(400).json({ message: 'File required' })

  const gender = normGender(req.body && req.body.gender)
  if (!gender) return res.status(400).json({ message: 'Category is required (MEN/WOMEN/KIDS)' })

  const category = await validateCategory(req.body && req.body.category_id, gender)
  if (!category) return res.status(400).json({ message: 'Valid sub-category is required' })

  const client = await pool.connect()
  let txStarted = false

  try {
    const exists = await ensureBranchExists(branchId)
    if (!exists) return res.status(404).json({ message: 'Branch not found' })

    await ensureImportRowsTable()

    const enumValues = await getAllowedImportRowStatuses()
    const createdStatus = resolveCreatedStatus(enumValues)
    const errorStatus = resolveErrorStatus(enumValues)

    if (!createdStatus || !errorStatus) {
      return res.status(500).json({ message: `Unsupported import_row_status enum values: ${enumValues.join(', ')}` })
    }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const wsName = wb.SheetNames && wb.SheetNames[0]
    if (!wsName) return res.status(400).json({ message: 'No worksheet in file' })

    const allRows = XLSX.utils.sheet_to_json(wb.Sheets[wsName], { defval: '' })
    const preparedRows = []
    const seenBarcodes = new Set()
    let duplicateErrors = 0

    for (const raw of allRows) {
      const prepared = rowToPreparedRecord(raw)
      if (!shouldQueueRow(prepared)) continue

      if (prepared.Barcode && seenBarcodes.has(prepared.Barcode)) {
        preparedRows.push({
          raw,
          status_enum: errorStatus,
          error_msg: `Duplicate barcode in Excel: ${prepared.Barcode}`
        })
        duplicateErrors += 1
        continue
      }

      if (prepared.Barcode) seenBarcodes.add(prepared.Barcode)

      preparedRows.push({
        raw,
        status_enum: createdStatus,
        error_msg: null
      })
    }

    await client.query('BEGIN')
    txStarted = true

    const uploadedBy = null
    const fileName = req.file.originalname || `import_${Date.now()}.xlsx`
    const initialStatus = preparedRows.length === 0 ? 'COMPLETE' : 'PENDING'
    const completedAtSql = preparedRows.length === 0 ? 'NOW()' : 'NULL'

    const { rows } = await client.query(
      `INSERT INTO import_jobs (file_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, branch_id, gender, category_id, completed_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, ${completedAtSql})
       RETURNING id, file_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, uploaded_at, completed_at, branch_id, gender, category_id`,
      [fileName, null, uploadedBy, initialStatus, preparedRows.length, duplicateErrors, branchId, gender, category.id]
    )

    const job = rows[0]

    if (preparedRows.length) {
      await insertImportRowsInBatches(client, job.id, preparedRows, createdStatus, category.id)
    }

    await client.query('COMMIT')
    txStarted = false

    res.status(201).json({
      ...job,
      category_name: category.name,
      category_slug: category.slug,
      category_path: category.category_path
    })
  } catch (e) {
    if (txStarted) {
      try {
        await client.query('ROLLBACK')
      } catch {}
    }
    res.status(500).json({ message: e.message || 'Server error' })
  } finally {
    client.release()
  }
})

router.post('/:branchId/import/process/:jobId', async (req, res) => {
  const branchId = parseBranchId(req)
  if (!branchId) return res.status(400).json({ message: 'Invalid branchId' })

  const jobId = parseInt(req.params.jobId, 10)
  const limit = Math.max(1, Math.min(PROCESS_MAX_LIMIT, parseInt(req.query.limit || String(PROCESS_MAX_LIMIT), 10)))

  try {
    const exists = await ensureBranchExists(branchId)
    if (!exists) return res.status(404).json({ message: 'Branch not found' })

    await ensureImportRowsTable()

    const enumValues = await getAllowedImportRowStatuses()
    const createdStatus = resolveCreatedStatus(enumValues)
    const okStatus = resolveOkStatus(enumValues)
    const errorStatus = resolveErrorStatus(enumValues)

    if (!createdStatus || !okStatus || !errorStatus) {
      return res.status(500).json({ message: `Unsupported import_row_status enum values: ${enumValues.join(', ')}` })
    }

    const j = await pool.query(
      `SELECT id, file_url, status_enum, rows_total, rows_success, rows_error, gender, category_id
       FROM import_jobs
       WHERE id = $1 AND branch_id = $2`,
      [jobId, branchId]
    )

    if (!j.rows.length) return res.status(404).json({ message: 'Job not found' })

    const job = j.rows[0]
    const st = String(job.status_enum || '').toUpperCase()

    if (st === 'COMPLETE' || st === 'PARTIAL' || st === 'FAILED') {
      return res.json({
        done: true,
        processed: 0,
        nextStart: (job.rows_success || 0) + (job.rows_error || 0),
        ok: 0,
        err: 0,
        totalRows: job.rows_total || 0
      })
    }

    const client = await pool.connect()
    let ok = 0
    let err = 0
    const errMap = new Map()
    const errSamples = []

    try {
      const batch = await client.query(
        `SELECT id, raw_row_json, category_id
         FROM import_rows
         WHERE import_job_id = $1 AND status_enum = $2
         ORDER BY id ASC
         LIMIT $3`,
        [jobId, createdStatus, limit]
      )

      const rowsToProcess = batch.rows

      if (!rowsToProcess.length) {
        const finalSuccess = job.rows_success || 0
        const finalError = job.rows_error || 0
        const finalStatus = finalSuccess === 0 && finalError > 0 ? 'FAILED' : finalError > 0 ? 'PARTIAL' : 'COMPLETE'

        await pool.query(
          `UPDATE import_jobs
           SET status_enum = $1,
               completed_at = NOW()
           WHERE id = $2`,
          [finalStatus, jobId]
        )

        return res.json({
          done: true,
          processed: 0,
          nextStart: finalSuccess + finalError,
          ok: 0,
          err: 0,
          totalRows: job.rows_total || 0
        })
      }

      const gender = normGender(job.gender)
      const categoryId = parsePositiveInt(job.category_id)

      for (const batchRow of rowsToProcess) {
        const raw = batchRow.raw_row_json || {}
        const prepared = rowToPreparedRecord(raw)

        if (!prepared.ProductName || !prepared.BrandName || !prepared.SIZE || !prepared.COLOUR || !prepared.Barcode) {
          const msg = 'Missing required fields (ProductName/BrandName/SIZE/COLOUR/Barcode)'

          await client.query(
            `UPDATE import_rows
             SET status_enum = $2,
                 error_msg = $3,
                 processed_at = NOW()
             WHERE id = $1`,
            [batchRow.id, errorStatus, msg]
          )

          err += 1
          errMap.set(msg, (errMap.get(msg) || 0) + 1)
          if (errSamples.length < 5) errSamples.push({ row: raw, error: msg })
          continue
        }

        try {
          await client.query('BEGIN')

          const pRes = await client.query(
            `INSERT INTO products (name, brand_name, pattern_code, fit_type, mark_code, gender, category_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (name, brand_name, pattern_code, gender)
             DO UPDATE SET fit_type = EXCLUDED.fit_type,
                           mark_code = EXCLUDED.mark_code,
                           category_id = EXCLUDED.category_id,
                           updated_at = NOW()
             RETURNING id`,
            [prepared.ProductName, prepared.BrandName, prepared.PATTERN, prepared.FITT, prepared.MarkCode, gender || null, categoryId]
          )

          const productId = pRes.rows[0].id

          const existingBarcode = await client.query(
            `SELECT id, variant_id
             FROM barcodes
             WHERE REGEXP_REPLACE(UPPER(TRIM(ean_code)), '[^A-Z0-9._-]', '', 'g') = $1
             ORDER BY id ASC
             LIMIT 1`,
            [prepared.Barcode]
          )

          let variantId

          if (existingBarcode.rowCount) {
            variantId = existingBarcode.rows[0].variant_id

            await client.query(
              `UPDATE product_variants
               SET product_id = $1,
                   size = $2,
                   colour = $3,
                   is_active = TRUE,
                   mrp = $4,
                   sale_price = $5,
                   cost_price = $6,
                   b2c_discount_pct = $7,
                   b2b_discount_pct = $8,
                   updated_at = NOW()
               WHERE id = $9`,
              [
                productId,
                prepared.SIZE,
                prepared.COLOUR,
                prepared.MRP,
                prepared.RSalePrice,
                prepared.CostPrice,
                prepared.B2CDiscount,
                prepared.B2BDiscount,
                variantId
              ]
            )
          } else {
            const vRes = await client.query(
              `INSERT INTO product_variants (product_id, size, colour, is_active, mrp, sale_price, cost_price, b2c_discount_pct, b2b_discount_pct, created_at, updated_at)
               VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7, $8, NOW(), NOW())
               RETURNING id`,
              [
                productId,
                prepared.SIZE,
                prepared.COLOUR,
                prepared.MRP,
                prepared.RSalePrice,
                prepared.CostPrice,
                prepared.B2CDiscount,
                prepared.B2BDiscount
              ]
            )

            variantId = vRes.rows[0].id

            await client.query(
              `INSERT INTO barcodes (variant_id, ean_code)
               VALUES ($1, $2)`,
              [variantId, prepared.Barcode]
            )
          }

          await client.query(
            `INSERT INTO branch_variant_stock (branch_id, variant_id, on_hand, reserved, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, 0, TRUE, NOW(), NOW())
             ON CONFLICT (branch_id, variant_id)
             DO UPDATE SET on_hand = EXCLUDED.on_hand,
                           reserved = 0,
                           is_active = TRUE,
                           updated_at = NOW()`,
            [branchId, variantId, prepared.PurchaseQty]
          )

          await client.query(
            `UPDATE import_rows
             SET status_enum = $2,
                 error_msg = NULL,
                 category_id = $3,
                 processed_at = NOW()
             WHERE id = $1`,
            [batchRow.id, okStatus, categoryId]
          )

          await client.query('COMMIT')
          ok += 1
        } catch (e) {
          await client.query('ROLLBACK')

          const msg = String(e.message || 'error').slice(0, 500)

          await client.query(
            `UPDATE import_rows
             SET status_enum = $2,
                 error_msg = $3,
                 processed_at = NOW()
             WHERE id = $1`,
            [batchRow.id, errorStatus, msg]
          )

          err += 1
          errMap.set(msg, (errMap.get(msg) || 0) + 1)
          if (errSamples.length < 5) errSamples.push({ row: raw, error: msg })
        }
      }
    } finally {
      client.release()
    }

    const currentStatusRow = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status_enum = $2)::int AS pending_count,
         COUNT(*) FILTER (WHERE status_enum = $3)::int AS ok_count,
         COUNT(*) FILTER (WHERE status_enum = $4)::int AS error_count
       FROM import_rows
       WHERE import_job_id = $1`,
      [jobId, createdStatus, okStatus, errorStatus]
    )

    const counts = currentStatusRow.rows[0]
    const pendingCount = counts.pending_count || 0
    const okCount = counts.ok_count || 0
    const errorCount = counts.error_count || 0
    const processedCount = okCount + errorCount
    const isDone = pendingCount === 0

    let finalStatus = 'PENDING'

    if (isDone) {
      if (okCount === 0 && errorCount > 0) finalStatus = 'FAILED'
      else if (errorCount > 0) finalStatus = 'PARTIAL'
      else finalStatus = 'COMPLETE'
    }

    await pool.query(
      `UPDATE import_jobs
       SET rows_total = $1,
           rows_success = $2,
           rows_error = $3,
           status_enum = $4,
           completed_at = CASE WHEN $4 IN ('COMPLETE','PARTIAL','FAILED') THEN NOW() ELSE completed_at END
       WHERE id = $5`,
      [job.rows_total || 0, okCount, errorCount, finalStatus, jobId]
    )

    const error_counts = Array.from(errMap.entries())
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    res.json({
      done: isDone,
      processed: ok + err,
      ok,
      err,
      totalRows: job.rows_total || 0,
      nextStart: processedCount,
      error_counts,
      errors_sample: errSamples
    })
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.post('/:branchId/images/confirm', async (req, res) => {
  const branchId = parseBranchId(req)
  if (!branchId) return res.status(400).json({ message: 'Invalid branchId' })

  const images = Array.isArray(req.body && req.body.images) ? req.body.images : []
  if (!images.length) return res.status(400).json({ message: 'No images' })

  try {
    const exists = await ensureBranchExists(branchId)
    if (!exists) return res.status(404).json({ message: 'Branch not found' })

    await ensureProductImagesTable()

    const client = await pool.connect()
    let updated = 0
    const unmatched = []

    try {
      await client.query('BEGIN')

      for (const img of images) {
        const directBarcode = normalizeBarcode(img.barcode || img.ean_code || img.ean || '')
        const fallbackBarcode = extractBarcodeFromName(img.original_filename || img.public_id || '')
        const barcode = directBarcode || fallbackBarcode
        const imageType = normalizeImageType(img.image_type || extractImageTypeFromName(img.original_filename || img.public_id || ''))
        const url = String(img.secure_url || img.url || img.image_url || '').trim()
        const publicId = String(img.public_id || '').trim()

        if (!barcode || !url) {
          unmatched.push({
            barcode: barcode || null,
            image_type: imageType,
            original_filename: img.original_filename || '',
            reason: 'Missing barcode or URL'
          })
          continue
        }

        const barcodeResult = await client.query(
          `SELECT
             b.ean_code,
             b.variant_id,
             v.product_id,
             v.is_active AS variant_active,
             bvs.branch_id,
             bvs.is_active AS stock_active,
             bvs.on_hand
           FROM barcodes b
           JOIN product_variants v ON v.id = b.variant_id
           LEFT JOIN branch_variant_stock bvs ON bvs.variant_id = v.id AND bvs.branch_id = $2
           WHERE REGEXP_REPLACE(UPPER(TRIM(b.ean_code)), '[^A-Z0-9._-]', '', 'g') = $1
           ORDER BY CASE WHEN bvs.branch_id = $2 THEN 0 ELSE 1 END, b.id ASC
           LIMIT 1`,
          [barcode, branchId]
        )

        if (!barcodeResult.rowCount) {
          unmatched.push({
            barcode,
            image_type: imageType,
            original_filename: img.original_filename || '',
            reason: 'Barcode not found in barcodes table'
          })
          continue
        }

        const matched = barcodeResult.rows[0]

        if (!matched.branch_id) {
          unmatched.push({
            barcode,
            image_type: imageType,
            original_filename: img.original_filename || '',
            reason: 'Barcode found but not available in this branch'
          })
          continue
        }

        if (matched.variant_active === false) {
          await client.query(
            `UPDATE product_variants
             SET is_active = TRUE,
                 updated_at = NOW()
             WHERE id = $1`,
            [matched.variant_id]
          )
        }

        if (matched.stock_active === false) {
          await client.query(
            `UPDATE branch_variant_stock
             SET is_active = TRUE,
                 updated_at = NOW()
             WHERE branch_id = $1 AND variant_id = $2`,
            [branchId, matched.variant_id]
          )
        }

        await client.query(
          `INSERT INTO product_images (ean_code, image_type, image_url, public_id, uploaded_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (ean_code, image_type)
           DO UPDATE SET image_url = EXCLUDED.image_url,
                         public_id = EXCLUDED.public_id,
                         uploaded_at = NOW()`,
          [matched.ean_code, imageType, url, publicId || null]
        )

        if (imageType === 'front' || imageType === 'main') {
          await client.query(
            `UPDATE product_variants
             SET image_url = $1,
                 updated_at = NOW()
             WHERE id = $2`,
            [url, matched.variant_id]
          )
        } else {
          await client.query(
            `UPDATE product_variants
             SET image_url = COALESCE(NULLIF(image_url, ''), $1),
                 updated_at = NOW()
             WHERE id = $2`,
            [url, matched.variant_id]
          )
        }

        updated += 1
      }

      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      return res.status(500).json({ message: e.message || 'DB error' })
    } finally {
      client.release()
    }

    res.json({ totalUpdated: updated, unmatched })
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.get('/:branchId/stock', async (req, res) => {
  const branchId = parseBranchId(req)
  if (!branchId) return res.status(400).json({ message: 'Invalid branchId' })

  const gender = normGender(req.query && req.query.gender)
  const categoryId = parsePositiveInt(req.query && req.query.category_id)

  try {
    const exists = await ensureBranchExists(branchId)
    if (!exists) return res.status(404).json({ message: 'Branch not found' })

    await ensureProductImagesTable()

    const params = [branchId]
    let where = `bvs.branch_id = $1 AND bvs.is_active = TRUE AND v.is_active = TRUE AND bvs.on_hand > 0`

    if (gender) {
      params.push(gender)
      where += ` AND p.gender = $${params.length}`
    }

    if (categoryId) {
      params.push(categoryId)
      where += ` AND p.category_id IN (
        WITH RECURSIVE cats AS (
          SELECT id FROM product_categories WHERE id = $${params.length}
          UNION ALL
          SELECT pc.id FROM product_categories pc JOIN cats c ON pc.parent_id = c.id
        )
        SELECT id FROM cats
      )`
    }

    const { rows } = await pool.query(
      `SELECT
         p.id AS product_id,
         p.name AS product_name,
         p.brand_name,
         p.pattern_code,
         p.fit_type,
         p.mark_code,
         p.gender,
         p.category_id,
         c.name AS category_name,
         c.slug AS category_slug,
         c.level AS category_level,
         pc.id AS parent_category_id,
         pc.name AS parent_category_name,
         pc.slug AS parent_category_slug,
         CASE
           WHEN ppc.id IS NOT NULL THEN ppc.name || ' > ' || pc.name || ' > ' || c.name
           WHEN pc.id IS NOT NULL THEN pc.name || ' > ' || c.name
           ELSE c.name
         END AS category_path,
         v.id AS variant_id,
         v.size,
         v.colour,
         v.mrp::numeric AS mrp,
         v.sale_price::numeric AS base_sale_price,
         v.sale_price::numeric AS original_sale_price,
         v.cost_price::numeric AS cost_price,
         COALESCE(v.b2c_discount_pct, 0)::numeric AS b2c_discount_pct,
         COALESCE(v.b2b_discount_pct, 0)::numeric AS b2b_discount_pct,
         v.mrp::numeric AS original_price_b2c,
         CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS final_price_b2c,
         v.mrp::numeric AS original_price_b2b,
         CASE WHEN COALESCE(v.b2b_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2b_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.cost_price, 0), NULLIF(v.sale_price, 0), v.mrp)::numeric END AS final_price_b2b,
         CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS sale_price,
         CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS price,
         CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS selling_price,
         CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS discounted_price,
         CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS mahaveer_price,
         bvs.on_hand,
         bvs.reserved,
         GREATEST(COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0), 0)::int AS available_qty,
         TRUE AS in_stock,
         COALESCE(bc.ean_code,'') AS barcode,
         COALESCE(bc.ean_code,'') AS ean_code,
         COALESCE(imgs.front_image_url, imgs.main_image_url, v.image_url, '') AS image_url,
         COALESCE(imgs.front_image_url, '') AS front_image_url,
         COALESCE(imgs.back_image_url, '') AS back_image_url,
         COALESCE(imgs.main_image_url, '') AS main_image_url,
         COALESCE(imgs.images, '[]'::json) AS images
       FROM branch_variant_stock bvs
       JOIN product_variants v ON v.id = bvs.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN product_categories c ON c.id = p.category_id
       LEFT JOIN product_categories pc ON pc.id = c.parent_id
       LEFT JOIN product_categories ppc ON ppc.id = pc.parent_id
       LEFT JOIN LATERAL (
         SELECT ean_code
         FROM barcodes bc
         WHERE bc.variant_id = v.id
         ORDER BY id ASC
         LIMIT 1
       ) bc ON TRUE
       LEFT JOIN LATERAL (
         SELECT
           MAX(image_url) FILTER (WHERE image_type = 'front') AS front_image_url,
           MAX(image_url) FILTER (WHERE image_type = 'back') AS back_image_url,
           MAX(image_url) FILTER (WHERE image_type = 'main') AS main_image_url,
           JSON_AGG(
             JSON_BUILD_OBJECT(
               'image_type', image_type,
               'image_url', image_url,
               'public_id', public_id
             )
             ORDER BY CASE image_type WHEN 'front' THEN 1 WHEN 'main' THEN 2 WHEN 'back' THEN 3 ELSE 4 END, id
           ) AS images
         FROM product_images pi
         WHERE pi.ean_code = bc.ean_code
       ) imgs ON TRUE
       WHERE ${where}
       ORDER BY p.brand_name, p.name, v.colour, v.size, v.id`,
      params
    )

    res.json(groupStockRows(rows))
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.get('/:branchId/discounts', async (req, res) => {
  const branchId = parseBranchId(req)
  if (!branchId) return res.status(400).json({ message: 'Invalid branchId' })

  try {
    const exists = await ensureBranchExists(branchId)
    if (!exists) return res.status(404).json({ message: 'Branch not found' })

    const { rows } = await pool.query(
      `SELECT
         COALESCE(
           (
             SELECT v.b2c_discount_pct
             FROM product_variants v
             JOIN branch_variant_stock bvs ON bvs.variant_id = v.id
             WHERE bvs.branch_id = $1
               AND v.b2c_discount_pct IS NOT NULL
               AND v.is_active = TRUE
               AND bvs.is_active = TRUE
             LIMIT 1
           ),
           0
         ) AS b2c_discount_pct,
         COALESCE(
           (
             SELECT v.b2b_discount_pct
             FROM product_variants v
             JOIN branch_variant_stock bvs ON bvs.variant_id = v.id
             WHERE bvs.branch_id = $1
               AND v.b2b_discount_pct IS NOT NULL
               AND v.is_active = TRUE
               AND bvs.is_active = TRUE
             LIMIT 1
           ),
           0
         ) AS b2b_discount_pct`,
      [branchId]
    )

    if (!rows.length) return res.json({ b2c_discount_pct: 0, b2b_discount_pct: 0 })

    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.post('/:branchId/discounts', async (req, res) => {
  const branchId = parseBranchId(req)
  if (!branchId) return res.status(400).json({ message: 'Invalid branchId' })

  const b2c = Number(req.body && req.body.b2c_discount_pct)
  const b2b = Number(req.body && req.body.b2b_discount_pct)

  if (!Number.isFinite(b2c) || !Number.isFinite(b2b) || b2c < 0 || b2b < 0) {
    return res.status(400).json({ message: 'Invalid discount values' })
  }

  try {
    const exists = await ensureBranchExists(branchId)
    if (!exists) return res.status(404).json({ message: 'Branch not found' })

    await pool.query(
      `UPDATE product_variants v
       SET b2c_discount_pct = $2,
           b2b_discount_pct = $3,
           updated_at = NOW()
       FROM branch_variant_stock bvs
       WHERE bvs.variant_id = v.id
         AND bvs.branch_id = $1
         AND v.is_active = TRUE
         AND bvs.is_active = TRUE`,
      [branchId, b2c, b2b]
    )

    res.json({ b2c_discount_pct: b2c, b2b_discount_pct: b2b })
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

module.exports = router