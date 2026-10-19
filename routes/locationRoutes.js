const router = require('express').Router();
const postal = require('../services/postalLookup');
router.get('/states', (_req, res) => res.json({ states: require('../services/indiaLocations').states }));
router.get('/pincode/:pin', async (req, res) => {
  try { res.json(await postal.lookup(req.params.pin)); }
  catch (error) { res.status(error.status || 503).json({ message: error.message, code: error.code }); }
});
module.exports = router;
