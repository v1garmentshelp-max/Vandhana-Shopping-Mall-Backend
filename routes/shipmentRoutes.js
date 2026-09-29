const express = require('express')
const pool = require('../db')
const { trackByOrderId } = require('../services/shiprocketClient')
const {
  bestOrderStatus,
  collectStatusValues,
  extractShipmentInfo,
  syncSaleStatus,
  syncShipmentRows
} = require('../services/orderStatusSync')

const router = express.Router()

router.get('/shipments/by-sale/:id', async (req, res) => {
  const id = req.params.id

  try {
    const { rows } = await pool.query(
      'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC',
      [id]
    )

    const enriched = []

    for (const sh of rows) {
      let current = sh

      if (sh.shiprocket_order_id) {
        try {
          const tracking = await trackByOrderId(sh.shiprocket_order_id)
          const updated = await syncShipmentRows(pool, [sh], tracking, sh.awb ? 'PACKED' : sh.status || 'CONFIRMED')
          current = updated[0] || sh
        } catch (err) {
          console.error('shipments/by-sale track error', sh.id, err.message || err)
          const fallback = bestOrderStatus([sh.status, sh.awb ? 'PACKED' : ''], sh.status || 'CONFIRMED')
          const updated = await syncShipmentRows(pool, [sh], { status: fallback }, fallback)
          current = updated[0] || sh
        }
      } else {
        const fallback = bestOrderStatus([sh.status, sh.awb ? 'PACKED' : ''], sh.status || 'CONFIRMED')
        const updated = await syncShipmentRows(pool, [sh], { status: fallback }, fallback)
        current = updated[0] || sh
      }

      const info = extractShipmentInfo(current, current.status)

      enriched.push({
        ...current,
        status: info.status || current.status,
        awb: info.awb || current.awb,
        tracking_url: info.tracking_url || current.tracking_url,
        label_url: info.label_url || current.label_url,
        current_location: info.current_location || current.current_location
      })
    }

    const finalStatus = bestOrderStatus(
      enriched.flatMap((sh) => [
        sh.status,
        sh.raw_status,
        sh.current_status,
        sh.shipment_status,
        sh.awb ? 'PACKED' : '',
        ...collectStatusValues(sh.last_tracking_payload)
      ]),
      rows.length ? 'CONFIRMED' : 'PLACED'
    )

    await syncSaleStatus(pool, id, finalStatus)

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')

    return res.json(enriched)
  } catch (err) {
    console.error('shipments/by-sale error', err.message || err)
    return res.status(500).json({ error: 'Failed to fetch shipments' })
  }
})

module.exports = router