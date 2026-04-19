const express = require('express');
const pool = require('../db');
const { trackByOrderId } = require('../services/shiprocketClient');

const router = express.Router();

router.get('/shipments/by-sale/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC',
      [id]
    );

    const enriched = await Promise.all(
      rows.map(async (sh) => {
        if (!sh.shiprocket_order_id) return sh;
        try {
          const tracking = await trackByOrderId(sh.shiprocket_order_id);
          const td = tracking && (tracking.tracking_data || tracking);
          if (!td) return sh;

          const status =
            td.shipment_status ||
            td.current_status ||
            tracking.current_status ||
            tracking.status ||
            sh.status;

          let location =
            td.current_location ||
            td.current_city ||
            td.destination_city ||
            null;

          const rawEvents =
            (Array.isArray(td.shipment_track) && td.shipment_track) ||
            (Array.isArray(td.track_data) && td.track_data) ||
            (Array.isArray(td.scans) && td.scans) ||
            (Array.isArray(td.track_activities) && td.track_activities) ||
            [];

          if (!location && rawEvents.length) {
            const ev = rawEvents[0];
            location =
              ev.location ||
              ev.location_city ||
              ev.city ||
              ev.scan_location ||
              ev.scanned_location ||
              null;
          }

          const trackingUrl =
            td.track_url ||
            tracking.track_url ||
            sh.tracking_url;

          return {
            ...sh,
            status: status || sh.status,
            current_location: location || sh.current_location || null,
            tracking_url: trackingUrl || sh.tracking_url
          };
        } catch (err) {
          console.error('shipments/by-sale track error', sh.id, err.message || err);
          return sh;
        }
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error('shipments/by-sale error', err.message || err);
    res.status(500).json({ error: 'Failed to fetch shipments' });
  }
});

module.exports = router;
