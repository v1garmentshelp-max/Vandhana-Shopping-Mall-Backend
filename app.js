const dotenv = require('dotenv')
dotenv.config()

const express = require('express')
const cors = require('cors')

const app = express()

app.set('etag', false)

const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3002',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://vandhana-shopping-mall-backend.vercel.app',
  'https://vandhana-shopping-mall-admin.vercel.app',
  'https://vandhana-shopping-mall-website.vercel.app'
]

const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const allowedOrigins = envOrigins.length ? envOrigins : defaultOrigins

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true)
    if (allowedOrigins.includes('*')) return cb(null, true)
    if (allowedOrigins.includes(origin)) return cb(null, true)
    return cb(new Error('Not allowed by CORS'))
  },
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['authorization', 'content-type'],
  credentials: true
}

const shiprocketPublicRoutes = require('./routes/shiprocketPublicRoutes')

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
  next()
})

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))
app.use(express.json())

app.use('/api', shiprocketPublicRoutes)
app.use('/api/upload', require('./routes/uploadRoutes'))
app.use('/api/products', require('./routes/productRoutes'))
app.use('/api/b2b-customers', require('./routes/b2bCustomerRoutes'))
app.use('/api/b2c-customers', require('./routes/b2cCustomerRoutes'))
app.use('/api/signup', require('./routes/b2cCustomerRoutes'))
app.use('/api/auth', require('./routes/authRoutes'))
app.use('/api/wishlist', require('./routes/wishlistRoutes'))
app.use('/api/cart', require('./routes/cartRoutes'))
app.use('/api/user', require('./routes/userRoutes'))
app.use('/api/orders', require('./routes/orderRoutes'))
app.use('/api/auth-branch', require('./routes/authBranchRoutes'))
app.use('/api/barcodes', require('./routes/barcodeRoutes'))
app.use('/api/branch', require('./routes/branchInventoryRoutes'))
app.use('/api/inventory', require('./routes/inventoryRoutes'))
app.use('/api/sales', require('./routes/salesRoutes'))
app.use('/api', require('./routes/shiprocketRoutes'))
app.use('/api', require('./routes/shipmentRoutes'))
app.use('/api', require('./routes/returnsRoutes'))
app.use('/api/razorpay', require('./routes/razorpayRoutes'))
app.use('/api/homepage-images', require('./routes/homepageImageRoutes'))

app.get('/', (req, res) => res.status(200).send('Vandana Shopping Mall API is running'))
app.get('/healthz', (req, res) => res.status(200).send('ok'))

app.get('/api/debug/jwt', (req, res) => {
  res.json({ jwtSecretPresent: Boolean(process.env.JWT_SECRET) })
})

app.get('/api/debug/db', async (req, res) => {
  const pool = require('./db')
  const schema = process.env.DB_SCHEMA || 'public'

  try {
    const dbInfo = await pool.query('SELECT current_database() AS db, current_schema() AS current_schema')
    const tableInfo = await pool.query(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_name = 'vandana_users'
       ORDER BY table_schema, table_name`
    )
    const rowInfo = await pool.query(`SELECT COUNT(*)::int AS count FROM "${schema}"."vandana_users"`)

    res.json({
      dbOk: true,
      database: dbInfo.rows[0],
      vandanaUsersTables: tableInfo.rows,
      vandanaUsersCount: rowInfo.rows[0].count
    })
  } catch (e) {
    res.status(500).json({
      dbOk: false,
      error: e.message,
      detail: e.detail || null,
      code: e.code || null,
      table: e.table || null,
      constraint: e.constraint || null
    })
  }
})

app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'CORS blocked' })
  }
  return next(err)
})

app.use((req, res) => res.status(404).json({ message: 'Not found' }))

module.exports = app