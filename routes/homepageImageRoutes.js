const express = require('express')
const multer = require('multer')
const path = require('path')
const { put, del } = require('@vercel/blob')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
const MAX_FILE_SIZE_BYTES = 3.5 * 1024 * 1024
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter(req, file, callback) {
    if (!allowedMimeTypes.has(file.mimetype)) {
      const error = new Error('Only JPG, PNG, WEBP and AVIF images are allowed')
      error.status = 400
      return callback(error)
    }
    return callback(null, true)
  }
})

function uploadSingleImage(req, res, next) {
  upload.single('image')(req, res, error => {
    if (!error) return next()
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'Image must be smaller than 3.5 MB' })
    }
    return res.status(error.status || 400).json({ message: error.message || 'Invalid image' })
  })
}

function getBlobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_RW_TOKEN || ''
}

function nullableText(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text || null
}

function normalizePage(value) {
  const text = nullableText(value)
  return text ? text.toLowerCase() : null
}

function normalizeSection(value) {
  const text = nullableText(value)
  return text ? text.toLowerCase() : null
}

function normalizeSlotOrder(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) return null
  return number
}

function parseExtra(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    const error = new Error('Invalid extra JSON')
    error.status = 400
    throw error
  }
}

function safeSlotName(value) {
  const result = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  return result || 'homepage-image'
}

function extensionForFile(file) {
  const originalExtension = path.extname(file.originalname || '').toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.webp', '.avif'].includes(originalExtension)) return originalExtension
  if (file.mimetype === 'image/png') return '.png'
  if (file.mimetype === 'image/webp') return '.webp'
  if (file.mimetype === 'image/avif') return '.avif'
  return '.jpg'
}

function jsonValue(value) {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function shapeImage(row) {
  if (!row) return null
  return {
    id: row.id,
    page: row.page,
    section: row.section,
    slotOrder: row.slot_order,
    imageUrl: row.image_url,
    defaultImageUrl: row.default_image_url,
    altText: row.alt_text,
    link: row.link,
    extra: row.extra_json,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function shapeHistory(row) {
  return {
    id: row.id,
    homepageImageId: row.homepage_image_id,
    imageUrl: row.image_url,
    altText: row.alt_text,
    link: row.link,
    extra: row.extra_json,
    changedBy: row.changed_by,
    changedByUsername: row.changed_by_username,
    changedByName: row.changed_by_name,
    changeType: row.change_type,
    createdAt: row.created_at
  }
}

router.get('/', async (req, res) => {
  const page = normalizePage(req.query.page)
  const section = normalizeSection(req.query.section)
  const conditions = []
  const values = []

  if (page) {
    values.push(page)
    conditions.push(`LOWER(page) = $${values.length}`)
  }

  if (section) {
    values.push(section)
    conditions.push(`LOWER(section) = $${values.length}`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const result = await pool.query(
      `
      SELECT id,page,section,slot_order,image_url,default_image_url,alt_text,link,extra_json,updated_by,created_at,updated_at
      FROM homepage_images
      ${where}
      ORDER BY COALESCE(page,''),COALESCE(section,''),slot_order,id
      `,
      values
    )
    return res.json(result.rows.map(shapeImage))
  } catch (error) {
    console.error('homepage images load failed', error)
    return res.status(500).json({ message: 'Failed to load homepage images' })
  }
})

router.get('/:id/history', requireAuth, async (req, res) => {
  const id = String(req.params.id || '').trim()

  if (!id) return res.status(400).json({ message: 'Missing image slot id' })

  try {
    const result = await pool.query(
      `
      SELECT h.id,h.homepage_image_id,h.image_url,h.alt_text,h.link,h.extra_json,h.changed_by,h.change_type,h.created_at,u.username AS changed_by_username,u.name AS changed_by_name
      FROM homepage_image_history h
      LEFT JOIN users u ON u.id=h.changed_by
      WHERE h.homepage_image_id=$1
      ORDER BY h.created_at DESC,h.id DESC
      `,
      [id]
    )
    return res.json(result.rows.map(shapeHistory))
  } catch (error) {
    console.error('homepage image history load failed', error)
    return res.status(500).json({ message: 'Failed to load image history' })
  }
})

router.patch('/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id || '').trim()

  if (!id) return res.status(400).json({ message: 'Missing image slot id' })

  let extra

  try {
    extra = parseExtra(req.body.extra)
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message })
  }

  const page = normalizePage(req.body.page)
  const section = normalizeSection(req.body.section)
  const slotOrder = normalizeSlotOrder(req.body.slotOrder)
  const defaultImageUrl = nullableText(req.body.defaultImageUrl)
  const altText = nullableText(req.body.altText)
  const link = nullableText(req.body.link)

  try {
    const result = await pool.query(
      `
      INSERT INTO homepage_images(id,page,section,slot_order,default_image_url,alt_text,link,extra_json,updated_by,updated_at)
      VALUES($1,$2,$3,COALESCE($4,0),$5,$6,$7,$8::jsonb,$9,NOW())
      ON CONFLICT(id) DO UPDATE SET
        page=COALESCE(EXCLUDED.page,homepage_images.page),
        section=COALESCE(EXCLUDED.section,homepage_images.section),
        slot_order=COALESCE($4,homepage_images.slot_order),
        default_image_url=COALESCE(EXCLUDED.default_image_url,homepage_images.default_image_url),
        alt_text=COALESCE(EXCLUDED.alt_text,homepage_images.alt_text),
        link=COALESCE(EXCLUDED.link,homepage_images.link),
        extra_json=COALESCE(EXCLUDED.extra_json,homepage_images.extra_json),
        updated_by=EXCLUDED.updated_by,
        updated_at=NOW()
      RETURNING id,page,section,slot_order,image_url,default_image_url,alt_text,link,extra_json,updated_by,created_at,updated_at
      `,
      [id,page,section,slotOrder,defaultImageUrl,altText,link,jsonValue(extra),req.user.id]
    )
    return res.json(shapeImage(result.rows[0]))
  } catch (error) {
    console.error('homepage image metadata update failed', error)
    return res.status(500).json({ message: 'Failed to update homepage image metadata' })
  }
})

router.post('/:id/replace', requireAuth, uploadSingleImage, async (req, res) => {
  const id = String(req.params.id || '').trim()

  if (!id) return res.status(400).json({ message: 'Missing image slot id' })
  if (!req.file) return res.status(400).json({ message: 'No image uploaded' })

  const token = getBlobToken()

  if (!token) return res.status(500).json({ message: 'Blob storage is not configured' })

  let extra

  try {
    extra = parseExtra(req.body.extra)
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message })
  }

  const page = normalizePage(req.body.page)
  const section = normalizeSection(req.body.section)
  const slotOrder = normalizeSlotOrder(req.body.slotOrder)
  const defaultImageUrl = nullableText(req.body.defaultImageUrl)
  const altText = nullableText(req.body.altText)
  const link = nullableText(req.body.link)
  const extension = extensionForFile(req.file)
  const filename = `homepage-posters/${safeSlotName(id)}/${Date.now()}-${Math.random().toString(36).slice(2,10)}${extension}`

  let uploaded

  try {
    uploaded = await put(filename, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype,
      token
    })
  } catch (error) {
    console.error('homepage poster blob upload failed', error)
    return res.status(500).json({ message: 'Failed to upload image' })
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const currentResult = await client.query(
      `
      SELECT id,page,section,slot_order,image_url,default_image_url,alt_text,link,extra_json,updated_by,created_at,updated_at
      FROM homepage_images
      WHERE id=$1
      FOR UPDATE
      `,
      [id]
    )

    let current = currentResult.rows[0] || null

    if (!current) {
      const insertedResult = await client.query(
        `
        INSERT INTO homepage_images(id,page,section,slot_order,image_url,default_image_url,alt_text,link,extra_json,updated_by,updated_at)
        VALUES($1,$2,$3,COALESCE($4,0),NULL,$5,$6,$7,$8::jsonb,$9,NOW())
        RETURNING id,page,section,slot_order,image_url,default_image_url,alt_text,link,extra_json,updated_by,created_at,updated_at
        `,
        [id,page,section,slotOrder,defaultImageUrl,altText,link,jsonValue(extra),req.user.id]
      )
      current = insertedResult.rows[0]
    }

    const previousImageUrl = current.image_url || current.default_image_url || defaultImageUrl

    if (previousImageUrl && previousImageUrl !== uploaded.url) {
      await client.query(
        `
        INSERT INTO homepage_image_history(homepage_image_id,image_url,alt_text,link,extra_json,changed_by,change_type)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,'REPLACE')
        `,
        [
          id,
          previousImageUrl,
          current.alt_text || altText,
          current.link || link,
          jsonValue(current.extra_json || extra),
          req.user.id
        ]
      )
    }

    const updatedResult = await client.query(
      `
      UPDATE homepage_images
      SET
        page=COALESCE($2,page),
        section=COALESCE($3,section),
        slot_order=COALESCE($4,slot_order),
        image_url=$5,
        default_image_url=COALESCE($6,default_image_url),
        alt_text=COALESCE($7,alt_text),
        link=COALESCE($8,link),
        extra_json=COALESCE($9::jsonb,extra_json),
        updated_by=$10,
        updated_at=NOW()
      WHERE id=$1
      RETURNING id,page,section,slot_order,image_url,default_image_url,alt_text,link,extra_json,updated_by,created_at,updated_at
      `,
      [id,page,section,slotOrder,uploaded.url,defaultImageUrl,altText,link,jsonValue(extra),req.user.id]
    )

    await client.query('COMMIT')
    return res.json(shapeImage(updatedResult.rows[0]))
  } catch (error) {
    await client.query('ROLLBACK')

    try {
      await del(uploaded.url,{ token })
    } catch {}

    console.error('homepage poster replace failed', error)
    return res.status(500).json({ message: 'Failed to replace homepage image' })
  } finally {
    client.release()
  }
})

router.post('/:id/history/:historyId/restore', requireAuth, async (req, res) => {
  const id = String(req.params.id || '').trim()
  const historyId = Number(req.params.historyId)

  if (!id || !Number.isInteger(historyId) || historyId <= 0) {
    return res.status(400).json({ message: 'Invalid restore request' })
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const currentResult = await client.query(
      `
      SELECT id,image_url,default_image_url,alt_text,link,extra_json
      FROM homepage_images
      WHERE id=$1
      FOR UPDATE
      `,
      [id]
    )

    if (!currentResult.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Homepage image slot not found' })
    }

    const historyResult = await client.query(
      `
      SELECT id,image_url,alt_text,link,extra_json
      FROM homepage_image_history
      WHERE id=$1 AND homepage_image_id=$2
      `,
      [historyId,id]
    )

    if (!historyResult.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Previous image version not found' })
    }

    const current = currentResult.rows[0]
    const historical = historyResult.rows[0]

    if (current.image_url && current.image_url !== historical.image_url) {
      await client.query(
        `
        INSERT INTO homepage_image_history(homepage_image_id,image_url,alt_text,link,extra_json,changed_by,change_type)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,'RESTORE_BACKUP')
        `,
        [id,current.image_url,current.alt_text,current.link,jsonValue(current.extra_json),req.user.id]
      )
    }

    const updatedResult = await client.query(
      `
      UPDATE homepage_images
      SET image_url=$2,alt_text=$3,link=$4,extra_json=$5::jsonb,updated_by=$6,updated_at=NOW()
      WHERE id=$1
      RETURNING id,page,section,slot_order,image_url,default_image_url,alt_text,link,extra_json,updated_by,created_at,updated_at
      `,
      [
        id,
        historical.image_url,
        historical.alt_text,
        historical.link,
        jsonValue(historical.extra_json),
        req.user.id
      ]
    )

    await client.query('COMMIT')
    return res.json(shapeImage(updatedResult.rows[0]))
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('homepage poster restore failed', error)
    return res.status(500).json({ message: 'Failed to restore homepage image' })
  } finally {
    client.release()
  }
})

module.exports = router