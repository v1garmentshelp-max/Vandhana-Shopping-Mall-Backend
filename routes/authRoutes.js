const express = require('express');
const pool = require('../db');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const router = express.Router();
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-env';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });

  try {
    const result = await pool.query('SELECT * FROM userstaras WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });

    const user = result.rows[0];

    let isMatch = false;
    try {
      if (user.password) {
        if (
          user.password.startsWith('$2a$') ||
          user.password.startsWith('$2b$') ||
          user.password.startsWith('$2y$')
        ) {
          isMatch = await bcrypt.compare(password, user.password);
        } else {
          isMatch = password === user.password;
        }
      }
    } catch (e) {
      isMatch = false;
    }

    if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

    const payload = {
      id: user.id,
      email: user.email,
      type: user.type || 'customer'
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        type: user.type || 'customer'
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/branch-admins', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         u.id,
         u.username,
         u.hashed_pw,
         u.role_enum,
         u.branch_id,
         u.last_login,
         sw.warehouse_id,
         sw.name AS warehouse_name,
         sw.city,
         sw.pincode,
         sw.state,
         sw.address,
         sw.phone
       FROM users u
       LEFT JOIN shiprocket_warehouses sw ON sw.branch_id = u.branch_id
       ORDER BY u.id`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch branch admins' });
  }
});

router.post('/branch-admins', async (req, res) => {
  const { username, password, role_enum, branch_id } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO users (username, hashed_pw, role_enum, branch_id, last_login)
       VALUES ($1, $2, $3, $4, NULL)
       RETURNING id, username, hashed_pw, role_enum, branch_id, last_login`,
      [username, password, role_enum || null, branch_id || null]
    );
    const row = result.rows[0];
    const joined = await pool.query(
      `SELECT 
         u.id,
         u.username,
         u.hashed_pw,
         u.role_enum,
         u.branch_id,
         u.last_login,
         sw.warehouse_id,
         sw.name AS warehouse_name,
         sw.city,
         sw.pincode,
         sw.state,
         sw.address,
         sw.phone
       FROM users u
       LEFT JOIN shiprocket_warehouses sw ON sw.branch_id = u.branch_id
       WHERE u.id = $1`,
      [row.id]
    );
    res.status(201).json(joined.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Failed to create branch admin' });
  }
});

router.put('/branch-admins/:id', async (req, res) => {
  const { id } = req.params;
  const { username, password, role_enum, branch_id } = req.body;
  if (!username && !password && typeof role_enum === 'undefined' && typeof branch_id === 'undefined') {
    return res.status(400).json({ message: 'No fields to update' });
  }
  try {
    let query;
    let params;
    if (password) {
      query = `UPDATE users
               SET username = $1,
                   hashed_pw = $2,
                   role_enum = $3,
                   branch_id = $4
               WHERE id = $5
               RETURNING id, username, hashed_pw, role_enum, branch_id, last_login`;
      params = [username, password, role_enum || null, branch_id || null, id];
    } else {
      query = `UPDATE users
               SET username = $1,
                   role_enum = $2,
                   branch_id = $3
               WHERE id = $4
               RETURNING id, username, hashed_pw, role_enum, branch_id, last_login`;
      params = [username, role_enum || null, branch_id || null, id];
    }
    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Branch admin not found' });
    }
    const row = result.rows[0];
    const joined = await pool.query(
      `SELECT 
         u.id,
         u.username,
         u.hashed_pw,
         u.role_enum,
         u.branch_id,
         u.last_login,
         sw.warehouse_id,
         sw.name AS warehouse_name,
         sw.city,
         sw.pincode,
         sw.state,
         sw.address,
         sw.phone
       FROM users u
       LEFT JOIN shiprocket_warehouses sw ON sw.branch_id = u.branch_id
       WHERE u.id = $1`,
      [row.id]
    );
    res.json(joined.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update branch admin' });
  }
});

router.delete('/branch-admins/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Branch admin not found' });
    }
    res.json({ message: 'Branch admin deleted', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete branch admin' });
  }
});

router.get('/:email', async (req, res) => {
  const { email } = req.params;
  try {
    const result = await pool.query(
      'SELECT id, name, email, mobile, type, created_at FROM userstaras WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.post('/forgot/start', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  try {
    const result = await pool.query('SELECT id, type FROM userstaras WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'You are a new user. Please register' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const updateResult = await pool.query(
      'UPDATE userstaras SET otp = $1, otp_expiry = $2 WHERE email = $3',
      [otp, expiresAt, email]
    );

    if (updateResult.rowCount === 0) {
      return res.status(500).json({ message: 'Failed to update OTP' });
    }

    await transporter.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: email,
      subject: 'Your Tars Kart OTP',
      text: `Your OTP is ${otp}. It is valid for 10 minutes.`,
      html: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#111">
        <p>Your OTP is <strong>${otp}</strong></p>
        <p>This code is valid for 10 minutes.</p>
      </div>`
    });

    res.json({ message: 'OTP sent' });
  } catch (err) {
    res.status(500).json({ message: 'Could not start reset' });
  }
});

router.post('/forgot/verify', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: 'Email and OTP are required' });

  try {
    const result = await pool.query('SELECT otp, otp_expiry FROM userstaras WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ message: 'Invalid or expired OTP' });

    const user = result.rows[0];
    if (user.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });
    if (new Date(user.otp_expiry).getTime() < Date.now()) {
      return res.status(400).json({ message: 'OTP expired' });
    }

    res.json({ message: 'OTP verified' });
  } catch (err) {
    res.status(500).json({ message: 'Verification failed' });
  }
});

router.post('/forgot/reset', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) {
    return res.status(400).json({ message: 'Email, OTP, and new password are required' });
  }

  try {
    const result = await pool.query('SELECT otp, otp_expiry FROM userstaras WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ message: 'Invalid or expired OTP' });

    const user = result.rows[0];
    if (user.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });
    if (new Date(user.otp_expiry).getTime() < Date.now()) {
      return res.status(400).json({ message: 'OTP expired' });
    }

    await pool.query('UPDATE userstaras SET password = $1 WHERE email = $2', [newPassword, email]);
    await pool.query('UPDATE userstaras SET otp = NULL, otp_expiry = NULL WHERE email = $1', [email]);

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Password reset failed' });
  }
});

router.post('/firebase-login', async (req, res) => {
  const { uid, email, name } = req.body;
  if (!uid || !email) return res.status(400).json({ message: 'uid and email are required' });

  const displayName = name || email.split('@')[0] || 'User';
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT id, name, email, mobile, type FROM userstaras WHERE email = $1',
        [email]
      );

      let user;
      if (existing.rows.length > 0) {
        user = existing.rows[0];
      } else {
        const inserted = await client.query(
          'INSERT INTO userstaras (name, email, password, type, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, name, email, mobile, type',
          [displayName, email, '', 'B2C']
        );
        user = inserted.rows[0];
      }

      await client.query('COMMIT');

      const payload = {
        id: user.id,
        email: user.email,
        type: user.type || 'B2C'
      };

      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

      res.json({
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          mobile: user.mobile,
          type: user.type || 'B2C'
        }
      });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ message: 'Server error' });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
