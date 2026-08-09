const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { requireCustomerAuth } = require('../middleware/customerAuth')
const {
  getWalletSummary,
  getHistory,
  previewRedemption,
  getSettings,
  expireLots
} = require('../services/rewardPointsService')

const router = express.Router()

const asPositiveInt = (value, fallback) => {
  const n = Number(value)

  if (!Number.isInteger(n) || n <= 0) {
    return fallback
  }

  return n
}

const requireSuperAdmin = (req, res, next) => {
  const role = String(
    req.user?.role_enum ||
      req.user?.role ||
      ''
  ).toUpperCase()

  if (role !== 'SUPER_ADMIN') {
    return res.status(403).json({
      message: 'Forbidden'
    })
  }

  return next()
}

router.get(
  '/admin/summary',
  requireAuth,
  requireSuperAdmin,
  async (req, res) => {
    try {
      await expireLots(pool)

      const settings = await getSettings(pool)

      const activeQ = await pool.query(
        `SELECT
           COUNT(DISTINCT user_id)::int AS users_with_active_points,
           COALESCE(SUM(points_remaining), 0)::int AS active_points,
           COALESCE(
             SUM(points_remaining)
             FILTER (
               WHERE expires_at <= NOW() + ($1::text || ' days')::interval
             ),
             0
           )::int AS expiring_soon_points
         FROM reward_point_lots
         WHERE status = 'ACTIVE'
           AND points_remaining > 0
           AND expires_at > NOW()`,
        [settings.warning_days]
      )

      const customerQ = await pool.query(
        `SELECT COUNT(*)::int AS total_b2c_customers
         FROM vandana_users
         WHERE UPPER(COALESCE(type, 'B2C')) = 'B2C'`
      )

      const transactionQ = await pool.query(
        `SELECT
           COALESCE(
             SUM(-points)
             FILTER (
               WHERE transaction_type = 'REDEEMED'
                 AND points < 0
             ),
             0
           )::int AS redeemed_points,
           COALESCE(
             SUM(-points)
             FILTER (
               WHERE transaction_type = 'EXPIRED'
                 AND points < 0
             ),
             0
           )::int AS expired_points,
           COALESCE(
             SUM(points)
             FILTER (
               WHERE transaction_type = 'REFUNDED'
                 AND points > 0
             ),
             0
           )::int AS refunded_points,
           COUNT(*)::int AS total_transactions
         FROM reward_point_transactions`
      )

      const lotsQ = await pool.query(
        `SELECT
           COUNT(*)::int AS total_lots,
           COUNT(*) FILTER (
             WHERE status = 'ACTIVE'
               AND points_remaining > 0
               AND expires_at > NOW()
           )::int AS active_lots,
           COUNT(*) FILTER (
             WHERE status = 'USED'
           )::int AS used_lots,
           COUNT(*) FILTER (
             WHERE status = 'EXPIRED'
           )::int AS expired_lots
         FROM reward_point_lots`
      )

      const active = activeQ.rows[0] || {}
      const transaction = transactionQ.rows[0] || {}
      const lots = lotsQ.rows[0] || {}

      return res.json({
        settings,
        metrics: {
          total_b2c_customers: Number(
            customerQ.rows[0]?.total_b2c_customers || 0
          ),
          users_with_active_points: Number(
            active.users_with_active_points || 0
          ),
          active_points: Number(
            active.active_points || 0
          ),
          expiring_soon_points: Number(
            active.expiring_soon_points || 0
          ),
          redeemed_points: Number(
            transaction.redeemed_points || 0
          ),
          expired_points: Number(
            transaction.expired_points || 0
          ),
          refunded_points: Number(
            transaction.refunded_points || 0
          ),
          total_transactions: Number(
            transaction.total_transactions || 0
          ),
          total_lots: Number(
            lots.total_lots || 0
          ),
          active_lots: Number(
            lots.active_lots || 0
          ),
          used_lots: Number(
            lots.used_lots || 0
          ),
          expired_lots: Number(
            lots.expired_lots || 0
          )
        }
      })
    } catch (error) {
      return res.status(500).json({
        message:
          process.env.DEBUG_ERRORS === '1'
            ? error.message
            : 'Server error'
      })
    }
  }
)

router.get(
  '/admin/users',
  requireAuth,
  requireSuperAdmin,
  async (req, res) => {
    try {
      await expireLots(pool)

      const settings = await getSettings(pool)

      const search = String(
        req.query.search ||
          req.query.q ||
          ''
      ).trim()

      const page = asPositiveInt(
        req.query.page,
        1
      )

      const limit = Math.min(
        asPositiveInt(
          req.query.limit,
          50
        ),
        200
      )

      const offset =
        (page - 1) * limit

      const q = await pool.query(
        `WITH active_lots AS (
           SELECT
             user_id,
             SUM(points_remaining)::int AS balance,
             MIN(expires_at) AS nearest_expiry,
             COALESCE(
               SUM(points_remaining)
               FILTER (
                 WHERE expires_at <= NOW() + ($4::text || ' days')::interval
               ),
               0
             )::int AS expiring_soon_points
           FROM reward_point_lots
           WHERE status = 'ACTIVE'
             AND points_remaining > 0
             AND expires_at > NOW()
           GROUP BY user_id
         ),
         user_transactions AS (
           SELECT
             user_id,
             COUNT(*)::int AS transaction_count,
             COALESCE(
               SUM(-points)
               FILTER (
                 WHERE transaction_type = 'REDEEMED'
                   AND points < 0
               ),
               0
             )::int AS redeemed_points
           FROM reward_point_transactions
           GROUP BY user_id
         )
         SELECT
           u.id,
           u.name,
           u.email,
           u.mobile,
           u.type,
           u.city,
           u.created_at,
           COALESCE(a.balance, 0)::int AS balance,
           COALESCE(a.expiring_soon_points, 0)::int AS expiring_soon_points,
           a.nearest_expiry,
           CASE
             WHEN a.nearest_expiry IS NULL THEN NULL
             ELSE GREATEST(
               CEIL(
                 EXTRACT(
                   EPOCH FROM (
                     a.nearest_expiry - NOW()
                   )
                 ) / 86400.0
               ),
               0
             )::int
           END AS days_remaining,
           CASE
             WHEN a.nearest_expiry IS NULL THEN FALSE
             WHEN a.nearest_expiry <= NOW() + ($4::text || ' days')::interval
             THEN TRUE
             ELSE FALSE
           END AS hurry_up,
           COALESCE(t.transaction_count, 0)::int AS transaction_count,
           COALESCE(t.redeemed_points, 0)::int AS redeemed_points,
           COUNT(*) OVER()::int AS total_count
         FROM vandana_users u
         LEFT JOIN active_lots a
           ON a.user_id = u.id
         LEFT JOIN user_transactions t
           ON t.user_id = u.id
         WHERE UPPER(COALESCE(u.type, 'B2C')) = 'B2C'
           AND (
             $1 = ''
             OR u.name ILIKE '%' || $1 || '%'
             OR u.email ILIKE '%' || $1 || '%'
             OR COALESCE(u.mobile, '') ILIKE '%' || $1 || '%'
           )
         ORDER BY
           COALESCE(a.balance, 0) DESC,
           u.created_at DESC,
           u.id DESC
         LIMIT $2
         OFFSET $3`,
        [
          search,
          limit,
          offset,
          settings.warning_days
        ]
      )

      const total = Number(
        q.rows[0]?.total_count || 0
      )

      return res.json({
        page,
        limit,
        total,
        total_pages:
          total > 0
            ? Math.ceil(total / limit)
            : 1,
        warning_days:
          settings.warning_days,
        users: q.rows.map(row => ({
          id: Number(row.id),
          name: row.name,
          email: row.email,
          mobile: row.mobile,
          type: row.type,
          city: row.city,
          created_at: row.created_at,
          balance: Number(
            row.balance || 0
          ),
          expiring_soon_points: Number(
            row.expiring_soon_points || 0
          ),
          nearest_expiry:
            row.nearest_expiry,
          days_remaining:
            row.days_remaining == null
              ? null
              : Number(row.days_remaining),
          hurry_up:
            Boolean(row.hurry_up),
          transaction_count: Number(
            row.transaction_count || 0
          ),
          redeemed_points: Number(
            row.redeemed_points || 0
          )
        }))
      })
    } catch (error) {
      return res.status(500).json({
        message:
          process.env.DEBUG_ERRORS === '1'
            ? error.message
            : 'Server error'
      })
    }
  }
)

router.get(
  '/admin/users/:userId',
  requireAuth,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const userId = Number(
        req.params.userId
      )

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {
        return res.status(400).json({
          message: 'Invalid user id'
        })
      }

      const userQ = await pool.query(
        `SELECT
           id,
           name,
           email,
           mobile,
           type,
           city,
           created_at,
           updated_at
         FROM vandana_users
         WHERE id = $1
           AND UPPER(COALESCE(type, 'B2C')) = 'B2C'
         LIMIT 1`,
        [userId]
      )

      if (!userQ.rowCount) {
        return res.status(404).json({
          message: 'Customer not found'
        })
      }

      const wallet =
        await getWalletSummary(
          userId,
          pool
        )

      const history =
        await getHistory(
          userId,
          100,
          pool
        )

      return res.json({
        user: userQ.rows[0],
        wallet,
        history
      })
    } catch (error) {
      return res
        .status(
          Number(
            error?.status || 500
          )
        )
        .json({
          message:
            error?.message ||
            'Server error'
        })
    }
  }
)

router.get(
  '/wallet',
  requireCustomerAuth,
  async (req, res) => {
    try {
      const wallet =
        await getWalletSummary(
          req.customer.id
        )

      return res.json(wallet)
    } catch (error) {
      return res
        .status(
          Number(
            error?.status || 500
          )
        )
        .json({
          message:
            error?.message ||
            'Server error'
        })
    }
  }
)

router.get(
  '/history',
  requireCustomerAuth,
  async (req, res) => {
    try {
      const history =
        await getHistory(
          req.customer.id,
          req.query.limit
        )

      return res.json({
        history
      })
    } catch (error) {
      return res
        .status(
          Number(
            error?.status || 500
          )
        )
        .json({
          message:
            error?.message ||
            'Server error'
        })
    }
  }
)

router.post(
  '/preview',
  requireCustomerAuth,
  async (req, res) => {
    try {
      const result =
        await previewRedemption({
          userId:
            req.customer.id,
          requestedPoints:
            req.body?.reward_points ??
            req.body?.points ??
            0,
          orderSubtotal:
            req.body?.order_subtotal ??
            req.body?.subtotal ??
            req.body?.payable ??
            0
        })

      return res.json(result)
    } catch (error) {
      const payload = {
        message:
          error?.message ||
          'Server error'
      }

      if (error?.code) {
        payload.code =
          error.code
      }

      if (
        error?.available_points !=
        null
      ) {
        payload.available_points =
          Number(
            error.available_points
          )
      }

      if (
        error?.max_redeemable !=
        null
      ) {
        payload.max_redeemable =
          Number(
            error.max_redeemable
          )
      }

      return res
        .status(
          Number(
            error?.status || 500
          )
        )
        .json(payload)
    }
  }
)

module.exports = router