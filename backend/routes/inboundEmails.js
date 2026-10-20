const express = require('express');
const auth = require('../auth');
const graphMail = require('../graphMail');
const inboundEmail = require('../inboundEmail');
const { OrderError } = require('../orderService');
const { inboundEmailPollingEnabled } = require('../systemSettings');
const { sendError } = require('../httpError');

const router = express.Router();
const staff = auth.requireRole('admin', 'manager', 'operator');

async function statusPayload(user) {
  const status = await inboundEmail.syncStatus(user);
  status.polling_enabled = await inboundEmailPollingEnabled();
  return status;
}

router.get('/status', auth.requireAuth, staff, async (req, res) => {
  try {
    res.json(await statusPayload(req.user));
  } catch (err) {
    sendError(res, err, 'INBOUND MAIL STATUS ERROR:', 'Failed to load mailbox status');
  }
});

router.post('/sync', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  if (!graphMail.isConfigured()) {
    return res.status(400).json({ error: 'Microsoft 365 mailbox is not configured' });
  }
  try {
    const result = await inboundEmail.syncOnce();
    const status = await statusPayload(req.user);
    res.json({ ok: true, ...result, ...status });
  } catch (err) {
    const message = await inboundEmail.recordSyncError(err);
    console.error('INBOUND MAIL ERROR:', message);
    const notConfigured = err && err.status === 400 && /not configured/i.test(message);
    return res.status(notConfigured ? 400 : 502).json({ error: message });
  }
});

router.get('/', auth.requireAuth, staff, async (req, res) => {
  try {
    res.json(await inboundEmail.listEmails(req.query || {}));
  } catch (err) {
    sendError(res, err, 'INBOUND MAIL LIST ERROR:', 'Failed to load emails');
  }
});

router.get('/:id/attachments/:attachmentId/download', auth.requireAuth, staff, async (req, res) => {
  try {
    const file = await inboundEmail.attachmentDownload(req.user, req.params.id, req.params.attachmentId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', file.contentType);
    res.set('Cache-Control', 'private, no-store');
    return res.download(file.path, file.name, (err) => {
      if (!err || err.code === 'ECONNABORTED') return;
      if (res.headersSent) return;
      console.error('INBOUND DOWNLOAD ERROR:', err.message);
      res.status(500).json({ error: 'Failed to download file' });
    });
  } catch (err) {
    sendError(res, err, 'INBOUND DOWNLOAD ERROR:', 'Failed to download file');
  }
});

router.get('/:id', auth.requireAuth, staff, async (req, res) => {
  try {
    const email = await inboundEmail.getEmail(req.params.id);
    if (!email) return res.status(404).json({ error: 'Email not found' });
    res.json(email);
  } catch (err) {
    sendError(res, err, 'INBOUND MAIL GET ERROR:', 'Failed to load email');
  }
});

router.post('/:id/convert', auth.requireAuth, staff, async (req, res) => {
  try {
    const created = await inboundEmail.convertEmail(req.user, req.params.id, req.body || {});
    res.status(201).json(created);
  } catch (err) {
    if (err && err.status === 409 && err.orderId) {
      return res.status(409).json({
        error: err.publicMessage || err.message,
        order_id: err.orderId,
        order_number: err.orderNumber || null,
      });
    }
    if (err instanceof OrderError || (err && err.status && (err.publicMessage || err.message))) {
      const status = err.status && err.status < 500 ? err.status : 400;
      return res.status(status).json({ error: err.publicMessage || err.message });
    }
    console.error('INBOUND CONVERT ERROR:', err);
    return res.status(500).json({ error: 'Failed to create the order' });
  }
});

router.post('/:id/dismiss', auth.requireAuth, staff, async (req, res) => {
  try {
    const email = await inboundEmail.dismissEmail(req.user, req.params.id);
    res.json(email);
  } catch (err) {
    if (err && err.status === 409 && err.orderId) {
      return res.status(409).json({
        error: err.publicMessage || err.message,
        order_id: err.orderId,
        order_number: err.orderNumber || null,
      });
    }
    sendError(res, err, 'INBOUND DISMISS ERROR:', 'Failed to dismiss the email');
  }
});

module.exports = router;
