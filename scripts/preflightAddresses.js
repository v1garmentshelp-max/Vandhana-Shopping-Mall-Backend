require('dotenv').config();
const pool = require('../db');
pool.query('SELECT id,user_id,label,address,is_default,created_at,updated_at FROM mobile_addresses LIMIT 0')
  .then(() => console.log('Saved-address database schema is ready.'))
  .catch(() => { console.error('Saved-address schema is not ready. Run npm run migrate:addresses on this DATABASE_URL, then retry.'); process.exitCode = 1; })
  .finally(() => pool.end());
