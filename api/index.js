let app;
try {
  app = require('../app');
} catch (e) {
  console.error('App import failed:', e);
  module.exports = (_req, res) => res.status(500).json({
    error: 'BOOT_FAIL',
    message: 'The store is temporarily unavailable.'
  });
  return;
}
module.exports = (req, res) => app(req, res);
