const express = require('express')
const pool = require('../db')

const router = express.Router()

const normGender = value => {
  const gender = String(value || '').trim().toUpperCase()
  if (['MEN', 'WOMEN', 'KIDS'].includes(gender)) return gender
  if (['MAN', 'MALE', 'MENS', "MEN'S"].includes(gender)) return 'MEN'
  if (['WOMAN', 'FEMALE', 'LADIES', 'WOMENS', "WOMEN'S"].includes(gender)) return 'WOMEN'
  if (['CHILD', 'CHILDREN', 'BOYS', 'GIRLS', 'KID'].includes(gender)) return 'KIDS'
  return ''
}

const parsePositiveInt = value => {
  const parsed = parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const noStore = res => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
}

const compareNodes = (a, b) => {
  const orderA = Number(a.sort_order) || 0
  const orderB = Number(b.sort_order) || 0
  if (orderA !== orderB) return orderA - orderB
  return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true })
}

const buildTree = rows => {
  const categoryMap = new Map()
  const roots = []

  for (const row of rows) {
    categoryMap.set(String(row.id), {
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

  for (const category of categoryMap.values()) {
    const parentId = category.parent_id == null ? null : String(category.parent_id)
    if (parentId && categoryMap.has(parentId)) {
      categoryMap.get(parentId).children.push(category)
    } else {
      roots.push(category)
    }
  }

  const sortChildren = category => {
    category.children.sort(compareNodes)
    category.children.forEach(sortChildren)
  }

  roots.sort(compareNodes)
  roots.forEach(sortChildren)

  return roots
}

const getCategoryRows = async ({ gender = '', id = null } = {}) => {
  const params = []
  const filters = []

  if (gender) {
    params.push(gender)
    filters.push(`c.gender = $${params.length}`)
  }

  if (id) {
    params.push(id)
    filters.push(`c.id = $${params.length}`)
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

  const result = await pool.query(
    `
      WITH RECURSIVE category_tree AS (
        SELECT
          c.id,
          c.parent_id,
          c.gender,
          c.name,
          c.slug,
          c.level,
          c.sort_order,
          c.is_active,
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
          c.sort_order,
          c.is_active,
          category_tree.category_path || ' > ' || c.name
        FROM product_categories c
        JOIN category_tree
          ON category_tree.id = c.parent_id
        WHERE c.is_active = TRUE
      )
      SELECT
        c.id,
        c.parent_id,
        parent.name AS parent_name,
        parent.slug AS parent_slug,
        c.gender,
        c.name,
        c.slug,
        c.level,
        c.sort_order,
        c.is_active,
        c.category_path
      FROM category_tree c
      LEFT JOIN category_tree parent
        ON parent.id = c.parent_id
      ${whereClause}
      ORDER BY
        CASE c.gender
          WHEN 'MEN' THEN 1
          WHEN 'WOMEN' THEN 2
          WHEN 'KIDS' THEN 3
          ELSE 4
        END,
        c.level,
        c.sort_order,
        c.name
    `,
    params
  )

  return result.rows
}

router.get('/', async (req, res) => {
  try {
    noStore(res)
    const requestedGender = String(req.query.gender || '').trim()
    const gender = normGender(requestedGender)

    if (requestedGender && !gender) {
      return res.status(400).json({ message: 'Invalid gender' })
    }

    const rows = await getCategoryRows({ gender })
    return res.json(rows)
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Server error' })
  }
})

router.get('/tree', async (req, res) => {
  try {
    noStore(res)
    const requestedGender = String(req.query.gender || '').trim()
    const gender = normGender(requestedGender)

    if (requestedGender && !gender) {
      return res.status(400).json({ message: 'Invalid gender' })
    }

    const rows = await getCategoryRows({ gender })
    return res.json(buildTree(rows))
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Server error' })
  }
})

router.get('/gender/:gender', async (req, res) => {
  try {
    noStore(res)
    const gender = normGender(req.params.gender)

    if (!gender) {
      return res.status(400).json({ message: 'Invalid gender' })
    }

    const rows = await getCategoryRows({ gender })
    return res.json(rows)
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Server error' })
  }
})

router.get('/gender/:gender/tree', async (req, res) => {
  try {
    noStore(res)
    const gender = normGender(req.params.gender)

    if (!gender) {
      return res.status(400).json({ message: 'Invalid gender' })
    }

    const rows = await getCategoryRows({ gender })
    return res.json(buildTree(rows))
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Server error' })
  }
})

router.get('/:id(\\d+)', async (req, res) => {
  try {
    noStore(res)
    const id = parsePositiveInt(req.params.id)

    if (!id) {
      return res.status(400).json({ message: 'Invalid category id' })
    }

    const rows = await getCategoryRows({ id })

    if (!rows.length) {
      return res.status(404).json({ message: 'Category not found' })
    }

    return res.json(rows[0])
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Server error' })
  }
})

module.exports = router