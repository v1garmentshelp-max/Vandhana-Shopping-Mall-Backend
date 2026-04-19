// backend/routes/barcodeRoutes.js
const express = require('express');
const pool = require('../db');

const router = express.Router();

// Use your own cloud name here or via env var
// e.g. CLOUDINARY_CLOUD_NAME=your_cloud_name
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';

router.get('/:ean', async (req, res) => {
  const ean = String(req.params.ean || '').trim();
  if (!ean) return res.status(400).json({ message: 'ean required' });

  try {
    const { rows } = await pool.query(
      `
      SELECT
        b.ean_code,
        pv.id AS variant_id,
        pv.size,
        pv.colour,
        pv.mrp::numeric       AS mrp,
        pv.sale_price::numeric AS sale_price,
        pv.cost_price::numeric AS cost_price,
        p.id AS product_id,
        p.name AS product_name,
        p.brand_name,
        COALESCE(
          NULLIF(pv.image_url, ''),
          NULLIF(pi.image_url, ''),
          CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', b.ean_code)
        ) AS image_url
      FROM public.barcodes b
      JOIN public.product_variants pv ON pv.id = b.variant_id
      JOIN public.products p          ON p.id  = pv.product_id
      LEFT JOIN public.product_images pi ON pi.ean_code = b.ean_code
      WHERE b.ean_code = $1
      LIMIT 1
      `,
      [ean, CLOUD_NAME]
    );

    if (!rows.length) return res.status(404).json({ message: 'Not found' });

    // Optional: normalize numeric fields to numbers for the client
    const row = rows[0];
    const result = {
      ean_code: row.ean_code,
      variant_id: Number(row.variant_id),
      size: row.size,
      colour: row.colour,
      mrp: row.mrp !== null ? Number(row.mrp) : null,
      sale_price: row.sale_price !== null ? Number(row.sale_price) : null,
      cost_price: row.cost_price !== null ? Number(row.cost_price) : null,
      image_url: row.image_url || '',
      product_id: Number(row.product_id),
      product_name: row.product_name,
      brand_name: row.brand_name,
    };

    return res.json(result);
  } catch (err) {
    console.error('GET /api/barcodes/:ean error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
