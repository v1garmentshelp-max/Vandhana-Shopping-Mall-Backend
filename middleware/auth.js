const jwt = require('jsonwebtoken')

function getRole(user) {
  return String(user?.role || user?.role_enum || '').trim().toUpperCase()
}

function sign(user) {
  return jwt.sign(
    {
      id: user.id,
      role: user.role_enum || user.role,
      branch_id: user.branch_id
    },
    process.env.JWT_SECRET || 'dev_secret',
    {
      expiresIn: '7d'
    }
  )
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  if (!token) {
    return res.status(401).json({
      message: 'Unauthorized'
    })
  }

  try {
    req.user = jwt.verify(
      token,
      process.env.JWT_SECRET || 'dev_secret'
    )

    return next()
  } catch {
    return res.status(401).json({
      message: 'Unauthorized'
    })
  }
}

function requireSuperAdmin(req, res, next) {
  if (getRole(req.user) !== 'SUPER_ADMIN') {
    return res.status(403).json({
      message: 'Super admin access required'
    })
  }

  return next()
}

module.exports = {
  sign,
  requireAuth,
  requireSuperAdmin
}