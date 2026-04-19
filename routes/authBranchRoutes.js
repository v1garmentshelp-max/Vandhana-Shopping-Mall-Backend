const express = require('express');
const pool = require('../db');
const bcrypt = require('bcryptjs');
const { sign, requireAuth } = require('../middleware/auth');
const router = express.Router();

function isBcryptHash(s = '') {
  return typeof s === 'string' && (s.startsWith('$2a$') || s.startsWith('$2b$') || s.startsWith('$2y$'));
}

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ message: 'username and password required' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1 LIMIT 1',
      [username]
    );
    if (!rows.length) return res.status(401).json({ message: 'Invalid credentials' });
    const u = rows[0];

    if (u.is_active === false) return res.status(401).json({ message: 'Invalid credentials' });

    let ok = false;
    if (isBcryptHash(u.hashed_pw)) {
      ok = await bcrypt.compare(password, u.hashed_pw);
    } else {
      ok = password === u.hashed_pw;
    }
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [u.id]);
    const token = sign(u);
    res.json({ token, user: { id: u.id, username: u.username, role: u.role_enum, branch_id: u.branch_id } });
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, role_enum, branch_id, last_login FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) return res.status(400).json({ message: 'Both passwords required' });
  try {
    const { rows } = await pool.query('SELECT hashed_pw FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    let ok = false;
    const hp = rows[0].hashed_pw;
    if (isBcryptHash(hp)) {
      ok = await bcrypt.compare(old_password, hp);
    } else {
      ok = old_password === hp;
    }
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET hashed_pw = $1 WHERE id = $2', [hashed, req.user.id]);
    res.json({ message: 'Password updated' });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

function requireSuperAdmin(req, res, next) {
  const role = req.user && (req.user.role || req.user.role_enum);
  if (role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
}

function mapUserToBranchAdmin(row) {
  return {
    id: row.id,
    email: row.username,
    name: row.name || null,
    branch_name: row.branch_name || null,
    branch_code: row.branch_code || null,
    last_login: row.last_login || null,
    is_active: row.is_active !== false
  };
}

router.get('/branch-admins', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, username, role_enum, branch_id, last_login, is_active, name, branch_name, branch_code FROM users WHERE role_enum::text LIKE 'BRANCH%' ORDER BY id DESC"
    );
    res.json(rows.map(mapUserToBranchAdmin));
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/branch-admins', requireAuth, requireSuperAdmin, async (req, res) => {
  const { email, password, name, branch_name, branch_code } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: 'email and password required' });
  try {
    const existing = await pool.query(
      'SELECT id FROM users WHERE username = $1 LIMIT 1',
      [email]
    );
    if (existing.rows.length) {
      return res.status(409).json({ message: 'Admin with this email already exists' });
    }

    const hashed = await bcrypt.hash(password, 10);

    const branchRoleMap = {
      '1': 'BRANCH1',
      '2': 'BRANCH2',
      '3': 'BRANCH3',
      '4': 'BRANCH4',
      '5': 'BRANCH5'
    };

    let branchId = null;
    let roleEnum = null;

    if (branch_code && branchRoleMap[String(branch_code)]) {
      roleEnum = branchRoleMap[String(branch_code)];
      branchId = Number(branch_code);
    } else {
      roleEnum = 'BRANCH1';
      branchId = 1;
    }

    const insertQuery = `
      INSERT INTO users (username, hashed_pw, role_enum, branch_id, is_active, name, branch_name, branch_code)
      VALUES ($1, $2, $3, $4, true, $5, $6, $7)
      RETURNING id, username, role_enum, branch_id, last_login, is_active, name, branch_name, branch_code
    `;
    const { rows } = await pool.query(insertQuery, [
      email,
      hashed,
      roleEnum,
      branchId,
      name || null,
      branch_name || null,
      branch_code || null
    ]);
    res.status(201).json(mapUserToBranchAdmin(rows[0]));
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/branch-admins/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  const { id } = req.params;
  const { email, password, name, branch_name, branch_code, is_active } = req.body || {};
  if (!email) return res.status(400).json({ message: 'email is required' });
  try {
    const { rows: existingRows } = await pool.query(
      "SELECT * FROM users WHERE id = $1 AND role_enum::text LIKE 'BRANCH%'",
      [id]
    );
    if (!existingRows.length) return res.status(404).json({ message: 'Branch admin not found' });

    const usernameTaken = await pool.query(
      'SELECT id FROM users WHERE username = $1 AND id <> $2 LIMIT 1',
      [email, id]
    );
    if (usernameTaken.rows.length) {
      return res.status(409).json({ message: 'Another admin with this email already exists' });
    }

    let hashed = null;
    if (password && String(password).trim() !== '') {
      hashed = await bcrypt.hash(password, 10);
    }

    const updateParts = [];
    const params = [];
    let idx = 1;

    updateParts.push(`username = $${idx++}`);
    params.push(email);
    updateParts.push(`name = $${idx++}`);
    params.push(name || null);
    updateParts.push(`branch_name = $${idx++}`);
    params.push(branch_name || null);
    updateParts.push(`branch_code = $${idx++}`);
    params.push(branch_code || null);

    if (typeof is_active === 'boolean') {
      updateParts.push(`is_active = $${idx++}`);
      params.push(is_active);
    }

    if (hashed) {
      updateParts.push(`hashed_pw = $${idx++}`);
      params.push(hashed);
    }

    params.push(id);

    const updateQuery = `
      UPDATE users
      SET ${updateParts.join(', ')}
      WHERE id = $${idx} AND role_enum::text LIKE 'BRANCH%'
      RETURNING id, username, role_enum, branch_id, last_login, is_active, name, branch_name, branch_code
    `;
    const { rows } = await pool.query(updateQuery, params);
    if (!rows.length) return res.status(404).json({ message: 'Branch admin not found' });
    res.json(mapUserToBranchAdmin(rows[0]));
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/branch-admins/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      UPDATE users
      SET is_active = false
      WHERE id = $1 AND role_enum::text LIKE 'BRANCH%'
      RETURNING id, username, role_enum, branch_id, last_login, is_active, name, branch_name, branch_code
      `,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Branch admin not found' });
    res.json(mapUserToBranchAdmin(rows[0]));
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
