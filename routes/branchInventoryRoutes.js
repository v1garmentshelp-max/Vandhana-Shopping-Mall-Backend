const express = require('express')
const jwt = require('jsonwebtoken')
const multer = require('multer')
const XLSX = require('xlsx')
const pool = require('../db')
const { put } = require('@vercel/blob')

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } })

const HEADER_ALIASES = {
  productname: ['product', 'product name', 'item', 'item name', 'productname'],
  brandname: ['brand', 'brand name', 'brandname'],
  costprice: ['cost', 'purchase cost', 'costprice'],
  purchaseqty: ['clqty', 'qty', 'quantity', 'purchase qty', 'purchaseqty'],
  eancode: ['ean', 'barcode', 'bar code', 'ean code', 'eancode'],
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
  if (!out.eancode && raw && raw.__EMPTY_3) out.eancode = raw.__EMPTY_3
  if (out.mrp == null && raw && raw.__EMPTY_4 != null) out.mrp = raw.__EMPTY_4
  if (!out.size && raw && raw.__EMPTY_5) out.size = raw.__EMPTY_5
  if (!out.colour && raw && raw.__EMPTY_6) out.colour = raw.__EMPTY_6
  if (!out.pattern && raw && raw.__EMPTY_7) out.pattern = raw.__EMPTY_7
  return out
}

function cleanText(v) {
  if (v == null) return ''
  return String(v).replace(/\s+/g, ' ').trim()
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

function requireBranchAuth(req, res, next) {
  const hdr = req.headers.authorization || ''
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret')
    req.user = payload
    return next()
  } catch {
    return res.status(401).json({ message: 'Unauthorized' })
  }
}

function getBranchId(req) {
  const fromUser = Number(req.user && req.user.branch_id)
  if (Number.isInteger(fromUser) && fromUser > 0) return fromUser
  const fromParam = Number(req.params && req.params.branchId)
  if (Number.isInteger(fromParam) && fromParam > 0) return fromParam
  return 1
}

function extractEANFromName(name) {
  const m = String(name).match(/(\d{12,14})/)
  return m ? m[1] : null
}

function isSummaryOrBlankRow(raw, ProductName, BrandName, SIZE, COLOUR, row) {
  const summary = cleanText((raw && (raw['Stock Summary'] || raw['stock summary'])) || '')
  const allMainEmpty = !ProductName && !BrandName && !SIZE && !COLOUR
  const hasAnyDataField =
    cleanText(row.eancode) ||
    toNumOrNull(row.mrp) != null ||
    toNumOrNull(row.rsaleprice) != null ||
    toIntOrZero(row.purchaseqty) !== 0
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
  if (badContains.some(x => t.includes(x))) return true
  return false
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_rows_job_status_id ON import_rows(import_job_id, status_enum, id)`)
}

function rowToPreparedRecord(raw) {
  const row = normalizeRow(raw)
  const ProductName = cleanText(row.productname)
  const BrandName = cleanText(row.brandname)
  const SIZE = cleanText(row.size)
  const COLOUR = cleanText(row.colour)
  const PATTERN = cleanText(row.pattern) || null
  const FITT = cleanText(row.fitt) || null
  const MarkCode = cleanText(row.markcode) || null
  const MRP = toNumOrNull(row.mrp)
  const RSalePrice = toNumOrNull(row.rsaleprice)
  const CostPrice = toNumOrNull(row.costprice) ?? 0
  const PurchaseQty = toIntOrZero(row.purchaseqty)
  const B2CDiscount = toNumOrNull(row.b2cdiscount) ?? 0
  const B2BDiscount = toNumOrNull(row.b2bdiscount) ?? 0
  let EANCode = row.eancode
  if (EANCode != null && EANCode !== '') EANCode = cleanText(EANCode)

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
    EANCode
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

async function insertImportRowsInBatches(client, jobId, rows, createdStatus) {
  const chunkSize = 250
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const values = []
    const params = []
    let p = 1
    for (const item of chunk) {
      values.push(`($${p++}, $${p++}::jsonb, $${p++}, NULL)`)
      params.push(jobId, JSON.stringify(item.raw), createdStatus)
    }
    await client.query(
      `INSERT INTO import_rows (import_job_id, raw_row_json, status_enum, error_msg)
       VALUES ${values.join(',')}`,
      params
    )
  }
}

router.get('/:branchId/import-jobs', requireBranchAuth, async (req, res) => {
  const branchId = getBranchId(req)
  try {
    const { rows } = await pool.query(
      `SELECT id, file_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, uploaded_at, completed_at, branch_id, gender
       FROM import_jobs
       WHERE branch_id = $1
       ORDER BY id DESC
       LIMIT 100`,
      [branchId]
    )
    res.json(rows)
  } catch {
    res.status(500).json({ message: 'Server error' })
  }
})

router.get('/:branchId/import-rows', requireBranchAuth, async (req, res) => {
  const branchId = getBranchId(req)
  const jobId = req.query.jobId ? parseInt(req.query.jobId, 10) : null
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10))
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '200', 10)))
  const status = String(req.query.status || '').trim()

  try {
    await ensureImportRowsTable()

    let job
    if (jobId) {
      const r = await pool.query(`SELECT * FROM import_jobs WHERE id=$1 AND branch_id=$2`, [jobId, branchId])
      if (!r.rows.length) return res.status(404).json({ message: 'Job not found' })
      job = r.rows[0]
    } else {
      const r = await pool.query(`SELECT * FROM import_jobs WHERE branch_id=$1 ORDER BY id DESC LIMIT 1`, [branchId])
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
      `SELECT id, status_enum, error_msg, raw_row_json
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
        gender: job.gender
      },
      rows: rowsQ.rows,
      nextOffset,
      total: totalQ.rows[0].c
    })
  } catch {
    res.status(500).json({ message: 'Server error' })
  }
})

router.post('/:branchId/import', requireBranchAuth, upload.single('file'), async (req, res) => {
  const branchId = getBranchId(req)
  if (!req.file) return res.status(400).json({ message: 'File required' })

  const gender = normGender(req.body && req.body.gender)
  if (!gender) return res.status(400).json({ message: 'Category is required (MEN/WOMEN/KIDS)' })

  const token = process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_RW_TOKEN
  if (!token) return res.status(500).json({ message: 'Upload store not configured' })

  const client = await pool.connect()

  try {
    await ensureImportRowsTable()

    const enumValues = await getAllowedImportRowStatuses()
    const createdStatus = resolveCreatedStatus(enumValues)

    if (!createdStatus) {
      return res.status(500).json({ message: `import_row_status enum is missing CREATED. Available values: ${enumValues.join(', ')}` })
    }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const wsName = wb.SheetNames && wb.SheetNames[0]
    if (!wsName) return res.status(400).json({ message: 'No worksheet in file' })

    const allRows = XLSX.utils.sheet_to_json(wb.Sheets[wsName], { defval: '' })
    const preparedRows = []

    for (const raw of allRows) {
      const prepared = rowToPreparedRecord(raw)
      if (shouldQueueRow(prepared)) preparedRows.push(prepared)
    }

    const ext = (req.file.originalname.split('.').pop() || 'xlsx').toLowerCase()
    const name = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    const stored = await put(name, req.file.buffer, { access: 'public', contentType: req.file.mimetype, token })

    await client.query('BEGIN')

    const { rows } = await client.query(
      `INSERT INTO import_jobs (file_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, branch_id, gender)
       VALUES ($1, $2, $3, 'PENDING', $4, 0, 0, $5, $6)
       RETURNING id, file_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, uploaded_at, completed_at, branch_id, gender`,
      [req.file.originalname || name, stored.url, req.user.id, preparedRows.length, branchId, gender]
    )

    const job = rows[0]

    if (preparedRows.length) {
      await insertImportRowsInBatches(client, job.id, preparedRows, createdStatus)
    }

    await client.query('COMMIT')
    res.status(201).json(job)
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ message: e.message || 'Server error' })
  } finally {
    client.release()
  }
})

router.post('/:branchId/import/process/:jobId', requireBranchAuth, async (req, res) => {
  const branchId = getBranchId(req)
  const jobId = parseInt(req.params.jobId, 10)
  const limit = Math.max(1, Math.min(25, parseInt(req.query.limit || '25', 10)))

  try {
    await ensureImportRowsTable()

    const enumValues = await getAllowedImportRowStatuses()
    const createdStatus = resolveCreatedStatus(enumValues)
    const okStatus = resolveOkStatus(enumValues)
    const errorStatus = resolveErrorStatus(enumValues)

    if (!createdStatus || !okStatus || !errorStatus) {
      return res.status(500).json({ message: `Unsupported import_row_status enum values: ${enumValues.join(', ')}` })
    }

    const j = await pool.query(
      `SELECT id, file_url, status_enum, rows_total, rows_success, rows_error, gender
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
        `SELECT id, raw_row_json
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

      for (const batchRow of rowsToProcess) {
        const raw = batchRow.raw_row_json || {}
        const prepared = rowToPreparedRecord(raw)

        if (!prepared.ProductName || !prepared.BrandName || !prepared.SIZE || !prepared.COLOUR) {
          const msg = 'Missing required fields (ProductName/BrandName/SIZE/COLOUR)'
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
            `INSERT INTO products (name, brand_name, pattern_code, fit_type, mark_code, gender)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (name, brand_name, pattern_code, gender)
             DO UPDATE SET fit_type = EXCLUDED.fit_type,
                           mark_code = EXCLUDED.mark_code
             RETURNING id`,
            [prepared.ProductName, prepared.BrandName, prepared.PATTERN, prepared.FITT, prepared.MarkCode, gender || null]
          )

          const productId = pRes.rows[0].id

          const vRes = await client.query(
            `INSERT INTO product_variants (product_id, size, colour, is_active, mrp, sale_price, cost_price, b2c_discount_pct, b2b_discount_pct)
             VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7, $8)
             ON CONFLICT (product_id, size, colour)
             DO UPDATE SET is_active = TRUE,
                           mrp = EXCLUDED.mrp,
                           sale_price = EXCLUDED.sale_price,
                           cost_price = EXCLUDED.cost_price,
                           b2c_discount_pct = EXCLUDED.b2c_discount_pct,
                           b2b_discount_pct = EXCLUDED.b2b_discount_pct
             RETURNING id`,
            [productId, prepared.SIZE, prepared.COLOUR, prepared.MRP, prepared.RSalePrice, prepared.CostPrice, prepared.B2CDiscount, prepared.B2BDiscount]
          )

          const variantId = vRes.rows[0].id

          if (prepared.EANCode) {
            await client.query(
              `INSERT INTO barcodes (variant_id, ean_code)
               VALUES ($1, $2)
               ON CONFLICT (ean_code)
               DO UPDATE SET variant_id = EXCLUDED.variant_id`,
              [variantId, prepared.EANCode]
            )
          }

          await client.query(
            `INSERT INTO branch_variant_stock (branch_id, variant_id, on_hand, reserved, is_active)
             VALUES ($1, $2, $3, 0, TRUE)
             ON CONFLICT (branch_id, variant_id)
             DO UPDATE SET on_hand = branch_variant_stock.on_hand + EXCLUDED.on_hand,
                           is_active = TRUE`,
            [branchId, variantId, prepared.PurchaseQty]
          )

          await client.query(
            `UPDATE import_rows
             SET status_enum = $2,
                 error_msg = NULL,
                 processed_at = NOW()
             WHERE id = $1`,
            [batchRow.id, okStatus]
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
      if (okCount === 0 && errorCount > 0) {
        finalStatus = 'FAILED'
      } else if (errorCount > 0) {
        finalStatus = 'PARTIAL'
      } else {
        finalStatus = 'COMPLETE'
      }
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

router.post('/:branchId/images/confirm', requireBranchAuth, async (req, res) => {
  const branchId = getBranchId(req)
  const images = Array.isArray(req.body && req.body.images) ? req.body.images : []
  if (!images.length) return res.status(400).json({ message: 'No images' })
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_images (
        ean_code text PRIMARY KEY,
        image_url text NOT NULL,
        uploaded_at timestamptz DEFAULT now()
      )
    `)
    const client = await pool.connect()
    let updated = 0
    try {
      await client.query('BEGIN')
      for (const img of images) {
        const ean = extractEANFromName(img.ean || '')
        const url = String(img.secure_url || '').trim()
        if (!ean || !url) continue
        await client.query(
          `INSERT INTO product_images (ean_code, image_url, uploaded_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (ean_code) DO UPDATE SET image_url = EXCLUDED.image_url, uploaded_at = NOW()`,
          [ean, url]
        )
        await client.query(
          `UPDATE product_variants v
             SET image_url = $2
           FROM barcodes b
           WHERE b.variant_id = v.id AND b.ean_code = $1`,
          [ean, url]
        )
        updated += 1
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      return res.status(500).json({ message: e.message || 'DB error' })
    } finally {
      client.release()
    }
    res.json({ totalUpdated: updated })
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.get('/:branchId/stock', requireBranchAuth, async (req, res) => {
  const branchId = getBranchId(req)
  const gender = normGender(req.query && req.query.gender)
  try {
    const params = [branchId]
    let where = `bvs.branch_id = $1 AND bvs.is_active = TRUE`
    if (gender) {
      params.push(gender)
      where += ` AND p.gender = $${params.length}`
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
         v.id AS variant_id,
         v.size,
         v.colour,
         v.mrp,
         v.sale_price,
         v.cost_price,
         bvs.on_hand,
         bvs.reserved,
         COALESCE(bc.ean_code,'') AS ean_code,
         COALESCE(v.image_url, pi.image_url, '') AS image_url
       FROM branch_variant_stock bvs
       JOIN product_variants v ON v.id = bvs.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN LATERAL (
         SELECT ean_code FROM barcodes bc WHERE bc.variant_id = v.id ORDER BY id ASC LIMIT 1
       ) bc ON TRUE
       LEFT JOIN product_images pi ON pi.ean_code = bc.ean_code
       WHERE ${where}
       ORDER BY p.brand_name, p.name, v.size, v.colour`,
      params
    )
    res.json(rows)
  } catch {
    res.status(500).json({ message: 'Server error' })
  }
})

router.get('/:branchId/discounts', requireBranchAuth, async (req, res) => {
  const branchId = getBranchId(req)
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(
           (
             SELECT v.b2c_discount_pct
             FROM product_variants v
             JOIN branch_variant_stock bvs ON bvs.variant_id = v.id
             WHERE bvs.branch_id = $1
               AND v.b2c_discount_pct IS NOT NULL
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
             LIMIT 1
           ),
           0
         ) AS b2b_discount_pct`,
      [branchId]
    )
    if (!rows.length) {
      return res.json({ b2c_discount_pct: 0, b2b_discount_pct: 0 })
    }
    res.json(rows[0])
  } catch {
    res.status(500).json({ message: 'Server error' })
  }
})

router.post('/:branchId/discounts', requireBranchAuth, async (req, res) => {
  const branchId = getBranchId(req)
  const b2c = Number(req.body && req.body.b2c_discount_pct)
  const b2b = Number(req.body && req.body.b2b_discount_pct)
  if (!Number.isFinite(b2c) || !Number.isFinite(b2b) || b2c < 0 || b2b < 0) {
    return res.status(400).json({ message: 'Invalid discount values' })
  }
  try {
    await pool.query(
      `UPDATE product_variants v
         SET b2c_discount_pct = $2,
             b2b_discount_pct = $3
       FROM branch_variant_stock bvs
       WHERE bvs.variant_id = v.id
         AND bvs.branch_id = $1`,
      [branchId, b2c, b2b]
    )
    res.json({ b2c_discount_pct: b2c, b2b_discount_pct: b2b })
  } catch {
    res.status(500).json({ message: 'Server error' })
  }
})

module.exports = router