const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-env'

function readToken(req) {
  const authHeader = String(req.headers.authorization || '').trim()
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
}

function decodeCustomerToken(req) {
  const token = readToken(req)
  if (!token) return { token: '', decoded: null, error: null }

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    const id = Number(decoded?.id || 0)
    const role = String(decoded?.role_enum || decoded?.role || '').trim().toUpperCase()

    if (!id || role) {
      return { token, decoded: null, error: new Error('Unauthorized') }
    }

    return {
      token,
      decoded: {
        ...decoded,
        id
      },
      error: null
    }
  } catch (error) {
    return { token, decoded: null, error }
  }
}

function optionalCustomerAuth(req, _res, next) {
  const result = decodeCustomerToken(req)
  req.customer = result.decoded
  req.customerAuthError = result.error
  next()
}

function requireCustomerAuth(req, res, next) {
  const result = decodeCustomerToken(req)

  if (!result.token || !result.decoded) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  req.customer = result.decoded
  return next()
}

module.exports = {
  optionalCustomerAuth,
  requireCustomerAuth
}