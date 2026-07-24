const express = require('express')
const multer = require('multer')
const XLSX = require('xlsx')
const pool = require('../db')

const router = express.Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
})

const PROCESS_MAX_LIMIT = 250
const INSERT_CHUNK_SIZE = 500

const HEADER_ALIASES = {
  productname: ['product', 'product name', 'item', 'item name', 'productname'],
  brandname: ['brand', 'brand name', 'brandname'],
  costprice: ['cost', 'purchase cost', 'costprice'],
  purchaseqty: ['clqty', 'qty', 'quantity', 'purchase qty', 'purchaseqty'],
  barcode: ['barcode', 'bar code', 'bar-code', 'barcode number', 'barcode no', 'sku', 'sku code', 'ean', 'ean code', 'eancode'],
  mrp: ['mrp', 'retail mrp'],
  rsaleprice: ['retailprice', 'saleprice', 'sale price', 'retail price', 'rsp', 'rsaleprice'],
  markcode: ['mark code', 'mark', 'marking', 'markcode'],
  size: ['size'],
  colour: ['colour', 'color'],
  pattern: ['pattern code', 'style', 'style code', 'pattern'],
  fitt: ['fit', 'fit type', 'fitt'],
  b2cdiscount: ['b2cdiscount', 'b2c discount', 'discount_b2c', 'b2c disc', 'b2c_disc'],
  b2bdiscount: ['b2bdiscount', 'b2b discount', 'discount_b2b', 'b2b disc', 'b2b_disc']
}

const ALL_CATEGORY_PATHS_CTE = `WITH RECURSIVE category_paths AS (SELECT c.id, c.parent_id, c.gender, c.name, c.slug, c.level, c.is_active, c.name::text AS category_path FROM product_categories c WHERE c.parent_id IS NULL UNION ALL SELECT c.id, c.parent_id, c.gender, c.name, c.slug, c.level, c.is_active, category_paths.category_path || ' > ' || c.name FROM product_categories c JOIN category_paths ON category_paths.id = c.parent_id)`

function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
}

function parseBranchId(req) {
  const value = parseInt(req.params.branchId, 10)
  return Number.isInteger(value) && value > 0 ? value : null
}

function parsePositiveInt(value) {
  const parsed = parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

async function ensureBranchExists(branchId) {
  const result = await pool.query('SELECT id FROM branches WHERE id = $1 LIMIT 1', [branchId])
  return result.rows.length > 0
}

function cleanText(value) {
  if (value == null) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function normalizeLogicalText(value) {
  return cleanText(value).toLowerCase()
}

function normalizeBarcode(value) {
  return String(value ?? '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, '')
}

function normalizeImageType(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '')

  if (normalized.includes('front')) return 'front'
  if (normalized.includes('back')) return 'back'
  if (normalized.includes('main')) return 'main'

  return normalized || 'main'
}

function baseNameNoExt(name) {
  const fileName = String(name || '').split('/').pop() || String(name || '')
  const extensionIndex = fileName.lastIndexOf('.')
  return extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
}

function extractBarcodeFromName(name) {
  const base = baseNameNoExt(name)

  if (base.includes('__')) {
    return normalizeBarcode(base.split('__')[0])
  }

  const dotMatch = base.match(/^(.+)\.(front|back|main)$/i)

  if (dotMatch) {
    return normalizeBarcode(dotMatch[1])
  }

  return normalizeBarcode(base)
}

function extractImageTypeFromName(name) {
  const base = baseNameNoExt(name)

  if (base.includes('__')) {
    return normalizeImageType(base.split('__').slice(1).join('__'))
  }

  const dotMatch = base.match(/^(.+)\.(front|back|main)$/i)

  if (dotMatch) {
    return normalizeImageType(dotMatch[2])
  }

  return 'main'
}

function normalizeRow(raw) {
  const normalized = {}

  for (const [key, value] of Object.entries(raw || {})) {
    normalized[String(key).trim().toLowerCase()] = value
  }

  for (const canonicalName of Object.keys(HEADER_ALIASES)) {
    if (normalized[canonicalName] != null && normalized[canonicalName] !== '') {
      continue
    }

    for (const alias of HEADER_ALIASES[canonicalName]) {
      const normalizedAlias = String(alias).trim().toLowerCase()

      if (normalized[normalizedAlias] != null && normalized[normalizedAlias] !== '') {
        normalized[canonicalName] = normalized[normalizedAlias]
        break
      }
    }
  }

  if (!normalized.productname && raw?.__EMPTY) normalized.productname = raw.__EMPTY
  if (!normalized.brandname && raw?.__EMPTY_1) normalized.brandname = raw.__EMPTY_1
  if (normalized.purchaseqty == null && raw?.__EMPTY_2 != null) normalized.purchaseqty = raw.__EMPTY_2
  if (!normalized.barcode && raw?.__EMPTY_3) normalized.barcode = raw.__EMPTY_3
  if (normalized.mrp == null && raw?.__EMPTY_4 != null) normalized.mrp = raw.__EMPTY_4
  if (!normalized.size && raw?.__EMPTY_5) normalized.size = raw.__EMPTY_5
  if (!normalized.colour && raw?.__EMPTY_6) normalized.colour = raw.__EMPTY_6
  if (!normalized.pattern && raw?.__EMPTY_7) normalized.pattern = raw.__EMPTY_7

  return normalized
}

function toNumOrNull(value) {
  if (value === '' || value == null) return null
  const parsed = parseFloat(String(value).replace(/[₹, ]+/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function toIntOrZero(value) {
  const parsed = parseInt(String(value).replace(/[₹, ]+/g, ''), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function normGender(value) {
  const normalized = String(value || '').trim().toUpperCase()

  if (['MEN', 'WOMEN', 'KIDS'].includes(normalized)) return normalized
  if (['MAN', 'MALE', 'MENS', "MEN'S"].includes(normalized)) return 'MEN'
  if (['WOMAN', 'FEMALE', 'LADIES', 'WOMENS', "WOMEN'S"].includes(normalized)) return 'WOMEN'
  if (['CHILD', 'CHILDREN', 'BOYS', 'GIRLS', 'KID'].includes(normalized)) return 'KIDS'

  return ''
}

function isSummaryOrBlankRow(raw, productName, brandName, size, colour, row) {
  const summary = cleanText(raw?.['Stock Summary'] || raw?.['stock summary'] || '')
  const allMainEmpty = !productName && !brandName && !size && !colour
  const hasAnyDataField = cleanText(row.barcode) || toNumOrNull(row.mrp) != null || toNumOrNull(row.rsaleprice) != null || toIntOrZero(row.purchaseqty) !== 0

  if (allMainEmpty && !hasAnyDataField) return true

  const normalizedSummary = summary.toLowerCase()

  if (!summary) return false
  if (normalizedSummary.startsWith('date between')) return true
  if (normalizedSummary.startsWith('| branchs')) return true

  return false
}

function isDefaultText(value) {
  const normalized = cleanText(value).toLowerCase()

  if (!normalized) return true

  const blockedValues = new Set([
    'brand',
    'product',
    'new in',
    'inclusive of all taxes',
    '₹0.00',
    '0',
    '0.00',
    '₹0',
    '₹0.0'
  ])

  if (blockedValues.has(normalized)) return true

  return ['inclusive of all taxes', 'new in'].some(text => normalized.includes(text))
}

function shouldSkipBusinessRow(productName, brandName, mrp, salePrice) {
  const normalizedMrp = mrp == null ? null : Number(mrp)
  const normalizedSalePrice = salePrice == null ? null : Number(salePrice)
  const bothZero = (normalizedMrp === 0 || normalizedMrp === null) && (normalizedSalePrice === 0 || normalizedSalePrice === null)

  if (!bothZero) return false

  return isDefaultText(productName) || isDefaultText(brandName)
}

let importSchemaPromise = null
let productImagesSchemaPromise = null

async function ensureImportRowsTable() {
  if (!importSchemaPromise) {
    importSchemaPromise = initializeImportRowsTable().catch(error => {
      importSchemaPromise = null
      throw error
    })
  }

  return importSchemaPromise
}

async function initializeImportRowsTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS import_rows (id BIGSERIAL PRIMARY KEY, import_job_id BIGINT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE, raw_row_json JSONB NOT NULL, status_enum TEXT, error_msg TEXT)`)
  await pool.query(`ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await pool.query(`ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS raw_row_json JSONB`)
  await pool.query(`ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS error_msg TEXT`)
  await pool.query(`ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES product_categories(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES product_categories(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS worksheet_name TEXT`)
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES product_categories(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_name_brand_name_pattern_code_gender_key`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_products_name_brand_pattern_gender_category ON products (name, brand_name, pattern_code, gender, category_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_rows_job_status_id ON import_rows (import_job_id, status_enum, id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_jobs_branch_uploaded_id ON import_jobs (branch_id, id DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_jobs_category_id ON import_jobs(category_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_barcodes_variant_id ON barcodes(variant_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_branch_variant_stock_branch_active ON branch_variant_stock(branch_id, is_active, variant_id)`)
}

async function ensureProductImagesTable() {
  if (!productImagesSchemaPromise) {
    productImagesSchemaPromise = initializeProductImagesTable().catch(error => {
      productImagesSchemaPromise = null
      throw error
    })
  }

  return productImagesSchemaPromise
}

async function initializeProductImagesTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS product_images (id BIGSERIAL PRIMARY KEY, ean_code TEXT NOT NULL, image_type TEXT NOT NULL, image_url TEXT NOT NULL, public_id TEXT, uploaded_at TIMESTAMPTZ DEFAULT NOW())`)
  await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS ean_code TEXT`)
  await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS image_type TEXT NOT NULL DEFAULT 'main'`)
  await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS image_url TEXT`)
  await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS public_id TEXT`)
  await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ DEFAULT NOW()`)
  await pool.query(`DELETE FROM product_images a USING product_images b WHERE a.ctid < b.ctid AND a.ean_code = b.ean_code AND a.image_type = b.image_type`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS product_images_ean_code_image_type_key ON product_images(ean_code, image_type)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_images_ean_code ON product_images(ean_code)`)
}

async function validateCategory(categoryId, gender) {
  const id = parsePositiveInt(categoryId)

  if (!id) return null

  const result = await pool.query(`WITH RECURSIVE category_tree AS (SELECT c.id, c.parent_id, c.gender, c.name, c.slug, c.level, c.name::text AS category_path FROM product_categories c WHERE c.parent_id IS NULL AND c.is_active = TRUE UNION ALL SELECT c.id, c.parent_id, c.gender, c.name, c.slug, c.level, category_tree.category_path || ' > ' || c.name FROM product_categories c JOIN category_tree ON category_tree.id = c.parent_id WHERE c.is_active = TRUE) SELECT c.id, c.parent_id, c.gender, c.name, c.slug, c.level, c.category_path FROM category_tree c WHERE c.id = $1 AND c.gender = $2 AND NOT EXISTS (SELECT 1 FROM product_categories child WHERE child.parent_id = c.id AND child.is_active = TRUE) LIMIT 1`, [id, gender])

  return result.rows[0] || null
}

function rowToPreparedRecord(raw) {
  const row = normalizeRow(raw)
  const barcode = normalizeBarcode(row.barcode)

  return {
    raw,
    ProductName: cleanText(row.productname),
    BrandName: cleanText(row.brandname),
    SIZE: cleanText(row.size),
    COLOUR: cleanText(row.colour),
    PATTERN: cleanText(row.pattern) || '',
    FITT: cleanText(row.fitt) || null,
    MarkCode: cleanText(row.markcode) || null,
    MRP: toNumOrNull(row.mrp),
    RSalePrice: toNumOrNull(row.rsaleprice),
    CostPrice: toNumOrNull(row.costprice) ?? 0,
    PurchaseQty: Math.max(0, toIntOrZero(row.purchaseqty)),
    B2CDiscount: toNumOrNull(row.b2cdiscount) ?? 0,
    B2BDiscount: toNumOrNull(row.b2bdiscount) ?? 0,
    Barcode: barcode,
    Barcodes: barcode ? [barcode] : []
  }
}

function shouldQueueRow(prepared) {
  if (isSummaryOrBlankRow(prepared.raw, prepared.ProductName, prepared.BrandName, prepared.SIZE, prepared.COLOUR, normalizeRow(prepared.raw))) {
    return false
  }

  if (shouldSkipBusinessRow(prepared.ProductName, prepared.BrandName, prepared.MRP, prepared.RSalePrice)) {
    return false
  }

  return true
}

function buildPreparedImportRows(rows, createdStatus, errorStatus) {
  const grouped = new Map()
  const preparedRows = []

  for (const raw of rows) {
    const prepared = rowToPreparedRecord(raw)

    if (!shouldQueueRow(prepared)) continue

    if (!prepared.Barcode) {
      preparedRows.push({
        raw,
        status_enum: createdStatus,
        error_msg: null
      })

      continue
    }

    const signature = [
      normalizeLogicalText(prepared.ProductName),
      normalizeLogicalText(prepared.BrandName),
      normalizeLogicalText(prepared.PATTERN),
      normalizeLogicalText(prepared.SIZE),
      normalizeLogicalText(prepared.COLOUR),
      String(prepared.MRP ?? ''),
      String(prepared.RSalePrice ?? ''),
      String(prepared.CostPrice ?? ''),
      normalizeLogicalText(prepared.MarkCode),
      normalizeLogicalText(prepared.FITT)
    ].join('|')

    const existing = grouped.get(prepared.Barcode)

    if (!existing) {
      grouped.set(prepared.Barcode, {
        raw: {
          ...raw,
          purchaseqty: prepared.PurchaseQty,
          barcode: prepared.Barcode,
          barcodes: [prepared.Barcode]
        },
        signature,
        quantity: prepared.PurchaseQty,
        conflict: false
      })

      continue
    }

    if (existing.signature !== signature) {
      existing.conflict = true
      continue
    }

    existing.quantity += prepared.PurchaseQty
    existing.raw.purchaseqty = existing.quantity
  }

  for (const [barcode, item] of grouped.entries()) {
    preparedRows.push({
      raw: {
        ...item.raw,
        purchaseqty: item.quantity,
        barcode,
        barcodes: [barcode]
      },
      status_enum: item.conflict ? errorStatus : createdStatus,
      error_msg: item.conflict ? `Conflicting product details for barcode: ${barcode}` : null
    })
  }

  return preparedRows
}

async function findImportBarcodeConflicts(preparedRows, categoryId, gender) {
  const sourceByBarcode = new Map()

  for (const item of preparedRows) {
    if (item.error_msg) continue

    const prepared = rowToPreparedRecord(item.raw)

    if (!prepared.Barcode) continue

    sourceByBarcode.set(prepared.Barcode, prepared)
  }

  const barcodes = Array.from(sourceByBarcode.keys())

  if (!barcodes.length) return []

  const result = await pool.query(`WITH RECURSIVE category_paths AS (SELECT c.id, c.parent_id, c.name, c.name::text AS category_path FROM product_categories c WHERE c.parent_id IS NULL UNION ALL SELECT c.id, c.parent_id, c.name, category_paths.category_path || ' > ' || c.name FROM product_categories c JOIN category_paths ON category_paths.id = c.parent_id) SELECT REGEXP_REPLACE(UPPER(TRIM(b.ean_code)), '[^A-Z0-9._-]', '', 'g') AS barcode, b.ean_code, b.variant_id, v.product_id, p.name AS product_name, p.brand_name, p.gender, p.category_id, cp.category_path FROM barcodes b JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN category_paths cp ON cp.id = p.category_id WHERE REGEXP_REPLACE(UPPER(TRIM(b.ean_code)), '[^A-Z0-9._-]', '', 'g') = ANY($1::text[]) ORDER BY b.id ASC`, [barcodes])

  const conflicts = []

  for (const existing of result.rows) {
    const prepared = sourceByBarcode.get(existing.barcode)

    if (!prepared) continue

    const categoryMismatch = Number(existing.category_id) !== Number(categoryId)
    const genderMismatch = normGender(existing.gender) !== gender
    const productMismatch = normalizeLogicalText(existing.product_name) !== normalizeLogicalText(prepared.ProductName)
    const brandMismatch = normalizeLogicalText(existing.brand_name) !== normalizeLogicalText(prepared.BrandName)

    if (!categoryMismatch && !genderMismatch && !productMismatch && !brandMismatch) {
      continue
    }

    conflicts.push({
      barcode: existing.ean_code,
      incoming_product: prepared.ProductName,
      incoming_brand: prepared.BrandName,
      selected_gender: gender,
      selected_category_id: categoryId,
      existing_product_id: existing.product_id,
      existing_product: existing.product_name,
      existing_brand: existing.brand_name,
      existing_gender: existing.gender,
      existing_category_id: existing.category_id,
      existing_category_path: existing.category_path
    })
  }

  return conflicts
}

function normalizeImportSearchText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/co[\s-]*ords?/g, ' coord ')
    .replace(/t[\s-]*shirts?/g, ' tshirt ')
    .replace(/round[\s-]*necks?/g, ' roundneck ')
    .replace(/half[\s-]*sleeves?/g, ' halfsleeve ')
    .replace(/full[\s-]*sleeves?/g, ' fullsleeve ')
    .replace(/3\s*\/\s*4(?:th)?/g, ' threequarter ')
    .replace(/three[\s-]*quarters?/g, ' threequarter ')
    .replace(/night[\s-]*dresses?/g, ' nightdress ')
    .replace(/western[\s-]*wear/g, ' westernwear ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeImportToken(token) {
  const aliases = {
    mens: 'man',
    man: 'man',
    male: 'man',
    womens: 'woman',
    woman: 'woman',
    women: 'woman',
    ladies: 'woman',
    lady: 'woman',
    female: 'woman',
    kids: 'kid',
    kid: 'kid',
    child: 'kid',
    children: 'kid',
    boys: 'boy',
    boy: 'boy',
    girls: 'girl',
    girl: 'girl',
    tshirts: 'tshirt',
    tshirt: 'tshirt',
    tee: 'tshirt',
    tees: 'tshirt',
    shirts: 'shirt',
    shirt: 'shirt',
    tops: 'top',
    top: 'top',
    pants: 'pant',
    pant: 'pant',
    trousers: 'pant',
    trouser: 'pant',
    jeans: 'jean',
    jean: 'jean',
    cargos: 'cargo',
    cargo: 'cargo',
    joggers: 'jogger',
    jogger: 'jogger',
    shorts: 'short',
    short: 'short',
    dresses: 'dress',
    dress: 'dress',
    frocks: 'dress',
    frock: 'dress',
    nighties: 'nightdress',
    nightys: 'nightdress',
    nighty: 'nightdress',
    kurtis: 'kurti',
    kurti: 'kurti',
    kurthis: 'kurti',
    kurthi: 'kurti',
    suits: 'suit',
    suit: 'suit',
    oversized: 'oversize',
    oversize: 'oversize',
    bagge: 'baggy',
    baggies: 'baggy',
    baggy: 'baggy',
    polos: 'polo',
    polo: 'polo',
    coord: 'coord',
    coords: 'coord',
    capris: 'threequarter',
    capri: 'threequarter'
  }

  return aliases[token] || token
}

function tokenizeImportText(value) {
  const normalized = normalizeImportSearchText(value)

  if (!normalized) return []

  return normalized
    .split(' ')
    .map(normalizeImportToken)
    .filter(Boolean)
}

function toImportTokenSet(value) {
  return new Set(tokenizeImportText(value))
}

function getImportAudience(category, gender) {
  const tokens = toImportTokenSet(category?.category_path || category?.name || '')

  if (tokens.has('boy')) return 'boy'
  if (tokens.has('girl')) return 'girl'
  if (gender === 'MEN') return 'man'
  if (gender === 'WOMEN') return 'woman'

  return 'kid'
}

function getImportAudienceScore(tokens, audience) {
  const acceptedMap = {
    man: ['man'],
    woman: ['woman'],
    boy: ['boy', 'kid'],
    girl: ['girl', 'kid'],
    kid: ['kid', 'boy', 'girl']
  }

  const blockedMap = {
    man: ['woman', 'boy', 'girl', 'kid'],
    woman: ['man', 'boy', 'girl', 'kid'],
    boy: ['woman', 'man', 'girl'],
    girl: ['woman', 'man', 'boy'],
    kid: ['woman', 'man']
  }

  const accepted = acceptedMap[audience] || []
  const blocked = blockedMap[audience] || []
  const acceptedCount = accepted.filter(token => tokens.has(token)).length
  const blockedCount = blocked.filter(token => tokens.has(token)).length

  return {
    acceptedCount,
    blockedCount,
    mismatch: blockedCount > 0 && acceptedCount === 0
  }
}

function getImportCategoryTokens(category) {
  const path = cleanText(category?.category_path || category?.name || '')
  const segments = path.split('>').map(segment => segment.trim()).filter(Boolean)
  const allTokens = segments.flatMap(tokenizeImportText)
  const leafTokens = segments.length ? tokenizeImportText(segments[segments.length - 1]) : []
  const ignored = new Set(['man', 'woman', 'kid', 'boy', 'girl', 'wear', 'product', 'category', 'collection'])
  const specificTokens = Array.from(new Set(allTokens.filter(token => !ignored.has(token))))
  const specificLeafTokens = Array.from(new Set(leafTokens.filter(token => !ignored.has(token))))

  return {
    specificTokens,
    specificLeafTokens
  }
}

function getValidPreparedRecords(preparedRows) {
  return preparedRows
    .filter(item => !item.error_msg)
    .map(item => rowToPreparedRecord(item.raw))
    .filter(item => item.ProductName && item.BrandName && item.SIZE && item.COLOUR && item.Barcode)
}

function countTokenMatches(tokens, expectedTokens) {
  return expectedTokens.reduce((count, token) => count + (tokens.has(token) ? 1 : 0), 0)
}

function scoreImportWorksheetCandidate({
  validRecords,
  preparedRows,
  worksheetName,
  fileName,
  category,
  gender,
  conflicts
}) {
  const { specificTokens, specificLeafTokens } = getImportCategoryTokens(category)
  const rowText = validRecords
    .slice(0, 500)
    .map(item => [item.ProductName, item.PATTERN, item.FITT, item.MarkCode].filter(Boolean).join(' '))
    .join(' ')

  const rowTokens = toImportTokenSet(rowText)
  const sheetTokens = toImportTokenSet(worksheetName)
  const fileTokens = toImportTokenSet(baseNameNoExt(fileName))
  const audience = getImportAudience(category, gender)
  const rowAudience = getImportAudienceScore(rowTokens, audience)
  const sheetAudience = getImportAudienceScore(sheetTokens, audience)
  const fileAudience = getImportAudienceScore(fileTokens, audience)
  const rowCategoryMatches = countTokenMatches(rowTokens, specificTokens)
  const rowLeafMatches = countTokenMatches(rowTokens, specificLeafTokens)
  const sheetCategoryMatches = countTokenMatches(sheetTokens, specificTokens)
  const fileCategoryMatches = countTokenMatches(fileTokens, specificTokens)

  const genericCategoryTokens = new Set([
    'top',
    'tshirt',
    'shirt',
    'pant',
    'jean',
    'cargo',
    'jogger',
    'short',
    'dress',
    'nightdress',
    'kurti',
    'suit',
    'polo',
    'coord'
  ])

  const discriminatingTokens = specificTokens.filter(token => !genericCategoryTokens.has(token))
  const discriminatingMatches =
    countTokenMatches(rowTokens, discriminatingTokens) +
    countTokenMatches(sheetTokens, discriminatingTokens) +
    countTokenMatches(fileTokens, discriminatingTokens)

  const internalErrorCount = preparedRows.filter(item => item.error_msg).length
  const audienceMismatch =
    rowAudience.mismatch ||
    (
      rowAudience.acceptedCount === 0 &&
      sheetAudience.mismatch &&
      fileAudience.mismatch
    )

  const categoryEvidence =
    rowCategoryMatches > 0 ||
    rowLeafMatches > 0 ||
    sheetCategoryMatches > 0 ||
    fileCategoryMatches > 0 ||
    discriminatingMatches > 0

  const score =
    rowCategoryMatches * 18 +
    rowLeafMatches * 10 +
    sheetCategoryMatches * 8 +
    fileCategoryMatches * 8 +
    discriminatingMatches * 20 +
    rowAudience.acceptedCount * 12 +
    sheetAudience.acceptedCount * 5 +
    fileAudience.acceptedCount * 5 +
    Math.min(validRecords.length, 25) -
    rowAudience.blockedCount * 40 -
    sheetAudience.blockedCount * 10 -
    fileAudience.blockedCount * 10 -
    internalErrorCount * 3 -
    conflicts.length * 1000

  return {
    score,
    categoryEvidence,
    audienceMismatch,
    rowCategoryMatches,
    rowLeafMatches,
    sheetCategoryMatches,
    fileCategoryMatches,
    discriminatingMatches,
    audienceAccepted:
      rowAudience.acceptedCount +
      sheetAudience.acceptedCount +
      fileAudience.acceptedCount,
    internalErrorCount
  }
}

async function selectImportWorksheet(
  workbook,
  category,
  gender,
  createdStatus,
  errorStatus,
  fileName
) {
  const worksheetNames = Array.isArray(workbook.SheetNames)
    ? workbook.SheetNames.filter(Boolean)
    : []

  const candidates = []

  for (const worksheetName of worksheetNames) {
    const worksheet = workbook.Sheets[worksheetName]

    if (!worksheet) continue

    const rows = XLSX.utils.sheet_to_json(worksheet, {
      defval: '',
      raw: true
    })

    if (!rows.length) continue

    const preparedRows = buildPreparedImportRows(
      rows,
      createdStatus,
      errorStatus
    )

    const validRecords = getValidPreparedRecords(preparedRows)

    if (!validRecords.length) continue

    const conflicts = await findImportBarcodeConflicts(
      preparedRows,
      category.id,
      gender
    )

    const scoring = scoreImportWorksheetCandidate({
      validRecords,
      preparedRows,
      worksheetName,
      fileName,
      category,
      gender,
      conflicts
    })

    candidates.push({
      name: worksheetName,
      rows,
      preparedRows,
      validRecords,
      conflicts,
      ...scoring
    })
  }

  if (!candidates.length) {
    return {
      status: 400,
      error: {
        message:
          'No worksheet contains valid rows with ProductName, BrandName, SIZE, COLOUR and Barcode.'
      }
    }
  }

  if (candidates.length === 1) {
    const candidate = candidates[0]

    if (candidate.conflicts.length) {
      return {
        status: 409,
        error: {
          message:
            'One or more barcodes already belong to a different product or category. Import was not created.',
          detected_worksheet: candidate.name,
          conflict_count: candidate.conflicts.length,
          conflicts: candidate.conflicts.slice(0, 50)
        }
      }
    }

    if (candidate.audienceMismatch) {
      return {
        status: 422,
        error: {
          message:
            `The uploaded data does not match ${category.category_path}.`,
          detected_worksheet: candidate.name
        }
      }
    }

    return {
      selected: candidate
    }
  }

  const safeCandidates = candidates
    .filter(candidate =>
      candidate.conflicts.length === 0 &&
      !candidate.audienceMismatch &&
      categoryCandidateIsSafe(candidate)
    )
    .sort((a, b) =>
      b.score - a.score ||
      b.discriminatingMatches - a.discriminatingMatches ||
      b.rowCategoryMatches - a.rowCategoryMatches ||
      b.fileCategoryMatches - a.fileCategoryMatches ||
      b.validRecords.length - a.validRecords.length ||
      a.name.localeCompare(b.name)
    )

  if (!safeCandidates.length) {
    const conflictCandidates = candidates
      .filter(candidate =>
        candidate.conflicts.length > 0 &&
        !candidate.audienceMismatch
      )
      .sort((a, b) =>
        b.score - a.score ||
        a.conflicts.length - b.conflicts.length
      )

    if (conflictCandidates.length) {
      const candidate = conflictCandidates[0]

      return {
        status: 409,
        error: {
          message:
            'The closest worksheet contains barcodes assigned to another product or category.',
          detected_worksheet: candidate.name,
          conflict_count: candidate.conflicts.length,
          conflicts: candidate.conflicts.slice(0, 50)
        }
      }
    }

    return {
      status: 422,
      error: {
        message:
          `The correct worksheet could not be detected for ${category.category_path}.`,
        worksheet_analysis: candidates.map(candidate => ({
          worksheet_name: candidate.name,
          rows: candidate.validRecords.length,
          score: candidate.score,
          category_matches:
            candidate.rowCategoryMatches +
            candidate.sheetCategoryMatches +
            candidate.fileCategoryMatches,
          discriminating_matches:
            candidate.discriminatingMatches,
          audience_mismatch:
            candidate.audienceMismatch
        }))
      }
    }
  }

  const top = safeCandidates[0]
  const second = safeCandidates[1]

  if (second) {
    const scoreGap = top.score - second.score

    const sameSignals =
      top.discriminatingMatches === second.discriminatingMatches &&
      top.rowCategoryMatches === second.rowCategoryMatches &&
      top.sheetCategoryMatches === second.sheetCategoryMatches &&
      top.fileCategoryMatches === second.fileCategoryMatches &&
      top.audienceAccepted === second.audienceAccepted

    if (scoreGap < 5 && sameSignals) {
      return {
        status: 422,
        error: {
          message:
            `More than one worksheet appears to match ${category.category_path}.`,
          worksheet_analysis: safeCandidates
            .slice(0, 5)
            .map(candidate => ({
              worksheet_name: candidate.name,
              rows: candidate.validRecords.length,
              score: candidate.score,
              category_matches:
                candidate.rowCategoryMatches +
                candidate.sheetCategoryMatches +
                candidate.fileCategoryMatches,
              discriminating_matches:
                candidate.discriminatingMatches
            }))
        }
      }
    }
  }

  return {
    selected: top
  }
}

function categoryCandidateIsSafe(candidate) {
  if (candidate.categoryEvidence) return true

  return (
    candidate.audienceAccepted > 0 &&
    candidate.validRecords.length > 0
  )
}

async function getAllowedImportRowStatuses() {
  const result = await pool.query(`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'import_row_status' ORDER BY enumsortorder`)
  return result.rows.map(row => row.enumlabel)
}

function resolveCreatedStatus(enumValues) {
  return enumValues.includes('CREATED') ? 'CREATED' : null
}

function resolveOkStatus(enumValues) {
  return enumValues.includes('OK') ? 'OK' : null
}

function resolveErrorStatus(enumValues) {
  return enumValues.includes('ERROR') ? 'ERROR' : null
}

async function insertImportRowsInBatches(
  client,
  jobId,
  rows,
  createdStatus,
  categoryId
) {
  for (
    let index = 0;
    index < rows.length;
    index += INSERT_CHUNK_SIZE
  ) {
    const chunk = rows.slice(
      index,
      index + INSERT_CHUNK_SIZE
    )

    const values = []
    const params = []
    let parameterIndex = 1

    for (const item of chunk) {
      values.push(`($${parameterIndex++}, $${parameterIndex++}::jsonb, $${parameterIndex++}, $${parameterIndex++}, $${parameterIndex++})`)

      params.push(
        jobId,
        JSON.stringify(item.raw),
        item.status_enum || createdStatus,
        item.error_msg || null,
        categoryId
      )
    }

    await client.query(`INSERT INTO import_rows (import_job_id, raw_row_json, status_enum, error_msg, category_id) VALUES ${values.join(',')}`, params)
  }
}

function toNumber(value) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : 0
}

function uniqueValues(values) {
  const seen = new Set()
  const result = []

  for (const item of values) {
    const value = String(item || '').trim()

    if (!value) continue

    const key = value.toLowerCase()

    if (!seen.has(key)) {
      seen.add(key)
      result.push(value)
    }
  }

  return result
}

function sortVariantValues(values) {
  return uniqueValues(values).sort((a, b) => {
    const aNumber = parseFloat(String(a).replace(/[^\d.]/g, ''))
    const bNumber = parseFloat(String(b).replace(/[^\d.]/g, ''))

    if (
      Number.isFinite(aNumber) &&
      Number.isFinite(bNumber) &&
      aNumber !== bNumber
    ) {
      return aNumber - bNumber
    }

    return String(a).localeCompare(
      String(b),
      undefined,
      { numeric: true }
    )
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

function normalizeGroupColour(value) {
  return String(value || '').trim().toUpperCase()
}

function normalizeGroupSize(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
}

function mergeImages(first, second) {
  const seen = new Set()
  const output = []

  for (
    const item of [
      ...normalizeImages(first),
      ...normalizeImages(second)
    ]
  ) {
    const url = String(
      item?.image_url ||
      item?.imageUrl ||
      item?.secure_url ||
      item?.url ||
      item ||
      ''
    ).trim()

    const key = url.toLowerCase()

    if (!url || seen.has(key)) continue

    seen.add(key)
    output.push(item)
  }

  return output
}

function makeVariantPayload(row) {
  const barcode =
    row.barcode ||
    row.ean_code ||
    ''

  const stockSource = {
    variant_id: row.variant_id,
    variantId: row.variant_id,
    barcode,
    ean_code: barcode,
    on_hand: toNumber(row.on_hand),
    onHand: toNumber(row.on_hand),
    reserved: toNumber(row.reserved),
    available_qty:
      toNumber(row.available_qty),
    availableQty:
      toNumber(row.available_qty)
  }

  return {
    id: row.variant_id,
    variant_id: row.variant_id,
    variantId: row.variant_id,
    variant_ids: [row.variant_id],
    variantIds: [row.variant_id],
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
    barcode,
    ean_code: barcode,
    eanCode: barcode,
    barcodes: barcode ? [barcode] : [],
    ean_codes: barcode ? [barcode] : [],
    eanCodes: barcode ? [barcode] : [],
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
    on_hand: toNumber(row.on_hand),
    onHand: toNumber(row.on_hand),
    reserved: toNumber(row.reserved),
    reserved_qty: toNumber(row.reserved),
    reservedQty: toNumber(row.reserved),
    available_qty: toNumber(row.available_qty),
    availableQty: toNumber(row.available_qty),
    in_stock: toNumber(row.available_qty) > 0,
    inStock: toNumber(row.available_qty) > 0,
    stock_sources: [stockSource],
    stockSources: [stockSource],
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

function mergeVariantPayload(target, source) {
  const existingVariantIds =
    new Set(
      (
        target.variant_ids || []
      ).map(value => String(value))
    )

  const sourceVariantIds =
    source.variant_ids || []

  const newVariantIds =
    sourceVariantIds.filter(
      value =>
        !existingVariantIds.has(
          String(value)
        )
    )

  const shouldAddStock =
    newVariantIds.length > 0

  target.variant_ids = uniqueValues([
    ...(target.variant_ids || []),
    ...sourceVariantIds
  ])

  target.variantIds =
    target.variant_ids

  target.barcodes = uniqueValues([
    ...(target.barcodes || []),
    ...(source.barcodes || [])
  ])

  target.ean_codes =
    target.barcodes

  target.eanCodes =
    target.barcodes

  target.stock_sources = [
    ...(target.stock_sources || []),
    ...(
      source.stock_sources || []
    ).filter(item =>
      newVariantIds.some(
        variantId =>
          String(variantId) ===
          String(item.variant_id)
      )
    )
  ]

  target.stockSources =
    target.stock_sources

  if (shouldAddStock) {
    target.on_hand =
      toNumber(target.on_hand) +
      toNumber(source.on_hand)

    target.onHand =
      target.on_hand

    target.reserved =
      toNumber(target.reserved) +
      toNumber(source.reserved)

    target.reserved_qty =
      target.reserved

    target.reservedQty =
      target.reserved

    target.available_qty =
      toNumber(target.available_qty) +
      toNumber(source.available_qty)

    target.availableQty =
      target.available_qty

    target.in_stock =
      target.available_qty > 0

    target.inStock =
      target.in_stock
  }

  target.image_url =
    target.image_url ||
    source.image_url ||
    ''

  target.imageUrl =
    target.image_url

  target.front_image_url =
    target.front_image_url ||
    source.front_image_url ||
    ''

  target.frontImageUrl =
    target.front_image_url

  target.back_image_url =
    target.back_image_url ||
    source.back_image_url ||
    ''

  target.backImageUrl =
    target.back_image_url

  target.main_image_url =
    target.main_image_url ||
    source.main_image_url ||
    ''

  target.mainImageUrl =
    target.main_image_url

  target.images = mergeImages(
    target.images,
    source.images
  )

  return target
}

function groupStockRows(rows) {
  const productGroups = new Map()

  for (
    const row of
    Array.isArray(rows) ? rows : []
  ) {
    const productKey = [
      String(row.product_id || ''),
      String(row.category_id || '')
    ].join('|')

    if (!productGroups.has(productKey)) {
      productGroups.set(
        productKey,
        {
          product_id:
            row.product_id,
          product_name:
            row.product_name,
          brand_name:
            row.brand_name,
          pattern_code:
            row.pattern_code || '',
          fit_type:
            row.fit_type || null,
          mark_code:
            row.mark_code || null,
          gender:
            row.gender,
          category_id:
            row.category_id,
          category_name:
            row.category_name,
          category_slug:
            row.category_slug,
          parent_category_id:
            row.parent_category_id,
          parent_category_name:
            row.parent_category_name,
          parent_category_slug:
            row.parent_category_slug,
          category_path:
            row.category_path,
          variantMap:
            new Map(),
          rows: []
        }
      )
    }

    const group =
      productGroups.get(productKey)

    const variantKey = [
      normalizeGroupColour(
        row.colour
      ),
      normalizeGroupSize(
        row.size
      )
    ].join('|')

    const payload =
      makeVariantPayload(row)

    const existingVariant =
      group.variantMap.get(
        variantKey
      )

    if (existingVariant) {
      mergeVariantPayload(
        existingVariant,
        payload
      )
    } else {
      group.variantMap.set(
        variantKey,
        payload
      )
    }

    group.rows.push(row)
  }

  const groupedProducts = []

  for (
    const group of
    productGroups.values()
  ) {
    const variants =
      Array.from(
        group.variantMap.values()
      )

    variants.sort((a, b) => {
      const colourCompare =
        String(
          a.colour || ''
        ).localeCompare(
          String(b.colour || ''),
          undefined,
          { numeric: true }
        )

      if (colourCompare !== 0) {
        return colourCompare
      }

      const sizeCompare =
        String(
          a.size || ''
        ).localeCompare(
          String(b.size || ''),
          undefined,
          { numeric: true }
        )

      if (sizeCompare !== 0) {
        return sizeCompare
      }

      return String(
        a.variant_id || ''
      ).localeCompare(
        String(
          b.variant_id || ''
        ),
        undefined,
        { numeric: true }
      )
    })

    const allSizes =
      sortVariantValues(
        variants.map(
          variant =>
            variant.size
        )
      )

    const allColours =
      sortVariantValues(
        variants.map(
          variant =>
            variant.colour
        )
      )

    const allBarcodes =
      uniqueValues(
        variants.flatMap(
          variant =>
            variant.barcodes || []
        )
      )

    const colourGroups =
      new Map()

    for (const row of group.rows) {
      const colourKey =
        normalizeGroupColour(
          row.colour
        ) || 'NO_COLOUR'

      if (!colourGroups.has(colourKey)) {
        colourGroups.set(
          colourKey,
          {
            colour:
              row.colour || '',
            rows: []
          }
        )
      }

      colourGroups
        .get(colourKey)
        .rows
        .push(row)
    }

    for (
      const colourGroup of
      colourGroups.values()
    ) {
      const cardRows =
        colourGroup.rows
          .slice()
          .sort((a, b) => {
            const availableCompare =
              toNumber(
                b.available_qty
              ) -
              toNumber(
                a.available_qty
              )

            if (
              availableCompare !== 0
            ) {
              return availableCompare
            }

            const bHasImage =
              Boolean(
                b.front_image_url ||
                b.main_image_url ||
                b.image_url
              )

            const aHasImage =
              Boolean(
                a.front_image_url ||
                a.main_image_url ||
                a.image_url
              )

            if (
              bHasImage !== aHasImage
            ) {
              return (
                Number(bHasImage) -
                Number(aHasImage)
              )
            }

            return String(
              a.variant_id || ''
            ).localeCompare(
              String(
                b.variant_id || ''
              ),
              undefined,
              { numeric: true }
            )
          })

      const selected =
        cardRows[0] || {}

      const imageRow =
        cardRows.find(
          row =>
            row.front_image_url ||
            row.main_image_url ||
            row.image_url
        ) || selected

      const cardVariantIds =
        new Set(
          cardRows.map(
            row =>
              String(row.variant_id)
          )
        )

      const cardVariants =
        variants.filter(variant =>
          (
            variant.variant_ids || []
          ).some(variantId =>
            cardVariantIds.has(
              String(variantId)
            )
          )
        )

      const cardSizes =
        sortVariantValues(
          cardVariants.map(
            variant =>
              variant.size
          )
        )

      const cardBarcodes =
        uniqueValues(
          cardVariants.flatMap(
            variant =>
              variant.barcodes || []
          )
        )

      const cardVariantIdsList =
        uniqueValues(
          cardVariants.flatMap(
            variant =>
              variant.variant_ids || []
          )
        )

      const stockSources =
        cardVariants.flatMap(
          variant =>
            variant.stock_sources || []
        )

      const totalOnHand =
        cardVariants.reduce(
          (sum, variant) =>
            sum +
            toNumber(
              variant.on_hand
            ),
          0
        )

      const totalReserved =
        cardVariants.reduce(
          (sum, variant) =>
            sum +
            toNumber(
              variant.reserved
            ),
          0
        )

      const totalAvailable =
        cardVariants.reduce(
          (sum, variant) =>
            sum +
            toNumber(
              variant.available_qty
            ),
          0
        )

      const selectedColour =
        colourGroup.colour ||
        selected.colour ||
        ''

      const selectedImages =
        normalizeImages(
          imageRow.images
        )

      groupedProducts.push({
        id:
          selected.variant_id ||
          group.product_id,
        product_id:
          group.product_id,
        productId:
          group.product_id,
        primary_variant_id:
          selected.variant_id,
        primaryVariantId:
          selected.variant_id,
        variant_id:
          selected.variant_id,
        variantId:
          selected.variant_id,
        variant_ids:
          cardVariantIdsList,
        variantIds:
          cardVariantIdsList,
        product_name:
          group.product_name,
        productName:
          group.product_name,
        name:
          group.product_name,
        title:
          group.product_name,
        brand_name:
          group.brand_name,
        brandName:
          group.brand_name,
        brand:
          group.brand_name,
        pattern_code:
          group.pattern_code,
        patternCode:
          group.pattern_code,
        fit_type:
          group.fit_type,
        fitType:
          group.fit_type,
        mark_code:
          group.mark_code,
        markCode:
          group.mark_code,
        gender:
          group.gender,
        category:
          group.gender,
        category_id:
          group.category_id,
        categoryId:
          group.category_id,
        category_name:
          group.category_name,
        categoryName:
          group.category_name,
        category_slug:
          group.category_slug,
        categorySlug:
          group.category_slug,
        parent_category_id:
          group.parent_category_id,
        parentCategoryId:
          group.parent_category_id,
        parent_category_name:
          group.parent_category_name,
        parentCategoryName:
          group.parent_category_name,
        parent_category_slug:
          group.parent_category_slug,
        parentCategorySlug:
          group.parent_category_slug,
        category_path:
          group.category_path,
        categoryPath:
          group.category_path,
        size:
          cardSizes.join(', '),
        size_summary:
          allSizes.join(', '),
        sizeSummary:
          allSizes.join(', '),
        display_size:
          cardSizes.join(', '),
        displaySize:
          cardSizes.join(', '),
        colour:
          selectedColour,
        color:
          selectedColour,
        selected_colour:
          selectedColour,
        selectedColor:
          selectedColour,
        colour_summary:
          allColours.join(', '),
        color_summary:
          allColours.join(', '),
        colourSummary:
          allColours.join(', '),
        colorSummary:
          allColours.join(', '),
        display_color:
          selectedColour,
        displayColor:
          selectedColour,
        sizes:
          cardSizes,
        all_sizes:
          allSizes,
        allSizes,
        colours:
          allColours,
        colors:
          allColours,
        barcodes:
          cardBarcodes,
        ean_codes:
          cardBarcodes,
        eanCodes:
          cardBarcodes,
        all_barcodes:
          allBarcodes,
        allBarcodes,
        barcode:
          selected.barcode || '',
        ean_code:
          selected.ean_code ||
          selected.barcode ||
          '',
        eanCode:
          selected.ean_code ||
          selected.barcode ||
          '',
        mrp:
          selected.mrp,
        original_price:
          selected.original_price_b2c,
        originalPrice:
          selected.original_price_b2c,
        base_sale_price:
          selected.base_sale_price,
        baseSalePrice:
          selected.base_sale_price,
        original_sale_price:
          selected.original_sale_price,
        originalSalePrice:
          selected.original_sale_price,
        sale_price:
          selected.sale_price,
        salePrice:
          selected.sale_price,
        price:
          selected.price,
        selling_price:
          selected.selling_price,
        sellingPrice:
          selected.selling_price,
        discounted_price:
          selected.discounted_price,
        discountedPrice:
          selected.discounted_price,
        mahaveer_price:
          selected.mahaveer_price,
        mahaveerPrice:
          selected.mahaveer_price,
        cost_price:
          selected.cost_price,
        costPrice:
          selected.cost_price,
        b2c_discount_pct:
          selected.b2c_discount_pct,
        b2cDiscountPct:
          selected.b2c_discount_pct,
        b2b_discount_pct:
          selected.b2b_discount_pct,
        b2bDiscountPct:
          selected.b2b_discount_pct,
        discount_b2c:
          selected.b2c_discount_pct,
        discountB2c:
          selected.b2c_discount_pct,
        discount_b2b:
          selected.b2b_discount_pct,
        discountB2b:
          selected.b2b_discount_pct,
        discount:
          selected.b2c_discount_pct,
        discount_percentage:
          selected.b2c_discount_pct,
        discountPercentage:
          selected.b2c_discount_pct,
        discount_percent:
          selected.b2c_discount_pct,
        discountPercent:
          selected.b2c_discount_pct,
        original_price_b2c:
          selected.original_price_b2c,
        originalPriceB2c:
          selected.original_price_b2c,
        final_price_b2c:
          selected.final_price_b2c,
        finalPriceB2c:
          selected.final_price_b2c,
        original_price_b2b:
          selected.original_price_b2b,
        originalPriceB2b:
          selected.original_price_b2b,
        final_price_b2b:
          selected.final_price_b2b,
        finalPriceB2b:
          selected.final_price_b2b,
        b2c_final_price:
          selected.final_price_b2c,
        b2cFinalPrice:
          selected.final_price_b2c,
        b2b_final_price:
          selected.final_price_b2b,
        b2bFinalPrice:
          selected.final_price_b2b,
        final_price:
          selected.final_price_b2c,
        finalPrice:
          selected.final_price_b2c,
        on_hand:
          totalOnHand,
        onHand:
          totalOnHand,
        reserved:
          totalReserved,
        reserved_qty:
          totalReserved,
        reservedQty:
          totalReserved,
        available_qty:
          totalAvailable,
        availableQty:
          totalAvailable,
        total_count:
          totalOnHand,
        totalCount:
          totalOnHand,
        in_stock:
          totalAvailable > 0,
        inStock:
          totalAvailable > 0,
        stock_sources:
          stockSources,
        stockSources,
        image_url:
          imageRow.image_url || '',
        imageUrl:
          imageRow.image_url || '',
        front_image_url:
          imageRow.front_image_url || '',
        frontImageUrl:
          imageRow.front_image_url || '',
        back_image_url:
          imageRow.back_image_url || '',
        backImageUrl:
          imageRow.back_image_url || '',
        main_image_url:
          imageRow.main_image_url || '',
        mainImageUrl:
          imageRow.main_image_url || '',
        images:
          selectedImages,
        variant_count:
          variants.length,
        variantCount:
          variants.length,
        color_variant_count:
          cardVariants.length,
        colorVariantCount:
          cardVariants.length,
        card_group_index:
          0,
        cardGroupIndex:
          0,
        variants,
        color_variants:
          cardVariants,
        colorVariants:
          cardVariants
      })
    }
  }

  groupedProducts.sort(
    (a, b) => {
      const categoryCompare =
        String(
          a.category_path || ''
        ).localeCompare(
          String(
            b.category_path || ''
          ),
          undefined,
          { numeric: true }
        )

      if (categoryCompare !== 0) {
        return categoryCompare
      }

      const brandCompare =
        String(
          a.brand_name || ''
        ).localeCompare(
          String(
            b.brand_name || ''
          ),
          undefined,
          { numeric: true }
        )

      if (brandCompare !== 0) {
        return brandCompare
      }

      const nameCompare =
        String(
          a.product_name || ''
        ).localeCompare(
          String(
            b.product_name || ''
          ),
          undefined,
          { numeric: true }
        )

      if (nameCompare !== 0) {
        return nameCompare
      }

      const colourCompare =
        String(
          a.colour || ''
        ).localeCompare(
          String(
            b.colour || ''
          ),
          undefined,
          { numeric: true }
        )

      if (colourCompare !== 0) {
        return colourCompare
      }

      return String(
        a.variant_id || ''
      ).localeCompare(
        String(
          b.variant_id || ''
        ),
        undefined,
        { numeric: true }
      )
    }
  )

  return groupedProducts
}

router.get(
  '/:branchId/import-jobs',
  async (req, res) => {
    noStore(res)

    const branchId =
      parseBranchId(req)

    if (!branchId) {
      return res.status(400).json({
        message: 'Invalid branchId'
      })
    }

    try {
      const branchExists =
        await ensureBranchExists(
          branchId
        )

      if (!branchExists) {
        return res.status(404).json({
          message: 'Branch not found'
        })
      }

      await ensureImportRowsTable()

      const result =
        await pool.query(
          `${ALL_CATEGORY_PATHS_CTE} SELECT ij.id, ij.file_name, ij.worksheet_name, ij.file_url, ij.uploaded_by, ij.status_enum, ij.rows_total, ij.rows_success, ij.rows_error, ij.uploaded_at, ij.completed_at, ij.branch_id, ij.gender, ij.category_id, c.name AS category_name, c.slug AS category_slug, pc.id AS parent_category_id, pc.name AS parent_category_name, pc.slug AS parent_category_slug, cp.category_path FROM import_jobs ij LEFT JOIN product_categories c ON c.id = ij.category_id LEFT JOIN product_categories pc ON pc.id = c.parent_id LEFT JOIN category_paths cp ON cp.id = ij.category_id WHERE ij.branch_id = $1 ORDER BY ij.id DESC LIMIT 100`,
          [branchId]
        )

      return res.json(result.rows)
    } catch (error) {
      return res.status(500).json({
        message:
          error.message ||
          'Server error'
      })
    }
  }
)

router.get(
  '/:branchId/import-rows',
  async (req, res) => {
    noStore(res)

    const branchId =
      parseBranchId(req)

    if (!branchId) {
      return res.status(400).json({
        message: 'Invalid branchId'
      })
    }

    const jobId =
      req.query.jobId
        ? parseInt(
            req.query.jobId,
            10
          )
        : null

    const offset = Math.max(
      0,
      parseInt(
        req.query.offset || '0',
        10
      )
    )

    const limit = Math.max(
      1,
      Math.min(
        500,
        parseInt(
          req.query.limit || '200',
          10
        )
      )
    )

    const status =
      String(
        req.query.status || ''
      ).trim()

    try {
      const branchExists =
        await ensureBranchExists(
          branchId
        )

      if (!branchExists) {
        return res.status(404).json({
          message: 'Branch not found'
        })
      }

      await ensureImportRowsTable()

      let job

      if (jobId) {
        const result =
          await pool.query(
            `${ALL_CATEGORY_PATHS_CTE} SELECT ij.*, c.name AS category_name, c.slug AS category_slug, pc.id AS parent_category_id, pc.name AS parent_category_name, pc.slug AS parent_category_slug, cp.category_path FROM import_jobs ij LEFT JOIN product_categories c ON c.id = ij.category_id LEFT JOIN product_categories pc ON pc.id = c.parent_id LEFT JOIN category_paths cp ON cp.id = ij.category_id WHERE ij.id = $1 AND ij.branch_id = $2`,
            [jobId, branchId]
          )

        if (!result.rows.length) {
          return res.status(404).json({
            message: 'Job not found'
          })
        }

        job = result.rows[0]
      } else {
        const result =
          await pool.query(
            `${ALL_CATEGORY_PATHS_CTE} SELECT ij.*, c.name AS category_name, c.slug AS category_slug, pc.id AS parent_category_id, pc.name AS parent_category_name, pc.slug AS parent_category_slug, cp.category_path FROM import_jobs ij LEFT JOIN product_categories c ON c.id = ij.category_id LEFT JOIN product_categories pc ON pc.id = c.parent_id LEFT JOIN category_paths cp ON cp.id = ij.category_id WHERE ij.branch_id = $1 ORDER BY ij.id DESC LIMIT 1`,
            [branchId]
          )

        if (!result.rows.length) {
          return res.json({
            job: null,
            rows: [],
            nextOffset: offset,
            total: 0
          })
        }

        job = result.rows[0]
      }

      const params = [job.id]
      let whereClause = 'import_job_id = $1'

      if (status) {
        params.push(status)
        whereClause +=
          ` AND status_enum = $${params.length}`
      }

      const totalResult =
        await pool.query(
          `SELECT COUNT(*)::int AS count FROM import_rows WHERE ${whereClause}`,
          params
        )

      params.push(limit, offset)

      const rowsResult =
        await pool.query(
          `SELECT id, status_enum, error_msg, raw_row_json, category_id FROM import_rows WHERE ${whereClause} ORDER BY id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        )

      return res.json({
        job: {
          id: job.id,
          file_name:
            job.file_name,
          worksheet_name:
            job.worksheet_name,
          status_enum:
            job.status_enum,
          rows_total:
            job.rows_total,
          rows_success:
            job.rows_success,
          rows_error:
            job.rows_error,
          uploaded_at:
            job.uploaded_at,
          completed_at:
            job.completed_at,
          gender:
            job.gender,
          category_id:
            job.category_id,
          category_name:
            job.category_name,
          category_slug:
            job.category_slug,
          parent_category_id:
            job.parent_category_id,
          parent_category_name:
            job.parent_category_name,
          parent_category_slug:
            job.parent_category_slug,
          category_path:
            job.category_path
        },
        rows: rowsResult.rows,
        nextOffset:
          offset +
          rowsResult.rows.length,
        total:
          totalResult.rows[0].count
      })
    } catch (error) {
      return res.status(500).json({
        message:
          error.message ||
          'Server error'
      })
    }
  }
)

router.post(
  '/:branchId/import',
  upload.single('file'),
  async (req, res) => {
    const branchId =
      parseBranchId(req)

    if (!branchId) {
      return res.status(400).json({
        message: 'Invalid branchId'
      })
    }

    if (!req.file) {
      return res.status(400).json({
        message: 'File required'
      })
    }

    const gender =
      normGender(req.body?.gender)

    if (!gender) {
      return res.status(400).json({
        message:
          'Category is required (MEN/WOMEN/KIDS)'
      })
    }

    const client =
      await pool.connect()

    let transactionStarted = false

    try {
      const branchExists =
        await ensureBranchExists(
          branchId
        )

      if (!branchExists) {
        return res.status(404).json({
          message: 'Branch not found'
        })
      }

      await ensureImportRowsTable()

      const category =
        await validateCategory(
          req.body?.category_id,
          gender
        )

      if (!category) {
        return res.status(400).json({
          message:
            'Valid active leaf sub-category is required'
        })
      }

      const enumValues =
        await getAllowedImportRowStatuses()

      const createdStatus =
        resolveCreatedStatus(
          enumValues
        )

      const errorStatus =
        resolveErrorStatus(
          enumValues
        )

      if (
        !createdStatus ||
        !errorStatus
      ) {
        return res.status(500).json({
          message:
            `Unsupported import_row_status enum values: ${enumValues.join(', ')}`
        })
      }

      const workbook = XLSX.read(
        req.file.buffer,
        { type: 'buffer' }
      )

      const worksheetSelection =
        await selectImportWorksheet(
          workbook,
          category,
          gender,
          createdStatus,
          errorStatus,
          req.file.originalname || ''
        )

      if (!worksheetSelection.selected) {
        return res
          .status(
            worksheetSelection.status ||
            422
          )
          .json(
            worksheetSelection.error || {
              message:
                'Unable to detect matching worksheet'
            }
          )
      }

      const worksheetName =
        worksheetSelection.selected.name

      const preparedRows =
        worksheetSelection.selected.preparedRows

      const barcodeConflicts =
        worksheetSelection.selected.conflicts

      if (barcodeConflicts.length) {
        return res.status(409).json({
          message:
            'One or more barcodes already belong to a different product or category. Import was not created.',
          worksheet_name:
            worksheetName,
          conflict_count:
            barcodeConflicts.length,
          conflicts:
            barcodeConflicts.slice(
              0,
              50
            )
        })
      }

      const initialErrorCount =
        preparedRows.filter(
          row =>
            row.status_enum ===
            errorStatus
        ).length

      await client.query('BEGIN')
      transactionStarted = true

      const fileName =
        req.file.originalname ||
        `import_${Date.now()}.xlsx`

      const initialStatus =
        preparedRows.length === 0
          ? 'COMPLETE'
          : 'PENDING'

      const completedAtSql =
        preparedRows.length === 0
          ? 'NOW()'
          : 'NULL'

      const result =
        await client.query(
          `INSERT INTO import_jobs (file_name, worksheet_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, branch_id, gender, category_id, completed_at) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, ${completedAtSql}) RETURNING id, file_name, worksheet_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, uploaded_at, completed_at, branch_id, gender, category_id`,
          [
            fileName,
            worksheetName,
            null,
            null,
            initialStatus,
            preparedRows.length,
            initialErrorCount,
            branchId,
            gender,
            category.id
          ]
        )

      const job =
        result.rows[0]

      if (preparedRows.length) {
        await insertImportRowsInBatches(
          client,
          job.id,
          preparedRows,
          createdStatus,
          category.id
        )
      }

      await client.query('COMMIT')
      transactionStarted = false

      return res.status(201).json({
        ...job,
        worksheet_name:
          worksheetName,
        category_name:
          category.name,
        category_slug:
          category.slug,
        category_path:
          category.category_path
      })
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query(
            'ROLLBACK'
          )
        } catch {}
      }

      return res.status(500).json({
        message:
          error.message ||
          'Server error'
      })
    } finally {
      client.release()
    }
  }
)

router.post(
  '/:branchId/import/process/:jobId',
  async (req, res) => {
    const branchId =
      parseBranchId(req)

    if (!branchId) {
      return res.status(400).json({
        message: 'Invalid branchId'
      })
    }

    const jobId =
      parsePositiveInt(
        req.params.jobId
      )

    if (!jobId) {
      return res.status(400).json({
        message: 'Invalid jobId'
      })
    }

    const requestedLimit =
      parseInt(
        req.query.limit ||
        String(PROCESS_MAX_LIMIT),
        10
      )

    const limit =
      Number.isInteger(
        requestedLimit
      )
        ? Math.max(
            1,
            Math.min(
              PROCESS_MAX_LIMIT,
              requestedLimit
            )
          )
        : PROCESS_MAX_LIMIT

    try {
      const branchExists =
        await ensureBranchExists(
          branchId
        )

      if (!branchExists) {
        return res.status(404).json({
          message: 'Branch not found'
        })
      }

      await ensureImportRowsTable()

      const enumValues =
        await getAllowedImportRowStatuses()

      const createdStatus =
        resolveCreatedStatus(
          enumValues
        )

      const okStatus =
        resolveOkStatus(
          enumValues
        )

      const errorStatus =
        resolveErrorStatus(
          enumValues
        )

      if (
        !createdStatus ||
        !okStatus ||
        !errorStatus
      ) {
        return res.status(500).json({
          message:
            `Unsupported import_row_status enum values: ${enumValues.join(', ')}`
        })
      }

      const jobResult =
        await pool.query(
          `SELECT id, file_url, status_enum, rows_total, rows_success, rows_error, gender, category_id FROM import_jobs WHERE id = $1 AND branch_id = $2`,
          [jobId, branchId]
        )

      if (!jobResult.rows.length) {
        return res.status(404).json({
          message: 'Job not found'
        })
      }

      const job =
        jobResult.rows[0]

      const status =
        String(
          job.status_enum || ''
        ).toUpperCase()

      if (
        status === 'COMPLETE' ||
        status === 'PARTIAL' ||
        status === 'FAILED'
      ) {
        return res.json({
          done: true,
          processed: 0,
          nextStart:
            (job.rows_success || 0) +
            (job.rows_error || 0),
          ok: 0,
          err: 0,
          totalRows:
            job.rows_total || 0
        })
      }

      const client =
        await pool.connect()

      let ok = 0
      let err = 0

      const errorMap =
        new Map()

      const errorSamples = []

      try {
        const batchResult =
          await client.query(
            `SELECT id, raw_row_json, category_id FROM import_rows WHERE import_job_id = $1 AND status_enum = $2 ORDER BY id ASC LIMIT $3`,
            [
              jobId,
              createdStatus,
              limit
            ]
          )

        const rowsToProcess =
          batchResult.rows

        if (!rowsToProcess.length) {
          const countResult =
            await client.query(
              `SELECT COUNT(*) FILTER (WHERE status_enum = $2)::int AS ok_count, COUNT(*) FILTER (WHERE status_enum = $3)::int AS error_count FROM import_rows WHERE import_job_id = $1`,
              [
                jobId,
                okStatus,
                errorStatus
              ]
            )

          const finalSuccess =
            countResult.rows[0]
              ?.ok_count || 0

          const finalError =
            countResult.rows[0]
              ?.error_count || 0

          const finalStatus =
            finalSuccess === 0 &&
            finalError > 0
              ? 'FAILED'
              : finalError > 0
                ? 'PARTIAL'
                : 'COMPLETE'

          await client.query(
            `UPDATE import_jobs SET rows_success = $1, rows_error = $2, status_enum = $3, completed_at = NOW() WHERE id = $4`,
            [
              finalSuccess,
              finalError,
              finalStatus,
              jobId
            ]
          )

          return res.json({
            done: true,
            processed: 0,
            nextStart:
              finalSuccess +
              finalError,
            ok: 0,
            err: 0,
            totalRows:
              job.rows_total || 0
          })
        }

        const gender =
          normGender(job.gender)

        const categoryId =
          parsePositiveInt(
            job.category_id
          )

        const category =
          await validateCategory(
            categoryId,
            gender
          )

        if (!category) {
          return res.status(400).json({
            message:
              'Import job category is invalid or is not a selectable leaf category'
          })
        }

        for (
          const batchRow of
          rowsToProcess
        ) {
          const raw =
            batchRow.raw_row_json || {}

          const prepared =
            rowToPreparedRecord(raw)

          if (
            !prepared.ProductName ||
            !prepared.BrandName ||
            !prepared.SIZE ||
            !prepared.COLOUR ||
            !prepared.Barcodes.length
          ) {
            const message =
              'Missing required fields (ProductName/BrandName/SIZE/COLOUR/Barcode)'

            await client.query(
              `UPDATE import_rows SET status_enum = $2, error_msg = $3, processed_at = NOW() WHERE id = $1`,
              [
                batchRow.id,
                errorStatus,
                message
              ]
            )

            err += 1

            errorMap.set(
              message,
              (
                errorMap.get(
                  message
                ) || 0
              ) + 1
            )

            if (
              errorSamples.length < 5
            ) {
              errorSamples.push({
                row: raw,
                error: message
              })
            }

            continue
          }

          try {
            await client.query(
              'BEGIN'
            )

            const barcode =
              prepared.Barcode

            const existingBarcodeResult =
              await client.query(
                `WITH RECURSIVE category_paths AS (SELECT c.id, c.parent_id, c.name, c.name::text AS category_path FROM product_categories c WHERE c.parent_id IS NULL UNION ALL SELECT c.id, c.parent_id, c.name, category_paths.category_path || ' > ' || c.name FROM product_categories c JOIN category_paths ON category_paths.id = c.parent_id) SELECT b.id AS barcode_id, b.ean_code, b.variant_id, v.product_id, p.name AS product_name, p.brand_name, p.pattern_code, p.gender, p.category_id, cp.category_path FROM barcodes b JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN category_paths cp ON cp.id = p.category_id WHERE REGEXP_REPLACE(UPPER(TRIM(b.ean_code)), '[^A-Z0-9._-]', '', 'g') = $1 ORDER BY b.id ASC LIMIT 1 FOR UPDATE OF b, v, p`,
                [barcode]
              )

            let productId
            let variantId

            if (
              existingBarcodeResult.rowCount
            ) {
              const existing =
                existingBarcodeResult
                  .rows[0]

              if (
                Number(
                  existing.category_id
                ) !==
                  Number(categoryId) ||
                normGender(
                  existing.gender
                ) !== gender
              ) {
                throw new Error(
                  `Barcode ${barcode} belongs to ${existing.category_path || existing.category_id}, not ${category.category_path}`
                )
              }

              if (
                normalizeLogicalText(
                  existing.product_name
                ) !==
                  normalizeLogicalText(
                    prepared.ProductName
                  ) ||
                normalizeLogicalText(
                  existing.brand_name
                ) !==
                  normalizeLogicalText(
                    prepared.BrandName
                  )
              ) {
                throw new Error(
                  `Barcode ${barcode} belongs to ${existing.product_name} / ${existing.brand_name}`
                )
              }

              productId =
                existing.product_id

              variantId =
                existing.variant_id

              await client.query(
                `UPDATE products SET fit_type = COALESCE($1, fit_type), mark_code = COALESCE($2, mark_code), updated_at = NOW() WHERE id = $3`,
                [
                  prepared.FITT,
                  prepared.MarkCode,
                  productId
                ]
              )

              await client.query(
                `UPDATE product_variants SET size = $1, colour = $2, is_active = TRUE, mrp = $3, sale_price = $4, cost_price = $5, b2c_discount_pct = $6, b2b_discount_pct = $7, updated_at = NOW() WHERE id = $8`,
                [
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
              if (!prepared.PATTERN) {
                const patternResult =
                  await client.query(
                    `SELECT COUNT(*)::int AS count FROM products WHERE category_id = $1 AND gender = $2 AND LOWER(TRIM(name)) = LOWER(TRIM($3)) AND LOWER(TRIM(brand_name)) = LOWER(TRIM($4)) AND NULLIF(TRIM(COALESCE(pattern_code, '')), '') IS NOT NULL`,
                    [
                      categoryId,
                      gender,
                      prepared.ProductName,
                      prepared.BrandName
                    ]
                  )

                if (
                  (
                    patternResult.rows[0]
                      ?.count || 0
                  ) > 0
                ) {
                  throw new Error(
                    `Pattern/Style code is required for new barcode ${barcode}`
                  )
                }
              }

              const productResult =
                await client.query(
                  `INSERT INTO products (name, brand_name, pattern_code, fit_type, mark_code, gender, category_id) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (name, brand_name, pattern_code, gender, category_id) DO UPDATE SET fit_type = COALESCE(EXCLUDED.fit_type, products.fit_type), mark_code = COALESCE(EXCLUDED.mark_code, products.mark_code), updated_at = NOW() RETURNING id`,
                  [
                    prepared.ProductName,
                    prepared.BrandName,
                    prepared.PATTERN,
                    prepared.FITT,
                    prepared.MarkCode,
                    gender,
                    categoryId
                  ]
                )

              productId =
                productResult.rows[0].id

              const variantResult =
                await client.query(
                  `INSERT INTO product_variants (product_id, size, colour, is_active, mrp, sale_price, cost_price, b2c_discount_pct, b2b_discount_pct, created_at, updated_at) VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7, $8, NOW(), NOW()) RETURNING id`,
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

              variantId =
                variantResult.rows[0].id

              await client.query(
                `INSERT INTO barcodes (variant_id, ean_code) VALUES ($1, $2)`,
                [
                  variantId,
                  barcode
                ]
              )
            }

            await client.query(
              `INSERT INTO branch_variant_stock (branch_id, variant_id, on_hand, reserved, is_active, created_at, updated_at) VALUES ($1, $2, $3, 0, TRUE, NOW(), NOW()) ON CONFLICT (branch_id, variant_id) DO UPDATE SET on_hand = EXCLUDED.on_hand, reserved = LEAST(branch_variant_stock.reserved, EXCLUDED.on_hand), is_active = TRUE, updated_at = NOW()`,
              [
                branchId,
                variantId,
                prepared.PurchaseQty
              ]
            )

            await client.query(
              `UPDATE import_rows SET status_enum = $2, error_msg = NULL, category_id = $3, processed_at = NOW() WHERE id = $1`,
              [
                batchRow.id,
                okStatus,
                categoryId
              ]
            )

            await client.query(
              'COMMIT'
            )

            ok += 1
          } catch (error) {
            await client.query(
              'ROLLBACK'
            )

            const message =
              String(
                error.message ||
                'error'
              ).slice(0, 500)

            await client.query(
              `UPDATE import_rows SET status_enum = $2, error_msg = $3, processed_at = NOW() WHERE id = $1`,
              [
                batchRow.id,
                errorStatus,
                message
              ]
            )

            err += 1

            errorMap.set(
              message,
              (
                errorMap.get(
                  message
                ) || 0
              ) + 1
            )

            if (
              errorSamples.length < 5
            ) {
              errorSamples.push({
                row: raw,
                error: message
              })
            }
          }
        }
      } finally {
        client.release()
      }

      const statusResult =
        await pool.query(
          `SELECT COUNT(*) FILTER (WHERE status_enum = $2)::int AS pending_count, COUNT(*) FILTER (WHERE status_enum = $3)::int AS ok_count, COUNT(*) FILTER (WHERE status_enum = $4)::int AS error_count FROM import_rows WHERE import_job_id = $1`,
          [
            jobId,
            createdStatus,
            okStatus,
            errorStatus
          ]
        )

      const counts =
        statusResult.rows[0]

      const pendingCount =
        counts.pending_count || 0

      const okCount =
        counts.ok_count || 0

      const errorCount =
        counts.error_count || 0

      const processedCount =
        okCount + errorCount

      const isDone =
        pendingCount === 0

      let finalStatus = 'PENDING'

      if (isDone) {
        if (
          okCount === 0 &&
          errorCount > 0
        ) {
          finalStatus = 'FAILED'
        } else if (
          errorCount > 0
        ) {
          finalStatus = 'PARTIAL'
        } else {
          finalStatus = 'COMPLETE'
        }
      }

      await pool.query(
        `UPDATE import_jobs SET rows_total = $1, rows_success = $2, rows_error = $3, status_enum = $4, completed_at = CASE WHEN $4 IN ('COMPLETE', 'PARTIAL', 'FAILED') THEN NOW() ELSE completed_at END WHERE id = $5`,
        [
          job.rows_total || 0,
          okCount,
          errorCount,
          finalStatus,
          jobId
        ]
      )

      const errorCounts =
        Array.from(
          errorMap.entries()
        )
          .map(
            ([message, count]) => ({
              message,
              count
            })
          )
          .sort(
            (a, b) =>
              b.count - a.count
          )
          .slice(0, 10)

      return res.json({
        done: isDone,
        processed: ok + err,
        ok,
        err,
        totalRows:
          job.rows_total || 0,
        nextStart:
          processedCount,
        error_counts:
          errorCounts,
        errors_sample:
          errorSamples
      })
    } catch (error) {
      return res.status(500).json({
        message:
          error.message ||
          'Server error'
      })
    }
  }
)

router.post(
  '/:branchId/images/confirm',
  async (req, res) => {
    const branchId =
      parseBranchId(req)

    if (!branchId) {
      return res.status(400).json({
        message: 'Invalid branchId'
      })
    }

    const images =
      Array.isArray(
        req.body?.images
      )
        ? req.body.images
        : []

    if (!images.length) {
      return res.status(400).json({
        message: 'No images'
      })
    }

    try {
      const branchExists =
        await ensureBranchExists(
          branchId
        )

      if (!branchExists) {
        return res.status(404).json({
          message: 'Branch not found'
        })
      }

      await ensureProductImagesTable()

      const client =
        await pool.connect()

      let updated = 0
      const unmatched = []

      try {
        await client.query('BEGIN')

        for (const image of images) {
          const directBarcode =
            normalizeBarcode(
              image.barcode ||
              image.ean_code ||
              image.ean ||
              ''
            )

          const fallbackBarcode =
            extractBarcodeFromName(
              image.original_filename ||
              image.public_id ||
              ''
            )

          const barcode =
            directBarcode ||
            fallbackBarcode

          const imageType =
            normalizeImageType(
              image.image_type ||
              extractImageTypeFromName(
                image.original_filename ||
                image.public_id ||
                ''
              )
            )

          const imageUrl =
            String(
              image.secure_url ||
              image.url ||
              image.image_url ||
              ''
            ).trim()

          const publicId =
            String(
              image.public_id || ''
            ).trim()

          if (
            !barcode ||
            !imageUrl
          ) {
            unmatched.push({
              barcode:
                barcode || null,
              image_type:
                imageType,
              original_filename:
                image.original_filename ||
                '',
              reason:
                'Missing barcode or URL'
            })

            continue
          }

          const barcodeResult =
            await client.query(
              `SELECT b.ean_code, b.variant_id, v.product_id, v.is_active AS variant_active, bvs.branch_id, bvs.is_active AS stock_active, bvs.on_hand FROM barcodes b JOIN product_variants v ON v.id = b.variant_id LEFT JOIN branch_variant_stock bvs ON bvs.variant_id = v.id AND bvs.branch_id = $2 WHERE REGEXP_REPLACE(UPPER(TRIM(b.ean_code)), '[^A-Z0-9._-]', '', 'g') = $1 ORDER BY CASE WHEN bvs.branch_id = $2 THEN 0 ELSE 1 END, b.id ASC LIMIT 1`,
              [
                barcode,
                branchId
              ]
            )

          if (
            !barcodeResult.rowCount
          ) {
            unmatched.push({
              barcode,
              image_type:
                imageType,
              original_filename:
                image.original_filename ||
                '',
              reason:
                'Barcode not found in barcodes table'
            })

            continue
          }

          const matched =
            barcodeResult.rows[0]

          if (!matched.branch_id) {
            unmatched.push({
              barcode,
              image_type:
                imageType,
              original_filename:
                image.original_filename ||
                '',
              reason:
                'Barcode found but not available in this branch'
            })

            continue
          }

          if (
            matched.variant_active ===
            false
          ) {
            await client.query(
              `UPDATE product_variants SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
              [matched.variant_id]
            )
          }

          if (
            matched.stock_active ===
            false
          ) {
            await client.query(
              `UPDATE branch_variant_stock SET is_active = TRUE, updated_at = NOW() WHERE branch_id = $1 AND variant_id = $2`,
              [
                branchId,
                matched.variant_id
              ]
            )
          }

          await client.query(
            `INSERT INTO product_images (ean_code, image_type, image_url, public_id, uploaded_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (ean_code, image_type) DO UPDATE SET image_url = EXCLUDED.image_url, public_id = EXCLUDED.public_id, uploaded_at = NOW()`,
            [
              matched.ean_code,
              imageType,
              imageUrl,
              publicId || null
            ]
          )

          if (
            imageType === 'front' ||
            imageType === 'main'
          ) {
            await client.query(
              `UPDATE product_variants SET image_url = $1, updated_at = NOW() WHERE id = $2`,
              [
                imageUrl,
                matched.variant_id
              ]
            )
          } else {
            await client.query(
              `UPDATE product_variants SET image_url = COALESCE(NULLIF(image_url, ''), $1), updated_at = NOW() WHERE id = $2`,
              [
                imageUrl,
                matched.variant_id
              ]
            )
          }

          updated += 1
        }

        await client.query('COMMIT')
      } catch (error) {
        await client.query(
          'ROLLBACK'
        )

        return res.status(500).json({
          message:
            error.message ||
            'DB error'
        })
      } finally {
        client.release()
      }

      return res.json({
        totalUpdated: updated,
        unmatched
      })
    } catch (error) {
      return res.status(500).json({
        message:
          error.message ||
          'Server error'
      })
    }
  }
)

router.get(
  '/:branchId/stock',
  async (req, res) => {
    noStore(res)

    const branchId =
      parseBranchId(req)

    if (!branchId) {
      return res.status(400).json({
        message: 'Invalid branchId'
      })
    }

    const gender =
      normGender(
        req.query?.gender
      )

    const categoryId =
      parsePositiveInt(
        req.query?.category_id
      )

    try {
      const branchExists =
        await ensureBranchExists(
          branchId
        )

      if (!branchExists) {
        return res.status(404).json({
          message: 'Branch not found'
        })
      }

      await ensureProductImagesTable()

      const params = [branchId]

      let whereClause = `bvs.branch_id = $1 AND bvs.is_active = TRUE AND v.is_active = TRUE AND c.is_active = TRUE AND GREATEST(COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0), 0) > 0`

      if (gender) {
        params.push(gender)
        whereClause += ` AND p.gender = $${params.length}`
      }

      if (categoryId) {
        params.push(categoryId)
        whereClause += ` AND p.category_id IN (WITH RECURSIVE cats AS (SELECT id FROM product_categories WHERE id = $${params.length} AND is_active = TRUE UNION ALL SELECT pc.id FROM product_categories pc JOIN cats c ON pc.parent_id = c.id WHERE pc.is_active = TRUE) SELECT id FROM cats)`
      }

      const result =
        await pool.query(
          `WITH RECURSIVE category_paths AS (SELECT c.id, c.parent_id, c.name, c.name::text AS category_path FROM product_categories c WHERE c.parent_id IS NULL AND c.is_active = TRUE UNION ALL SELECT c.id, c.parent_id, c.name, category_paths.category_path || ' > ' || c.name FROM product_categories c JOIN category_paths ON category_paths.id = c.parent_id WHERE c.is_active = TRUE) SELECT p.id AS product_id, p.name AS product_name, p.brand_name, p.pattern_code, p.fit_type, p.mark_code, p.gender, p.category_id, c.name AS category_name, c.slug AS category_slug, c.level AS category_level, pc.id AS parent_category_id, pc.name AS parent_category_name, pc.slug AS parent_category_slug, cp.category_path, v.id AS variant_id, v.size, v.colour, v.mrp::numeric AS mrp, v.sale_price::numeric AS base_sale_price, v.sale_price::numeric AS original_sale_price, v.cost_price::numeric AS cost_price, COALESCE(v.b2c_discount_pct, 0)::numeric AS b2c_discount_pct, COALESCE(v.b2b_discount_pct, 0)::numeric AS b2b_discount_pct, v.mrp::numeric AS original_price_b2c, CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS final_price_b2c, v.mrp::numeric AS original_price_b2b, CASE WHEN COALESCE(v.b2b_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2b_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.cost_price, 0), NULLIF(v.sale_price, 0), v.mrp)::numeric END AS final_price_b2b, CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS sale_price, CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS price, CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS selling_price, CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS discounted_price, CASE WHEN COALESCE(v.b2c_discount_pct, 0) > 0 THEN ROUND(v.mrp::numeric * (100 - COALESCE(v.b2c_discount_pct, 0)) / 100, 2) ELSE COALESCE(NULLIF(v.sale_price, 0), v.mrp)::numeric END AS mahaveer_price, bvs.on_hand, bvs.reserved, GREATEST(COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0), 0)::int AS available_qty, TRUE AS in_stock, COALESCE(bc.ean_code, '') AS barcode, COALESCE(bc.ean_code, '') AS ean_code, COALESCE(imgs.front_image_url, imgs.main_image_url, v.image_url, '') AS image_url, COALESCE(imgs.front_image_url, '') AS front_image_url, COALESCE(imgs.back_image_url, '') AS back_image_url, COALESCE(imgs.main_image_url, '') AS main_image_url, COALESCE(imgs.images, '[]'::json) AS images FROM branch_variant_stock bvs JOIN product_variants v ON v.id = bvs.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN product_categories c ON c.id = p.category_id LEFT JOIN product_categories pc ON pc.id = c.parent_id LEFT JOIN category_paths cp ON cp.id = p.category_id LEFT JOIN LATERAL (SELECT ean_code FROM barcodes bc WHERE bc.variant_id = v.id ORDER BY id ASC LIMIT 1) bc ON TRUE LEFT JOIN LATERAL (SELECT MAX(image_url) FILTER (WHERE image_type = 'front') AS front_image_url, MAX(image_url) FILTER (WHERE image_type = 'back') AS back_image_url, MAX(image_url) FILTER (WHERE image_type = 'main') AS main_image_url, JSON_AGG(JSON_BUILD_OBJECT('image_type', image_type, 'image_url', image_url, 'public_id', public_id) ORDER BY CASE image_type WHEN 'front' THEN 1 WHEN 'main' THEN 2 WHEN 'back' THEN 3 ELSE 4 END, id) AS images FROM product_images pi WHERE pi.ean_code IN (SELECT barcode.ean_code FROM barcodes barcode WHERE barcode.variant_id = v.id)) imgs ON TRUE WHERE ${whereClause} ORDER BY p.brand_name, p.name, v.colour, v.size, v.id`,
          params
        )

      return res.json(
        groupStockRows(
          result.rows
        )
      )
    } catch (error) {
      return res.status(500).json({
        message:
          error.message ||
          'Server error'
      })
    }
  }
)

router.get(
  '/:branchId/discounts',
  async (req, res) => {
    noStore(res)

    const branchId =
      parseBranchId(req)

    if (!branchId) {
      return res.status(400).json({
        message: 'Invalid branchId'
      })
    }

    try {
      const branchExists =
        await ensureBranchExists(
          branchId
        )

      if (!branchExists) {
        return res.status(404).json({
          message: 'Branch not found'
        })
      }

      const result =
        await pool.query(
          `SELECT COALESCE((SELECT v.b2c_discount_pct FROM product_variants v JOIN branch_variant_stock bvs ON bvs.variant_id = v.id WHERE bvs.branch_id = $1 AND v.b2c_discount_pct IS NOT NULL AND v.is_active = TRUE AND bvs.is_active = TRUE LIMIT 1), 0) AS b2c_discount_pct, COALESCE((SELECT v.b2b_discount_pct FROM product_variants v JOIN branch_variant_stock bvs ON bvs.variant_id = v.id WHERE bvs.branch_id = $1 AND v.b2b_discount_pct IS NOT NULL AND v.is_active = TRUE AND bvs.is_active = TRUE LIMIT 1), 0) AS b2b_discount_pct`,
          [branchId]
        )

      if (!result.rows.length) {
        return res.json({
          b2c_discount_pct: 0,
          b2b_discount_pct: 0
        })
      }

      return res.json(
        result.rows[0]
      )
    } catch (error) {
      return res.status(500).json({
        message:
          error.message ||
          'Server error'
      })
    }
  }
)

router.post(
  '/:branchId/discounts',
  async (req, res) => {
    const branchId =
      parseBranchId(req)

    if (!branchId) {
      return res.status(400).json({
        message: 'Invalid branchId'
      })
    }

    const b2cDiscount =
      Number(
        req.body?.b2c_discount_pct
      )

    const b2bDiscount =
      Number(
        req.body?.b2b_discount_pct
      )

    if (
      !Number.isFinite(
        b2cDiscount
      ) ||
      !Number.isFinite(
        b2bDiscount
      ) ||
      b2cDiscount < 0 ||
      b2bDiscount < 0 ||
      b2cDiscount > 100 ||
      b2bDiscount > 100
    ) {
      return res.status(400).json({
        message:
          'Invalid discount values'
      })
    }

    try {
      const branchExists =
        await ensureBranchExists(
          branchId
        )

      if (!branchExists) {
        return res.status(404).json({
          message: 'Branch not found'
        })
      }

      await pool.query(
        `UPDATE product_variants v SET b2c_discount_pct = $2, b2b_discount_pct = $3, updated_at = NOW() FROM branch_variant_stock bvs WHERE bvs.variant_id = v.id AND bvs.branch_id = $1 AND v.is_active = TRUE AND bvs.is_active = TRUE`,
        [
          branchId,
          b2cDiscount,
          b2bDiscount
        ]
      )

      return res.json({
        b2c_discount_pct:
          b2cDiscount,
        b2b_discount_pct:
          b2bDiscount
      })
    } catch (error) {
      return res.status(500).json({
        message:
          error.message ||
          'Server error'
      })
    }
  }
)

module.exports = router