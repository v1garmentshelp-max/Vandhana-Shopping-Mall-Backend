require('dotenv').config()
const { Pool } = require('pg')

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_L4WCoHgsFbt1@ep-lingering-lab-a1plroab-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
})

module.exports = pool