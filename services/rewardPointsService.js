const pool = require('../db')

const asInt = value => {
  const n = Number(value)
  return Number.isInteger(n) ? n : null
}

const asPositiveInt = value => {
  const n = asInt(value)
  return n != null && n > 0 ? n : null
}

const asNonNegativeInt = value => {
  const n = asInt(value)
  return n != null && n >= 0 ? n : null
}

const asMoney = value => {
  const n = Number(value)
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0
}

async function getSetting(key, db = pool) {
  const q = await db.query(
    `SELECT setting_value
     FROM reward_settings
     WHERE setting_key = $1
     LIMIT 1`,
    [key]
  )
  return q.rows?.[0]?.setting_value ?? null
}

async function getSettings(db = pool) {
  const q = await db.query(
    `SELECT setting_key, setting_value
     FROM reward_settings
     ORDER BY setting_key`
  )

  const raw = Object.fromEntries(q.rows.map(row => [row.setting_key, row.setting_value]))

  return {
    enabled: String(raw.enabled || 'false').toLowerCase() === 'true',
    signup_bonus_points: asNonNegativeInt(raw.signup_bonus_points) ?? 1000,
    validity_days: asPositiveInt(raw.validity_days) ?? 90,
    warning_days: asNonNegativeInt(raw.warning_days) ?? 10
  }
}

async function expireLots(db = pool, userId = null) {
  const params = []
  let userSql = ''

  if (userId != null) {
    params.push(Number(userId))
    userSql = `AND user_id = $${params.length}`
  }

  const q = await db.query(
    `UPDATE reward_point_lots
     SET status = 'EXPIRED',
         updated_at = NOW()
     WHERE status = 'ACTIVE'
       AND points_remaining > 0
       AND expires_at <= NOW()
       ${userSql}
     RETURNING id, user_id, points_remaining`,
    params
  )

  for (const row of q.rows) {
    await db.query(
      `INSERT INTO reward_point_transactions
       (user_id, lot_id, transaction_type, points, note, metadata, created_at)
       VALUES ($1, $2, 'EXPIRED', $3, $4, $5::jsonb, NOW())`,
      [
        row.user_id,
        row.id,
        -Math.abs(Number(row.points_remaining || 0)),
        'Reward points expired',
        JSON.stringify({ expired_points: Number(row.points_remaining || 0) })
      ]
    )
  }

  return q.rows.length
}

async function creditSignupBonus(userId, db = pool) {
  const uid = asPositiveInt(userId)
  if (!uid) throw Object.assign(new Error('Invalid user id'), { status: 400 })

  const settings = await getSettings(db)
  if (!settings.enabled || settings.signup_bonus_points <= 0) return null

  const userQ = await db.query(
    `SELECT id, type
     FROM vandana_users
     WHERE id = $1
     LIMIT 1`,
    [uid]
  )

  if (!userQ.rowCount) throw Object.assign(new Error('User not found'), { status: 404 })
  if (String(userQ.rows[0].type || 'B2C').toUpperCase() !== 'B2C') return null

  const existing = await db.query(
    `SELECT id, user_id, points_granted, points_remaining, granted_at, expires_at, status
     FROM reward_point_lots
     WHERE user_id = $1
       AND source_type = 'SIGNUP_BONUS'
     LIMIT 1`,
    [uid]
  )

  if (existing.rowCount) return existing.rows[0]

  const lotQ = await db.query(
    `INSERT INTO reward_point_lots
     (user_id, source_type, source_ref, points_granted, points_remaining, granted_at, expires_at, status, created_at, updated_at)
     VALUES ($1, 'SIGNUP_BONUS', NULL, $2, $2, NOW(), NOW() + ($3::text || ' days')::interval, 'ACTIVE', NOW(), NOW())
     RETURNING id, user_id, points_granted, points_remaining, granted_at, expires_at, status`,
    [uid, settings.signup_bonus_points, settings.validity_days]
  )

  const lot = lotQ.rows[0]

  await db.query(
    `INSERT INTO reward_point_transactions
     (user_id, lot_id, transaction_type, points, note, metadata, created_at)
     VALUES ($1, $2, 'SIGNUP_BONUS', $3, $4, $5::jsonb, NOW())`,
    [
      uid,
      lot.id,
      settings.signup_bonus_points,
      'Signup reward points',
      JSON.stringify({ validity_days: settings.validity_days })
    ]
  )

  return lot
}

async function getWalletSummary(userId, db = pool) {
  const uid = asPositiveInt(userId)
  if (!uid) throw Object.assign(new Error('Invalid user id'), { status: 400 })

  const userQ = await db.query(
    `SELECT id, name, email, type
     FROM vandana_users
     WHERE id = $1
     LIMIT 1`,
    [uid]
  )

  if (!userQ.rowCount) throw Object.assign(new Error('User not found'), { status: 404 })

  await expireLots(db, uid)
  const settings = await getSettings(db)

  const lotsQ = await db.query(
    `SELECT
       id,
       source_type,
       source_ref,
       points_granted,
       points_remaining,
       granted_at,
       expires_at,
       status,
       GREATEST(CEIL(EXTRACT(EPOCH FROM (expires_at - NOW())) / 86400.0), 0)::int AS days_remaining
     FROM reward_point_lots
     WHERE user_id = $1
     ORDER BY expires_at ASC, id ASC`,
    [uid]
  )

  const activeLots = lotsQ.rows.filter(row =>
    row.status === 'ACTIVE' && Number(row.points_remaining || 0) > 0
  )

  const balance = activeLots.reduce(
    (sum, row) => sum + Number(row.points_remaining || 0),
    0
  )

  const nearest = activeLots[0] || null

  const expiringSoon = activeLots.filter(
    row => Number(row.days_remaining) <= settings.warning_days
  )

  const expiringSoonPoints = expiringSoon.reduce(
    (sum, row) => sum + Number(row.points_remaining || 0),
    0
  )

  return {
    enabled: settings.enabled,
    user: userQ.rows[0],
    balance,
    point_value_rupees: 1,
    signup_bonus_points: settings.signup_bonus_points,
    validity_days: settings.validity_days,
    warning_days: settings.warning_days,
    nearest_expiry: nearest?.expires_at || null,
    days_remaining: nearest ? Number(nearest.days_remaining) : null,
    hurry_up: Boolean(
      nearest &&
      Number(nearest.days_remaining) <= settings.warning_days
    ),
    expiring_soon_points: expiringSoonPoints,
    active_lots: activeLots.map(row => ({
      id: Number(row.id),
      source_type: row.source_type,
      source_ref: row.source_ref,
      points_granted: Number(row.points_granted || 0),
      points_remaining: Number(row.points_remaining || 0),
      granted_at: row.granted_at,
      expires_at: row.expires_at,
      days_remaining: Number(row.days_remaining)
    }))
  }
}

async function getHistory(userId, limit = 50, db = pool) {
  const uid = asPositiveInt(userId)
  if (!uid) throw Object.assign(new Error('Invalid user id'), { status: 400 })

  await expireLots(db, uid)

  const safeLimit = Math.min(
    Math.max(asPositiveInt(limit) || 50, 1),
    200
  )

  const q = await db.query(
    `SELECT
       t.id,
       t.lot_id,
       t.sale_id,
       t.transaction_type,
       t.points,
       t.note,
       t.metadata,
       t.created_at,
       l.source_type,
       l.expires_at
     FROM reward_point_transactions t
     LEFT JOIN reward_point_lots l ON l.id = t.lot_id
     WHERE t.user_id = $1
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT $2`,
    [uid, safeLimit]
  )

  return q.rows.map(row => ({
    ...row,
    id: Number(row.id),
    lot_id: row.lot_id != null ? Number(row.lot_id) : null,
    points: Number(row.points || 0)
  }))
}

async function getRedeemableBalance(userId, db = pool, lock = false) {
  const uid = asPositiveInt(userId)
  if (!uid) throw Object.assign(new Error('Invalid user id'), { status: 400 })

  await expireLots(db, uid)

  const q = await db.query(
    `SELECT id, user_id, points_granted, points_remaining, granted_at, expires_at, status
     FROM reward_point_lots
     WHERE user_id = $1
       AND status = 'ACTIVE'
       AND points_remaining > 0
       AND expires_at > NOW()
     ORDER BY expires_at ASC, id ASC
     ${lock ? 'FOR UPDATE' : ''}`,
    [uid]
  )

  const balance = q.rows.reduce(
    (sum, row) => sum + Number(row.points_remaining || 0),
    0
  )

  return {
    balance,
    lots: q.rows
  }
}

async function previewRedemption(
  {
    userId,
    requestedPoints,
    orderSubtotal
  },
  db = pool
) {
  const points = asNonNegativeInt(requestedPoints)

  if (points == null) {
    throw Object.assign(
      new Error('reward_points must be a non-negative integer'),
      { status: 400 }
    )
  }

  const subtotal = asMoney(orderSubtotal)

  if (subtotal < 0) {
    throw Object.assign(
      new Error('Invalid order subtotal'),
      { status: 400 }
    )
  }

  const settings = await getSettings(db)
  const wallet = await getRedeemableBalance(userId, db, false)

  const maxByOrder = Math.max(
    Math.floor(subtotal),
    0
  )

  const maxRedeemable = Math.min(
    wallet.balance,
    maxByOrder
  )

  return {
    enabled: settings.enabled,
    balance: wallet.balance,
    requested_points: points,
    max_redeemable: settings.enabled ? maxRedeemable : 0,
    can_redeem:
      settings.enabled &&
      points <= maxRedeemable,
    reward_discount:
      settings.enabled &&
      points <= maxRedeemable
        ? points
        : 0,
    payable_after_rewards:
      settings.enabled &&
      points <= maxRedeemable
        ? asMoney(
            Math.max(
              subtotal - points,
              0
            )
          )
        : subtotal,
    point_value_rupees: 1
  }
}

async function redeemPoints(
  db,
  {
    userId,
    requestedPoints,
    saleId,
    orderSubtotal
  }
) {
  const uid = asPositiveInt(userId)
  const points = asPositiveInt(requestedPoints)
  const subtotal = asMoney(orderSubtotal)

  if (!uid) {
    throw Object.assign(
      new Error('Invalid user id'),
      { status: 400 }
    )
  }

  if (!points) {
    throw Object.assign(
      new Error('reward_points must be a positive integer'),
      { status: 400 }
    )
  }

  if (!saleId) {
    throw Object.assign(
      new Error('sale_id required'),
      { status: 400 }
    )
  }

  const settings = await getSettings(db)

  if (!settings.enabled) {
    throw Object.assign(
      new Error('Reward points are disabled'),
      {
        status: 409,
        code: 'REWARDS_DISABLED'
      }
    )
  }

  const wallet = await getRedeemableBalance(
    uid,
    db,
    true
  )

  const maxByOrder = Math.max(
    Math.floor(subtotal),
    0
  )

  const maxRedeemable = Math.min(
    wallet.balance,
    maxByOrder
  )

  if (points > wallet.balance) {
    throw Object.assign(
      new Error('Insufficient reward points'),
      {
        status: 409,
        code: 'INSUFFICIENT_REWARD_POINTS',
        available_points: wallet.balance,
        max_redeemable: maxRedeemable
      }
    )
  }

  if (points > maxByOrder) {
    throw Object.assign(
      new Error('Reward points cannot exceed the order payable amount'),
      {
        status: 409,
        code: 'REWARD_EXCEEDS_ORDER',
        available_points: wallet.balance,
        max_redeemable: maxRedeemable
      }
    )
  }

  let remaining = points
  const deductions = []

  for (const lot of wallet.lots) {
    if (remaining <= 0) break

    const lotAvailable = Number(
      lot.points_remaining || 0
    )

    const deduct = Math.min(
      lotAvailable,
      remaining
    )

    if (deduct <= 0) continue

    const updated = await db.query(
      `UPDATE reward_point_lots
       SET points_remaining = points_remaining - $2,
           status = CASE
             WHEN points_remaining - $2 <= 0
             THEN 'USED'
             ELSE 'ACTIVE'
           END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, points_remaining, status`,
      [lot.id, deduct]
    )

    await db.query(
      `INSERT INTO reward_point_transactions
       (user_id, lot_id, sale_id, transaction_type, points, note, metadata, created_at)
       VALUES
       ($1, $2, $3::uuid, 'REDEEMED', $4, $5, $6::jsonb, NOW())`,
      [
        uid,
        lot.id,
        saleId,
        -deduct,
        'Reward points redeemed',
        JSON.stringify({
          expires_at: lot.expires_at
        })
      ]
    )

    deductions.push({
      lot_id: Number(lot.id),
      points: deduct,
      expires_at: lot.expires_at,
      points_remaining: Number(
        updated.rows[0].points_remaining || 0
      )
    })

    remaining -= deduct
  }

  if (remaining > 0) {
    throw Object.assign(
      new Error('Insufficient reward points'),
      {
        status: 409,
        code: 'INSUFFICIENT_REWARD_POINTS',
        available_points: points - remaining
      }
    )
  }

  return {
    user_id: uid,
    sale_id: saleId,
    points_redeemed: points,
    reward_discount: points,
    deductions
  }
}

async function releaseRewardsForSale(db, saleId) {
  if (!saleId) {
    return {
      restored_points: 0,
      restored: []
    }
  }

  await db.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [String(saleId)]
  )

  const redeemedQ = await db.query(
    `SELECT
       t.user_id,
       t.lot_id,
       SUM(-t.points)::int AS redeemed_points
     FROM reward_point_transactions t
     WHERE t.sale_id = $1::uuid
       AND t.transaction_type = 'REDEEMED'
       AND t.points < 0
     GROUP BY t.user_id, t.lot_id
     ORDER BY t.lot_id`,
    [saleId]
  )

  if (!redeemedQ.rowCount) {
    return {
      restored_points: 0,
      restored: []
    }
  }

  const restored = []

  for (const row of redeemedQ.rows) {
    const refundedQ = await db.query(
      `SELECT
         COALESCE(SUM(points), 0)::int AS refunded_points
       FROM reward_point_transactions
       WHERE sale_id = $1::uuid
         AND user_id = $2
         AND lot_id = $3
         AND transaction_type = 'REFUNDED'
         AND points > 0`,
      [
        saleId,
        row.user_id,
        row.lot_id
      ]
    )

    const redeemedPoints = Number(
      row.redeemed_points || 0
    )

    const alreadyRefunded = Number(
      refundedQ.rows[0]?.refunded_points || 0
    )

    const outstanding = Math.max(
      redeemedPoints - alreadyRefunded,
      0
    )

    if (outstanding <= 0) continue

    const lotQ = await db.query(
      `SELECT
         id,
         user_id,
         points_granted,
         points_remaining,
         expires_at,
         status
       FROM reward_point_lots
       WHERE id = $1
       FOR UPDATE`,
      [row.lot_id]
    )

    if (!lotQ.rowCount) continue

    const lot = lotQ.rows[0]

    const capacity = Math.max(
      Number(lot.points_granted || 0) -
        Number(lot.points_remaining || 0),
      0
    )

    const restorePoints = Math.min(
      outstanding,
      capacity
    )

    if (restorePoints <= 0) continue

    const activeAfterRestore =
      new Date(lot.expires_at).getTime() >
      Date.now()

    await db.query(
      `UPDATE reward_point_lots
       SET points_remaining = points_remaining + $2,
           status = CASE
             WHEN $3::boolean
             THEN 'ACTIVE'
             ELSE 'EXPIRED'
           END,
           updated_at = NOW()
       WHERE id = $1`,
      [
        lot.id,
        restorePoints,
        activeAfterRestore
      ]
    )

    await db.query(
      `INSERT INTO reward_point_transactions
       (user_id, lot_id, sale_id, transaction_type, points, note, metadata, created_at)
       VALUES
       ($1, $2, $3::uuid, 'REFUNDED', $4, $5, $6::jsonb, NOW())`,
      [
        row.user_id,
        lot.id,
        saleId,
        restorePoints,
        'Reward points restored',
        JSON.stringify({
          original_expiry: lot.expires_at
        })
      ]
    )

    if (!activeAfterRestore) {
      await db.query(
        `INSERT INTO reward_point_transactions
         (user_id, lot_id, sale_id, transaction_type, points, note, metadata, created_at)
         VALUES
         ($1, $2, $3::uuid, 'EXPIRED', $4, $5, $6::jsonb, NOW())`,
        [
          row.user_id,
          lot.id,
          saleId,
          -restorePoints,
          'Restored reward points were already past their original expiry',
          JSON.stringify({
            original_expiry: lot.expires_at
          })
        ]
      )
    }

    restored.push({
      user_id: Number(row.user_id),
      lot_id: Number(lot.id),
      points: restorePoints,
      active: activeAfterRestore
    })
  }

  return {
    restored_points: restored.reduce(
      (sum, item) => sum + item.points,
      0
    ),
    restored
  }
}

async function releaseRewardsForSaleWithTransaction(
  saleId
) {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const result =
      await releaseRewardsForSale(
        client,
        saleId
      )

    await client.query('COMMIT')

    return result
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
  getSetting,
  getSettings,
  expireLots,
  creditSignupBonus,
  getWalletSummary,
  getHistory,
  getRedeemableBalance,
  previewRedemption,
  redeemPoints,
  releaseRewardsForSale,
  releaseRewardsForSaleWithTransaction
}