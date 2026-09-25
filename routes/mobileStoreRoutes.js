const express = require('express');
const crypto = require('node:crypto');
const multer = require('multer');
const pool = require('../db');
const {
  requireAuth
} = require('../middleware/auth');
const {
  requireCustomerAuth
} = require('../middleware/customerAuth');
const store = require('../services/mobileStore');
const {
  fail,
  addressOf
} = require('../services/mobileRules');
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const configuredAuth = (_req, res, next) => !process.env.JWT_SECRET || ['change-me-in-env', 'dev_secret'].includes(process.env.JWT_SECRET) ? res.status(503).json({
  message: 'Store authentication is unavailable.'
}) : next();
const superAdmin = (req, _res, next) => String(req.user?.role_enum || req.user?.role).toUpperCase() === 'SUPER_ADMIN' ? next() : next(fail('Forbidden', 403));
router.get('/store', wrap(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await store.config(pool));
}));
router.put('/admin/store', configuredAuth, requireAuth, superAdmin, wrap(async (req, res) => {
  const config = store.validateConfig(req.body);
  await pool.query('UPDATE mobile_store_settings SET config=$1::jsonb,updated_at=now() WHERE id=true', [JSON.stringify(config)]);
  res.json(await store.config(pool));
}));
router.use(['/addresses', '/designs', '/uploads'], configuredAuth, requireCustomerAuth, wrap(async (req, _res, next) => {
  const customer = await pool.query('SELECT id,type FROM vandana_users WHERE id=$1', [req.customer.id]);
  if (!customer.rowCount || customer.rows[0].type !== 'B2C') throw fail('A customer account is required.', 403);
  next();
}));
router.get('/addresses', wrap(async (req, res) => res.json((await pool.query('SELECT id,label,address,is_default FROM mobile_addresses WHERE user_id=$1 ORDER BY is_default DESC,updated_at DESC', [req.customer.id])).rows)));
router.put('/addresses/:id', wrap(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw fail('Invalid address ID.');
  const address = addressOf(req.body.address),
    db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM vandana_users WHERE id=$1 FOR UPDATE', [req.customer.id]);
    const all = await db.query('SELECT id FROM mobile_addresses WHERE user_id=$1', [req.customer.id]);
    if (all.rowCount >= 20 && !all.rows.some(x => x.id === req.params.id)) throw fail('You can save up to 20 addresses.');
    const isDefault = req.body.is_default === true || !all.rowCount;
    if (isDefault) await db.query('UPDATE mobile_addresses SET is_default=false WHERE user_id=$1', [req.customer.id]);
    const q = await db.query(`INSERT INTO mobile_addresses(id,user_id,label,address,is_default) VALUES($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,address=EXCLUDED.address,is_default=EXCLUDED.is_default,updated_at=now()
      WHERE mobile_addresses.user_id=EXCLUDED.user_id RETURNING id,label,address,is_default`, [req.params.id, req.customer.id, String(req.body.label || 'Home').slice(0, 40), JSON.stringify(address), isDefault]);
    if (!q.rowCount) throw fail('Address not found.', 404);
    await db.query('COMMIT');
    res.json(q.rows[0]);
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}));
router.delete('/addresses/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM mobile_addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.customer.id]);
  res.json({
    ok: true
  });
}));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024,
    files: 1
  },
  fileFilter: (_req, f, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(f.mimetype))
});
router.post('/uploads', upload.single('image'), wrap(async (req, res) => {
  if (!req.file) throw fail('Choose a PNG, JPEG or WebP image under 4 MB.');
  const b = req.file.buffer;
  const actual = b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : b[0] === 255 && b[1] === 216 && b[2] === 255 ? 'image/jpeg' : b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
  if (actual !== req.file.mimetype) throw fail('The image format is invalid.');
  const count = await pool.query("SELECT count(*)::int AS n FROM mobile_uploads WHERE user_id=$1 AND created_at>now()-interval '1 hour'", [req.customer.id]);
  if (count.rows[0].n >= 40) throw fail('Upload limit reached. Please try again later.', 429);
  const form = new FormData(),
    id = crypto.randomUUID();
  form.append('file', new Blob([b], {
    type: actual
  }), `${id}.${actual.split('/')[1]}`);
  const folder = `mobile-designs/${req.customer.id}`;
  form.append('folder', folder);
  if (process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = require('cloudinary').v2.utils.api_sign_request({
      folder,
      timestamp
    }, process.env.CLOUDINARY_API_SECRET);
    form.append('timestamp', String(timestamp));
    form.append('api_key', process.env.CLOUDINARY_API_KEY);
    form.append('signature', signature);
  } else if (process.env.CLOUDINARY_UPLOAD_PRESET) {
    form.append('upload_preset', process.env.CLOUDINARY_UPLOAD_PRESET);
  } else throw fail('The store must configure image uploads.', 503);
  const response = await fetch(`https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME || ''}/image/upload`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (!response.ok || !data.secure_url) throw fail('Your image could not be uploaded. Please retry.', 502);
  await pool.query('INSERT INTO mobile_uploads(id,user_id,url) VALUES($1,$2,$3)', [id, req.customer.id, data.secure_url]);
  res.status(201).json({
    id,
    url: data.secure_url
  });
}));
router.get('/designs', wrap(async (req, res) => res.json((await pool.query('SELECT id,title,payload,updated_at FROM mobile_designs WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100', [req.customer.id])).rows)));
router.put('/designs/:id', wrap(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw fail('Invalid design reference.');
  const payload = await store.validateDesign(pool, req.customer.id, req.body.payload);
  const q = await pool.query(`INSERT INTO mobile_designs(id,user_id,title,payload) VALUES($1,$2,$3,$4::jsonb)
    ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,payload=EXCLUDED.payload,updated_at=now()
    WHERE mobile_designs.user_id=EXCLUDED.user_id RETURNING id,title,payload`, [req.params.id, req.customer.id, String(req.body.title || 'My V1 design').slice(0, 100), JSON.stringify(payload)]);
  if (!q.rowCount) throw fail('Design not found.', 404);
  res.json(q.rows[0]);
}));
router.delete('/designs/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM mobile_designs WHERE id=$1 AND user_id=$2', [req.params.id, req.customer.id]);
  res.json({
    ok: true
  });
}));
router.post('/designs/:id/cart', wrap(async (req, res) => res.status(201).json(await store.addDesignToCart(pool, req.customer.id, req.params.id, req.body.quantity))));
router.use((e, _req, res, _next) => res.status(e.code === 'LIMIT_FILE_SIZE' ? 413 : e.status || 500).json({
  message: e.code === 'LIMIT_FILE_SIZE' ? 'Images must be under 4 MB.' : e.status ? e.message : 'The store could not complete this request. Please retry.'
}));
module.exports = router;
