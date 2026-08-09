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

  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null
}

const parseNonNegativeInt = value => {
  if (value === '' || value == null) return null

  const parsed = parseInt(value, 10)

  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : null
}

const cleanName = value => {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

const slugify = value => {
  return cleanName(value)
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const noStore = res => {
  res.set(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  )
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
}

const compareNodes = (a, b) => {
  const orderA = Number(a.sort_order) || 0
  const orderB = Number(b.sort_order) || 0

  if (orderA !== orderB) {
    return orderA - orderB
  }

  return String(a.name || '').localeCompare(
    String(b.name || ''),
    undefined,
    {
      numeric: true
    }
  )
}

const buildTree = rows => {
  const categoryMap = new Map()
  const roots = []

  for (const row of rows) {
    categoryMap.set(String(row.id), {
      ...row,
      children: []
    })
  }

  for (const category of categoryMap.values()) {
    const parentId =
      category.parent_id == null
        ? null
        : String(category.parent_id)

    if (
      parentId &&
      categoryMap.has(parentId)
    ) {
      categoryMap
        .get(parentId)
        .children
        .push(category)
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

const getCategoryRows = async ({
  gender = '',
  id = null,
  includeInactive = false
} = {}) => {
  const params = []
  const filters = []

  if (gender) {
    params.push(gender)
    filters.push(
      `category_tree.gender = $${params.length}`
    )
  }

  if (id) {
    params.push(id)
    filters.push(
      `category_tree.id = $${params.length}`
    )
  }

  const activeRootFilter =
    includeInactive
      ? ''
      : 'AND c.is_active = TRUE'

  const activeChildFilter =
    includeInactive
      ? ''
      : 'WHERE c.is_active = TRUE'

  const whereClause =
    filters.length
      ? `WHERE ${filters.join(' AND ')}`
      : ''

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
          c.created_at,
          c.updated_at,
          c.name::text AS category_path
        FROM product_categories c
        WHERE c.parent_id IS NULL
          ${activeRootFilter}

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
          c.created_at,
          c.updated_at,
          category_tree.category_path || ' > ' || c.name
        FROM product_categories c
        JOIN category_tree
          ON category_tree.id = c.parent_id
        ${activeChildFilter}
      )
      SELECT
        category_tree.id,
        category_tree.parent_id,
        parent.name AS parent_name,
        parent.slug AS parent_slug,
        category_tree.gender,
        category_tree.name,
        category_tree.slug,
        category_tree.level,
        category_tree.sort_order,
        category_tree.is_active,
        category_tree.created_at,
        category_tree.updated_at,
        category_tree.category_path,
        COALESCE(
          product_usage.product_count,
          0
        )::int AS product_count,
        COALESCE(
          import_job_usage.import_job_count,
          0
        )::int AS import_job_count,
        COALESCE(
          import_row_usage.import_row_count,
          0
        )::int AS import_row_count,
        COALESCE(
          child_usage.child_count,
          0
        )::int AS child_count,
        COALESCE(
          child_usage.active_child_count,
          0
        )::int AS active_child_count
      FROM category_tree
      LEFT JOIN product_categories parent
        ON parent.id = category_tree.parent_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS product_count
        FROM products p
        WHERE p.category_id = category_tree.id
          AND p.is_active = TRUE
      ) product_usage
        ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS import_job_count
        FROM import_jobs ij
        WHERE ij.category_id = category_tree.id
      ) import_job_usage
        ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS import_row_count
        FROM import_rows ir
        WHERE ir.category_id = category_tree.id
      ) import_row_usage
        ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS child_count,
          COUNT(*) FILTER (
            WHERE child.is_active = TRUE
          )::int AS active_child_count
        FROM product_categories child
        WHERE child.parent_id = category_tree.id
      ) child_usage
        ON TRUE
      ${whereClause}
      ORDER BY
        CASE category_tree.gender
          WHEN 'MEN' THEN 1
          WHEN 'WOMEN' THEN 2
          WHEN 'KIDS' THEN 3
          ELSE 4
        END,
        category_tree.level,
        category_tree.sort_order,
        category_tree.name
    `,
    params
  )

  return result.rows
}

const getCategoryById = async categoryId => {
  const result = await pool.query(
    `
      SELECT
        id,
        parent_id,
        gender,
        name,
        slug,
        level,
        sort_order,
        is_active,
        created_at,
        updated_at
      FROM product_categories
      WHERE id = $1
      LIMIT 1
    `,
    [categoryId]
  )

  return result.rows[0] || null
}

const getCategoryImpact = async categoryId => {
  const result = await pool.query(
    `
      WITH RECURSIVE subtree AS (
        SELECT
          c.id,
          c.parent_id,
          c.is_active,
          0 AS depth
        FROM product_categories c
        WHERE c.id = $1

        UNION ALL

        SELECT
          child.id,
          child.parent_id,
          child.is_active,
          subtree.depth + 1
        FROM product_categories child
        JOIN subtree
          ON subtree.id = child.parent_id
      ),
      descendant_summary AS (
        SELECT
          COUNT(*) FILTER (
            WHERE depth > 0
          )::int AS descendant_count,
          COUNT(*) FILTER (
            WHERE depth > 0
              AND is_active = TRUE
          )::int AS active_descendant_count
        FROM subtree
      ),
      product_summary AS (
        SELECT
          COUNT(*) FILTER (
            WHERE p.category_id = $1
          )::int AS product_count,
          COUNT(*)::int AS subtree_product_count
        FROM products p
        WHERE p.category_id IN (
          SELECT id
          FROM subtree
        )
          AND p.is_active = TRUE
      ),
      import_job_summary AS (
        SELECT
          COUNT(*) FILTER (
            WHERE ij.category_id = $1
          )::int AS import_job_count,
          COUNT(*)::int AS subtree_import_job_count
        FROM import_jobs ij
        WHERE ij.category_id IN (
          SELECT id
          FROM subtree
        )
      ),
      import_row_summary AS (
        SELECT
          COUNT(*) FILTER (
            WHERE ir.category_id = $1
          )::int AS import_row_count,
          COUNT(*)::int AS subtree_import_row_count
        FROM import_rows ir
        WHERE ir.category_id IN (
          SELECT id
          FROM subtree
        )
      )
      SELECT
        descendant_summary.descendant_count,
        descendant_summary.active_descendant_count,
        product_summary.product_count,
        product_summary.subtree_product_count,
        import_job_summary.import_job_count,
        import_job_summary.subtree_import_job_count,
        import_row_summary.import_row_count,
        import_row_summary.subtree_import_row_count
      FROM descendant_summary
      CROSS JOIN product_summary
      CROSS JOIN import_job_summary
      CROSS JOIN import_row_summary
    `,
    [categoryId]
  )

  return result.rows[0]
}

router.get('/admin', async (req, res) => {
  try {
    noStore(res)

    const rows = await getCategoryRows({
      includeInactive: true
    })

    return res.json({
      rows,
      tree: buildTree(rows)
    })
  } catch (error) {
    return res.status(500).json({
      message:
        error.message ||
        'Server error'
    })
  }
})

router.get('/tree', async (req, res) => {
  try {
    noStore(res)

    const requestedGender =
      String(
        req.query.gender || ''
      ).trim()

    const gender =
      normGender(
        requestedGender
      )

    if (
      requestedGender &&
      !gender
    ) {
      return res.status(400).json({
        message: 'Invalid gender'
      })
    }

    const rows =
      await getCategoryRows({
        gender
      })

    return res.json(
      buildTree(rows)
    )
  } catch (error) {
    return res.status(500).json({
      message:
        error.message ||
        'Server error'
    })
  }
})

router.get(
  '/gender/:gender/tree',
  async (req, res) => {
    try {
      noStore(res)

      const gender =
        normGender(
          req.params.gender
        )

      if (!gender) {
        return res.status(400).json({
          message: 'Invalid gender'
        })
      }

      const rows =
        await getCategoryRows({
          gender
        })

      return res.json(
        buildTree(rows)
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
  '/gender/:gender',
  async (req, res) => {
    try {
      noStore(res)

      const gender =
        normGender(
          req.params.gender
        )

      if (!gender) {
        return res.status(400).json({
          message: 'Invalid gender'
        })
      }

      const rows =
        await getCategoryRows({
          gender
        })

      return res.json(rows)
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
  '/:id(\\d+)/impact',
  async (req, res) => {
    try {
      noStore(res)

      const categoryId =
        parsePositiveInt(
          req.params.id
        )

      if (!categoryId) {
        return res.status(400).json({
          message:
            'Invalid category id'
        })
      }

      const category =
        await getCategoryById(
          categoryId
        )

      if (!category) {
        return res.status(404).json({
          message:
            'Category not found'
        })
      }

      const impact =
        await getCategoryImpact(
          categoryId
        )

      return res.json({
        category_id:
          categoryId,
        ...impact
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
  '/:id(\\d+)',
  async (req, res) => {
    try {
      noStore(res)

      const categoryId =
        parsePositiveInt(
          req.params.id
        )

      if (!categoryId) {
        return res.status(400).json({
          message:
            'Invalid category id'
        })
      }

      const rows =
        await getCategoryRows({
          id: categoryId,
          includeInactive: true
        })

      if (!rows.length) {
        return res.status(404).json({
          message:
            'Category not found'
        })
      }

      return res.json(rows[0])
    } catch (error) {
      return res.status(500).json({
        message:
          error.message ||
          'Server error'
      })
    }
  }
)

router.get('/', async (req, res) => {
  try {
    noStore(res)

    const requestedGender =
      String(
        req.query.gender || ''
      ).trim()

    const gender =
      normGender(
        requestedGender
      )

    if (
      requestedGender &&
      !gender
    ) {
      return res.status(400).json({
        message: 'Invalid gender'
      })
    }

    const rows =
      await getCategoryRows({
        gender
      })

    return res.json(rows)
  } catch (error) {
    return res.status(500).json({
      message:
        error.message ||
        'Server error'
    })
  }
})

router.post('/', async (req, res) => {
  const name =
    cleanName(
      req.body?.name
    )

  const parentId =
    parsePositiveInt(
      req.body?.parent_id
    )

  const sortOrderProvided =
    req.body?.sort_order !== '' &&
    req.body?.sort_order != null

  const requestedSortOrder =
    parseNonNegativeInt(
      req.body?.sort_order
    )

  if (!name) {
    return res.status(400).json({
      message:
        'Category name is required'
    })
  }

  if (!parentId) {
    return res.status(400).json({
      message:
        'Parent category is required'
    })
  }

  if (
    sortOrderProvided &&
    requestedSortOrder == null
  ) {
    return res.status(400).json({
      message:
        'Sort order must be zero or a positive number'
    })
  }

  const slug = slugify(name)

  if (!slug) {
    return res.status(400).json({
      message:
        'Invalid category name'
    })
  }

  const client =
    await pool.connect()

  try {
    await client.query('BEGIN')

    const parentResult =
      await client.query(
        `
          SELECT
            id,
            parent_id,
            gender,
            name,
            level,
            is_active
          FROM product_categories
          WHERE id = $1
          FOR UPDATE
        `,
        [parentId]
      )

    const parent =
      parentResult.rows[0]

    if (!parent) {
      await client.query(
        'ROLLBACK'
      )

      return res.status(404).json({
        message:
          'Parent category not found'
      })
    }

    if (!parent.is_active) {
      await client.query(
        'ROLLBACK'
      )

      return res.status(400).json({
        message:
          'Cannot add a category under an inactive parent'
      })
    }

    const parentProducts =
      await client.query(
        `
          SELECT EXISTS (
            SELECT 1
            FROM products
            WHERE category_id = $1
              AND is_active = TRUE
          ) AS has_products
        `,
        [parentId]
      )

    if (
      parentProducts.rows[0]
        ?.has_products
    ) {
      await client.query(
        'ROLLBACK'
      )

      return res.status(400).json({
        message:
          'This parent category already contains products'
      })
    }

    const duplicateResult =
      await client.query(
        `
          SELECT id
          FROM product_categories
          WHERE parent_id = $1
            AND LOWER(slug) = LOWER($2)
          LIMIT 1
        `,
        [
          parentId,
          slug
        ]
      )

    if (
      duplicateResult.rows.length
    ) {
      await client.query(
        'ROLLBACK'
      )

      return res.status(409).json({
        message:
          'A category with this name already exists under the selected parent'
      })
    }

    let sortOrder =
      requestedSortOrder

    if (sortOrder == null) {
      const sortResult =
        await client.query(
          `
            SELECT
              COALESCE(
                MAX(sort_order),
                0
              ) + 10 AS next_sort_order
            FROM product_categories
            WHERE parent_id = $1
          `,
          [parentId]
        )

      sortOrder =
        Number(
          sortResult.rows[0]
            ?.next_sort_order ||
          10
        )
    }

    const insertResult =
      await client.query(
        `
          INSERT INTO product_categories (
            parent_id,
            gender,
            name,
            slug,
            level,
            sort_order,
            is_active
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            TRUE
          )
          RETURNING id
        `,
        [
          parentId,
          parent.gender,
          name,
          slug,
          Number(
            parent.level || 0
          ) + 1,
          sortOrder
        ]
      )

    await client.query('COMMIT')

    const rows =
      await getCategoryRows({
        id:
          insertResult.rows[0].id,
        includeInactive: true
      })

    return res
      .status(201)
      .json(rows[0])
  } catch (error) {
    try {
      await client.query(
        'ROLLBACK'
      )
    } catch {}

    if (error.code === '23505') {
      return res.status(409).json({
        message:
          'A category with this slug already exists under the selected parent'
      })
    }

    return res.status(500).json({
      message:
        error.message ||
        'Server error'
    })
  } finally {
    client.release()
  }
})

router.put(
  '/:id(\\d+)',
  async (req, res) => {
    const categoryId =
      parsePositiveInt(
        req.params.id
      )

    const name =
      cleanName(
        req.body?.name
      )

    const parentId =
      parsePositiveInt(
        req.body?.parent_id
      )

    const sortOrder =
      parseNonNegativeInt(
        req.body?.sort_order
      )

    if (!categoryId) {
      return res.status(400).json({
        message:
          'Invalid category id'
      })
    }

    if (!name) {
      return res.status(400).json({
        message:
          'Category name is required'
      })
    }

    if (!parentId) {
      return res.status(400).json({
        message:
          'Parent category is required'
      })
    }

    if (sortOrder == null) {
      return res.status(400).json({
        message:
          'Sort order must be zero or a positive number'
      })
    }

    if (
      categoryId === parentId
    ) {
      return res.status(400).json({
        message:
          'A category cannot be its own parent'
      })
    }

    const slug =
      slugify(name)

    if (!slug) {
      return res.status(400).json({
        message:
          'Invalid category name'
      })
    }

    const client =
      await pool.connect()

    try {
      await client.query('BEGIN')

      const categoryResult =
        await client.query(
          `
            SELECT *
            FROM product_categories
            WHERE id = $1
            FOR UPDATE
          `,
          [categoryId]
        )

      const category =
        categoryResult.rows[0]

      if (!category) {
        await client.query(
          'ROLLBACK'
        )

        return res.status(404).json({
          message:
            'Category not found'
        })
      }

      if (
        category.parent_id == null
      ) {
        await client.query(
          'ROLLBACK'
        )

        return res.status(400).json({
          message:
            'Root categories cannot be edited'
        })
      }

      const parentResult =
        await client.query(
          `
            SELECT *
            FROM product_categories
            WHERE id = $1
            FOR UPDATE
          `,
          [parentId]
        )

      const parent =
        parentResult.rows[0]

      if (!parent) {
        await client.query(
          'ROLLBACK'
        )

        return res.status(404).json({
          message:
            'Parent category not found'
        })
      }

      if (!parent.is_active) {
        await client.query(
          'ROLLBACK'
        )

        return res.status(400).json({
          message:
            'Cannot move a category under an inactive parent'
        })
      }

      if (
        parent.gender !==
        category.gender
      ) {
        await client.query(
          'ROLLBACK'
        )

        return res.status(400).json({
          message:
            'A category cannot be moved to another gender'
        })
      }

      const descendantResult =
        await client.query(
          `
            WITH RECURSIVE descendants AS (
              SELECT id
              FROM product_categories
              WHERE parent_id = $1

              UNION ALL

              SELECT child.id
              FROM product_categories child
              JOIN descendants
                ON descendants.id = child.parent_id
            )
            SELECT EXISTS (
              SELECT 1
              FROM descendants
              WHERE id = $2
            ) AS found
          `,
          [
            categoryId,
            parentId
          ]
        )

      if (
        descendantResult.rows[0]
          ?.found
      ) {
        await client.query(
          'ROLLBACK'
        )

        return res.status(400).json({
          message:
            'A category cannot be moved under one of its child categories'
        })
      }

      if (
        Number(
          category.parent_id
        ) !== parentId
      ) {
        const parentProducts =
          await client.query(
            `
              SELECT EXISTS (
                SELECT 1
                FROM products
                WHERE category_id = $1
                  AND is_active = TRUE
              ) AS has_products
            `,
            [parentId]
          )

        if (
          parentProducts.rows[0]
            ?.has_products
        ) {
          await client.query(
            'ROLLBACK'
          )

          return res.status(400).json({
            message:
              'The selected parent category already contains products'
          })
        }
      }

      const duplicateResult =
        await client.query(
          `
            SELECT id
            FROM product_categories
            WHERE parent_id = $1
              AND LOWER(slug) = LOWER($2)
              AND id <> $3
            LIMIT 1
          `,
          [
            parentId,
            slug,
            categoryId
          ]
        )

      if (
        duplicateResult.rows.length
      ) {
        await client.query(
          'ROLLBACK'
        )

        return res.status(409).json({
          message:
            'A category with this name already exists under the selected parent'
        })
      }

      const nextLevel =
        Number(
          parent.level || 0
        ) + 1

      const levelDifference =
        nextLevel -
        Number(
          category.level || 0
        )

      await client.query(
        `
          UPDATE product_categories
          SET
            parent_id = $2,
            gender = $3,
            name = $4,
            slug = $5,
            level = $6,
            sort_order = $7
          WHERE id = $1
        `,
        [
          categoryId,
          parentId,
          parent.gender,
          name,
          slug,
          nextLevel,
          sortOrder
        ]
      )

      if (
        levelDifference !== 0
      ) {
        await client.query(
          `
            WITH RECURSIVE descendants AS (
              SELECT id
              FROM product_categories
              WHERE parent_id = $1

              UNION ALL

              SELECT child.id
              FROM product_categories child
              JOIN descendants
                ON descendants.id = child.parent_id
            )
            UPDATE product_categories
            SET
              level = level + $2
            WHERE id IN (
              SELECT id
              FROM descendants
            )
          `,
          [
            categoryId,
            levelDifference
          ]
        )
      }

      await client.query('COMMIT')

      const rows =
        await getCategoryRows({
          id: categoryId,
          includeInactive: true
        })

      return res.json(rows[0])
    } catch (error) {
      try {
        await client.query(
          'ROLLBACK'
        )
      } catch {}

      if (
        error.code === '23505'
      ) {
        return res.status(409).json({
          message:
            'A category with this slug already exists under the selected parent'
        })
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

router.patch(
  '/:id(\\d+)/status',
  async (req, res) => {
    const categoryId =
      parsePositiveInt(
        req.params.id
      )

    const isActive =
      req.body?.is_active

    const cascade =
      req.body?.cascade === true

    if (!categoryId) {
      return res.status(400).json({
        message:
          'Invalid category id'
      })
    }

    if (
      typeof isActive !==
      'boolean'
    ) {
      return res.status(400).json({
        message:
          'is_active must be true or false'
      })
    }

    const client =
      await pool.connect()

    try {
      await client.query('BEGIN')

      const categoryResult =
        await client.query(
          `
            SELECT *
            FROM product_categories
            WHERE id = $1
            FOR UPDATE
          `,
          [categoryId]
        )

      const category =
        categoryResult.rows[0]

      if (!category) {
        await client.query(
          'ROLLBACK'
        )

        return res.status(404).json({
          message:
            'Category not found'
        })
      }

      if (
        category.parent_id == null
      ) {
        await client.query(
          'ROLLBACK'
        )

        return res.status(400).json({
          message:
            'Root categories cannot be deactivated or restored'
        })
      }

      if (isActive) {
        const parentResult =
          await client.query(
            `
              SELECT is_active
              FROM product_categories
              WHERE id = $1
              LIMIT 1
            `,
            [
              category.parent_id
            ]
          )

        if (
          !parentResult.rows[0]
            ?.is_active
        ) {
          await client.query(
            'ROLLBACK'
          )

          return res.status(400).json({
            message:
              'Restore the parent category first'
          })
        }
      }

      const descendantResult =
        await client.query(
          `
            WITH RECURSIVE descendants AS (
              SELECT
                id,
                is_active
              FROM product_categories
              WHERE parent_id = $1

              UNION ALL

              SELECT
                child.id,
                child.is_active
              FROM product_categories child
              JOIN descendants
                ON descendants.id = child.parent_id
            )
            SELECT
              COUNT(*)::int AS descendant_count,
              COUNT(*) FILTER (
                WHERE is_active = TRUE
              )::int AS active_descendant_count
            FROM descendants
          `,
          [categoryId]
        )

      const descendantCount =
        Number(
          descendantResult.rows[0]
            ?.descendant_count ||
          0
        )

      const activeDescendantCount =
        Number(
          descendantResult.rows[0]
            ?.active_descendant_count ||
          0
        )

      if (
        !isActive &&
        activeDescendantCount > 0 &&
        !cascade
      ) {
        await client.query(
          'ROLLBACK'
        )

        return res.status(400).json({
          message:
            'This category has active child categories. Select the cascade option to deactivate the full category tree'
        })
      }

      if (
        cascade &&
        descendantCount > 0
      ) {
        await client.query(
          `
            WITH RECURSIVE subtree AS (
              SELECT id
              FROM product_categories
              WHERE id = $1

              UNION ALL

              SELECT child.id
              FROM product_categories child
              JOIN subtree
                ON subtree.id = child.parent_id
            )
            UPDATE product_categories
            SET is_active = $2
            WHERE id IN (
              SELECT id
              FROM subtree
            )
          `,
          [
            categoryId,
            isActive
          ]
        )
      } else {
        await client.query(
          `
            UPDATE product_categories
            SET is_active = $2
            WHERE id = $1
          `,
          [
            categoryId,
            isActive
          ]
        )
      }

      await client.query('COMMIT')

      const rows =
        await getCategoryRows({
          id: categoryId,
          includeInactive: true
        })

      return res.json(rows[0])
    } catch (error) {
      try {
        await client.query(
          'ROLLBACK'
        )
      } catch {}

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

module.exports = router