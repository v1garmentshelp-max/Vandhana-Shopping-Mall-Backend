const express = require('express')
const router = express.Router()
const pool = require('../db')

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, section, image_url AS "imageUrl", alt_text AS "altText", link, extra_json AS "extra" FROM homepage_images ORDER BY id'
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load homepage images' })
  }
})

router.patch('/:id', async (req, res) => {
  const { id } = req.params
  const { section, imageUrl, altText, link, extra } = req.body

  if (!id) {
    return res.status(400).json({ error: 'Missing id' })
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO homepage_images (id, section, image_url, alt_text, link, extra_json)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        section = COALESCE(EXCLUDED.section, homepage_images.section),
        image_url = COALESCE(EXCLUDED.image_url, homepage_images.image_url),
        alt_text = COALESCE(EXCLUDED.alt_text, homepage_images.alt_text),
        link = COALESCE(EXCLUDED.link, homepage_images.link),
        extra_json = COALESCE(EXCLUDED.extra_json, homepage_images.extra_json)
      RETURNING id, section, image_url AS "imageUrl", alt_text AS "altText", link, extra_json AS "extra"
      `,
      [
        id,
        section || null,
        imageUrl || null,
        altText || null,
        link || null,
        extra ? JSON.stringify(extra) : null
      ]
    )

    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update homepage image' })
  }
})

module.exports = router
