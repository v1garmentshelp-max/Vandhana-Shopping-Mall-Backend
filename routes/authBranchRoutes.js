const express = require('express')
const pool = require('../db')
const bcrypt = require('bcryptjs')
const { sign, requireAuth } = require('../middleware/auth')

const router = express.Router()

function isBcryptHash(s = '') {
  return typeof s === 'string' && (s.startsWith('$2a$') || s.startsWith('$2b$') || s.startsWith('$2y$'))
}

function mapUserToBranchAdmin(row) {
  return {
    id: row.id,
    email: row.username,
    name: row.name || null,
    branch_id: row.branch_id || null,
    last_login: row.last_login || null,
    is_active: row.is_active !== false
  }
}

function requireSuperAdmin(req, res, next) {
  const role = req.user && (req.user.role || req.user.role_enum)
  if (role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'Forbidden' })
  }
  next()
}

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ message: 'username and password required' })
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1 LIMIT 1',
      [username]
    )

    if (!rows.length) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    const u = rows[0]

    if (u.is_active === false) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    let ok = false
    if (isBcryptHash(u.hashed_pw)) {
      ok = await bcrypt.compare(password, u.hashed_pw)
    } else {
      ok = password === u.hashed_pw
    }

    if (!ok) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [u.id])

    const token = sign(u)
    return res.json({
      token,
      user: {
        id: u.id,
        username: u.username,
        role: u.role_enum,
        branch_id: u.branch_id
      }
    })
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, role_enum, branch_id, last_login FROM users WHERE id = $1',
      [req.user.id]
    )
    if (!rows.length) return res.status(404).json({ message: 'Not found' })
    return res.json(rows[0])
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.post('/change-password', requireAuth, async (req, res) => {
  const { old_password, new_password } = req.body || {}
  if (!old_password || !new_password) {
    return res.status(400).json({ message: 'Both passwords required' })
  }

  try {
    const { rows } = await pool.query('SELECT hashed_pw FROM users WHERE id = $1', [req.user.id])
    if (!rows.length) return res.status(404).json({ message: 'Not found' })

    let ok = false
    const hp = rows[0].hashed_pw

    if (isBcryptHash(hp)) {
      ok = await bcrypt.compare(old_password, hp)
    } else {
      ok = old_password === hp
    }

    if (!ok) return res.status(401).json({ message: 'Invalid credentials' })

    const hashed = await bcrypt.hash(new_password, 10)
    await pool.query('UPDATE users SET hashed_pw = $1 WHERE id = $2', [hashed, req.user.id])

    return res.json({ message: 'Password updated' })
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.get('/branch-admins', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, username, role_enum, branch_id, last_login, is_active, name FROM users WHERE role_enum::text LIKE 'BRANCH%' ORDER BY id DESC"
    )
    return res.json(rows.map(mapUserToBranchAdmin))
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.post('/branch-admins', requireAuth, requireSuperAdmin, async (req, res) => {
  const { email, password, name, branch_id } = req.body || {}

  if (!email || !password || !branch_id) {
    return res.status(400).json({ message: 'email, password and branch_id required' })
  }

  try {
    const existing = await pool.query(
      'SELECT id FROM users WHERE username = $1 LIMIT 1',
      [email]
    )
    if (existing.rows.length) {
      return res.status(409).json({ message: 'Admin with this email already exists' })
    }

    const branchCheck = await pool.query(
      'SELECT id FROM branches WHERE id = $1 LIMIT 1',
      [branch_id]
    )
    if (!branchCheck.rows.length) {
      return res.status(400).json({ message: 'Invalid branch_id' })
    }

    const hashed = await bcrypt.hash(password, 10)
    const roleEnum = `BRANCH${branch_id}`

    const { rows } = await pool.query(
      `INSERT INTO users (username, hashed_pw, role_enum, branch_id, is_active, name)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING id, username, role_enum, branch_id, last_login, is_active, name`,
      [email, hashed, roleEnum, branch_id, name || null]
    )

    return res.status(201).json(mapUserToBranchAdmin(rows[0]))
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.put('/branch-admins/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  const { id } = req.params
  const { email, password, name, branch_id, is_active } = req.body || {}

  if (!email || !branch_id) {
    return res.status(400).json({ message: 'email and branch_id required' })
  }

  try {
    const { rows: existingRows } = await pool.query(
      "SELECT * FROM users WHERE id = $1 AND role_enum::text LIKE 'BRANCH%'",
      [id]
    )
    if (!existingRows.length) return res.status(404).json({ message: 'Branch admin not found' })

    const usernameTaken = await pool.query(
      'SELECT id FROM users WHERE username = $1 AND id <> $2 LIMIT 1',
      [email, id]
    )
    if (usernameTaken.rows.length) {
      return res.status(409).json({ message: 'Another admin with this email already exists' })
    }

    const branchCheck = await pool.query(
      'SELECT id FROM branches WHERE id = $1 LIMIT 1',
      [branch_id]
    )
    if (!branchCheck.rows.length) {
      return res.status(400).json({ message: 'Invalid branch_id' })
    }

    let hashed = null
    if (password && String(password).trim() !== '') {
      hashed = await bcrypt.hash(password, 10)
    }

    const roleEnum = `BRANCH${branch_id}`
    const updateParts = []
    const params = []
    let idx = 1

    updateParts.push(`username = $${idx++}`)
    params.push(email)

    updateParts.push(`name = $${idx++}`)
    params.push(name || null)

    updateParts.push(`branch_id = $${idx++}`)
    params.push(branch_id)

    updateParts.push(`role_enum = $${idx++}`)
    params.push(roleEnum)

    if (typeof is_active === 'boolean') {
      updateParts.push(`is_active = $${idx++}`)
      params.push(is_active)
    }

    if (hashed) {
      updateParts.push(`hashed_pw = $${idx++}`)
      params.push(hashed)
    }

    params.push(id)

    const { rows } = await pool.query(
      `UPDATE users
       SET ${updateParts.join(', ')}
       WHERE id = $${idx} AND role_enum::text LIKE 'BRANCH%'
       RETURNING id, username, role_enum, branch_id, last_login, is_active, name`,
      params
    )

    if (!rows.length) return res.status(404).json({ message: 'Branch admin not found' })

    return res.json(mapUserToBranchAdmin(rows[0]))
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Server error' })
  }
})

router.delete('/branch-admins/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  const { id } = req.params
  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET is_active = false
       WHERE id = $1 AND role_enum::text LIKE 'BRANCH%'
       RETURNING id, username, role_enum, branch_id, last_login, is_active, name`,
      [id]
    )
    if (!rows.length) return res.status(404).json({ message: 'Branch admin not found' })
    return res.json(mapUserToBranchAdmin(rows[0]))
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Server error' })
  }
})

module.exports = router