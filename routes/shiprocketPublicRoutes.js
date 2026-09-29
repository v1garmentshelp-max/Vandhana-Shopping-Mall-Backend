const express = require('express')
const { getMyOrders, getTracking } = require('../controllers/orderController')

const router = express.Router()

router.get('/shiprocket/my-orders', getMyOrders)
router.get('/shiprocket/track/:orderId/:channelId?', getTracking)

module.exports = router
