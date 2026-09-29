const express = require('express');
const pool = require('../db');
const ReturnsService = require('../services/returnsService');
const refunds = require('../services/storeRefunds');
const router = express.Router();
const {
  requireAuth
} = require('../middleware/auth');
const {
  requireCustomerAuth
} = require('../middleware/customerAuth');
const configuredAuth = (_req, res, next) => !process.env.JWT_SECRET || ['change-me-in-env', 'dev_secret'].includes(process.env.JWT_SECRET) ? res.status(503).json({
  message: 'Store authentication is unavailable.'
}) : next();
const requireStaff = (req, res, next) => configuredAuth(req, res, () => requireAuth(req, res, () => ['SUPER_ADMIN', 'BRANCH_ADMIN'].includes(String(req.user?.role_enum || req.user?.role)) ? next() : res.status(403).json({
  message: 'Staff access required.'
})));
router.use('/returns/admin', requireStaff);
async function returnOwner(req, res, next) {
  try {
    if (!process.env.JWT_SECRET || ['change-me-in-env', 'dev_secret'].includes(process.env.JWT_SECRET)) return res.status(503).json({
      message: 'Store authentication is unavailable.'
    });
    const saleId = req.params.saleId || req.body?.sale_id;
    const result = await pool.query(`SELECT s.id FROM sales s JOIN vandana_users u ON u.id=$2
      WHERE s.id=$1 AND s.source='WEB' AND (lower(s.login_email)=lower(u.email) OR lower(s.customer_email)=lower(u.email))`, [saleId, req.customer.id]);
    if (!result.rowCount) return res.status(404).json({
      message: 'Order not found.'
    });
    next();
  } catch (_) {
    res.status(400).json({
      message: 'Invalid order reference.'
    });
  }
}
let extrasEnsured = false;
async function ensureReturnExtras() {
  if (extrasEnsured) return;
  await pool.query(`
    ALTER TABLE return_requests
      ADD COLUMN IF NOT EXISTS evidence_images jsonb,
      ADD COLUMN IF NOT EXISTS bank_account_name text,
      ADD COLUMN IF NOT EXISTS bank_account_number text,
      ADD COLUMN IF NOT EXISTS bank_ifsc text,
      ADD COLUMN IF NOT EXISTS bank_name text,
      ADD COLUMN IF NOT EXISTS bank_upi text,
      ADD COLUMN IF NOT EXISTS refund_status text
  `);
  extrasEnsured = true;
}
function normalizePaymentType(sale) {
  if (String(sale.payment_method).toUpperCase() === 'COD') return 'COD';
  const raw = String(sale.payment_status || '').toUpperCase();
  if (!raw) return 'UNKNOWN';
  if (raw === 'PREPAID') return 'PREPAID';
  if (raw.startsWith('PAID')) return 'PREPAID';
  if (raw.startsWith('PENDING')) return 'PREPAID';
  if (raw === 'COD' || raw === 'CASH_ON_DELIVERY') return 'COD';
  return raw;
}
async function isEligible(saleId) {
  const policy = await require('../services/returnPolicy').eligibility(pool, saleId);
  if (!policy.ok) return policy;
  return {
    ...policy,
    sale: (await pool.query('SELECT * FROM sales WHERE id=$1', [saleId])).rows[0]
  };
}
router.get('/returns/eligibility/:saleId', requireCustomerAuth, returnOwner, async (req, res) => {
  try {
    const result = await isEligible(req.params.saleId);
    const {
      sale,
      ...publicResult
    } = result;
    res.json(publicResult);
  } catch (e) {
    res.status(500).json({
      ok: false,
      reason: e.message || 'error'
    });
  }
});
router.post('/returns/upload-images', requireCustomerAuth, async (req, res) => {
  try {
    res.status(501).json({
      ok: false,
      message: 'Return image uploads are not available. Submit the return reason and selected items.'
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e.message || 'upload failed'
    });
  }
});
router.post('/returns', requireCustomerAuth, returnOwner, async (req, res) => {
  try {
    await ensureReturnExtras();
    const {
      sale_id,
      type,
      reason,
      notes,
      items,
      image_urls,
      bankDetails
    } = req.body || {};
    if (!sale_id) {
      return res.status(400).json({
        ok: false,
        reason: 'sale_id required'
      });
    }
    const savedSale = (await pool.query('SELECT * FROM sales WHERE id=$1', [sale_id])).rows[0];
    if (!savedSale) return res.status(404).json({
      message: 'Order not found.'
    });
    if (type === 'REFUND' && String(savedSale.status).toUpperCase() === 'CANCELLED') return res.status(409).json({
      message: 'Cancelled-order refunds are handled through the cancellation request to prevent duplicate refunds.'
    });
    if (type !== 'REFUND' || String(savedSale.status).toUpperCase() !== 'CANCELLED') {
      const result = await require('../services/returnPolicy').createReturn(pool, sale_id, req.body);
      return res.json(result);
    }
    let el;
    if (type === 'REFUND') {
      const saleRes = await pool.query('SELECT * FROM sales WHERE id=$1', [sale_id]);
      if (!saleRes.rows.length) {
        return res.status(400).json({
          ok: false,
          reason: 'Sale not found'
        });
      }
      const sale = saleRes.rows[0];
      const payType = normalizePaymentType(sale);
      if (payType !== 'PREPAID') {
        return res.status(400).json({
          ok: false,
          reason: 'Only prepaid orders are eligible for online refund'
        });
      }
      const status = String(sale.status || '').toUpperCase();
      if (!['CANCELLED', 'DELIVERED', 'RETURNED'].includes(status)) {
        return res.status(400).json({
          ok: false,
          reason: 'Refund is only allowed for cancelled or delivered orders'
        });
      }
      el = {
        ok: true,
        sale
      };
    } else {
      el = await isEligible(sale_id);
      if (!el.ok) return res.status(400).json(el);
    }
    const dbType = type === 'REPLACE' ? 'REPLACE' : type === 'REFUND' ? 'REFUND' : 'RETURN';
    const images = Array.isArray(image_urls) && image_urls.length ? image_urls.filter(u => typeof u === 'string' && u.trim()) : null;
    const bd = bankDetails || {};
    const accountName = String(bd.accountName || '').trim() || null;
    const bankName = String(bd.bankName || '').trim() || null;
    const accountNumber = String(bd.accountNumber || '').trim() || null;
    const ifsc = String(bd.ifsc || '').trim().toUpperCase() || null;
    const upiId = String(bd.upiId || '').trim() || null;
    const ins = await pool.query(`INSERT INTO return_requests (
         sale_id,
         customer_email,
         customer_mobile,
         type,
         reason,
         notes,
         status,
         evidence_images,
         bank_account_name,
         bank_account_number,
         bank_ifsc,
         bank_name,
         bank_upi,
         refund_status
       )
       VALUES ($1,$2,$3,$4,$5,$6,'REQUESTED',$7,$8,$9,$10,$11,$12,NULL)
       RETURNING *`, [sale_id, el.sale.customer_email || null, el.sale.customer_mobile || null, dbType, reason || null, notes || null, images, accountName, accountNumber, ifsc, bankName, upiId]);
    const reqRow = ins.rows[0];
    if (Array.isArray(items) && items.length) {
      const values = [];
      const params = [];
      items.forEach((it, i) => {
        params.push(`($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`);
        values.push(reqRow.id, it.variant_id, it.qty, it.reason_code || null, it.condition_note || null);
      });
      await pool.query(`INSERT INTO return_items (request_id, variant_id, qty, reason_code, condition_note)
         VALUES ${params.join(',')}`, values);
    }
    res.json({
      ok: true,
      request: reqRow
    });
  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      message: e.message || 'create failed'
    });
  }
});
router.get('/returns/admin', async (req, res) => {
  try {
    await ensureReturnExtras();
    const q = await pool.query(`SELECT r.*,
              s.totals AS sale_totals,
              s.customer_name
       FROM return_requests r
       JOIN sales s ON s.id = r.sale_id
       ORDER BY r.created_at DESC`);
    res.json({
      ok: true,
      rows: q.rows
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e.message || 'fetch failed'
    });
  }
});
router.get('/returns/admin/refunds', async (req, res) => {
  try {
    await ensureReturnExtras();
    const q = await pool.query(`SELECT
         r.id,
         r.sale_id,
         r.type,
         COALESCE(r.refund_status, r.status::text) AS status,
         r.refund_status,
         r.created_at,
         r.updated_at,
         r.bank_account_name,
         r.bank_account_number,
         r.bank_ifsc,
         r.bank_name,
         r.bank_upi,
         r.notes AS remarks,
         s.customer_name,
         s.customer_email,
         s.customer_mobile,
         r.refund_amount_paise / 100.0 AS amount,
         r.id AS return_request_id,
         'BANK/UPI'::text AS mode,
         'system'::text AS initiated_by
       FROM return_requests r
       JOIN sales s ON s.id = r.sale_id
       WHERE r.type = 'REFUND'
          OR r.refund_status IS NOT NULL
       ORDER BY r.created_at DESC`);
    res.json({
      ok: true,
      rows: q.rows
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e.message || 'refund list failed'
    });
  }
});
router.get('/returns/:id', requireStaff, async (req, res) => {
  try {
    await ensureReturnExtras();
    const id = req.params.id;
    const q = await pool.query(`SELECT
         r.*,
         s.totals,
         s.payment_status,
         s.payment_method,
         s.status AS sale_status,
         s.created_at AS sale_created_at
       FROM return_requests r
       JOIN sales s ON s.id = r.sale_id
       WHERE r.id = $1`, [id]);
    if (!q.rowCount) {
      return res.status(404).json({
        ok: false,
        message: 'Return request not found'
      });
    }
    const row = q.rows[0];
    require('../services/orderCancellation').staffAccess(req.user, {
      branch_id: (await pool.query('SELECT branch_id FROM sales WHERE id=$1', [row.sale_id])).rows[0]?.branch_id
    });
    const selectedItems = (await pool.query(`SELECT ri.qty,ri.sale_item_id,ri.variant_id,si.price,si.size,si.colour,COALESCE(si.custom_title,p.name,'Clothing') AS name
      FROM return_items ri LEFT JOIN sale_items si ON si.sale_id=$2 AND (ri.sale_item_id=si.id OR (ri.sale_item_id IS NULL AND ri.variant_id=si.variant_id))
      LEFT JOIN products p ON p.id=si.product_id WHERE ri.request_id=$1`, [id, row.sale_id])).rows;
    let imageUrls = [];
    if (Array.isArray(row.evidence_images)) {
      imageUrls = row.evidence_images;
    } else if (row.evidence_images && Array.isArray(row.evidence_images.images)) {
      imageUrls = row.evidence_images.images;
    }
    const bankDetails = {
      accountName: row.bank_account_name || '',
      bankName: row.bank_name || '',
      accountNumber: row.bank_account_number || '',
      ifsc: row.bank_ifsc || '',
      upiId: row.bank_upi || ''
    };
    return res.json({
      ok: true,
      request: {
        id: row.id,
        sale_id: row.sale_id,
        type: row.type,
        reason: row.reason,
        notes: row.notes,
        status: row.status,
        refund_status: row.refund_status,
        refund: row.refund_amount_paise == null ? null : refunds.publicRefund(row),
        created_at: row.created_at,
        updated_at: row.updated_at,
        customer_email: row.customer_email,
        customer_mobile: row.customer_mobile,
        bank_details: bankDetails,
        items: selectedItems,
        image_urls: imageUrls,
        sale: {
          id: row.sale_id,
          status: row.sale_status,
          payment_status: row.payment_status,
          payment_method: row.payment_method,
          created_at: row.sale_created_at,
          totals: row.totals
        }
      }
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e.message || 'fetch failed'
    });
  }
});
router.post('/returns/:id/details', requireStaff, async (req, res) => {
  try {
    await ensureReturnExtras();
    const id = req.params.id;
    const check = await pool.query('SELECT * FROM return_requests WHERE id=$1', [id]);
    if (!check.rowCount) {
      return res.status(404).json({
        ok: false,
        message: 'Return request not found'
      });
    }
    const {
      bankDetails,
      imageUrls
    } = req.body || {};
    const images = Array.isArray(imageUrls) && imageUrls.length ? imageUrls.filter(u => typeof u === 'string' && u.trim()) : [];
    const bd = bankDetails || {};
    const accountName = String(bd.accountName || '').trim() || null;
    const bankName = String(bd.bankName || '').trim() || null;
    const accountNumber = String(bd.accountNumber || '').trim() || null;
    const ifsc = String(bd.ifsc || '').trim().toUpperCase() || null;
    const upiId = String(bd.upiId || '').trim() || null;
    const upd = await pool.query(`UPDATE return_requests
       SET
         evidence_images = $1,
         bank_account_name = $2,
         bank_account_number = $3,
         bank_ifsc = $4,
         bank_name = $5,
         bank_upi = $6,
         updated_at = now()
       WHERE id = $7
       RETURNING *`, [images.length ? images : null, accountName, accountNumber, ifsc, bankName, upiId, id]);
    const row = upd.rows[0];
    return res.json({
      ok: true,
      request: {
        id: row.id,
        sale_id: row.sale_id,
        type: row.type,
        reason: row.reason,
        notes: row.notes,
        status: row.status,
        refund_status: row.refund_status,
        refund: row.refund_amount_paise == null ? null : refunds.publicRefund(row),
        created_at: row.created_at,
        updated_at: row.updated_at,
        customer_email: row.customer_email,
        customer_mobile: row.customer_mobile,
        bank_details: {
          accountName: row.bank_account_name || '',
          bankName: row.bank_name || '',
          accountNumber: row.bank_account_number || '',
          ifsc: row.bank_ifsc || '',
          upiId: row.bank_upi || ''
        },
        image_urls: images
      }
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e.message || 'save failed'
    });
  }
});
router.post('/returns/:id/approve', requireStaff, async (req, res) => {
  try {
    const found = (await pool.query('SELECT sale_id FROM return_requests WHERE id=$1', [req.params.id])).rows[0];
    if (!found) return res.status(404).json({
      message: 'Return request not found.'
    });
    const result = await require('../services/orderCancellation').locked(found.sale_id, async db => {
      const request = (await db.query('SELECT * FROM return_requests WHERE id=$1', [req.params.id])).rows[0];
      const sale = (await db.query('SELECT * FROM sales WHERE id=$1', [found.sale_id])).rows[0];
      require('../services/orderCancellation').staffAccess(req.user, sale);
      if (request.status === 'APPROVED') return {
        ok: true
      };
      if (request.status !== 'REQUESTED') throw Object.assign(new Error('Only a pending request can be approved.'), {
        status: 409
      });
      await refunds.prepareReturnRefund(db, request.id);
      let reverse = (await db.query('SELECT * FROM reverse_shipments WHERE request_id=$1 ORDER BY id DESC LIMIT 1', [request.id])).rows[0];
      if (!reverse) {
        if (request.reverse_pickup_attempted) throw Object.assign(new Error('A reverse pickup may already exist. Check and link the Shiprocket return booking before retrying. No second pickup has been requested.'), {
          status: 409
        });
        const items = (await db.query('SELECT * FROM return_items WHERE request_id=$1', [request.id])).rows;
        const branch = (await db.query('SELECT * FROM branches WHERE id=$1', [sale.branch_id])).rows[0];
        if (!branch) throw Object.assign(new Error('The original branch is unavailable.'), {
          status: 409
        });
        const svc = new ReturnsService({
          pool
        });
        await svc.init();
        await db.query('UPDATE return_requests SET reverse_pickup_attempted=true,reverse_pickup_error=NULL WHERE id=$1', [request.id]);
        try {
          reverse = await svc.createReversePickup({
            request,
            sale,
            items,
            branch
          });
        } catch (e) {
          await db.query('UPDATE return_requests SET reverse_pickup_error=$2 WHERE id=$1', [request.id, String(e.message).slice(0, 1000)]);
          throw Object.assign(new Error('Reverse pickup is awaiting store reconciliation. Check Shiprocket before trying again.'), {
            status: 409
          });
        }
      }
      await db.query("UPDATE return_requests SET status='APPROVED',refund_status=$2,updated_at=now() WHERE id=$1", [request.id, request.type === 'REPLACE' ? null : 'PENDING_REFUND']);
      return {
        ok: true,
        reverse
      };
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({
      message: e.status ? e.message : 'The return could not be approved. Please try again.'
    });
  }
});
router.post('/returns/:id/reject', requireStaff, async (req, res) => {
  try {
    const row = (await pool.query('SELECT r.*,s.branch_id FROM return_requests r JOIN sales s ON s.id=r.sale_id WHERE r.id=$1', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({
      message: 'Return request not found.'
    });
    require('../services/orderCancellation').staffAccess(req.user, row);
    const reason = String(req.body.reason || '').trim().slice(0, 1000);
    if (reason.length < 5) return res.status(400).json({
      message: 'Enter a rejection reason.'
    });
    const result = await pool.query("UPDATE return_requests SET status='REJECTED',notes=COALESCE(notes,'')||$2,updated_at=now() WHERE id=$1 AND status='REQUESTED' AND reverse_pickup_attempted=false AND COALESCE(refund_status,'')<>'REFUNDED' AND refund_reference IS NULL RETURNING id", [req.params.id, '\nRejected: ' + reason]);
    if (!result.rowCount) return res.status(409).json({
      message: 'Only a pending, unpaid return request can be rejected.'
    });
    res.json({
      ok: true
    });
  } catch (e) {
    res.status(e.status || 500).json({
      message: e.status ? e.message : 'The return decision could not be saved.'
    });
  }
});
router.post('/returns/:id/refund-complete', requireStaff, async (req, res) => {
  try {
    res.json(await refunds.completeReturn(req.user, req.params.id, req.body));
  } catch (e) {
    res.status(e.status || 500).json({
      message: e.status ? e.message : 'Refund verification could not be completed. Please try again.'
    });
  }
});
router.get('/returns/by-sale/:saleId', requireCustomerAuth, returnOwner, async (req, res) => {
  try {
    const saleId = req.params.saleId;
    const q = await pool.query(`SELECT r.*,
              COALESCE(json_agg(ri.*) FILTER (WHERE ri.id IS NOT NULL), '[]') AS items
       FROM return_requests r
       LEFT JOIN return_items ri ON ri.request_id = r.id
       WHERE r.sale_id=$1
       GROUP BY r.id
       ORDER BY r.created_at DESC`, [saleId]);
    res.json({
      ok: true,
      rows: q.rows
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e.message || 'list failed'
    });
  }
});
module.exports = router;
