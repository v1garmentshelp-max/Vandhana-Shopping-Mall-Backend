const { Pool } = require('pg')

const rawConnectionString = process.env.DATABASE_URL

if (!rawConnectionString) {
  throw new Error('DATABASE_URL is missing')
}

if (!rawConnectionString.startsWith('postgres://') && !rawConnectionString.startsWith('postgresql://')) {
  throw new Error('DATABASE_URL must start with postgres:// or postgresql://')
}

const connectionString = rawConnectionString.replace(/\?sslmode=require$/, '')

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  query_timeout: 30000,
  statement_timeout: 30000
})

module.exports = pool