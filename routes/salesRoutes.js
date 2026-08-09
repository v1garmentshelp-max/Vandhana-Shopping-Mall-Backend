const express = require('express')
const crypto = require('crypto')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const {
  fulfillOrderWithShiprocket
} = require('../services/orderFulfillment')
const {
  optionalCustomerAuth
} = require('../middleware/customerAuth')
const {
  redeemPoints,
  releaseRewardsForSale
} = require('../services/rewardPointsService')

const router = express.Router()

const isDebug = () =>
  String(
    process.env.DEBUG_ERRORS ||
      ''
  ).trim() === '1'

const uuid = () => {
  if (
    typeof crypto.randomUUID ===
    'function'
  ) {
    return crypto.randomUUID()
  }

  const b =
    crypto.randomBytes(16)

  b[6] =
    (b[6] & 0x0f) |
    0x40

  b[8] =
    (b[8] & 0x3f) |
    0x80

  const s =
    b.toString('hex')

  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

const getUserRole = req =>
  String(
    req.user?.role_enum ||
      req.user?.role ||
      ''
  ).toUpperCase()

const toArray = x => {
  if (Array.isArray(x)) {
    return x
  }

  if (
    Array.isArray(x?.data)
  ) {
    return x.data
  }

  if (
    Array.isArray(x?.rows)
  ) {
    return x.rows
  }

  if (
    Array.isArray(x?.items)
  ) {
    return x.items
  }

  if (
    Array.isArray(
      x?.shipments
    )
  ) {
    return x.shipments
  }

  if (
    Array.isArray(x?.result)
  ) {
    return x.result
  }

  return []
}

const statusText = s =>
  String(
    s || ''
  )
    .trim()
    .toUpperCase()

const normalizeOrderStatus =
  value => {
    const s =
      statusText(value)

    if (!s) return ''

    if (
      s.includes(
        'CANCEL'
      )
    ) {
      return 'CANCELLED'
    }

    if (
      s.includes(
        'DELIVERED'
      ) ||
      s.includes(
        'DELIVERED TO'
      ) ||
      s.includes(
        'DELIVER'
      )
    ) {
      return 'DELIVERED'
    }

    if (
      s.includes(
        'OUT FOR DELIVERY'
      ) ||
      s.includes(
        'OUT_FOR_DELIVERY'
      )
    ) {
      return 'SHIPPED'
    }

    if (
      s.includes(
        'IN TRANSIT'
      ) ||
      s.includes(
        'TRANSIT'
      ) ||
      s.includes(
        'DISPATCH'
      ) ||
      s.includes(
        'DISPATCHED'
      ) ||
      s.includes(
        'SHIPPED'
      ) ||
      s.includes(
        'PICKED'
      ) ||
      s.includes(
        'PICKUP'
      )
    ) {
      return 'SHIPPED'
    }

    if (
      s.includes(
        'PACKED'
      ) ||
      s.includes(
        'MANIFEST'
      ) ||
      s.includes(
        'AWB'
      ) ||
      s.includes(
        'READY TO SHIP'
      ) ||
      s.includes(
        'READY_TO_SHIP'
      )
    ) {
      return 'PACKED'
    }

    if (
      s.includes(
        'CONFIRMED'
      ) ||
      s.includes(
        'PROCESSING'
      ) ||
      s.includes(
        'ACCEPTED'
      ) ||
      s.includes(
        'CREATED'
      )
    ) {
      return 'CONFIRMED'
    }

    if (
      s.includes(
        'PLACED'
      ) ||
      s.includes(
        'NEW'
      )
    ) {
      return 'PLACED'
    }

    return s
  }

const statusRank = status => {
  const s =
    normalizeOrderStatus(
      status
    )

  if (s === 'PLACED') {
    return 0
  }

  if (
    s === 'CONFIRMED'
  ) {
    return 1
  }

  if (s === 'PACKED') {
    return 2
  }

  if (
    s === 'SHIPPED'
  ) {
    return 3
  }

  if (
    s === 'DELIVERED'
  ) {
    return 4
  }

  return -1
}

const collectStatusValues = (
  input,
  depth = 0,
  out = []
) => {
  if (
    !input ||
    depth > 6 ||
    out.length > 120
  ) {
    return out
  }

  if (
    typeof input ===
      'string' ||
    typeof input ===
      'number'
  ) {
    const v =
      String(
        input
      ).trim()

    if (
      v &&
      v.length <= 200
    ) {
      out.push(v)
    }

    return out
  }

  if (
    Array.isArray(input)
  ) {
    for (
      const item of
      input
    ) {
      collectStatusValues(
        item,
        depth + 1,
        out
      )
    }

    return out
  }

  if (
    typeof input ===
    'object'
  ) {
    for (
      const [
        key,
        value
      ] of Object.entries(
        input
      )
    ) {
      const k =
        String(
          key || ''
        ).toLowerCase()

      if (
        k.includes(
          'status'
        ) ||
        k.includes(
          'activity'
        ) ||
        k.includes(
          'remark'
        ) ||
        k.includes(
          'description'
        ) ||
        k.includes(
          'event'
        ) ||
        k.includes(
          'scan'
        )
      ) {
        if (
          typeof value ===
            'string' ||
          typeof value ===
            'number'
        ) {
          out.push(
            String(value)
          )
        } else {
          collectStatusValues(
            value,
            depth + 1,
            out
          )
        }
      } else if (
        typeof value ===
        'object'
      ) {
        collectStatusValues(
          value,
          depth + 1,
          out
        )
      }
    }
  }

  return out
}

const bestOrderStatus = (
  values,
  fallback = 'PLACED'
) => {
  const list =
    Array.isArray(values)
      ? values
      : [values]

  let best =
    normalizeOrderStatus(
      fallback
    ) ||
    'PLACED'

  let bestRank =
    statusRank(best)

  for (
    const value of list
  ) {
    const next =
      normalizeOrderStatus(
        value
      )

    if (!next) continue

    if (
      next ===
      'CANCELLED'
    ) {
      return 'CANCELLED'
    }

    const rank =
      statusRank(next)

    if (
      rank > bestRank
    ) {
      best = next
      bestRank = rank
    }
  }

  return best
}

const shouldUpdateSaleStatus =
  (current, next) => {
    const currentStatus =
      normalizeOrderStatus(
        current
      )

    const nextStatus =
      normalizeOrderStatus(
        next
      )

    if (!nextStatus) {
      return false
    }

    if (
      currentStatus ===
      'CANCELLED'
    ) {
      return false
    }

    if (
      nextStatus ===
      'CANCELLED'
    ) {
      return (
        currentStatus !==
        'CANCELLED'
      )
    }

    return (
      statusRank(
        nextStatus
      ) >
      statusRank(
        currentStatus
      )
    )
  }

const syncSaleStatus =
  async (
    saleId,
    candidateStatus,
    db = pool
  ) => {
    const nextStatus =
      normalizeOrderStatus(
        candidateStatus
      )

    if (
      !saleId ||
      !nextStatus
    ) {
      return null
    }

    const q =
      await db.query(
        `SELECT
           id,
           status
         FROM sales
         WHERE id = $1::uuid
         LIMIT 1`,
        [saleId]
      )

    if (!q.rowCount) {
      return null
    }

    const currentStatus =
      q.rows[0].status

    const finalStatus =
      bestOrderStatus(
        [
          currentStatus,
          nextStatus
        ],
        currentStatus ||
          'PLACED'
      )

    if (
      shouldUpdateSaleStatus(
        currentStatus,
        finalStatus
      )
    ) {
      const upd =
        await db.query(
          `UPDATE sales
           SET
             status = $2,
             updated_at = now()
           WHERE id = $1::uuid
           RETURNING status`,
          [
            saleId,
            finalStatus
          ]
        )

      return (
        upd.rows[0]
          ?.status ||
        finalStatus
      )
    }

    return (
      normalizeOrderStatus(
        currentStatus
      ) ||
      currentStatus
    )
  }

const getLatestShipment =
  shipments => {
    const list =
      toArray(shipments)

    if (!list.length) {
      return null
    }

    return [
      ...list
    ].sort(
      (a, b) => {
        const at =
          new Date(
            a?.updated_at ||
              a?.created_at ||
              0
          ).getTime()

        const bt =
          new Date(
            b?.updated_at ||
              b?.created_at ||
              0
          ).getTime()

        return bt - at
      }
    )[0]
  }

const applyEffectiveStatus =
  (
    sale,
    shipments = []
  ) => {
    const latestShipment =
      getLatestShipment(
        shipments
      )

    const shipmentStatuses =
      toArray(
        shipments
      ).flatMap(
        s =>
          collectStatusValues(
            s
          )
      )

    const effectiveStatus =
      bestOrderStatus(
        [
          sale?.status,
          sale
            ?.shipment_status,
          sale
            ?.shipping_status,
          sale
            ?.shiprocket_status,
          sale
            ?.tracking_status,
          sale
            ?.current_status,
          latestShipment
            ?.status,
          latestShipment
            ?.current_status,
          latestShipment
            ?.shipment_status,
          latestShipment
            ?.shiprocket_status,
          latestShipment?.awb
            ? 'PACKED'
            : '',
          ...shipmentStatuses
        ],
        sale?.status ||
          'PLACED'
      )

    return {
      ...sale,
      stored_status:
        sale?.status ||
        null,
      status:
        effectiveStatus,
      effective_status:
        effectiveStatus,
      latest_shipment:
        latestShipment ||
        null,
      shipment_status:
        latestShipment
          ?.status ||
        null,
      awb:
        latestShipment
          ?.awb ||
        null,
      shiprocket_order_id:
        latestShipment
          ?.shiprocket_order_id ||
        null,
      shiprocket_shipment_id:
        latestShipment
          ?.shiprocket_shipment_id ||
        null
    }
  }

const enrichSalesWithShipments =
  async rows => {
    const list =
      Array.isArray(rows)
        ? rows
        : []

    if (!list.length) {
      return []
    }

    const ids =
      list
        .map(
          row => row.id
        )
        .filter(Boolean)

    if (!ids.length) {
      return list.map(
        row =>
          applyEffectiveStatus(
            row,
            []
          )
      )
    }

    const shipmentsQ =
      await pool.query(
        `SELECT *
         FROM shipments
         WHERE sale_id = ANY($1::uuid[])
         ORDER BY created_at ASC`,
        [ids]
      )

    const bySale =
      new Map()

    for (
      const sh of
      shipmentsQ.rows
    ) {
      const key =
        String(
          sh.sale_id
        )

      if (
        !bySale.has(key)
      ) {
        bySale.set(
          key,
          []
        )
      }

      bySale
        .get(key)
        .push(sh)
    }

    return list.map(
      row =>
        applyEffectiveStatus(
          row,
          bySale.get(
            String(
              row.id
            )
          ) || []
        )
    )
  }

const orderItemsSelectForSingleSale = `
  SELECT
    si.product_id,
    si.variant_id,
    si.qty,
    si.price,
    si.mrp,
    si.size,
    si.colour,
    si.ean_code,
    COALESCE(
      NULLIF(si.image_url,''),
      NULLIF(pi.image_url,''),
      CASE
        WHEN si.ean_code IS NOT NULL
         AND si.ean_code <> ''
        THEN CONCAT(
          'https://res.cloudinary.com/',
          $2::text,
          '/image/upload/f_auto,q_auto/products/',
          si.ean_code
        )
        ELSE NULL
      END
    ) AS image_url,
    p.name AS product_name,
    p.brand_name
  FROM sale_items si
  LEFT JOIN product_variants v
    ON v.id = si.variant_id
  LEFT JOIN products p
    ON p.id = v.product_id
  LEFT JOIN LATERAL (
    SELECT pix.image_url
    FROM product_images pix
    WHERE pix.ean_code = si.ean_code
    ORDER BY
      CASE
        WHEN LOWER(COALESCE(pix.image_type, '')) = 'front'
        THEN 0
        WHEN LOWER(COALESCE(pix.image_type, '')) = 'main'
        THEN 1
        WHEN LOWER(COALESCE(pix.image_type, '')) = 'back'
        THEN 2
        ELSE 3
      END,
      pix.id ASC
    LIMIT 1
  ) pi ON TRUE
  WHERE si.sale_id = $1::uuid
`

const orderItemsSelectForMultipleSales = `
  SELECT
    si.sale_id,
    si.product_id,
    si.variant_id,
    si.qty,
    si.price,
    si.mrp,
    si.size,
    si.colour,
    si.ean_code,
    COALESCE(
      NULLIF(si.image_url,''),
      NULLIF(pi.image_url,''),
      CASE
        WHEN si.ean_code IS NOT NULL
         AND si.ean_code <> ''
        THEN CONCAT(
          'https://res.cloudinary.com/',
          $2::text,
          '/image/upload/f_auto,q_auto/products/',
          si.ean_code
        )
        ELSE NULL
      END
    ) AS image_url,
    p.name AS product_name,
    p.brand_name
  FROM sale_items si
  LEFT JOIN product_variants v
    ON v.id = si.variant_id
  LEFT JOIN products p
    ON p.id = v.product_id
  LEFT JOIN LATERAL (
    SELECT pix.image_url
    FROM product_images pix
    WHERE pix.ean_code = si.ean_code
    ORDER BY
      CASE
        WHEN LOWER(COALESCE(pix.image_type, '')) = 'front'
        THEN 0
        WHEN LOWER(COALESCE(pix.image_type, '')) = 'main'
        THEN 1
        WHEN LOWER(COALESCE(pix.image_type, '')) = 'back'
        THEN 2
        ELSE 3
      END,
      pix.id ASC
    LIMIT 1
  ) pi ON TRUE
  WHERE si.sale_id = ANY($1::uuid[])
`

const mapSaleItem =
  r => ({
    product_id:
      r.product_id,
    variant_id:
      r.variant_id,
    qty:
      Number(
        r.qty || 0
      ),
    price:
      Number(
        r.price || 0
      ),
    mrp:
      r.mrp != null
        ? Number(r.mrp)
        : null,
    size:
      r.size,
    colour:
      r.colour,
    ean_code:
      r.ean_code,
    image_url:
      r.image_url,
    product_name:
      r.product_name,
    brand_name:
      r.brand_name
  })

const parsePositiveInt =
  value => {
    const parsed =
      Number(value)

    return (
      Number.isInteger(
        parsed
      ) &&
      parsed > 0
    )
      ? parsed
      : null
  }

const parseNonNegativeInt =
  value => {
    const parsed =
      Number(value)

    return (
      Number.isInteger(
        parsed
      ) &&
      parsed >= 0
    )
      ? parsed
      : null
  }

const cleanText =
  value =>
    String(
      value ?? ''
    ).trim()

const cleanBarcode =
  value =>
    cleanText(
      value
    )
      .replace(
        /\s+/g,
        ''
      )
      .toUpperCase()

const isPosPaymentMethod =
  value => {
    const method =
      statusText(value)

    return (
      method ===
        'POS_CASH' ||
      method ===
        'POS_CARD' ||
      method ===
        'POS_UPI' ||
      method ===
        'POS_OTHER'
    )
  }

const resolvePosBranchId =
  req => {
    const role =
      getUserRole(req)

    const authBranchId =
      parsePositiveInt(
        req.user
          ?.branch_id
      )

    const requestedBranchId =
      parsePositiveInt(
        req.body
          ?.branch_id ??
        req.body
          ?.branchId
      )

    if (
      role ===
      'SUPER_ADMIN'
    ) {
      return (
        requestedBranchId ||
        authBranchId
      )
    }

    return authBranchId
  }

const resolveActiveVariantById =
  async (
    client,
    variantId
  ) => {
    const result =
      await client.query(
        `SELECT
           v.id AS variant_id,
           v.product_id,
           v.size,
           v.colour,
           v.mrp::numeric AS mrp,
           v.sale_price::numeric AS base_sale_price,
           COALESCE(v.b2c_discount_pct, 0)::numeric AS b2c_discount_pct,
           CASE
             WHEN COALESCE(v.b2c_discount_pct, 0) > 0
             THEN ROUND(
               v.mrp::numeric *
               (
                 100 -
                 COALESCE(v.b2c_discount_pct, 0)
               ) / 100,
               2
             )
             ELSE COALESCE(
               NULLIF(v.sale_price, 0),
               v.mrp
             )::numeric
           END AS sale_price,
           p.name AS product_name,
           p.brand_name,
           COALESCE(b.ean_code, '') AS ean_code,
           COALESCE(
             NULLIF(v.image_url, ''),
             NULLIF(pi.image_url, '')
           ) AS image_url
         FROM product_variants v
         JOIN products p
           ON p.id = v.product_id
         LEFT JOIN LATERAL (
           SELECT bc.ean_code
           FROM barcodes bc
           WHERE bc.variant_id = v.id
           ORDER BY bc.id ASC
           LIMIT 1
         ) b ON TRUE
         LEFT JOIN LATERAL (
           SELECT pix.image_url
           FROM product_images pix
           WHERE UPPER(TRIM(pix.ean_code)) =
                 UPPER(TRIM(COALESCE(b.ean_code, '')))
             AND COALESCE(pix.image_url, '') <> ''
           ORDER BY
             CASE
               WHEN LOWER(COALESCE(pix.image_type, '')) = 'front'
               THEN 0
               WHEN LOWER(COALESCE(pix.image_type, '')) = 'main'
               THEN 1
               WHEN LOWER(COALESCE(pix.image_type, '')) = 'back'
               THEN 2
               ELSE 3
             END,
             pix.uploaded_at DESC NULLS LAST,
             pix.id ASC
           LIMIT 1
         ) pi ON TRUE
         WHERE v.id = $1
           AND v.is_active = TRUE
           AND p.is_active = TRUE
         LIMIT 1`,
        [variantId]
      )

    return (
      result.rows[0] ||
      null
    )
  }

const resolveActiveVariantByBarcode =
  async (
    client,
    eanCode
  ) => {
    const result =
      await client.query(
        `SELECT
           v.id AS variant_id,
           v.product_id,
           v.size,
           v.colour,
           v.mrp::numeric AS mrp,
           v.sale_price::numeric AS base_sale_price,
           COALESCE(v.b2c_discount_pct, 0)::numeric AS b2c_discount_pct,
           CASE
             WHEN COALESCE(v.b2c_discount_pct, 0) > 0
             THEN ROUND(
               v.mrp::numeric *
               (
                 100 -
                 COALESCE(v.b2c_discount_pct, 0)
               ) / 100,
               2
             )
             ELSE COALESCE(
               NULLIF(v.sale_price, 0),
               v.mrp
             )::numeric
           END AS sale_price,
           p.name AS product_name,
           p.brand_name,
           b.ean_code,
           COALESCE(
             NULLIF(v.image_url, ''),
             NULLIF(pi.image_url, '')
           ) AS image_url
         FROM barcodes b
         JOIN product_variants v
           ON v.id = b.variant_id
         JOIN products p
           ON p.id = v.product_id
         LEFT JOIN LATERAL (
           SELECT pix.image_url
           FROM product_images pix
           WHERE UPPER(TRIM(pix.ean_code)) =
                 UPPER(TRIM(b.ean_code))
             AND COALESCE(pix.image_url, '') <> ''
           ORDER BY
             CASE
               WHEN LOWER(COALESCE(pix.image_type, '')) = 'front'
               THEN 0
               WHEN LOWER(COALESCE(pix.image_type, '')) = 'main'
               THEN 1
               WHEN LOWER(COALESCE(pix.image_type, '')) = 'back'
               THEN 2
               ELSE 3
             END,
             pix.uploaded_at DESC NULLS LAST,
             pix.id ASC
           LIMIT 1
         ) pi ON TRUE
         WHERE UPPER(TRIM(b.ean_code)) =
               UPPER(TRIM($1))
           AND v.is_active = TRUE
           AND p.is_active = TRUE
         LIMIT 1`,
        [eanCode]
      )

    return (
      result.rows[0] ||
      null
    )
  }

const resolvePosItems =
  async (
    client,
    rawItems
  ) => {
    const aggregated =
      new Map()

    for (
      const rawItem of
      rawItems
    ) {
      const qty =
        parsePositiveInt(
          rawItem?.qty ??
            rawItem
              ?.quantity ??
            1
        )

      if (!qty) {
        throw Object.assign(
          new Error(
            'qty must be a positive integer'
          ),
          {
            status: 400
          }
        )
      }

      const eanCode =
        cleanBarcode(
          rawItem
            ?.ean_code ??
          rawItem?.ean ??
          rawItem
            ?.barcode ??
          rawItem
            ?.barcode_value
        )

      const requestedVariantId =
        parsePositiveInt(
          rawItem
            ?.variant_id ??
          rawItem
            ?.variantId
        )

      if (
        !eanCode &&
        !requestedVariantId
      ) {
        throw Object.assign(
          new Error(
            'ean_code or variant_id required for every POS item'
          ),
          {
            status: 400
          }
        )
      }

      const snapshot =
        eanCode
          ? await resolveActiveVariantByBarcode(
              client,
              eanCode
            )
          : await resolveActiveVariantById(
              client,
              requestedVariantId
            )

      if (!snapshot) {
        throw Object.assign(
          new Error(
            eanCode
              ? `Barcode ${eanCode} not found`
              : `Variant ${requestedVariantId} not found`
          ),
          {
            status: 404,
            code:
              'PRODUCT_NOT_FOUND'
          }
        )
      }

      if (
        requestedVariantId &&
        Number(
          snapshot.variant_id
        ) !==
          requestedVariantId
      ) {
        throw Object.assign(
          new Error(
            `Barcode ${snapshot.ean_code} does not match variant ${requestedVariantId}`
          ),
          {
            status: 409,
            code:
              'BARCODE_VARIANT_MISMATCH'
          }
        )
      }

      const key =
        Number(
          snapshot.variant_id
        )

      const existing =
        aggregated.get(key)

      if (existing) {
        existing.qty += qty
      } else {
        aggregated.set(
          key,
          {
            ...snapshot,
            variant_id:
              Number(
                snapshot.variant_id
              ),
            product_id:
              Number(
                snapshot.product_id
              ),
            mrp:
              Number(
                snapshot.mrp ||
                  0
              ),
            sale_price:
              Number(
                snapshot.sale_price ||
                  0
              ),
            qty
          }
        )
      }
    }

    return Array.from(
      aggregated.values()
    ).sort(
      (a, b) =>
        a.variant_id -
        b.variant_id
    )
  }

const lockAndDeductPosStock =
  async (
    client,
    branchId,
    items
  ) => {
    const remaining = []

    for (
      const item of items
    ) {
      const stockQ =
        await client.query(
          `SELECT
             on_hand,
             reserved,
             is_active
           FROM branch_variant_stock
           WHERE branch_id = $1
             AND variant_id = $2
           FOR UPDATE`,
          [
            branchId,
            item.variant_id
          ]
        )

      if (!stockQ.rowCount) {
        throw Object.assign(
          new Error(
            `Stock not found for barcode ${item.ean_code || item.variant_id}`
          ),
          {
            status: 409,
            code:
              'STOCK_NOT_FOUND',
            item
          }
        )
      }

      const stock =
        stockQ.rows[0]

      const onHand =
        Number(
          stock.on_hand ||
            0
        )

      const reserved =
        Number(
          stock.reserved ||
            0
        )

      const available =
        Math.max(
          onHand -
            reserved,
          0
        )

      if (
        !stock.is_active ||
        available <
          item.qty
      ) {
        throw Object.assign(
          new Error(
            `Out of stock for barcode ${item.ean_code || item.variant_id}`
          ),
          {
            status: 409,
            code:
              'OUT_OF_STOCK',
            item,
            available_qty:
              available
          }
        )
      }

      const updateQ =
        await client.query(
          `UPDATE branch_variant_stock
           SET
             on_hand = on_hand - $3,
             updated_at = NOW()
           WHERE branch_id = $1
             AND variant_id = $2
           RETURNING
             on_hand,
             reserved,
             GREATEST(
               on_hand - reserved,
               0
             )::int AS available_qty`,
          [
            branchId,
            item.variant_id,
            item.qty
          ]
        )

      remaining.push({
        variant_id:
          item.variant_id,
        ean_code:
          item.ean_code,
        on_hand:
          Number(
            updateQ.rows[0]
              .on_hand ||
              0
          ),
        reserved:
          Number(
            updateQ.rows[0]
              .reserved ||
              0
          ),
        available_qty:
          Number(
            updateQ.rows[0]
              .available_qty ||
              0
          )
      })
    }

    return remaining
  }

const buildPosTotals =
  items => {
    let bagTotal = 0
    let discountTotal = 0
    let payable = 0

    for (
      const item of items
    ) {
      bagTotal +=
        Number(
          item.mrp || 0
        ) *
        item.qty

      payable +=
        Number(
          item.sale_price ||
            0
        ) *
        item.qty
    }

    discountTotal =
      Math.max(
        bagTotal -
          payable,
        0
      )

    return {
      bagTotal:
        Number(
          bagTotal.toFixed(
            2
          )
        ),
      discountTotal:
        Number(
          discountTotal.toFixed(
            2
          )
        ),
      couponPct: 0,
      couponDiscount: 0,
      convenience: 0,
      giftWrap: 0,
      payable:
        Number(
          payable.toFixed(
            2
          )
        )
    }
  }

router.post(
  '/pos/place',
  requireAuth,
  async (req, res) => {
    const branchId =
      resolvePosBranchId(
        req
      )

    const body =
      req.body || {}

    const rawItems =
      Array.isArray(
        body.items
      ) &&
      body.items.length
        ? body.items
        : [body]

    const paymentMethod =
      statusText(
        body.payment_method ||
          body.paymentMethod ||
          'POS_CASH'
      )

    if (!branchId) {
      return res
        .status(400)
        .json({
          message:
            'branch_id required'
        })
    }

    if (
      !isPosPaymentMethod(
        paymentMethod
      )
    ) {
      return res
        .status(400)
        .json({
          message:
            'payment_method must be POS_CASH, POS_CARD, POS_UPI or POS_OTHER'
        })
    }

    if (!rawItems.length) {
      return res
        .status(400)
        .json({
          message:
            'items required'
        })
    }

    const client =
      await pool.connect()

    try {
      await client.query(
        'BEGIN'
      )

      const branchQ =
        await client.query(
          `SELECT id
           FROM branches
           WHERE id = $1
           LIMIT 1`,
          [branchId]
        )

      if (!branchQ.rowCount) {
        await client.query(
          'ROLLBACK'
        )

        return res
          .status(404)
          .json({
            message:
              'Branch not found'
          })
      }

      const resolvedItems =
        await resolvePosItems(
          client,
          rawItems
        )

      const remainingStock =
        await lockAndDeductPosStock(
          client,
          branchId,
          resolvedItems
        )

      const calculatedTotals =
        buildPosTotals(
          resolvedItems
        )

      const suppliedTotals =
        body.totals &&
        typeof body.totals ===
          'object'
          ? body.totals
          : {}

      const storedTotals = {
        ...suppliedTotals,
        ...calculatedTotals,
        pos: true
      }

      const saleQ =
        await client.query(
          `INSERT INTO sales
           (
             source,
             status,
             payment_status,
             payment_method,
             total,
             totals,
             branch_id,
             customer_name,
             customer_email,
             customer_mobile,
             shipping_address,
             login_email,
             is_b2b,
             created_at,
             updated_at
           )
           VALUES
           (
             'POS',
             'COMPLETED',
             'PAID',
             $1,
             $2,
             $3::jsonb,
             $4,
             $5,
             $6,
             $7,
             $8::jsonb,
             $9,
             false,
             NOW(),
             NOW()
           )
           RETURNING
             id,
             source,
             status,
             payment_status,
             payment_method,
             total,
             branch_id,
             created_at`,
          [
            paymentMethod,
            calculatedTotals
              .payable,
            JSON.stringify(
              storedTotals
            ),
            branchId,
            cleanText(
              body.customer_name ||
                body.customerName
            ) || null,
            cleanText(
              body.customer_email ||
                body.customerEmail
            ) || null,
            cleanText(
              body.customer_mobile ||
                body.customerMobile
            ) || null,
            JSON.stringify(
              body.shipping_address &&
              typeof body
                .shipping_address ===
                'object'
                ? body
                    .shipping_address
                : {}
            ),
            cleanText(
              body.login_email ||
                body.loginEmail
            ) || null
          ]
        )

      const sale =
        saleQ.rows[0]

      for (
        const item of
        resolvedItems
      ) {
        await client.query(
          `INSERT INTO sale_items
           (
             id,
             sale_id,
             product_id,
             variant_id,
             qty,
             price,
             mrp,
             size,
             colour,
             image_url,
             ean_code,
             created_at
           )
           VALUES
           (
             $1::uuid,
             $2::uuid,
             $3,
             $4,
             $5,
             $6,
             $7,
             $8,
             $9,
             $10,
             $11,
             NOW()
           )`,
          [
            uuid(),
            sale.id,
            item.product_id,
            item.variant_id,
            item.qty,
            item.sale_price,
            item.mrp,
            item.size ||
              null,
            item.colour ||
              null,
            item.image_url ||
              null,
            item.ean_code ||
              null
          ]
        )
      }

      await client.query(
        'COMMIT'
      )

      return res
        .status(201)
        .json({
          ok: true,
          id:
            sale.id,
          sale_id:
            sale.id,
          source:
            sale.source,
          status:
            sale.status,
          payment_status:
            sale.payment_status,
          payment_method:
            sale.payment_method,
          branch_id:
            Number(
              sale.branch_id
            ),
          totals:
            calculatedTotals,
          total:
            Number(
              sale.total ||
                0
            ),
          items:
            resolvedItems.map(
              item => ({
                product_id:
                  item.product_id,
                variant_id:
                  item.variant_id,
                ean_code:
                  item.ean_code,
                product_name:
                  item.product_name,
                brand_name:
                  item.brand_name,
                size:
                  item.size,
                colour:
                  item.colour,
                qty:
                  item.qty,
                mrp:
                  item.mrp,
                price:
                  item.sale_price,
                image_url:
                  item.image_url ||
                  ''
              })
            ),
          remaining_stock:
            remainingStock
        })
    } catch (error) {
      try {
        await client.query(
          'ROLLBACK'
        )
      } catch {}

      const status =
        Number(
          error?.status ||
            500
        )

      const payload = {
        message:
          status >= 500 &&
          !isDebug()
            ? 'Server error'
            : error?.message ||
              'Server error'
      }

      if (error?.code) {
        payload.code =
          error.code
      }

      if (
        error?.available_qty !=
        null
      ) {
        payload.available_qty =
          Number(
            error.available_qty
          )
      }

      if (error?.item) {
        payload.item = {
          product_id:
            error.item
              .product_id,
          variant_id:
            error.item
              .variant_id,
          ean_code:
            error.item
              .ean_code,
          product_name:
            error.item
              .product_name,
          size:
            error.item.size,
          colour:
            error.item.colour,
          requested_qty:
            error.item.qty
        }
      }

      return res
        .status(status)
        .json(payload)
    } finally {
      client.release()
    }
  }
)

router.post(
  '/web/place',
  optionalCustomerAuth,
  async (req, res) => {
    const {
      customer_email,
      customer_name,
      customer_mobile,
      shipping_address,
      totals,
      items,
      branch_id,
      payment_status,
      login_email,
      payment_method,
      reward_points
    } = req.body || {}

    if (
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res
        .status(400)
        .json({
          message:
            'items required'
        })
    }

    const method =
      statusText(
        payment_method
      )

    const posMethod =
      isPosPaymentMethod(
        method
      )

    const requestedRewardPoints =
      parseNonNegativeInt(
        reward_points ??
          totals?.reward_points ??
          totals?.rewardPoints ??
          0
      )

    if (
      requestedRewardPoints ==
      null
    ) {
      return res
        .status(400)
        .json({
          message:
            'reward_points must be a non-negative integer'
        })
    }

    if (
      posMethod &&
      requestedRewardPoints >
        0
    ) {
      return res
        .status(400)
        .json({
          message:
            'Reward points are not available for POS sales'
        })
    }

    if (
      requestedRewardPoints >
        0 &&
      !req.customer?.id
    ) {
      return res
        .status(401)
        .json({
          message:
            'Login required to redeem reward points'
        })
    }

    if (
      requestedRewardPoints >
        0 &&
      String(
        req.customer?.type ||
          'B2C'
      ).toUpperCase() !==
        'B2C'
    ) {
      return res
        .status(403)
        .json({
          message:
            'Reward points are available only for B2C customers'
        })
    }

    if (
      !posMethod &&
      (
        !shipping_address ||
        typeof shipping_address !==
          'object'
      )
    ) {
      return res
        .status(400)
        .json({
          message:
            'shipping_address required'
        })
    }

    let finalPaymentStatus =
      statusText(
        payment_status
      )

    if (posMethod) {
      finalPaymentStatus =
        'PAID'
    } else {
      if (
        !finalPaymentStatus
      ) {
        finalPaymentStatus =
          method ===
          'ONLINE'
            ? 'PENDING'
            : 'COD'
      }

      if (
        ![
          'COD',
          'PENDING',
          'PAID',
          'FAILED'
        ].includes(
          finalPaymentStatus
        )
      ) {
        finalPaymentStatus =
          method ===
          'ONLINE'
            ? 'PENDING'
            : 'COD'
      }
    }

    const agg =
      new Map()

    for (
      const it of items
    ) {
      const vId =
        parsePositiveInt(
          it?.variant_id ??
            it?.product_id
        )

      const qty =
        parsePositiveInt(
          it?.qty ??
            it?.quantity ??
            1
        )

      if (
        !vId ||
        !qty
      ) {
        continue
      }

      agg.set(
        vId,
        (
          agg.get(vId) ||
          0
        ) + qty
      )
    }

    if (
      agg.size === 0
    ) {
      return res
        .status(400)
        .json({
          message:
            'invalid items'
        })
    }

    const providedBranchId =
      parsePositiveInt(
        branch_id
      )

    const client =
      await pool.connect()

    let saleId = null
    let saleTotals = null
    let resolvedBranchId =
      null

    let trustedVariants =
      new Map()

    let rewardResult = null

    try {
      await client.query(
        'BEGIN'
      )

      const variantIds =
        Array.from(
          agg.keys()
        ).sort(
          (a, b) =>
            a - b
        )

      const variantsQ =
        await client.query(
          `SELECT
             v.id AS variant_id,
             v.product_id,
             v.size,
             v.colour,
             v.mrp::numeric AS mrp,
             p.name AS product_name,
             p.brand_name,
             COALESCE(b.ean_code, '') AS ean_code
           FROM product_variants v
           JOIN products p
             ON p.id = v.product_id
           LEFT JOIN LATERAL (
             SELECT bc.ean_code
             FROM barcodes bc
             WHERE bc.variant_id = v.id
             ORDER BY bc.id ASC
             LIMIT 1
           ) b ON TRUE
           WHERE v.id = ANY($1::bigint[])
             AND v.is_active = TRUE
             AND p.is_active = TRUE`,
          [variantIds]
        )

      trustedVariants =
        new Map(
          variantsQ.rows.map(
            row => [
              Number(
                row.variant_id
              ),
              row
            ]
          )
        )

      if (
        trustedVariants.size !==
        variantIds.length
      ) {
        const missing =
          variantIds.filter(
            id =>
              !trustedVariants.has(
                id
              )
          )

        await client.query(
          'ROLLBACK'
        )

        return res
          .status(409)
          .json({
            message:
              `Inactive or missing variant: ${missing.join(', ')}`
          })
      }

      let bagTotal = 0
      let discountTotal = 0

      for (
        const it of items
      ) {
        const mrp =
          Number(
            it?.mrp ??
              it?.price ??
              0
          ) || 0

        const price =
          Number(
            it?.price ??
              0
          ) || 0

        const qty =
          parsePositiveInt(
            it?.qty ??
              it?.quantity ??
              1
          ) || 1

        bagTotal +=
          mrp * qty

        discountTotal +=
          Math.max(
            mrp - price,
            0
          ) *
          qty
      }

      const couponPct =
        Number(
          totals?.couponPct ??
            0
        ) || 0

      const couponDiscount =
        Math.floor(
          (
            (
              bagTotal -
              discountTotal
            ) *
            couponPct
          ) /
          100
        )

      const convenience =
        Number(
          totals
            ?.convenience ??
          totals?.shipping ??
          0
        ) || 0

      const giftWrap =
        Number(
          totals?.giftWrap ??
            0
        ) || 0

      const payableBeforeRewards =
        Math.max(
          bagTotal -
            discountTotal -
            couponDiscount +
            convenience +
            giftWrap,
          0
        )

      if (
        requestedRewardPoints >
        Math.floor(
          payableBeforeRewards
        )
      ) {
        await client.query(
          'ROLLBACK'
        )

        return res
          .status(409)
          .json({
            message:
              'Reward points cannot exceed the order payable amount',
            code:
              'REWARD_EXCEEDS_ORDER',
            max_redeemable:
              Math.floor(
                payableBeforeRewards
              )
          })
      }

      const rewardDiscount =
        requestedRewardPoints

      const payable =
        Math.max(
          payableBeforeRewards -
            rewardDiscount,
          0
        )

      if (
        rewardDiscount > 0 &&
        payable <= 0
      ) {
        finalPaymentStatus =
          'PAID'
      }

      saleTotals = {
        bagTotal,
        discountTotal,
        couponPct,
        couponDiscount,
        convenience,
        giftWrap,
        payableBeforeRewards,
        rewardPoints:
          rewardDiscount,
        reward_points:
          rewardDiscount,
        rewardDiscount,
        reward_discount:
          rewardDiscount,
        payable
      }

      const baseTotals =
        JSON.stringify(
          totals &&
          typeof totals ===
            'object'
            ? {
                ...totals,
                ...saleTotals
              }
            : saleTotals
        )

      const storedEmail =
        req.customer?.email ||
        login_email ||
        customer_email
          ? String(
              req.customer
                ?.email ||
                login_email ||
                customer_email
            )
          : null

      if (
        providedBranchId
      ) {
        resolvedBranchId =
          providedBranchId
      } else {
        const pairs =
          variantIds.map(
            vId => ({
              variant_id:
                vId,
              qty:
                Number(
                  agg.get(
                    vId
                  ) || 0
                )
            })
          )

        const cartJson =
          JSON.stringify(
            pairs
          )

        const branchQ =
          await client.query(
            `WITH cart AS (
               SELECT *
               FROM jsonb_to_recordset($1::jsonb)
               AS x(
                 variant_id bigint,
                 qty int
               )
             )
             SELECT
               bvs.branch_id
             FROM branch_variant_stock bvs
             JOIN cart c
               ON c.variant_id = bvs.variant_id
             JOIN product_variants v
               ON v.id = bvs.variant_id
             JOIN products p
               ON p.id = v.product_id
             WHERE bvs.is_active = TRUE
               AND v.is_active = TRUE
               AND p.is_active = TRUE
               AND GREATEST(
                 COALESCE(bvs.on_hand, 0) -
                 COALESCE(bvs.reserved, 0),
                 0
               ) >= c.qty
             GROUP BY bvs.branch_id
             HAVING COUNT(*) = (
               SELECT COUNT(*)
               FROM cart
             )
             ORDER BY bvs.branch_id ASC
             LIMIT 1`,
            [cartJson]
          )

        resolvedBranchId =
          branchQ.rows?.[0]
            ?.branch_id
            ? Number(
                branchQ.rows[0]
                  .branch_id
              )
            : null
      }

      if (
        !resolvedBranchId
      ) {
        await client.query(
          'ROLLBACK'
        )

        return res
          .status(409)
          .json({
            message:
              'Stock not available in a single branch for all items'
          })
      }

      for (
        const vId of
        variantIds
      ) {
        const qty =
          Number(
            agg.get(vId) ||
              0
          )

        const stockQ =
          await client.query(
            `SELECT
               on_hand,
               reserved,
               is_active
             FROM branch_variant_stock
             WHERE branch_id = $1
               AND variant_id = $2
             FOR UPDATE`,
            [
              resolvedBranchId,
              vId
            ]
          )

        if (
          !stockQ.rowCount
        ) {
          await client.query(
            'ROLLBACK'
          )

          return res
            .status(409)
            .json({
              message:
                `Stock not found for variant ${vId} in branch ${resolvedBranchId}`
            })
        }

        const stock =
          stockQ.rows[0]

        const available =
          Math.max(
            Number(
              stock.on_hand ||
                0
            ) -
              Number(
                stock.reserved ||
                  0
              ),
            0
          )

        if (
          !stock.is_active ||
          available < qty
        ) {
          await client.query(
            'ROLLBACK'
          )

          return res
            .status(409)
            .json({
              message:
                `Insufficient stock for variant ${vId} in branch ${resolvedBranchId}`,
              code:
                'OUT_OF_STOCK',
              variant_id:
                vId,
              available_qty:
                available,
              requested_qty:
                qty
            })
        }

        await client.query(
          `UPDATE branch_variant_stock
           SET
             on_hand = on_hand - $3,
             updated_at = NOW()
           WHERE branch_id = $1
             AND variant_id = $2`,
          [
            resolvedBranchId,
            vId,
            qty
          ]
        )
      }

      const saleSource =
        posMethod
          ? 'POS'
          : 'WEB'

      const saleStatus =
        posMethod
          ? 'COMPLETED'
          : 'PLACED'

      const safeShippingAddress =
        shipping_address &&
        typeof shipping_address ===
          'object'
          ? shipping_address
          : {}

      const inserted =
        await client.query(
          `INSERT INTO sales
           (
             source,
             customer_email,
             customer_name,
             customer_mobile,
             shipping_address,
             status,
             payment_status,
             totals,
             branch_id,
             total,
             payment_method,
             login_email
           )
           VALUES
           (
             $1,
             $2,
             $3,
             $4,
             $5::jsonb,
             $6,
             $7,
             $8::jsonb,
             $9,
             $10,
             $11,
             $12
           )
           RETURNING id`,
          [
            saleSource,
            storedEmail,
            customer_name
              ? String(
                  customer_name
                )
              : null,
            customer_mobile
              ? String(
                  customer_mobile
                )
              : null,
            JSON.stringify(
              safeShippingAddress
            ),
            saleStatus,
            finalPaymentStatus,
            baseTotals,
            resolvedBranchId,
            payable,
            method || null,
            storedEmail
          ]
        )

      saleId =
        inserted.rows?.[0]
          ?.id ||
        null

      if (!saleId) {
        await client.query(
          'ROLLBACK'
        )

        return res
          .status(500)
          .json({
            message:
              'Failed to create order'
          })
      }

      for (
        const it of items
      ) {
        const vId =
          parsePositiveInt(
            it?.variant_id ??
              it?.product_id
          )

        const qty =
          parsePositiveInt(
            it?.qty ??
              it?.quantity ??
              1
          ) || 1

        const trusted =
          trustedVariants.get(
            vId
          )

        await client.query(
          `INSERT INTO sale_items
           (
             id,
             sale_id,
             product_id,
             variant_id,
             qty,
             price,
             mrp,
             size,
             colour,
             image_url,
             ean_code
           )
           VALUES
           (
             $1::uuid,
             $2::uuid,
             $3,
             $4,
             $5,
             $6,
             $7,
             $8,
             $9,
             $10,
             $11
           )`,
          [
            uuid(),
            saleId,
            Number(
              trusted
                .product_id
            ),
            vId,
            qty,
            Number(
              it?.price ??
                0
            ) || 0,
            it?.mrp != null
              ? Number(
                  it.mrp
                )
              : trusted.mrp !=
                  null
                ? Number(
                    trusted.mrp
                  )
                : null,
            trusted.size ??
              it?.size ??
              it?.selected_size ??
              null,
            trusted.colour ??
              it?.colour ??
              it?.color ??
              it
                ?.selected_color ??
              null,
            it?.image_url ??
              null,
            trusted.ean_code ||
              it?.ean_code ||
              it?.barcode_value ||
              null
          ]
        )
      }

      if (
        requestedRewardPoints >
        0
      ) {
        rewardResult =
          await redeemPoints(
            client,
            {
              userId:
                req.customer.id,
              requestedPoints:
                requestedRewardPoints,
              saleId,
              orderSubtotal:
                payableBeforeRewards
            }
          )
      }

      await client.query(
        'COMMIT'
      )
    } catch (e) {
      try {
        await client.query(
          'ROLLBACK'
        )
      } catch {}

      const status =
        Number(
          e?.status ||
            500
        )

      const payload = {
        message:
          status >= 500 &&
          !isDebug()
            ? 'Server error'
            : e?.message ||
              String(e)
      }

      if (e?.code) {
        payload.code =
          e.code
      }

      if (
        e?.available_points !=
        null
      ) {
        payload.available_points =
          Number(
            e.available_points
          )
      }

      if (
        e?.max_redeemable !=
        null
      ) {
        payload.max_redeemable =
          Number(
            e.max_redeemable
          )
      }

      return res
        .status(status)
        .json(payload)
    } finally {
      try {
        client.release()
      } catch {}
    }

    const responseTotals =
      saleTotals ||
      (
        totals &&
        typeof totals ===
          'object'
          ? totals
          : null
      ) ||
      null

    let shiprocket = null
    let shiprocket_error =
      null

    let finalOrderStatus =
      posMethod
        ? 'COMPLETED'
        : 'PLACED'

    const canFulfill =
      !posMethod &&
      (
        finalPaymentStatus ===
          'PAID' ||
        finalPaymentStatus ===
          'COD'
      )

    if (
      canFulfill &&
      saleId &&
      responseTotals &&
      Number(
        responseTotals
          .payable ||
          0
      ) >= 0
    ) {
      const saleForShiprocket = {
        id: saleId,
        branch_id:
          resolvedBranchId,
        stock_already_committed:
          true,
        customer_email:
          req.customer
            ?.email ||
          login_email ||
          customer_email ||
          null,
        customer_name:
          customer_name ||
          null,
        customer_mobile:
          customer_mobile ||
          null,
        shipping_address,
        totals:
          responseTotals,
        payment_status:
          finalPaymentStatus,
        pincode:
          shipping_address
            ?.pincode ||
          null,
        items:
          items.map(
            it => ({
              variant_id:
                Number(
                  it?.variant_id ??
                    it?.product_id
                ),
              qty:
                Number(
                  it?.qty ??
                    it?.quantity ??
                    1
                ),
              price:
                Number(
                  it?.price ??
                    0
                ),
              mrp:
                it?.mrp != null
                  ? Number(
                      it.mrp
                    )
                  : Number(
                      it?.price ??
                        0
                    ),
              size:
                it?.size ??
                it
                  ?.selected_size ??
                null,
              colour:
                it?.colour ??
                it?.color ??
                it
                  ?.selected_color ??
                null,
              image_url:
                it?.image_url ??
                null,
              ean_code:
                it?.ean_code ??
                it
                  ?.barcode_value ??
                null,
              name:
                it?.name ??
                it
                  ?.product_name ??
                null
            })
          )
      }

      try {
        shiprocket =
          await fulfillOrderWithShiprocket(
            saleForShiprocket,
            pool
          )

        finalOrderStatus =
          bestOrderStatus(
            collectStatusValues(
              shiprocket
            ),
            'CONFIRMED'
          )

        await syncSaleStatus(
          saleId,
          finalOrderStatus
        )
      } catch (err) {
        shiprocket_error =
          err?.response?.data ||
          err?.message ||
          String(err)
      }
    }

    return res.json({
      id:
        saleId,
      status:
        finalOrderStatus,
      payment_status:
        finalPaymentStatus,
      totals:
        responseTotals,
      branch_id:
        resolvedBranchId,
      rewards:
        rewardResult,
      shiprocket,
      shiprocket_error
    })
  }
)

router.post(
  '/web/b2b-place',
  async (req, res) => {
    const {
      customer_email,
      customer_name,
      shipping_address,
      items,
      totals,
      payment_method
    } = req.body || {}

    if (!customer_email) {
      return res
        .status(400)
        .json({
          message:
            'customer_email required'
        })
    }

    if (
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res
        .status(400)
        .json({
          message:
            'items required'
        })
    }

    const client =
      await pool.connect()

    try {
      await client.query(
        'BEGIN'
      )

      const saleQ =
        await client.query(
          `INSERT INTO sales
           (
             source,
             customer_email,
             customer_name,
             shipping_address,
             status,
             payment_status,
             totals,
             total,
             payment_method,
             is_b2b,
             created_at
           )
           VALUES
           (
             'B2B',
             $1,
             $2,
             $3::jsonb,
             'B2B_PENDING',
             'PENDING',
             $4::jsonb,
             $5,
             $6,
             true,
             now()
           )
           RETURNING id`,
          [
            customer_email ||
              'b2b@wholesale.com',
            customer_name ||
              'B2B User',
            JSON.stringify(
              shipping_address ||
                {}
            ),
            JSON.stringify(
              totals || {}
            ),
            totals?.payable ||
              0,
            payment_method ||
              'B2B_BULK'
          ]
        )

      const saleId =
        saleQ.rows[0].id

      for (
        const it of items
      ) {
        if (
          !it.variant_id
        ) {
          await client.query(
            'ROLLBACK'
          )

          return res
            .status(400)
            .json({
              message:
                'variant_id is required for all items'
            })
        }

        await client.query(
          `INSERT INTO sale_items
           (
             id,
             sale_id,
             variant_id,
             qty,
             price,
             mrp,
             size,
             colour,
             image_url
           )
           VALUES
           (
             $1::uuid,
             $2::uuid,
             $3,
             $4,
             $5,
             $6,
             $7,
             $8,
             $9
           )`,
          [
            uuid(),
            saleId,
            it.variant_id,
            Number(
              it.qty
            ) || 1,
            Number(
              it.price
            ) || 0,
            Number(
              it.mrp
            ) || 0,
            it.size || '',
            it.colour || '',
            it.image_url ||
              ''
          ]
        )
      }

      await client.query(
        'COMMIT'
      )

      return res.json({
        id:
          saleId,
        status:
          'B2B_PENDING',
        message:
          'Bulk order submitted successfully'
      })
    } catch {
      try {
        await client.query(
          'ROLLBACK'
        )
      } catch {}

      return res
        .status(500)
        .json({
          message:
            'Failed to place B2B order'
        })
    } finally {
      client.release()
    }
  }
)

router.post(
  '/web/set-payment-status',
  async (req, res) => {
    const client =
      await pool.connect()

    try {
      const requestedSaleId =
        String(
          req.body.sale_id ||
            ''
        ).trim()

      const status =
        String(
          req.body.status ||
            ''
        )
          .trim()
          .toUpperCase()

      if (
        !requestedSaleId ||
        !status
      ) {
        return res
          .status(400)
          .json({
            message:
              'sale_id and status required'
          })
      }

      if (
        ![
          'COD',
          'PENDING',
          'PAID',
          'FAILED'
        ].includes(status)
      ) {
        return res
          .status(400)
          .json({
            message:
              'invalid status'
          })
      }

      await client.query(
        'BEGIN'
      )

      const saleQ =
        await client.query(
          `SELECT
             id,
             payment_status
           FROM sales
           WHERE id = $1::uuid
           FOR UPDATE`,
          [requestedSaleId]
        )

      if (
        !saleQ.rowCount
      ) {
        await client.query(
          'ROLLBACK'
        )

        return res
          .status(404)
          .json({
            message:
              'Sale not found'
          })
      }

      const saleRow =
        saleQ.rows[0]

      const currentStatus =
        String(
          saleRow
            .payment_status ||
            ''
        ).toUpperCase()

      if (
        currentStatus ===
        status
      ) {
        if (
          status ===
          'FAILED'
        ) {
          await releaseRewardsForSale(
            client,
            saleRow.id
          )
        }

        await client.query(
          'COMMIT'
        )

        return res.json({
          id:
            saleRow.id,
          payment_status:
            currentStatus
        })
      }

      const q =
        await client.query(
          `UPDATE sales
           SET
             payment_status = $2,
             updated_at = now()
           WHERE id = $1::uuid
           RETURNING
             id,
             payment_status`,
          [
            saleRow.id,
            status
          ]
        )

      if (
        status ===
        'FAILED'
      ) {
        await releaseRewardsForSale(
          client,
          saleRow.id
        )
      }

      await client.query(
        'COMMIT'
      )

      return res.json({
        id:
          q.rows[0].id,
        payment_status:
          q.rows[0]
            .payment_status
      })
    } catch (e) {
      try {
        await client.query(
          'ROLLBACK'
        )
      } catch {}

      const msg =
        isDebug()
          ? e?.message ||
            String(e)
          : 'Server error'

      return res
        .status(500)
        .json({
          message: msg
        })
    } finally {
      client.release()
    }
  }
)

router.get(
  '/web',
  async (_req, res) => {
    try {
      const list =
        await pool.query(
          `SELECT
             s.*,
             oc.payment_type AS cancellation_payment_type,
             oc.reason AS cancellation_reason,
             oc.cancellation_source,
             oc.created_at AS cancellation_created_at
           FROM sales s
           LEFT JOIN order_cancellations oc
             ON oc.sale_id = s.id
           ORDER BY
             s.created_at DESC NULLS LAST,
             s.id DESC
           LIMIT 200`
        )

      const rows =
        await enrichSalesWithShipments(
          list.rows
        )

      res.set(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
      )

      res.set(
        'Pragma',
        'no-cache'
      )

      res.set(
        'Expires',
        '0'
      )

      return res.json(
        rows
      )
    } catch {
      return res
        .status(500)
        .json({
          message:
            'Server error'
        })
    }
  }
)

router.get(
  '/web/by-user',
  async (req, res) => {
    try {
      const email =
        String(
          req.query.email ||
            ''
        ).trim()

      const mobile =
        String(
          req.query.mobile ||
            ''
        ).trim()

      if (
        !email &&
        !mobile
      ) {
        return res
          .status(400)
          .json({
            message:
              'email or mobile required'
          })
      }

      const params = []

      const conds = [
        "s.source = 'WEB'"
      ]

      const ors = []

      if (email) {
        params.push(email)

        ors.push(
          `LOWER(s.customer_email) = LOWER($${params.length})`
        )
      }

      if (mobile) {
        params.push(mobile)

        ors.push(
          `regexp_replace(s.customer_mobile,'\\D','','g') = regexp_replace($${params.length},'\\D','','g')`
        )
      }

      if (ors.length) {
        conds.push(
          `(${ors.join(' OR ')})`
        )
      }

      const salesQ =
        await pool.query(
          `SELECT
             s.id,
             s.status,
             s.payment_status,
             s.payment_method,
             s.created_at,
             s.totals,
             s.branch_id,
             s.customer_name,
             s.customer_email,
             s.customer_mobile,
             oc.payment_type AS cancellation_payment_type,
             oc.reason AS cancellation_reason,
             oc.cancellation_source,
             oc.created_at AS cancellation_created_at
           FROM sales s
           LEFT JOIN order_cancellations oc
             ON oc.sale_id = s.id
           WHERE ${conds.join(' AND ')}
           ORDER BY
             s.created_at DESC NULLS LAST,
             s.id DESC
           LIMIT 200`,
          params
        )

      if (
        salesQ.rowCount ===
        0
      ) {
        return res.json([])
      }

      const enrichedSales =
        await enrichSalesWithShipments(
          salesQ.rows
        )

      const ids =
        enrichedSales.map(
          row => row.id
        )

      const cloud =
        process.env
          .CLOUDINARY_CLOUD_NAME ||
        'digu2krba'

      const itemsQ =
        await pool.query(
          orderItemsSelectForMultipleSales,
          [
            ids,
            cloud
          ]
        )

      const bySale =
        new Map()

      for (
        const sale of
        enrichedSales
      ) {
        bySale.set(
          sale.id,
          {
            ...sale,
            items: []
          }
        )
      }

      for (
        const item of
        itemsQ.rows
      ) {
        const rec =
          bySale.get(
            item.sale_id
          )

        if (rec) {
          rec.items.push(
            mapSaleItem(
              item
            )
          )
        }
      }

      return res.json(
        Array.from(
          bySale.values()
        )
      )
    } catch {
      return res
        .status(500)
        .json({
          message:
            'Server error'
        })
    }
  }
)

router.get(
  '/web/:id',
  async (req, res) => {
    const id =
      String(
        req.params.id ||
          ''
      ).trim()

    if (!id) {
      return res
        .status(400)
        .json({
          message:
            'id required'
        })
    }

    try {
      const saleQ =
        await pool.query(
          `SELECT
             s.id,
             s.status,
             s.payment_status,
             s.payment_method,
             s.created_at,
             s.totals,
             s.branch_id,
             s.customer_name,
             s.customer_email,
             s.customer_mobile,
             s.shipping_address,
             oc.payment_type AS cancellation_payment_type,
             oc.reason AS cancellation_reason,
             oc.cancellation_source,
             oc.created_at AS cancellation_created_at
           FROM sales s
           LEFT JOIN order_cancellations oc
             ON oc.sale_id = s.id
           WHERE s.id = $1::uuid`,
          [id]
        )

      if (
        !saleQ.rowCount
      ) {
        return res
          .status(404)
          .json({
            message:
              'Not found'
          })
      }

      const cloud =
        process.env
          .CLOUDINARY_CLOUD_NAME ||
        'digu2krba'

      const itemsQ =
        await pool.query(
          orderItemsSelectForSingleSale,
          [
            id,
            cloud
          ]
        )

      const items =
        itemsQ.rows.map(
          mapSaleItem
        )

      const enriched =
        await enrichSalesWithShipments(
          saleQ.rows
        )

      return res.json({
        sale:
          enriched[0],
        items
      })
    } catch {
      return res
        .status(500)
        .json({
          message:
            'Server error'
        })
    }
  }
)

router.get(
  '/admin',
  requireAuth,
  async (req, res) => {
    try {
      const role =
        getUserRole(req)

      const isSuper =
        role ===
        'SUPER_ADMIN'

      const branchId =
        Number(
          req.user
            ?.branch_id ||
            0
        )

      const params = []
      const where = []

      if (!isSuper) {
        if (!branchId) {
          return res
            .status(403)
            .json({
              message:
                'Forbidden'
            })
        }

        params.push(
          branchId
        )

        where.push(
          `(s.branch_id = $${params.length} OR s.is_b2b = true)`
        )
      }

      const whereSql =
        where.length
          ? `WHERE ${where.join(' AND ')}`
          : ''

      const list =
        await pool.query(
          `SELECT
             s.*,
             oc.payment_type AS cancellation_payment_type,
             oc.reason AS cancellation_reason,
             oc.cancellation_source,
             oc.created_at AS cancellation_created_at
           FROM sales s
           LEFT JOIN order_cancellations oc
             ON oc.sale_id = s.id
           ${whereSql}
           ORDER BY
             s.created_at DESC NULLS LAST,
             s.id DESC
           LIMIT 200`,
          params
        )

      const rows =
        await enrichSalesWithShipments(
          list.rows
        )

      res.set(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
      )

      res.set(
        'Pragma',
        'no-cache'
      )

      res.set(
        'Expires',
        '0'
      )

      return res.json(
        rows
      )
    } catch {
      return res
        .status(500)
        .json({
          message:
            'Server error'
        })
    }
  }
)

router.get(
  '/admin/:id',
  requireAuth,
  async (req, res) => {
    const id =
      String(
        req.params.id ||
          ''
      ).trim()

    if (!id) {
      return res
        .status(400)
        .json({
          message:
            'id required'
        })
    }

    try {
      const role =
        getUserRole(req)

      const isSuper =
        role ===
        'SUPER_ADMIN'

      const branchId =
        Number(
          req.user
            ?.branch_id ||
            0
        )

      const params = [id]

      let where =
        `s.id = $1::uuid`

      if (!isSuper) {
        if (!branchId) {
          return res
            .status(403)
            .json({
              message:
                'Forbidden'
            })
        }

        params.push(
          branchId
        )

        where +=
          ` AND (s.branch_id = $2 OR s.is_b2b = true)`
      }

      const saleQ =
        await pool.query(
          `SELECT
             s.id,
             s.status,
             s.payment_status,
             s.payment_method,
             s.created_at,
             s.totals,
             s.branch_id,
             s.customer_name,
             s.customer_email,
             s.customer_mobile,
             s.shipping_address,
             oc.payment_type AS cancellation_payment_type,
             oc.reason AS cancellation_reason,
             oc.cancellation_source,
             oc.created_at AS cancellation_created_at
           FROM sales s
           LEFT JOIN order_cancellations oc
             ON oc.sale_id = s.id
           WHERE ${where}`,
          params
        )

      if (
        !saleQ.rowCount
      ) {
        return res
          .status(404)
          .json({
            message:
              'Not found'
          })
      }

      const cloud =
        process.env
          .CLOUDINARY_CLOUD_NAME ||
        'digu2krba'

      const itemsQ =
        await pool.query(
          orderItemsSelectForSingleSale,
          [
            id,
            cloud
          ]
        )

      const items =
        itemsQ.rows.map(
          mapSaleItem
        )

      const enriched =
        await enrichSalesWithShipments(
          saleQ.rows
        )

      return res.json({
        sale:
          enriched[0],
        items
      })
    } catch {
      return res
        .status(500)
        .json({
          message:
            'Server error'
        })
    }
  }
)

router.post(
  '/web/b2b-update-status',
  requireAuth,
  async (req, res) => {
    const client =
      await pool.connect()

    try {
      const {
        sale_id,
        new_status,
        new_payment_status
      } = req.body || {}

      if (!sale_id) {
        return res
          .status(400)
          .json({
            message:
              'sale_id required'
          })
      }

      await client.query(
        'BEGIN'
      )

      const updates = []

      const params = [
        sale_id
      ]

      let paramIndex = 2

      if (new_status) {
        updates.push(
          `status = $${paramIndex}`
        )

        params.push(
          new_status
        )

        paramIndex++
      }

      if (
        new_payment_status
      ) {
        updates.push(
          `payment_status = $${paramIndex}`
        )

        params.push(
          new_payment_status
        )

        paramIndex++
      }

      if (
        updates.length ===
        0
      ) {
        await client.query(
          'ROLLBACK'
        )

        return res
          .status(400)
          .json({
            message:
              'No valid updates provided'
          })
      }

      const q =
        await client.query(
          `UPDATE sales
           SET
             ${updates.join(', ')},
             updated_at = now()
           WHERE id = $1::uuid
           RETURNING
             id,
             status,
             payment_status`,
          params
        )

      await client.query(
        'COMMIT'
      )

      return res.json(
        q.rows[0]
      )
    } catch {
      try {
        await client.query(
          'ROLLBACK'
        )
      } catch {}

      return res
        .status(500)
        .json({
          message:
            'Server error during B2B update'
        })
    } finally {
      client.release()
    }
  }
)

module.exports = router