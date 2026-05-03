const { Pool } = require('pg')

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://doadmin:YOUR_PASSWORD@db-postgresql-blr1-66161-do-user-36142224-0.f.db.ondigitalocean.com:25060/vandana_shopping_mall?sslmode=require'

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
})

module.exports = pool