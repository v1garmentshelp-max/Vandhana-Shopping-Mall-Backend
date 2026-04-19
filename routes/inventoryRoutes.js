const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.post('/scan', requireAuth, async (req, res) => {
  const { branch_id, ean_code, qty = 1, sale_id, client_action_id } = req.body || {};
  const branchId = Number(branch_id || req.user.branch_id);
  if (!branchId || !ean_code || !sale_id || !client_action_id) {
    return res.status(400).json({ message: 'branch_id, ean_code, sale_id, client_action_id required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const idem = await client.query('SELECT key FROM idempotency_keys WHERE key = $1', [client_action_id]);
    if (idem.rowCount) {
      await client.query('COMMIT');
      return res.json({ ok: true, idempotent: true });
    }

    const b = await client.query('SELECT variant_id FROM barcodes WHERE ean_code = $1', [ean_code]);
    if (!b.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Barcode not found' });
    }
    const variantId = b.rows[0].variant_id;

    const s0 = await client.query(
      'SELECT on_hand, reserved FROM branch_variant_stock WHERE branch_id = $1 AND variant_id = $2 FOR UPDATE',
      [branchId, variantId]
    );
    if (!s0.rowCount) {
      await client.query(
        'INSERT INTO branch_variant_stock (branch_id, variant_id, on_hand, reserved, is_active) VALUES ($1,$2,0,0,TRUE)',
        [branchId, variantId]
      );
    }
    const s1 = await client.query(
      'SELECT on_hand, reserved FROM branch_variant_stock WHERE branch_id = $1 AND variant_id = $2 FOR UPDATE',
      [branchId, variantId]
    );
    const onHand = Number(s1.rows[0].on_hand || 0);
    if (onHand < qty) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Insufficient stock' });
    }

    await client.query(
      `UPDATE branch_variant_stock
       SET on_hand = on_hand - $3,
           reserved = reserved + $3
       WHERE branch_id = $1 AND variant_id = $2`,
      [branchId, variantId, qty]
    );

    await client.query('INSERT INTO idempotency_keys (key) VALUES ($1)', [client_action_id]);
    await client.query('COMMIT');
    res.json({ ok: true, variant_id: variantId });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
