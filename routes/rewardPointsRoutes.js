const express = require('express')
const {
  requireCustomerAuth
} = require('../middleware/customerAuth')
const {
  getWalletSummary,
  getHistory,
  previewRedemption
} = require('../services/rewardPointsService')

const router = express.Router()

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