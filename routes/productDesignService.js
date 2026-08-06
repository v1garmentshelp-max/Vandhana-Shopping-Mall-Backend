const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim()

const parsePositiveInt = value => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const normalizeDesignCode = value => {
  const code = cleanText(value).toUpperCase()

  if (!code || code.length > 100 || !/^[A-Z0-9][A-Z0-9._-]*$/.test(code)) {
    return null
  }

  return code
}

const normalizePatternType = value => {
  const patternType = cleanText(value).toUpperCase()
  return patternType && patternType.length <= 100 ? patternType : null
}

const createError = (statusCode, message, details) => {
  const error = new Error(message)
  error.statusCode = statusCode

  if (details !== undefined) {
    error.details = details
  }

  return error
}

const getUniqueLegacyPatternCode = async (client, product, designCode) => {
  const base = `DESIGN-${designCode}`

  for (let index = 0; index < 1000; index += 1) {
    const candidate = index === 0 ? base : `${base}-${index + 1}`
    const result = await client.query(
      `
        SELECT 1
        FROM products
        WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
          AND LOWER(TRIM(brand_name)) = LOWER(TRIM($2))
          AND LOWER(TRIM(COALESCE(pattern_code, ''))) = LOWER(TRIM($3))
          AND gender = $4
          AND category_id IS NOT DISTINCT FROM $5
        LIMIT 1
      `,
      [
        product.name,
        product.brand_name,
        candidate,
        product.gender,
        product.category_id
      ]
    )

    if (!result.rowCount) {
      return candidate
    }
  }

  throw createError(409, `Unable to generate a unique legacy pattern code for ${designCode}`)
}

const chooseRetainedDesignCode = ({ groups, currentDesignCode, unreviewedVariantCount }) => {
  if (currentDesignCode && groups.has(currentDesignCode)) {
    return currentDesignCode
  }

  if (unreviewedVariantCount > 0) {
    throw createError(
      422,
      'The current product has variants outside this review. Keep the current design code on one reviewed group before applying.',
      { current_design_code: currentDesignCode, unreviewed_variant_count: unreviewedVariantCount }
    )
  }

  return [...groups.values()]
    .sort((left, right) => {
      if (right.variantIds.length !== left.variantIds.length) {
        return right.variantIds.length - left.variantIds.length
      }

      return left.designCode.localeCompare(right.designCode, undefined, { numeric: true })
    })[0].designCode
}

const buildGroups = (rows, product) => {
  const groups = new Map()

  for (const row of rows) {
    const designCode = normalizeDesignCode(
      row.proposed_design_code || row.current_design_code || product.design_code
    )

    if (!designCode) {
      throw createError(422, `Variant ${row.variant_id} does not have a valid design code`)
    }

    const patternType = normalizePatternType(
      row.proposed_pattern_type || row.current_pattern_type || product.pattern_type
    )

    if (!groups.has(designCode)) {
      groups.set(designCode, {
        designCode,
        patternTypes: new Set(),
        variantIds: [],
        eanCodes: []
      })
    }

    const group = groups.get(designCode)

    if (patternType) {
      group.patternTypes.add(patternType)
    }

    group.variantIds.push(Number(row.variant_id))
    group.eanCodes.push(row.ean_code)
  }

  for (const group of groups.values()) {
    if (group.patternTypes.size > 1) {
      throw createError(
        422,
        `Design ${group.designCode} has more than one pattern type`,
        { pattern_types: [...group.patternTypes] }
      )
    }

    group.patternType = [...group.patternTypes][0] || normalizePatternType(product.pattern_type)
    delete group.patternTypes
  }

  return groups
}

const applyProductDesignReview = async ({ pool, productId, actor = {} }) => {
  const sourceProductId = parsePositiveInt(productId)

  if (!pool || typeof pool.connect !== 'function') {
    throw createError(500, 'Database pool is not available')
  }

  if (!sourceProductId) {
    throw createError(400, 'Invalid productId')
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const productResult = await client.query(
      `
        SELECT
          id,
          name,
          brand_name,
          pattern_code,
          fit_type,
          mark_code,
          gender,
          category_id,
          design_code,
          pattern_type,
          created_at,
          updated_at
        FROM products
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [sourceProductId]
    )

    if (!productResult.rowCount) {
      throw createError(404, 'Product not found')
    }

    const product = productResult.rows[0]

    const reviewResult = await client.query(
      `
        SELECT
          r.id AS review_id,
          r.product_id,
          r.variant_id,
          r.ean_code,
          r.current_design_code,
          r.proposed_design_code,
          r.current_pattern_type,
          r.proposed_pattern_type,
          r.review_status,
          r.notes,
          v.product_id AS actual_product_id,
          v.is_active,
          v.size,
          v.colour
        FROM product_design_mapping_review r
        JOIN product_variants v
          ON v.id = r.variant_id
        WHERE r.product_id = $1
        ORDER BY r.variant_id
        FOR UPDATE OF r, v
      `,
      [sourceProductId]
    )

    if (!reviewResult.rowCount) {
      throw createError(404, 'Review rows not found')
    }

    if (reviewResult.rows.some(row => row.review_status === 'APPLIED')) {
      throw createError(409, 'Product design review has already been applied')
    }

    const nonApprovedRows = reviewResult.rows
      .filter(row => row.review_status !== 'APPROVED')
      .map(row => ({ variant_id: row.variant_id, review_status: row.review_status }))

    if (nonApprovedRows.length) {
      throw createError(
        409,
        'Every review row must be APPROVED before applying',
        { rows: nonApprovedRows }
      )
    }

    const movedBeforeApply = reviewResult.rows
      .filter(row => Number(row.actual_product_id) !== sourceProductId)
      .map(row => ({ variant_id: row.variant_id, actual_product_id: row.actual_product_id }))

    if (movedBeforeApply.length) {
      throw createError(
        409,
        'One or more reviewed variants no longer belong to the source product',
        { rows: movedBeforeApply }
      )
    }

    const groups = buildGroups(reviewResult.rows, product)
    const designCodes = [...groups.keys()]

    const conflictResult = await client.query(
      `
        SELECT id, design_code
        FROM products
        WHERE id <> $1
          AND UPPER(TRIM(COALESCE(design_code, ''))) = ANY($2::text[])
        ORDER BY id
        FOR UPDATE
      `,
      [sourceProductId, designCodes]
    )

    if (conflictResult.rowCount) {
      throw createError(
        409,
        'One or more design codes already belong to another product',
        { conflicts: conflictResult.rows }
      )
    }

    const reviewedVariantIds = reviewResult.rows.map(row => Number(row.variant_id))
    const unreviewedResult = await client.query(
      `
        SELECT
          COUNT(*)::int AS count,
          COALESCE(ARRAY_AGG(id ORDER BY id), ARRAY[]::bigint[]) AS variant_ids
        FROM product_variants
        WHERE product_id = $1
          AND NOT (id = ANY($2::bigint[]))
      `,
      [sourceProductId, reviewedVariantIds]
    )

    const unreviewedVariantCount = Number(unreviewedResult.rows[0]?.count || 0)
    const currentDesignCode = normalizeDesignCode(product.design_code)
    const retainedDesignCode = chooseRetainedDesignCode({
      groups,
      currentDesignCode,
      unreviewedVariantCount
    })

    const retainedGroup = groups.get(retainedDesignCode)

    const sourceUpdate = await client.query(
      `
        UPDATE products
        SET design_code = $1,
            pattern_type = $2,
            updated_at = NOW()
        WHERE id = $3
        RETURNING id, design_code, pattern_type, pattern_code
      `,
      [retainedGroup.designCode, retainedGroup.patternType, sourceProductId]
    )

    const targetByDesignCode = new Map()
    targetByDesignCode.set(retainedDesignCode, {
      productId: sourceProductId,
      created: false,
      patternCode: sourceUpdate.rows[0]?.pattern_code || product.pattern_code || null
    })

    const createdProducts = []

    for (const group of groups.values()) {
      if (group.designCode === retainedDesignCode) {
        continue
      }

      const legacyPatternCode = await getUniqueLegacyPatternCode(client, product, group.designCode)
      const inserted = await client.query(
        `
          INSERT INTO products (
            name,
            brand_name,
            pattern_code,
            fit_type,
            mark_code,
            gender,
            category_id,
            design_code,
            pattern_type,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
          RETURNING id, name, brand_name, pattern_code, design_code, pattern_type, gender, category_id
        `,
        [
          product.name,
          product.brand_name,
          legacyPatternCode,
          product.fit_type,
          product.mark_code,
          product.gender,
          product.category_id,
          group.designCode,
          group.patternType
        ]
      )

      const createdProduct = inserted.rows[0]

      targetByDesignCode.set(group.designCode, {
        productId: Number(createdProduct.id),
        created: true,
        patternCode: createdProduct.pattern_code
      })

      createdProducts.push(createdProduct)
    }

    let movedVariantCount = 0
    let updatedSaleItemCount = 0
    const appliedGroups = []

    for (const group of groups.values()) {
      const target = targetByDesignCode.get(group.designCode)
      const targetProductId = Number(target.productId)

      if (targetProductId !== sourceProductId) {
        const moved = await client.query(
          `
            UPDATE product_variants
            SET product_id = $1,
                updated_at = NOW()
            WHERE product_id = $2
              AND id = ANY($3::bigint[])
            RETURNING id
          `,
          [targetProductId, sourceProductId, group.variantIds]
        )

        if (moved.rowCount !== group.variantIds.length) {
          throw createError(
            409,
            `Not all variants could be moved to design ${group.designCode}`,
            {
              expected: group.variantIds.length,
              moved: moved.rowCount,
              variant_ids: group.variantIds
            }
          )
        }

        movedVariantCount += moved.rowCount
      }

      const updatedSales = await client.query(
        `
          UPDATE sale_items
          SET product_id = $1
          WHERE variant_id = ANY($2::bigint[])
            AND product_id IS DISTINCT FROM $1
          RETURNING variant_id
        `,
        [targetProductId, group.variantIds]
      )

      updatedSaleItemCount += updatedSales.rowCount

      const appliedReviews = await client.query(
        `
          UPDATE product_design_mapping_review
          SET current_design_code = $1,
              proposed_design_code = $1,
              current_pattern_type = $2,
              proposed_pattern_type = $2,
              review_status = 'APPLIED',
              updated_at = NOW()
          WHERE product_id = $3
            AND variant_id = ANY($4::bigint[])
          RETURNING variant_id
        `,
        [group.designCode, group.patternType, sourceProductId, group.variantIds]
      )

      if (appliedReviews.rowCount !== group.variantIds.length) {
        throw createError(
          409,
          `Not all review rows could be applied for design ${group.designCode}`,
          {
            expected: group.variantIds.length,
            applied: appliedReviews.rowCount,
            variant_ids: group.variantIds
          }
        )
      }

      appliedGroups.push({
        design_code: group.designCode,
        pattern_type: group.patternType,
        product_id: targetProductId,
        retained_product: targetProductId === sourceProductId,
        created_product: Boolean(target.created),
        legacy_pattern_code: target.patternCode,
        variant_count: group.variantIds.length,
        variant_ids: group.variantIds,
        ean_codes: group.eanCodes
      })
    }

    const verificationResult = await client.query(
      `
        SELECT
          r.variant_id,
          r.current_design_code,
          v.product_id,
          p.design_code
        FROM product_design_mapping_review r
        JOIN product_variants v
          ON v.id = r.variant_id
        JOIN products p
          ON p.id = v.product_id
        WHERE r.product_id = $1
          AND (
            r.review_status <> 'APPLIED'
            OR UPPER(TRIM(COALESCE(r.current_design_code, ''))) <> UPPER(TRIM(COALESCE(p.design_code, '')))
          )
        ORDER BY r.variant_id
      `,
      [sourceProductId]
    )

    if (verificationResult.rowCount) {
      throw createError(
        409,
        'Post-apply design verification failed',
        { rows: verificationResult.rows }
      )
    }

    const saleVerificationResult = await client.query(
      `
        SELECT
          si.variant_id,
          si.product_id AS sale_product_id,
          v.product_id AS variant_product_id
        FROM sale_items si
        JOIN product_variants v
          ON v.id = si.variant_id
        WHERE si.variant_id = ANY($1::bigint[])
          AND si.product_id IS DISTINCT FROM v.product_id
        ORDER BY si.variant_id
      `,
      [reviewedVariantIds]
    )

    if (saleVerificationResult.rowCount) {
      throw createError(
        409,
        'Sale item product references do not match the final variant products',
        { rows: saleVerificationResult.rows }
      )
    }

    await client.query('COMMIT')

    return {
      message: groups.size > 1
        ? 'Product designs split and applied successfully'
        : 'Product design review applied successfully',
      source_product_id: sourceProductId,
      retained_product_id: sourceProductId,
      retained_design_code: retainedDesignCode,
      design_count: groups.size,
      reviewed_variant_count: reviewedVariantIds.length,
      moved_variant_count: movedVariantCount,
      updated_sale_item_count: updatedSaleItemCount,
      unreviewed_variant_count: unreviewedVariantCount,
      created_products: createdProducts,
      design_groups: appliedGroups,
      actor: {
        user_id: actor?.userId || null,
        role: cleanText(actor?.role).toUpperCase() || null
      }
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {}

    if (error?.code === '23505') {
      throw createError(
        409,
        'A product with the same design code or legacy product identity already exists',
        {
          constraint: error.constraint || null,
          detail: error.detail || null
        }
      )
    }

    if (error?.code === '23503') {
      throw createError(
        409,
        'A related record prevents the design split from being applied',
        {
          constraint: error.constraint || null,
          detail: error.detail || null
        }
      )
    }

    throw error
  } finally {
    client.release()
  }
}

module.exports = {
  applyProductDesignReview
}
