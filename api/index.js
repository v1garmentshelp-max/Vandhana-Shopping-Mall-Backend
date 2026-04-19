let app;
try {
  app = require('../app');
} catch (e) {
  console.error('App import failed:', e);
  module.exports = (_req, res) => res.status(500).json({ error: 'BOOT_FAIL', detail: String(e && e.stack || e) });
  return;
}
module.exports = (req, res) => app(req, res);


