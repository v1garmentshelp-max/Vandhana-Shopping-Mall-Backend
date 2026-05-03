const express = require('express')
const pool = require('../db')
const bcrypt = require('bcryptjs')
const nodemailer = require('nodemailer')
const jwt = require('jsonwebtoken')

const router = express.Router()

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-env'

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
})

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      type: user.type || 'B2C'
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  )
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    req.user = decoded
    return next()
  } catch (err) {
    console.error('AUTH VERIFY ERROR:', err)
    return res.status(401).json({ message: 'Unauthorized', error: err.message })
  }
}

function isBcryptHash(value = '') {
  return typeof value === 'string' && (
    value.startsWith('$2a$') ||
    value.startsWith('$2b$') ||
    value.startsWith('$2y$')
  )
}

function isValidEmail(email = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())
}

function isValidMobile(mobile = '') {
  return /^[6-9]\d{9}$/.test(String(mobile).trim())
}

async function createUser(req, res) {
  const { name, email, mobile, password, type } = req.body || {}

  const cleanName = String(name || '').trim()
  const cleanEmail = String(email || '').trim().toLowerCase()
  const cleanMobile = String(mobile || '').trim()
  const cleanPassword = String(password || '')
  const cleanType = String(type || 'B2C').trim() || 'B2C'

  if (!cleanName || !cleanEmail || !cleanMobile || !cleanPassword) {
    return res.status(400).json({ message: 'name, email, mobile and password are required' })
  }

  if (!isValidEmail(cleanEmail)) {
    return res.status(400).json({ message: 'Invalid email address' })
  }

  if (!isValidMobile(cleanMobile)) {
    return res.status(400).json({ message: 'Invalid mobile number' })
  }

  if (cleanPassword.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' })
  }

  try {
    const existing = await pool.query(
      'SELECT id FROM public.vandana_users WHERE lower(email) = $1 LIMIT 1',
      [cleanEmail]
    )

    if (existing.rows.length > 0) {
      return res.status(409).json({ message: 'User already exists with this email' })
    }

    const hashedPassword = await bcrypt.hash(cleanPassword, 10)

    const insert = await pool.query(
      `INSERT INTO public.vandana_users (name, email, mobile, password, type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id, name, email, mobile, type`,
      [cleanName, cleanEmail, cleanMobile, hashedPassword, cleanType]
    )

    return res.status(201).json({
      message: 'Account created successfully',
      user: insert.rows[0]
    })
  } catch (err) {
    console.error('SIGNUP ERROR:', err)
    return res.status(500).json({
      message: 'Server error',
      error: err.message,
      detail: err.detail || null,
      code: err.code || null,
      table: err.table || null,
      constraint: err.constraint || null
    })
  }
}

router.post('/signup', createUser)
router.post('/register', createUser)

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {}
  const cleanEmail = String(email || '').trim().toLowerCase()
  const cleanPassword = String(password || '')

  if (!cleanEmail || !cleanPassword) {
    return res.status(400).json({ message: 'Email and password are required' })
  }

  try {
    const result = await pool.query(
      'SELECT * FROM public.vandana_users WHERE lower(email) = $1 LIMIT 1',
      [cleanEmail]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    const user = result.rows[0]

    let isMatch = false

    if (user.password) {
      if (isBcryptHash(user.password)) {
        isMatch = await bcrypt.compare(cleanPassword, user.password)
      } else {
        isMatch = cleanPassword === user.password
      }
    }

    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    const token = signToken(user)

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        type: user.type || 'B2C'
      }
    })
  } catch (err) {
    console.error('LOGIN ERROR:', err)
    return res.status(500).json({
      message: 'Server error',
      error: err.message,
      detail: err.detail || null,
      code: err.code || null,
      table: err.table || null,
      constraint: err.constraint || null
    })
  }
})

router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, mobile, type, created_at, updated_at FROM public.vandana_users WHERE id = $1 LIMIT 1',
      [req.user.id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' })
    }

    return res.json(result.rows[0])
  } catch (err) {
    console.error('ME ERROR:', err)
    return res.status(500).json({
      message: 'Server error',
      error: err.message,
      detail: err.detail || null,
      code: err.code || null
    })
  }
})

router.post('/change-password', requireAuth, async (req, res) => {
  const { old_password, new_password } = req.body || {}
  const oldPassword = String(old_password || '')
  const newPassword = String(new_password || '')

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ message: 'Both passwords required' })
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters' })
  }

  try {
    const result = await pool.query(
      'SELECT password FROM public.vandana_users WHERE id = $1 LIMIT 1',
      [req.user.id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' })
    }

    const currentPassword = result.rows[0].password
    let isMatch = false

    if (isBcryptHash(currentPassword)) {
      isMatch = await bcrypt.compare(oldPassword, currentPassword)
    } else {
      isMatch = oldPassword === currentPassword
    }

    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    const hashed = await bcrypt.hash(newPassword, 10)

    await pool.query(
      'UPDATE public.vandana_users SET password = $1, updated_at = NOW() WHERE id = $2',
      [hashed, req.user.id]
    )

    return res.json({ message: 'Password updated' })
  } catch (err) {
    console.error('CHANGE PASSWORD ERROR:', err)
    return res.status(500).json({
      message: 'Server error',
      error: err.message,
      detail: err.detail || null,
      code: err.code || null
    })
  }
})

router.post('/forgot/start', async (req, res) => {
  const { email } = req.body || {}
  const cleanEmail = String(email || '').trim().toLowerCase()

  if (!cleanEmail) {
    return res.status(400).json({ message: 'Email is required' })
  }

  try {
    const result = await pool.query(
      'SELECT id, type FROM public.vandana_users WHERE lower(email) = $1',
      [cleanEmail]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'You are a new user. Please register' })
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

    await pool.query(
      'UPDATE public.vandana_users SET otp = $1, otp_expiry = $2, updated_at = NOW() WHERE lower(email) = $3',
      [otp, expiresAt, cleanEmail]
    )

    await transporter.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: cleanEmail,
      subject: 'Your Vandana Shopping Mall OTP',
      text: `Your OTP is ${otp}. It is valid for 10 minutes.`,
      html: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#111"><p>Your OTP is <strong>${otp}</strong></p><p>This code is valid for 10 minutes.</p></div>`
    })

    return res.json({ message: 'OTP sent' })
  } catch (err) {
    console.error('FORGOT START ERROR:', err)
    return res.status(500).json({
      message: 'Could not start reset',
      error: err.message,
      detail: err.detail || null,
      code: err.code || null
    })
  }
})

router.post('/forgot/verify', async (req, res) => {
  const { email, otp } = req.body || {}
  const cleanEmail = String(email || '').trim().toLowerCase()
  const cleanOtp = String(otp || '').trim()

  if (!cleanEmail || !cleanOtp) {
    return res.status(400).json({ message: 'Email and OTP are required' })
  }

  try {
    const result = await pool.query(
      'SELECT otp, otp_expiry FROM public.vandana_users WHERE lower(email) = $1 LIMIT 1',
      [cleanEmail]
    )

    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired OTP' })
    }

    const user = result.rows[0]

    if (String(user.otp || '') !== cleanOtp) {
      return res.status(400).json({ message: 'Invalid OTP' })
    }

    if (!user.otp_expiry || new Date(user.otp_expiry).getTime() < Date.now()) {
      return res.status(400).json({ message: 'OTP expired' })
    }

    return res.json({ message: 'OTP verified' })
  } catch (err) {
    console.error('FORGOT VERIFY ERROR:', err)
    return res.status(500).json({
      message: 'Verification failed',
      error: err.message,
      detail: err.detail || null,
      code: err.code || null
    })
  }
})

router.post('/forgot/reset', async (req, res) => {
  const { email, otp, newPassword } = req.body || {}
  const cleanEmail = String(email || '').trim().toLowerCase()
  const cleanOtp = String(otp || '').trim()
  const cleanNewPassword = String(newPassword || '').trim()

  if (!cleanEmail || !cleanOtp || !cleanNewPassword) {
    return res.status(400).json({ message: 'Email, OTP, and new password are required' })
  }

  if (cleanNewPassword.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' })
  }

  try {
    const result = await pool.query(
      'SELECT otp, otp_expiry FROM public.vandana_users WHERE lower(email) = $1 LIMIT 1',
      [cleanEmail]
    )

    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired OTP' })
    }

    const user = result.rows[0]

    if (String(user.otp || '') !== cleanOtp) {
      return res.status(400).json({ message: 'Invalid OTP' })
    }

    if (!user.otp_expiry || new Date(user.otp_expiry).getTime() < Date.now()) {
      return res.status(400).json({ message: 'OTP expired' })
    }

    const hashedPassword = await bcrypt.hash(cleanNewPassword, 10)

    await pool.query(
      'UPDATE public.vandana_users SET password = $1, otp = NULL, otp_expiry = NULL, updated_at = NOW() WHERE lower(email) = $2',
      [hashedPassword, cleanEmail]
    )

    return res.json({ message: 'Password updated successfully' })
  } catch (err) {
    console.error('FORGOT RESET ERROR:', err)
    return res.status(500).json({
      message: 'Password reset failed',
      error: err.message,
      detail: err.detail || null,
      code: err.code || null
    })
  }
})

router.post('/firebase-login', async (req, res) => {
  const { uid, email, name } = req.body || {}

  if (!uid || !email) {
    return res.status(400).json({ message: 'uid and email are required' })
  }

  const cleanEmail = String(email).trim().toLowerCase()
  const displayName = String(name || cleanEmail.split('@')[0] || 'User').trim()

  try {
    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const existing = await client.query(
        'SELECT id, name, email, mobile, type FROM public.vandana_users WHERE lower(email) = $1 LIMIT 1',
        [cleanEmail]
      )

      let user

      if (existing.rows.length > 0) {
        user = existing.rows[0]
      } else {
        const inserted = await client.query(
          'INSERT INTO public.vandana_users (name, email, mobile, password, type, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING id, name, email, mobile, type',
          [displayName, cleanEmail, '', '', 'B2C']
        )
        user = inserted.rows[0]
      }

      await client.query('COMMIT')

      const token = signToken(user)

      return res.json({
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          mobile: user.mobile,
          type: user.type || 'B2C'
        }
      })
    } catch (err) {
      await client.query('ROLLBACK')
      console.error('FIREBASE LOGIN TX ERROR:', err)
      return res.status(500).json({
        message: 'Server error',
        error: err.message,
        detail: err.detail || null,
        code: err.code || null
      })
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('FIREBASE LOGIN ERROR:', err)
    return res.status(500).json({
      message: 'Server error',
      error: err.message,
      detail: err.detail || null,
      code: err.code || null
    })
  }
})

module.exports = router