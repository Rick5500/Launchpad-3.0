const express = require('express');
const path = require('path');
const auth = require('../auth');
const db = require('../db');
const {
  sanitizeOriginalName,
  contentTypeFor,
  removeUploaded,
  uploadMiddleware,
  uploadErrorStatus,
  uploadErrorMessage,
  storageRootOfUpload,
  openStored,
  sendStoredDownload,
  removeStored,
} = require('../fileStore');
const { maxUnattachedUploads, countUnattachedUploads } = require('../uploadMaintenance');
const shopLocations = require('../shopLocations');

const router = express.Router();
const uploadRoles = auth.requireRole('admin', 'manager', 'operator', 'customer');

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function publicFile(row) {
  return {
    id: row.id,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    uploaded_at: row.uploaded_at,
    order_id: row.order_id || null,
    line_item_id: row.line_item_id || null,
    work_order_id: row.work_order_id || null,
  };
}

function isQuoteOnlyFile(file) {
  return file.quote_request_id != null && file.order_id == null;
}

async function staffSeesLocation(user, locationId) {
  const access = await shopLocations.loadAccess(user.userId || user.id);
  return shopLocations.matches(access, locationId);
}

// An unattached file has no shop of its own. Use the customer's default shop,
// then the uploader's home shop. A null customer or operator shop is Raleigh.
async function unattachedLocationId(file) {
  if (file.customer_id) {
    const customer = await get(`SELECT location_id FROM users WHERE id = ?`, [file.customer_id]);
    if (customer && customer.location_id != null) return customer.location_id;
    return shopLocations.defaultLocationId();
  }
  if (file.uploaded_by) {
    const uploader = await get(`SELECT location_id, role FROM users WHERE id = ?`, [file.uploaded_by]);
    if (!uploader) return null;
    if (uploader.location_id != null) return uploader.location_id;
    if (uploader.role === 'operator' || uploader.role === 'customer') return shopLocations.defaultLocationId();
    return null;
  }
  return null;
}

async function canAccessUnattached(user, file) {
  const userId = Number(user.userId || user.id);
  if (user.role === 'operator') return false;
  if (user.role === 'customer') {
    return Number(file.customer_id) === userId || Number(file.uploaded_by) === userId;
  }
  if (Number(file.uploaded_by) === userId) return true;
  if (user.role !== 'admin' && user.role !== 'manager') return false;
  const locationId = await unattachedLocationId(file);
  if (locationId == null) {
    const access = await shopLocations.loadAccess(userId);
    return shopLocations.seesAll(access);
  }
  return staffSeesLocation(user, locationId);
}

async function canAccessFile(user, file) {
  if (!file) return false;
  // A quote attachment that is not on an order is visible only to the owning
  // customer, a manager, or an admin. Operators never see those files.
  if (isQuoteOnlyFile(file)) {
    if (user.role === 'admin') return true;
    if (user.role === 'manager') {
      const quote = await get('SELECT location_id FROM quote_requests WHERE id = ?', [file.quote_request_id]);
      if (!quote) return false;
      return staffSeesLocation(user, quote.location_id);
    }
    if (user.role !== 'customer') return false;
    return Number(file.customer_id) === Number(user.userId || user.id);
  }
  if (!file.order_id && !file.work_order_id) return canAccessUnattached(user, file);
  if (user.role === 'admin' || user.role === 'manager' || user.role === 'operator') {
    if (file.order_id) {
      const order = await get('SELECT location_id FROM orders WHERE id = ?', [file.order_id]);
      if (!order) return false;
      return staffSeesLocation(user, order.location_id);
    }
    const workOrder = await get(
      `SELECT COALESCE(wo.location_id, o.location_id) AS location_id
       FROM work_orders wo
       LEFT JOIN orders o ON o.id = wo.order_id
       WHERE wo.id = ?`,
      [file.work_order_id]
    );
    if (!workOrder) return false;
    return staffSeesLocation(user, workOrder.location_id);
  }
  if (user.role !== 'customer') return false;
  const userId = Number(user.userId || user.id);
  if (Number(file.customer_id) === userId) return true;
  if (!file.order_id) return false;
  const order = await get('SELECT customer_id FROM orders WHERE id = ?', [file.order_id]);
  return Boolean(order && Number(order.customer_id) === userId);
}

router.post('/', auth.requireAuth, uploadRoles, (req, res) => {
  uploadMiddleware()(req, res, async (err) => {
    if (err) {
      await Promise.resolve(removeUploaded(req.files));
      return res.status(uploadErrorStatus(err)).json({ error: uploadErrorMessage(err) });
    }

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'Choose a file to upload' });
    }

    let customerId = null;
    const insertedIds = [];
    try {
      if (req.user.role === 'customer') {
        customerId = Number(req.user.userId);
      } else if (req.body && req.body.customer_id != null && String(req.body.customer_id).trim() !== '') {
        const requested = Number(req.body.customer_id);
        if (!Number.isInteger(requested) || requested <= 0) {
          throw Object.assign(new Error('customer_id must be a positive integer'), { status: 400 });
        }
        const customer = await get(
          `SELECT id FROM users WHERE id = ? AND role = 'customer'`,
          [requested]
        );
        if (!customer) throw Object.assign(new Error('customer_id must be an existing customer'), { status: 400 });
        customerId = customer.id;
      }

      const waiting = await countUnattachedUploads(Number(req.user.userId));
      const limit = maxUnattachedUploads();
      if (waiting + files.length > limit) {
        await Promise.resolve(removeUploaded(files));
        return res.status(400).json({
          error: `You can have at most ${limit} files waiting to be attached to an order`,
        });
      }

      const saved = [];
      for (const file of files) {
        if (!file.size) {
          await Promise.resolve(removeUploaded([file]));
          throw Object.assign(new Error('Empty files are not allowed'), { status: 400 });
        }
        const storedName = path.basename(file.filename);
        const inserted = await run(
          `INSERT INTO order_files (
            customer_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, storage_root
          ) VALUES (?,?,?,?,?,?,?)`,
          [
            customerId,
            Number(req.user.userId),
            sanitizeOriginalName(file.originalname),
            storedName,
            contentTypeFor(storedName) || file.mimetype || null,
            file.size,
            storageRootOfUpload(file),
          ]
        );
        insertedIds.push(inserted.lastID);
        const row = await get(
          `SELECT id, original_name, mime_type, size_bytes, uploaded_at, order_id, line_item_id, work_order_id
           FROM order_files WHERE id = ?`,
          [inserted.lastID]
        );
        saved.push(publicFile(row));
      }
      return res.status(201).json({ files: saved });
    } catch (insertErr) {
      await Promise.resolve(removeUploaded(files));
      if (insertedIds.length) {
        const placeholders = insertedIds.map(() => '?').join(', ');
        await run(`DELETE FROM order_files WHERE id IN (${placeholders})`, insertedIds).catch(() => {});
      }
      const status = insertErr.status || 500;
      if (status >= 500) console.error('UPLOAD ERROR:', insertErr);
      return res.status(status).json({ error: status >= 500 ? 'Failed to store upload' : insertErr.message });
    }
  });
});

router.get('/:id/download', auth.requireAuth, uploadRoles, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }
  try {
    const file = await get(
      `SELECT id, order_id, work_order_id, quote_request_id, customer_id, uploaded_by,
              original_name, stored_name, size_bytes, storage_root
       FROM order_files WHERE id = ?`,
      [id]
    );
    if (!file || !(await canAccessFile(req.user, file))) {
      return res.status(404).json({ error: 'File not found' });
    }
    const opened = await Promise.resolve(openStored(file.stored_name, file.storage_root));
    if (!opened) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', contentTypeFor(file.stored_name));
    res.set('Cache-Control', 'private, no-store');
    return await Promise.resolve(sendStoredDownload(res, opened.fullPath, sanitizeOriginalName(file.original_name), path.dirname(opened.fullPath)));
  } catch (err) {
    if (err && err.status === 503) {
      return res.status(503).json({ error: err.publicMessage || err.message });
    }
    console.error('DOWNLOAD ERROR:', err);
    return res.status(500).json({ error: 'Failed to download file' });
  }
});

router.delete('/:id', auth.requireAuth, uploadRoles, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }
  try {
    const file = await get(
      `SELECT id, order_id, work_order_id, quote_request_id, customer_id, uploaded_by, stored_name, storage_root
       FROM order_files WHERE id = ?`,
      [id]
    );
    if (!file || !(await canAccessFile(req.user, file))) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (req.user.role === 'customer' && (file.order_id || file.quote_request_id)) {
      return res.status(403).json({ error: 'Files attached to a quote or an order cannot be deleted' });
    }
    await run('DELETE FROM order_files WHERE id = ?', [id]);
    await Promise.resolve(removeStored(file.stored_name, file.storage_root));
    return res.json({ ok: true, id });
  } catch (err) {
    console.error('UPLOAD DELETE ERROR:', err);
    return res.status(500).json({ error: 'Failed to delete file' });
  }
});

module.exports = router;
