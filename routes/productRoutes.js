const express = require('express')
const pool = require('../db')
const router = express.Router()

const WEB_BRANCH_ID = (() => {
  const v = parseInt(process.env.WEB_BRANCH_ID || '', 10)
  return Number.isFinite(v) && v > 0 ? v : null
})()

const toGender = (v) => {
  const s = String(v || '').trim().toUpperCase()
  if (s === 'MEN' || s === 'WOMEN' || s === 'KIDS') return s
  if (s === 'MAN' || s === 'MALE' || s === 'MENS' || s === "MEN'S") return 'MEN'
  if (s === 'WOMAN' || s === 'FEMALE' || s === 'LADIES' || s === 'WOMENS' || s === "WOMEN'S") return 'WOMEN'
  if (s === 'CHILD' || s === 'CHILDREN' || s === 'BOYS' || s === 'GIRLS' || s === 'KID' || s === 'KIDS') return 'KIDS'
  return ''
}

const GENDER_LABELS = { WOMEN: 'Women', MEN: 'Men', KIDS: 'Kids' }

function addHasImageWhere(whereSql) {
  return `
    (${whereSql})
    AND (
      (NULLIF(v.image_url,'') IS NOT NULL AND v.image_url NOT LIKE '/images/%')
      OR (NULLIF(pi.image_url,'') IS NOT NULL AND pi.image_url NOT LIKE '/images/%')
      OR COALESCE(bc_self.ean_code, bc_any.ean_code, '') <> ''
    )
  `
}

const normalizeText = (str) =>
  String(str || '')
    .toLowerCase()
    .replace(/₹/g, ' ')
    .replace(/rs\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const normalizeKey = (str) =>
  String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
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

const SYNONYMS = {
  women: ['woman', 'ladies', 'female', 'womens', "women's"],
  womens: ['women', 'woman', 'ladies', 'female', "women's"],
  men: ['man', 'gents', 'male', 'mens', "men's"],
  mens: ['men', 'man', 'gents', 'male', "men's"],
  kids: ['kid', 'children', 'child', 'boys', 'girls'],
  kid: ['kids', 'children', 'child', 'boys', 'girls'],
  children: ['kids', 'kid', 'child', 'boys', 'girls'],
  underwear: ['underware', 'underwares', 'innerwear', 'inners', 'brief', 'briefs'],
  underware: ['underwear', 'underwares', 'innerwear', 'inners', 'brief', 'briefs'],
  underwares: ['underwear', 'underware', 'innerwear', 'inners', 'brief', 'briefs'],
  innerwear: ['underwear', 'underware', 'underwares', 'inners', 'brief', 'briefs'],
  inners: ['innerwear', 'underwear', 'underware', 'underwares', 'brief', 'briefs'],
  chudi: ['chudidar', 'chudidhar', 'chudithar', 'chudidars', 'churidar', 'churidar'],
  chudidar: ['chudi', 'chudidhar', 'chudithar', 'chudidars', 'churidar'],
  chudidhar: ['chudi', 'chudidar', 'chudithar', 'chudidars', 'churidar'],
  chudithar: ['chudi', 'chudidar', 'chudidhar', 'chudidars', 'churidar'],
  chudidars: ['chudi', 'chudidar', 'chudidhar', 'chudithar', 'churidar'],
  churidar: ['chudi', 'chudidar', 'chudidhar', 'chudithar', 'chudidars'],
  pants: ['pant', 'trouser', 'trousers', 'bottom', 'bottoms'],
  pant: ['pants', 'trouser', 'trousers', 'bottom', 'bottoms'],
  trouser: ['trousers', 'pant', 'pants', 'bottom', 'bottoms'],
  trousers: ['trouser', 'pant', 'pants', 'bottom', 'bottoms'],
  jeans: ['jean', 'denim'],
  jean: ['jeans', 'denim'],
  leggings: ['legging', 'tights'],
  legging: ['leggings', 'tights']
}

const parsePriceRangeFromQuery = (raw) => {
  const original = String(raw || '')
  const s = original.toLowerCase()
  const hyphenRange = s.match(/(\d+)\s*-\s*(\d+)/)
  let priceMin = null
  let priceMax = null
  if (hyphenRange) {
    const n1 = parseInt(hyphenRange[1], 10)
    const n2 = parseInt(hyphenRange[2], 10)
    if (!Number.isNaN(n1) && !Number.isNaN(n2)) {
      priceMin = Math.min(n1, n2)
      priceMax = Math.max(n1, n2)
    }
  } else {
    const numbers = s.match(/\d+/g)
    if (numbers && numbers.length) {
      const first = parseInt(numbers[0], 10)
      const second = numbers[1] ? parseInt(numbers[1], 10) : null
      const hasUnder = /(under|below|upto|up to|less than|<|<=)/.test(s)
      const hasAbove = /(above|over|more than|>|>=)/.test(s)
      const hasBetween = /(between|from)/.test(s) && /(to|and)/.test(s)
      if (hasBetween && second != null && !Number.isNaN(second)) {
        priceMin = Math.min(first, second)
        priceMax = Math.max(first, second)
      } else if (hasUnder) {
        priceMax = first
      } else if (hasAbove) {
        priceMin = first
      }
    }
  }
  let cleaned = original.replace(
    /\b(under|below|between|upto|up to|less than|greater than|above|over|more than|price|rs|rs\.|rupees)\b/gi,
    ' '
  )
  cleaned = cleaned.replace(/\d+/g, ' ')
  cleaned = cleaned.replace(/₹/g, ' ')
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return { priceMin, priceMax, cleanedQuery: cleaned }
}

const buildTokens = (text) => {
  const norm = normalizeText(text)
  if (!norm) return []
  const raw = norm.split(' ').filter((t) => t && !STOPWORDS.has(t))
  const expanded = []
  for (const t of raw) {
    expanded.push(t)
    const syn = SYNONYMS[t]
    if (syn && syn.length) expanded.push(...syn)
  }
  const out = []
  const seen = new Set()
  for (const t of expanded) {
    const k = String(t || '').trim()
    if (!k) continue
    if (!seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  return out
}

const levenshteinDistance = (a, b) => {
  const s = normalizeKey(a)
  const t = normalizeKey(b)
  if (!s.length) return t.length
  if (!t.length) return s.length
  const dp = Array.from({ length: s.length + 1 }, () => new Array(t.length + 1).fill(0))
  for (let i = 0; i <= s.length; i += 1) dp[i][0] = i
  for (let j = 0; j <= t.length; j += 1) dp[0][j] = j
  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      const del = dp[i - 1][j] + 1
      const ins = dp[i][j - 1] + 1
      const sub = dp[i - 1][j - 1] + cost
      dp[i][j] = Math.min(del, ins, sub)
    }
  }
  return dp[s.length][t.length]
}

const scoreSuggestion = (q, candidate) => {
  const qs = normalizeKey(q)
  const cs = normalizeKey(candidate)
  if (!qs || !cs) return 999
  if (cs.startsWith(qs)) return 0
  if (cs.includes(qs)) return 1
  const parts = normalizeText(candidate).split(' ').filter(Boolean)
  let best = 999
  for (const p of parts) {
    const d = levenshteinDistance(qs, p)
    best = Math.min(best, d)
  }
  if (best <= 3) return 2 + best
  return 999
}

const getBranchIdFromReq = (req) => {
  let branchId = WEB_BRANCH_ID
  const branchFromQuery = req.query.branch_id || req.query.branchId
  if (branchFromQuery) {
    const parsed = parseInt(branchFromQuery, 10)
    if (Number.isFinite(parsed) && parsed > 0) branchId = parsed
  }
  return branchId
}

async function fetchImageList({ gender, limit }) {
  const params = []
  let where = 'v.is_active = TRUE'
  if (gender) {
    params.push(gender)
    where += ` AND p.gender = $${params.length}`
  }
  where = addHasImageWhere(where)
  const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'
  params.push(cloud)
  const cloudIdx = params.length
  params.push(limit)
  const limIdx = params.length

  const sql = `
    WITH base AS (
      SELECT
        v.id AS id,
        p.id AS product_id,
        p.name AS product_name,
        p.brand_name AS brand,
        p.gender AS gender,
        v.colour AS color,
        v.size AS size,
        COALESCE(bc_self.ean_code, bc_any.ean_code, '') AS ean_code,
        v.image_url AS v_image,
        pi.image_url AS pi_image
      FROM products p
      JOIN product_variants v ON v.product_id = p.id
      LEFT JOIN LATERAL (
        SELECT ean_code FROM barcodes b WHERE b.variant_id = v.id ORDER BY id ASC LIMIT 1
      ) bc_self ON TRUE
      LEFT JOIN LATERAL (
        SELECT b2.ean_code
        FROM product_variants v2
        JOIN products p2 ON p2.id = v2.product_id
        JOIN barcodes b2 ON b2.variant_id = v2.id
        WHERE p2.name = p.name AND p2.brand_name = p.brand_name AND v2.size = v.size AND v2.colour = v.colour
        ORDER BY b2.id ASC
        LIMIT 1
      ) bc_any ON TRUE
      LEFT JOIN LATERAL (
        SELECT image_url
        FROM product_images pi
        WHERE pi.ean_code = COALESCE(bc_self.ean_code, bc_any.ean_code)
        ORDER BY uploaded_at DESC
        LIMIT 1
      ) pi ON TRUE
      WHERE ${where}
    )
    SELECT
      id,
      product_id,
      product_name,
      brand,
      gender,
      color,
      size,
      COALESCE(
        NULLIF(v_image,''),
        NULLIF(pi_image,''),
        CASE
          WHEN ean_code <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}::text, '/image/upload/f_auto,q_auto/products/', ean_code)
          ELSE NULL
        END
      ) AS image_url
    FROM base
    WHERE COALESCE(
      NULLIF(v_image,''),
      NULLIF(pi_image,''),
      CASE
        WHEN ean_code <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}::text, '/image/upload/f_auto,q_auto/products/', ean_code)
        ELSE NULL
      END
    ) IS NOT NULL
    ORDER BY RANDOM()
    LIMIT $${limIdx}
  `
  const { rows } = await pool.query(sql, params)
  return rows
}

const buildProductSelectSql = ({ where, branchIdx, cloudIdx }) => `
  SELECT
    v.id AS id,
    p.id AS product_id,
    p.name AS product_name,
    p.brand_name AS brand,
    p.gender AS gender,
    v.colour AS color,
    v.size AS size,
    v.mrp::numeric AS original_price_b2c,
    CASE
      WHEN v.b2c_discount_pct IS NOT NULL AND v.b2c_discount_pct > 0
        THEN ROUND(v.mrp::numeric * (100 - v.b2c_discount_pct)::numeric / 100, 2)
      ELSE NULL
    END AS final_price_b2c,
    v.mrp::numeric AS original_price_b2b,
    CASE
      WHEN v.b2b_discount_pct IS NOT NULL AND v.b2b_discount_pct > 0
        THEN ROUND(v.mrp::numeric * (100 - v.b2b_discount_pct)::numeric / 100, 2)
      ELSE NULL
    END AS final_price_b2b,
    v.mrp::numeric AS mrp,
    v.sale_price::numeric AS sale_price,
    COALESCE(NULLIF(v.cost_price,0), 0)::numeric AS cost_price,
    COALESCE(bvs.on_hand, 0)::int AS on_hand,
    COALESCE(bvs.reserved, 0)::int AS reserved,
    GREATEST(COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0), 0)::int AS available_qty,
    CASE
      WHEN COALESCE(bvs.on_hand, 0) - COALESCE(bvs.reserved, 0) > 0 AND bvs.is_active IS TRUE THEN TRUE
      ELSE FALSE
    END AS in_stock,
    COALESCE(bc_self.ean_code, bc_any.ean_code, '') AS ean_code,
    COALESCE(
      NULLIF(v.image_url, ''),
      NULLIF(pi.image_url, ''),
      CASE
        WHEN COALESCE(bc_self.ean_code, bc_any.ean_code, '') <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}::text, '/image/upload/f_auto,q_auto/products/', COALESCE(bc_self.ean_code, bc_any.ean_code))
        ELSE NULL
      END,
      CASE
        WHEN p.gender = 'WOMEN' THEN '/images/women/women20.jpeg'
        WHEN p.gender = 'MEN'   THEN '/images/men/default.jpg'
        WHEN p.gender = 'KIDS'  THEN '/images/kids/default.jpg'
        ELSE '/images/placeholder.jpg'
      END
    ) AS image_url
  FROM products p
  JOIN product_variants v ON v.product_id = p.id
  LEFT JOIN LATERAL (
    SELECT ean_code FROM barcodes b WHERE b.variant_id = v.id ORDER BY id ASC LIMIT 1
  ) bc_self ON TRUE
  LEFT JOIN LATERAL (
    SELECT b2.ean_code
    FROM product_variants v2
    JOIN products p2 ON p2.id = v2.product_id
    JOIN barcodes b2 ON b2.variant_id = v2.id
    WHERE p2.name = p.name AND p2.brand_name = p.brand_name AND v2.size = v.size AND v2.colour = v.colour
    ORDER BY b2.id ASC
    LIMIT 1
  ) bc_any ON TRUE
  LEFT JOIN LATERAL (
    SELECT image_url
    FROM product_images pi
    WHERE pi.ean_code = COALESCE(bc_self.ean_code, bc_any.ean_code)
    ORDER BY uploaded_at DESC
    LIMIT 1
  ) pi ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      SUM(on_hand) AS on_hand,
      SUM(reserved) AS reserved,
      BOOL_OR(is_active) AS is_active
    FROM branch_variant_stock bvs
    WHERE bvs.variant_id = v.id
      AND ($${branchIdx}::int IS NULL OR bvs.branch_id = $${branchIdx}::int)
  ) bvs ON TRUE
  WHERE ${where}
`

const offerPriceSql = () => `
  COALESCE(
    NULLIF(
      CASE
        WHEN v.b2c_discount_pct IS NOT NULL AND v.b2c_discount_pct > 0
          THEN ROUND(v.mrp::numeric * (100 - v.b2c_discount_pct)::numeric / 100, 2)
        ELSE NULL
      END, 0
    ),
    NULLIF(v.sale_price::numeric, 0),
    v.mrp::numeric
  )
`

const expandWordVariants = (word) => {
  const w = String(word || '').trim()
  if (!w) return []
  const lw = w.toLowerCase()
  const out = [w]
  const syn = SYNONYMS[lw]
  if (syn && syn.length) out.push(...syn.map((x) => String(x)))
  return Array.from(new Set(out.map((x) => String(x).trim()).filter(Boolean)))
}

const addCandidate = (set, v) => {
  const s = String(v || '').replace(/\s+/g, ' ').trim()
  if (!s) return
  const k = s.toLowerCase()
  set.add(k + '||' + s)
}

const buildExpandedCandidatesFromRow = (r) => {
  const out = new Set()
  const productName = String(r.product_name || '').trim()
  const brand = String(r.brand || '').trim()
  const color = String(r.color || '').trim()
  const g = toGender(r.gender || '')
  const gLabel = g ? (GENDER_LABELS[g] || g) : ''

  const basePhrases = []
  if (productName) basePhrases.push(productName)
  if (brand) basePhrases.push(brand)
  if (color) basePhrases.push(color)
  if (gLabel) basePhrases.push(gLabel)

  for (const p of basePhrases) addCandidate(out, p)

  const nameWords = normalizeText(productName).split(' ').filter(Boolean)
  const nameWordVariants = []
  for (const w of nameWords) nameWordVariants.push(...expandWordVariants(w))

  if (productName) {
    for (const w of nameWordVariants) {
      const tc = w.charAt(0).toUpperCase() + w.slice(1)
      addCandidate(out, tc)
    }
  }

  if (gLabel && productName) {
    addCandidate(out, `${gLabel} ${productName}`)
    addCandidate(out, `${productName} ${gLabel}`)
    addCandidate(out, `${gLabel} ${productName}`.replace(/\s+/g, ' ').trim())
    for (const w of nameWordVariants) {
      const tc = w.charAt(0).toUpperCase() + w.slice(1)
      addCandidate(out, `${gLabel} ${tc}`)
      addCandidate(out, `${tc} ${gLabel}`)
      addCandidate(out, `${gLabel} ${tc} Set`)
      addCandidate(out, `${gLabel} ${tc} Wear`)
    }
    addCandidate(out, `${productName} for ${gLabel}`)
    for (const w of nameWordVariants) {
      const tc = w.charAt(0).toUpperCase() + w.slice(1)
      addCandidate(out, `${tc} for ${gLabel}`)
    }
  }

  if (brand && productName) {
    addCandidate(out, `${brand} ${productName}`)
    if (gLabel) addCandidate(out, `${gLabel} ${brand} ${productName}`)
  }

  if (color && productName) {
    addCandidate(out, `${color} ${productName}`)
    if (gLabel) addCandidate(out, `${gLabel} ${color} ${productName}`)
  }

  return Array.from(out).map((x) => x.split('||')[1])
}

router.get('/', async (req, res) => {
  try {
    const genderQ = toGender(req.query.gender || req.query.category || '')
    const brand = req.query.brand ? String(req.query.brand).trim() : ''
    const qRaw = req.query.q ? String(req.query.q).trim() : ''
    const { priceMin, priceMax, cleanedQuery } = parsePriceRangeFromQuery(qRaw)
    const q = cleanedQuery || qRaw

    const rawLimit = parseInt(req.query.limit || '200', 10)
    const limit = Math.max(1, Math.min(50000, Number.isFinite(rawLimit) ? rawLimit : 200))
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10))
    const wantRandom = String(req.query.random || '').trim() === '1'
    const wantHasImageOnly = String(req.query.hasImage || '').toLowerCase() === 'true'

    const params = []
    let where = 'v.is_active = TRUE'

    if (genderQ) {
      params.push(genderQ)
      where += ` AND p.gender = $${params.length}`
    }

    if (brand) {
      params.push(`%${brand}%`)
      where += ` AND p.brand_name ILIKE $${params.length}`
    }

    const tokens = buildTokens(q)
    if (tokens.length) {
      const parts = []
      for (const t of tokens) {
        params.push(`%${t}%`)
        const idx = params.length
        parts.push(`(p.name ILIKE $${idx} OR p.brand_name ILIKE $${idx} OR v.colour ILIKE $${idx} OR p.gender ILIKE $${idx})`)
      }
      where += ` AND (${parts.join(' OR ')})`
    }

    if (priceMin != null) {
      params.push(priceMin)
      where += ` AND ${offerPriceSql()} >= $${params.length}`
    }

    if (priceMax != null) {
      params.push(priceMax)
      where += ` AND ${offerPriceSql()} <= $${params.length}`
    }

    if (wantHasImageOnly) where = addHasImageWhere(where)

    const branchId = getBranchIdFromReq(req)
    params.push(branchId)
    const branchIdx = params.length

    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'
    params.push(cloud)
    const cloudIdx = params.length

    params.push(limit, offset)
    const limIdx = params.length - 1
    const offIdx = params.length

    const orderBy = wantRandom ? 'ORDER BY RANDOM()' : 'ORDER BY v.id DESC'

    const sql = `
      ${buildProductSelectSql({ where, branchIdx, cloudIdx })}
      ${orderBy}
      LIMIT $${limIdx} OFFSET $${offIdx}
    `
    const { rows } = await pool.query(sql, params)
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/suggest', async (req, res) => {
  try {
    const qRaw = String(req.query.q || '').trim()
    if (!qRaw || qRaw.length < 1) return res.json([])

    const genderQ = toGender(req.query.gender || req.query.category || '')
    const { cleanedQuery } = parsePriceRangeFromQuery(qRaw)
    const q = cleanedQuery || qRaw

    const branchId = getBranchIdFromReq(req)

    const params = []
    let where = 'v.is_active = TRUE'

    if (genderQ) {
      params.push(genderQ)
      where += ` AND p.gender = $${params.length}`
    }

    const tokens = buildTokens(q)
    if (tokens.length) {
      const parts = []
      for (const t of tokens) {
        params.push(`%${t}%`)
        const idx = params.length
        parts.push(`(p.name ILIKE $${idx} OR p.brand_name ILIKE $${idx} OR v.colour ILIKE $${idx} OR p.gender ILIKE $${idx})`)
      }
      where += ` AND (${parts.join(' OR ')})`
    } else {
      params.push(`%${String(q).trim()}%`)
      const idx = params.length
      where += ` AND (p.name ILIKE $${idx} OR p.brand_name ILIKE $${idx} OR v.colour ILIKE $${idx} OR p.gender ILIKE $${idx})`
    }

    params.push(branchId)
    const branchIdx = params.length

    const sql = `
      WITH base AS (
        SELECT DISTINCT
          p.name AS product_name,
          p.brand_name AS brand,
          p.gender AS gender,
          v.colour AS color
        FROM products p
        JOIN product_variants v ON v.product_id = p.id
        LEFT JOIN LATERAL (
          SELECT BOOL_OR(is_active) AS is_active
          FROM branch_variant_stock bvs
          WHERE bvs.variant_id = v.id
            AND ($${branchIdx}::int IS NULL OR bvs.branch_id = $${branchIdx}::int)
        ) bvs ON TRUE
        WHERE ${where}
        ORDER BY p.name ASC
        LIMIT 800
      )
      SELECT * FROM base
    `

    const { rows } = await pool.query(sql, params)

    const expanded = new Map()
    for (const r of rows) {
      const cands = buildExpandedCandidatesFromRow(r)
      for (const c of cands) {
        const key = String(c || '').trim().toLowerCase()
        if (!key) continue
        if (!expanded.has(key)) expanded.set(key, c)
      }
    }

    const allCandidates = Array.from(expanded.values())

    const scored = []
    for (const c of allCandidates) {
      const score = scoreSuggestion(qRaw, c)
      if (score < 999) scored.push({ v: c, score })
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return a.v.length - b.v.length
    })

    const out = []
    const outSeen = new Set()
    for (const x of scored) {
      const k = x.v.toLowerCase()
      if (!outSeen.has(k)) {
        outSeen.add(k)
        out.push(x.v)
        if (out.length >= 12) break
      }
    }

    res.json(out)
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/category/:category', async (req, res) => {
  try {
    const g = toGender(req.params.category)
    const wantRandom = String(req.query.random || '').trim() === '1'
    const wantHasImageOnly = String(req.query.hasImage || '').toLowerCase() === 'true'
    const params = []
    let where = 'v.is_active = TRUE'
    if (g) {
      params.push(g)
      where += ` AND p.gender = $${params.length}`
    }
    if (wantHasImageOnly) where = addHasImageWhere(where)

    const branchId = getBranchIdFromReq(req)
    params.push(branchId)
    const branchIdx = params.length

    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'
    params.push(cloud)
    const cloudIdx = params.length

    const orderBy = wantRandom ? 'ORDER BY RANDOM()' : 'ORDER BY v.id DESC'

    const sql = `
      ${buildProductSelectSql({ where, branchIdx, cloudIdx })}
      ${orderBy}
    `
    const { rows } = await pool.query(sql, params)
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/gender/:gender', async (req, res) => {
  try {
    const g = toGender(req.params.gender)
    const wantRandom = String(req.query.random || '').trim() === '1'
    const wantHasImageOnly = String(req.query.hasImage || '').toLowerCase() === 'true'
    const params = []
    let where = 'v.is_active = TRUE'
    if (g) {
      params.push(g)
      where += ` AND p.gender = $${params.length}`
    }
    if (wantHasImageOnly) where = addHasImageWhere(where)

    const branchId = getBranchIdFromReq(req)
    params.push(branchId)
    const branchIdx = params.length

    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'
    params.push(cloud)
    const cloudIdx = params.length

    const orderBy = wantRandom ? 'ORDER BY RANDOM()' : 'ORDER BY v.id DESC'

    const sql = `
      ${buildProductSelectSql({ where, branchIdx, cloudIdx })}
      ${orderBy}
    `
    const { rows } = await pool.query(sql, params)
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/search', async (req, res) => {
  try {
    const queryRaw = req.query.q || req.query.query
    if (!queryRaw || !String(queryRaw).trim()) {
      return res.status(400).json({ message: 'Search query is required' })
    }

    const { cleanedQuery, priceMin, priceMax } = parsePriceRangeFromQuery(String(queryRaw))
    const tokens = buildTokens(cleanedQuery || String(queryRaw))

    const genderQ = toGender(req.query.gender || req.query.category || '')
    const params = []
    let where = 'v.is_active = TRUE'

    if (genderQ) {
      params.push(genderQ)
      where += ` AND p.gender = $${params.length}`
    }

    if (tokens.length) {
      const parts = []
      for (const t of tokens) {
        params.push(`%${t}%`)
        const idx = params.length
        parts.push(`(p.name ILIKE $${idx} OR p.brand_name ILIKE $${idx} OR v.colour ILIKE $${idx} OR p.gender ILIKE $${idx})`)
      }
      where += ` AND (${parts.join(' OR ')})`
    } else {
      params.push(`%${String(queryRaw).trim()}%`)
      const idx = params.length
      where += ` AND (p.name ILIKE $${idx} OR p.brand_name ILIKE $${idx} OR v.colour ILIKE $${idx} OR p.gender ILIKE $${idx})`
    }

    if (priceMin != null) {
      params.push(priceMin)
      where += ` AND ${offerPriceSql()} >= $${params.length}`
    }

    if (priceMax != null) {
      params.push(priceMax)
      where += ` AND ${offerPriceSql()} <= $${params.length}`
    }

    const branchId = getBranchIdFromReq(req)
    params.push(branchId)
    const branchIdx = params.length

    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'
    params.push(cloud)
    const cloudIdx = params.length

    const sql = `
      ${buildProductSelectSql({ where, branchIdx, cloudIdx })}
      ORDER BY v.id DESC
      LIMIT 2000
    `
    const { rows } = await pool.query(sql, params)
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: 'Error searching products', error: err.message })
  }
})

router.get('/hero-images', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(120, parseInt(req.query.limit || '60', 10)))
    const rows = await fetchImageList({ gender: null, limit })
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/section-images', async (req, res) => {
  try {
    const limitHero = Math.max(1, Math.min(120, parseInt(req.query.limitHero || '30', 10)))
    const limitGender = Math.max(1, Math.min(80, parseInt(req.query.limitGender || '40', 10)))
    const hero = await fetchImageList({ gender: null, limit: limitHero })
    const women = await fetchImageList({ gender: 'WOMEN', limit: limitGender })
    const men = await fetchImageList({ gender: 'MEN', limit: limitGender })
    const kids = await fetchImageList({ gender: 'KIDS', limit: limitGender })
    res.json({ hero, women, men, kids })
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const branchId = getBranchIdFromReq(req)
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'
    const branchIdx = 2
    const cloudIdx = 3
    const { rows } = await pool.query(
      `
      ${buildProductSelectSql({ where: 'v.id = $1', branchIdx, cloudIdx })}
      `,
      [req.params.id, branchId, cloud]
    )
    if (!rows.length) return res.status(404).json({ message: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.put('/:id(\\d+)', async (req, res) => {
  const client = await pool.connect();

  try {
    const variantId = parseInt(req.params.id, 10);
    if (!Number.isFinite(variantId) || variantId <= 0) {
      return res.status(400).json({ message: 'Invalid product id' });
    }

    const {
      category,
      brand,
      product_name,
      color,
      size,
      original_price_b2b,
      discount_b2b,
      final_price_b2b,
      original_price_b2c,
      discount_b2c,
      final_price_b2c,
      total_count,
      image_url
    } = req.body || {};

    await client.query('BEGIN');

    const existingVariant = await client.query(
      `
      SELECT
        v.id AS variant_id,
        v.product_id,
        v.mrp,
        p.id AS product_id_actual
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      WHERE v.id = $1
      LIMIT 1
      `,
      [variantId]
    );

    if (!existingVariant.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Product not found' });
    }

    const row = existingVariant.rows[0];
    const productId = row.product_id;

    const gender = toGender(category);
    if (!gender) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Invalid category. Use Men, Women, or Kids' });
    }

    const mrp =
      Number.isFinite(Number(original_price_b2c))
        ? Number(original_price_b2c)
        : Number(original_price_b2b);

    const b2bDiscount = Number.isFinite(Number(discount_b2b)) ? Number(discount_b2b) : 0;
    const b2cDiscount = Number.isFinite(Number(discount_b2c)) ? Number(discount_b2c) : 0;
    const stockCount = Math.max(0, parseInt(total_count, 10) || 0);

    await client.query(
      `
      UPDATE products
      SET
        name = $1,
        brand_name = $2,
        gender = $3
      WHERE id = $4
      `,
      [product_name, brand, gender, productId]
    );

    await client.query(
      `
      UPDATE product_variants
      SET
        colour = $1,
        size = $2,
        mrp = $3,
        b2b_discount_pct = $4,
        b2c_discount_pct = $5,
        image_url = $6
      WHERE id = $7
      `,
      [color, size, mrp, b2bDiscount, b2cDiscount, image_url || null, variantId]
    );

    const branchId = getBranchIdFromReq(req);

    if (branchId) {
      const existingStock = await client.query(
        `
        SELECT id
        FROM branch_variant_stock
        WHERE variant_id = $1 AND branch_id = $2
        LIMIT 1
        `,
        [variantId, branchId]
      );

      if (existingStock.rows.length) {
        await client.query(
          `
          UPDATE branch_variant_stock
          SET on_hand = $1
          WHERE variant_id = $2 AND branch_id = $3
          `,
          [stockCount, variantId, branchId]
        );
      } else {
        await client.query(
          `
          INSERT INTO branch_variant_stock (variant_id, branch_id, on_hand, reserved, is_active)
          VALUES ($1, $2, $3, 0, TRUE)
          `,
          [variantId, branchId, stockCount]
        );
      }
    }

    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';
    const refreshed = await client.query(
      `
      ${buildProductSelectSql({ where: 'v.id = $1', branchIdx: 2, cloudIdx: 3 })}
      `,
      [variantId, branchId, cloud]
    );

    await client.query('COMMIT');

    if (!refreshed.rows.length) {
      return res.json({
        id: variantId,
        category,
        brand,
        product_name,
        color,
        size,
        original_price_b2b,
        discount_b2b,
        final_price_b2b,
        original_price_b2c,
        discount_b2c,
        final_price_b2c,
        total_count: stockCount,
        image_url
      });
    }

    const updatedRow = refreshed.rows[0];

    return res.json({
      ...updatedRow,
      category: updatedRow.gender ? updatedRow.gender.toLowerCase() : category,
      discount_b2b: b2bDiscount,
      discount_b2c: b2cDiscount,
      final_price_b2b,
      final_price_b2c,
      total_count: stockCount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({
      message: 'Error updating product',
      error: err.message
    });
  } finally {
    client.release();
  }
});


router.delete('/:id(\\d+)', async (req, res) => {
  const client = await pool.connect();

  try {
    const variantId = parseInt(req.params.id, 10);

    if (!Number.isFinite(variantId) || variantId <= 0) {
      return res.status(400).json({ message: 'Invalid product id' });
    }

    const existing = await client.query(
      `
      SELECT id
      FROM product_variants
      WHERE id = $1
      LIMIT 1
      `,
      [variantId]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ message: 'Product not found' });
    }

    await client.query(
      `
      UPDATE product_variants
      SET is_active = FALSE
      WHERE id = $1
      `,
      [variantId]
    );

    return res.json({
      message: 'Product deleted successfully',
      id: variantId
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Error deleting product',
      error: err.message
    });
  } finally {
    client.release();
  }
});


module.exports = router
