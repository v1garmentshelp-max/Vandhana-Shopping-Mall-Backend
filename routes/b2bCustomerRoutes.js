const express = require('express')
const pool = require('../db')
const router = express.Router()

router.post('/', async (req, res) => {
  const { name, email, mobile, password, city } = req.body

  if (!name || !email || !mobile || !password) {
    return res.status(400).json({ message: 'All fields except city are required' })
  }

  try {
    const exists = await pool.query(
      'SELECT id FROM vandana_users WHERE lower(email) = lower($1) LIMIT 1',
      [email]
    )

    if (exists.rows.length > 0) {
      return res.status(409).json({ message: 'Email already exists' })
    }

    const result = await pool.query(
      `INSERT INTO vandana_users (name, email, mobile, password, type, city, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING id, name, email, mobile, type, city`,
      [name, email, mobile, password, 'B2B', city || null]
    )

    res.status(201).json({ message: 'B2B customer added', user: result.rows[0] })
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, mobile, city FROM vandana_users WHERE type = $1 ORDER BY id DESC',
      ['B2B']
    )

    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ message: 'Error fetching B2B customers', error: err.message })
  }
})

module.exports = router