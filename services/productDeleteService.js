const pool = require('../db')

const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim()

const parsePositiveInt = value => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const normalizeGender = value => {
  const gender = cleanText(value).toUpperCase()

  if (['MEN', 'WOMEN', 'KIDS'].includes(gender)) return gender
  if (['MAN', 'MALE', 'MENS', "MEN'S"].includes(gender)) return 'MEN'
  if (['WOMAN', 'FEMALE', 'LADIES', 'WOMENS', "WOMEN'S"].includes(gender)) return 'WOMEN'
  if (['CHILD', 'CHILDREN', 'BOYS', 'GIRLS', 'KID'].includes(gender)) return 'KIDS'

  return ''
}

const uniqueIds = values => {
  const ids = []
  const seen = new Set()

  for (const value of Array.isArray(values) ? values : []) {
    const id = parsePositiveInt(value)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  return ids
}

const getDeletedBy = req => {
  return cleanText(
    req?.user?.email ||
      req?.user?.username ||
      req?.user?.name ||
      req?.user?.id ||
      req?.body?.deleted_by ||
      req?.body?.deletedBy ||
      req?.headers?.['x-admin-user'] ||
      ''
  ) || null
}

const buildAllCandidateQuery = filters => {
  const params = []
  const where = ['p.is_active = TRUE']
  const gender = normalizeGender(filters?.gender || filters?.category || '')
  const brand = cleanText(filters?.brand)
  const search = cleanText(filters?.search || filters?.q || filters?.query)
  const categoryId = parsePositiveInt(filters?.category_id || filters?.categoryId)

  if (gender) {
    params.push(gender)
    where.push(`p.gender = $${params.length}`)
  }

  if (brand) {
    params.push(`%${brand}%`)
    where.push(`p.brand_name ILIKE $${params.length}`)
  }

  if (categoryId) {
    params.push(categoryId)
    const idx = params.length
    where.push(`p.category_id IN (
      WITH RECURSIVE cats AS (
        SELECT id
        FROM product_categories
        WHERE id = $${idx}

        UNION ALL

        SELECT child.id
        FROM product_categories child
        JOIN cats parent
          ON parent.id = child.parent_id
      )
      SELECT id
      FROM cats
    )`)
  }

  if (search) {
    params.push(`%${search}%`)
    const idx = params.length
    where.push(`(
      p.name ILIKE $${idx}
      OR p.brand_name ILIKE $${idx}
      OR COALESCE(p.design_code, '') ILIKE $${idx}
      OR COALESCE(p.pattern_code, '') ILIKE $${idx}
      OR COALESCE(p.pattern_type, '') ILIKE $${idx}
      OR EXISTS (
        SELECT 1
        FROM product_variants v
        WHERE v.product_id = p.id
          AND (
            COALESCE(v.size, '') ILIKE $${idx}
            OR COALESCE(v.colour, '') ILIKE $${idx}
          )
      )
      OR EXISTS (
        SELECT 1
        FROM product_categories c
        WHERE c.id = p.category_id
          AND c.name ILIKE $${idx}
      )
    )`)
  }

  return {
    text: `SELECT p.id
           FROM products p
           WHERE ${where.join(' AND ')}
           ORDER BY p.id`,
    params
  }
}

const getAllCandidateIds = async (client, filters) => {
  const query = buildAllCandidateQuery(filters)
  const result = await client.query(query.text, query.params)
  return result.rows.map(row => Number(row.id)).filter(Number.isInteger)
}

const lockActiveProducts = async (client, productIds) => {
  if (!productIds.length) return []

  const result = await client.query(
    `SELECT id, name, brand_name, design_code
     FROM products
     WHERE id = ANY($1::bigint[])
       AND is_active = TRUE
     ORDER BY id
     FOR UPDATE`,
    [productIds]
  )

  return result.rows
}

const getReservedByProduct = async (client, productIds) => {
  const reserved = new Map()

  if (!productIds.length) return reserved

  const result = await client.query(
    `SELECT
       v.product_id,
       COALESCE(SUM(GREATEST(COALESCE(bvs.reserved, 0), 0)), 0)::int AS reserved
     FROM product_variants v
     JOIN branch_variant_stock bvs
       ON bvs.variant_id = v.id
     WHERE v.product_id = ANY($1::bigint[])
     GROUP BY v.product_id`,
    [productIds]
  )

  for (const row of result.rows) {
    reserved.set(Number(row.product_id), Number(row.reserved || 0))
  }

  return reserved
}

const insertBatch = async ({ client, scope, requestedCount, deletedBy }) => {
  const result = await client.query(
    `INSERT INTO product_delete_batches (
       delete_scope,
       requested_count,
       deleted_count,
       blocked_count,
       deleted_by,
       created_at
     )
     VALUES ($1, $2, 0, 0, $3, NOW())
     RETURNING id`,
    [scope, requestedCount, deletedBy]
  )

  return Number(result.rows[0].id)
}

const completeBatch = async ({ client, batchId, deletedCount, blockedCount }) => {
  await client.query(
    `UPDATE product_delete_batches
     SET deleted_count = $2,
         blocked_count = $3,
         completed_at = NOW()
     WHERE id = $1`,
    [batchId, deletedCount, blockedCount]
  )
}

const deleteProducts = async ({ productIds = [], scope = 'selected', filters = {}, deletedBy = null }) => {
  const normalizedScope = cleanText(scope).toLowerCase() === 'all' ? 'all' : cleanText(scope).toLowerCase() === 'single' ? 'single' : 'selected'
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const requestedIds = normalizedScope === 'all'
      ? await getAllCandidateIds(client, filters)
      : uniqueIds(productIds)

    if (!requestedIds.length) {
      await client.query('COMMIT')
      return {
        ok: true,
        batch_id: null,
        scope: normalizedScope,
        requested_count: 0,
        deleted_count: 0,
        blocked_count: 0,
        deleted_product_ids: [],
        blocked_products: []
      }
    }

    const products = await lockActiveProducts(client, requestedIds)
    const productMap = new Map(products.map(product => [Number(product.id), product]))
    const activeIds = products.map(product => Number(product.id))
    const reservedByProduct = await getReservedByProduct(client, activeIds)
    const blockedProducts = []

    if (normalizedScope !== 'all') {
      for (const requestedId of requestedIds) {
        if (!productMap.has(requestedId)) {
          blockedProducts.push({
            product_id: requestedId,
            reason: 'NOT_FOUND_OR_ALREADY_DELETED',
            reserved: 0
          })
        }
      }
    }

    const deletableIds = []

    for (const product of products) {
      const productId = Number(product.id)
      const reserved = Number(reservedByProduct.get(productId) || 0)

      if (reserved > 0) {
        blockedProducts.push({
          product_id: productId,
          name: product.name,
          brand_name: product.brand_name,
          design_code: product.design_code || '',
          reason: 'RESERVED_STOCK',
          reserved
        })
        continue
      }

      deletableIds.push(productId)
    }

    const batchId = await insertBatch({
      client,
      scope: normalizedScope,
      requestedCount: requestedIds.length,
      deletedBy
    })

    let deletedIds = []

    if (deletableIds.length) {
      await client.query(
        `UPDATE branch_variant_stock bvs
         SET is_active = FALSE,
             updated_at = NOW()
         FROM product_variants v
         WHERE v.id = bvs.variant_id
           AND v.product_id = ANY($1::bigint[])`,
        [deletableIds]
      )

      await client.query(
        `UPDATE product_variants
         SET is_active = FALSE,
             updated_at = NOW()
         WHERE product_id = ANY($1::bigint[])`,
        [deletableIds]
      )

      const deleted = await client.query(
        `UPDATE products
         SET is_active = FALSE,
             deleted_at = NOW(),
             delete_batch_id = $2,
             updated_at = NOW()
         WHERE id = ANY($1::bigint[])
           AND is_active = TRUE
         RETURNING id`,
        [deletableIds, batchId]
      )

      deletedIds = deleted.rows.map(row => Number(row.id))
    }

    const deletedSet = new Set(deletedIds)

    for (const productId of deletableIds) {
      if (!deletedSet.has(productId)) {
        const product = productMap.get(productId)
        blockedProducts.push({
          product_id: productId,
          name: product?.name,
          brand_name: product?.brand_name,
          design_code: product?.design_code || '',
          reason: 'NOT_DELETED',
          reserved: 0
        })
      }
    }

    await completeBatch({
      client,
      batchId,
      deletedCount: deletedIds.length,
      blockedCount: blockedProducts.length
    })

    await client.query('COMMIT')

    return {
      ok: true,
      batch_id: batchId,
      scope: normalizedScope,
      requested_count: requestedIds.length,
      deleted_count: deletedIds.length,
      blocked_count: blockedProducts.length,
      deleted_product_ids: deletedIds,
      blocked_products: blockedProducts
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw error
  } finally {
    client.release()
  }
}

module.exports = {
  deleteProducts,
  getDeletedBy
}
