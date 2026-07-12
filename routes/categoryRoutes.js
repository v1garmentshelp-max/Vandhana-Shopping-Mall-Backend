const express = require('express')
const pool = require('../db')

const router = express.Router()

const normGender = v => {
  const s = String(v || '').trim().toUpperCase()
  if (s === 'MEN' || s === 'WOMEN' || s === 'KIDS') return s
  if (s === 'MAN' || s === 'MALE' || s === 'MENS' || s === "MEN'S") return 'MEN'
  if (s === 'WOMAN' || s === 'FEMALE' || s === 'LADIES' || s === 'WOMENS' || s === "WOMEN'S") return 'WOMEN'
  if (s === 'CHILD' || s === 'CHILDREN' || s === 'BOYS' || s === 'GIRLS' || s === 'KID') return 'KIDS'
  return ''
}

const noStore = res => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
}

const buildTree = rows => {
  const map = new Map()
  const roots = []

  for (const row of rows) {
    map.set(String(row.id), {
      id: row.id,
      parent_id: row.parent_id,
      gender: row.gender,
      name: row.name,
      slug: row.slug,
      level: row.level,
      sort_order: row.sort_order,
      is_active: row.is_active,
      category_path: row.category_path,
      children: []
    })
  }

  for (const item of map.values()) {
    if (item.parent_id && map.has(String(item.parent_id))) {
      map.get(String(item.parent_id)).children.push(item)
    } else {
      roots.push(item)
    }
  }

  const sortNode = node => {
    node.children.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true })
    })
    node.children.forEach(sortNode)
  }

  roots.sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true })
  })

  roots.forEach(sortNode)
  return roots
}

const getRows = async ({ gender } = {}) => {
  const params = []
  let where = 'c.is_active = TRUE'

  if (gender) {
    params.push(gender)
    where += ` AND c.gender = $${params.length}`
  }

  const { rows } = await pool.query(
    `SELECT
       c.id,
       c.parent_id,
       p.name AS parent_name,
       p.slug AS parent_slug,
       c.gender,
       c.name,
       c.slug,
       c.level,
       c.sort_order,
       c.is_active,
       CASE
         WHEN p2.id IS NOT NULL THEN p2.name || ' > ' || p.name || ' > ' || c.name
         WHEN p.id IS NOT NULL THEN p.name || ' > ' || c.name
         ELSE c.name
       END AS category_path
     FROM product_categories c
     LEFT JOIN product_categories p ON p.id = c.parent_id
     LEFT JOIN product_categories p2 ON p2.id = p.parent_id
     WHERE ${where}
     ORDER BY c.gender, c.level, COALESCE(p.sort_order, c.sort_order), c.sort_order, c.name`,
    params
  )

  return rows
}

router.get('/', async (req, res) => {
  try {
    noStore(res)
    const gender = normGender(req.query.gender)
    const rows = await getRows({ gender })
    res.json(rows)
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.get('/tree', async (req, res) => {
  try {
    noStore(res)
    const gender = normGender(req.query.gender)
    const rows = await getRows({ gender })
    res.json(buildTree(rows))
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.get('/gender/:gender', async (req, res) => {
  try {
    noStore(res)
    const gender = normGender(req.params.gender)
    if (!gender) return res.status(400).json({ message: 'Invalid gender' })
    const rows = await getRows({ gender })
    res.json(rows)
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.get('/gender/:gender/tree', async (req, res) => {
  try {
    noStore(res)
    const gender = normGender(req.params.gender)
    if (!gender) return res.status(400).json({ message: 'Invalid gender' })
    const rows = await getRows({ gender })
    res.json(buildTree(rows))
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.get('/:id(\\d+)', async (req, res) => {
  try {
    noStore(res)
    const id = parseInt(req.params.id, 10)

    const { rows } = await pool.query(
      `SELECT
         c.id,
         c.parent_id,
         p.name AS parent_name,
         p.slug AS parent_slug,
         c.gender,
         c.name,
         c.slug,
         c.level,
         c.sort_order,
         c.is_active,
         CASE
           WHEN p2.id IS NOT NULL THEN p2.name || ' > ' || p.name || ' > ' || c.name
           WHEN p.id IS NOT NULL THEN p.name || ' > ' || c.name
           ELSE c.name
         END AS category_path
       FROM product_categories c
       LEFT JOIN product_categories p ON p.id = c.parent_id
       LEFT JOIN product_categories p2 ON p2.id = p.parent_id
       WHERE c.id = $1
       LIMIT 1`,
      [id]
    )

    if (!rows.length) return res.status(404).json({ message: 'Category not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' })
  }
})

module.exports = router