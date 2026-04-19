const express = require('express');
const pool = require('../db');
const router = express.Router();

const isValidMobile = (v) => /^[6-9]\d{9}$/.test(String(v || '').trim());

router.get('/by-email/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const q = await pool.query(
      'SELECT id, name, email, mobile, type FROM userstaras WHERE lower(email) = $1 LIMIT 1',
      [email]
    );

    if (!q.rowCount) return res.status(404).json({ message: 'User not found' });

    const u = q.rows[0];
    const mobile = isValidMobile(u.mobile) ? String(u.mobile) : '';

    res.json({
      id: u.id,
      name: u.name,
      email: u.email,
      mobile,
      type: u.type
    });
  } catch (e) {
    res.status(500).json({ message: 'Server error', error: e.message });
  }
});

router.post('/update-mobile', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const mobile = String(req.body?.mobile || '').trim();

    if (!email) return res.status(400).json({ message: 'Email is required' });
    if (!isValidMobile(mobile)) return res.status(400).json({ message: 'Invalid mobile number' });

    const upd = await pool.query(
      'UPDATE userstaras SET mobile = $1 WHERE lower(email) = $2 RETURNING id, name, email, mobile, type',
      [mobile, email]
    );

    if (!upd.rowCount) return res.status(404).json({ message: 'User not found' });

    const u = upd.rows[0];
    res.json({
      id: u.id,
      name: u.name,
      email: u.email,
      mobile: String(u.mobile),
      type: u.type
    });
  } catch (e) {
    res.status(500).json({ message: 'Server error', error: e.message });
  }
});

module.exports = router;
