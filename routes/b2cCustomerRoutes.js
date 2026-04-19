const express = require('express');
const pool = require('../db');
const router = express.Router();

router.post('/signup', async (req, res) => { 
  const { name, email, mobile, password } = req.body;
  if (!name || !email || !mobile || !password)
    return res.status(400).json({ message: 'All fields are required' });

  try {
    const exists = await pool.query('SELECT * FROM userstaras WHERE email = $1', [email]);
    if (exists.rows.length > 0) return res.status(409).json({ message: 'Email already exists' });

    const result = await pool.query(
      `INSERT INTO userstaras (name, email, mobile, password, type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, mobile, type`,
      [name, email, mobile, password, 'B2C']
    );

    res.status(201).json({ message: 'B2C customer added', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});



router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, mobile FROM userstaras WHERE type = $1',
      ['B2C']
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching B2C customers', error: err.message });
  }
});

module.exports = router;
