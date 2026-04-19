const express = require('express');
const pool = require('../db');
const router = express.Router();

router.post('/', async (req, res) => {
  // 1. Extract 'city' from the incoming request body
  const { name, email, mobile, password, city } = req.body;
  if (!name || !email || !mobile || !password)
    return res.status(400).json({ message: 'All fields except city are required' });

  try {
    const exists = await pool.query('SELECT * FROM userstaras WHERE email = $1', [email]);
    if (exists.rows.length > 0) return res.status(409).json({ message: 'Email already exists' });

    // 2. Add 'city' to the INSERT statement
    const result = await pool.query(
      `INSERT INTO userstaras (name, email, mobile, password, type, city)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, mobile, type, city`,
      [name, email, mobile, password, 'B2B', city || null]
    );

    res.status(201).json({ message: 'B2B customer added', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    // 3. Add 'city' to the SELECT statement so the frontend table can display it
    const result = await pool.query(
      'SELECT id, name, email, mobile, city FROM userstaras WHERE type = $1',
      ['B2B']
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching B2B customers', error: err.message });
  }
});

module.exports = router;