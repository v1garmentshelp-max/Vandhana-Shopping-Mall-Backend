const express = require('express')
const { getMyOrders, getTracking } = require('../controllers/orderController')

const router = express.Router()
const { requireOrderStaff } = require('../middleware/orderStaffAuth')
const { requireSuperAdmin } = require('../middleware/auth')

router.get('/shiprocket/my-orders', requireOrderStaff, requireSuperAdmin, getMyOrders)
router.get('/shiprocket/track/:orderId/:channelId?', requireOrderStaff, requireSuperAdmin, getTracking)

module.exports = router
