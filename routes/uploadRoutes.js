const express = require('express');
const multer = require('multer');
const { put } = require('@vercel/blob');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const token =
      process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.VERCEL_BLOB_READ_WRITE_TOKEN ||
      process.env.VERCEL_BLOB_RW_TOKEN;

    if (!token) return res.status(500).json({ error: 'Upload failed', detail: 'Missing BLOB_READ_WRITE_TOKEN in runtime' });

    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const filename = `${Date.now()}.${ext}`;

    const result = await put(filename, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype,
      token
    });

    res.json({ imageUrl: result.url });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed', detail: err?.message || 'unknown' });
  }
});

module.exports = router;
