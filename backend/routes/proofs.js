const express = require('express');
const auth = require('../auth');
const proofs = require('../proofs');
const { sendError } = require('../httpError');
const {
  removeUploaded,
  uploadMiddleware,
  uploadErrorStatus,
  uploadErrorMessage,
  createStoredReadStream,
} = require('../fileStore');

const proofRouter = express.Router();
const fileRouter = express.Router();
const readers = auth.requireRole('admin', 'manager', 'operator', 'customer');
const staff = auth.requireRole('admin', 'manager', 'operator');
const customers = auth.requireRole('customer');

function parseId(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function fail(res, err, label, fallback) {
  if (err && err.status === 429) {
    res.set('Retry-After', String(err.retryAfterSeconds || 1));
  }
  return sendError(res, err, label, fallback);
}

function acceptUpload(req, res, next) {
  uploadMiddleware()(req, res, (err) => {
    if (err) {
      removeUploaded(req.files);
      return res.status(uploadErrorStatus(err)).json({ error: uploadErrorMessage(err) });
    }
    return next();
  });
}

function sendProofFile(res, file, disposition) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', file.contentType);
  res.set('Cache-Control', 'private, no-store');
  if (disposition === 'inline') {
    const name = String(file.downloadName || 'proof').replace(/["\r\n]/g, '');
    res.set('Content-Disposition', `inline; filename="${name}"`);
    res.set('Content-Length', file.size);
    const stream = createStoredReadStream(file.fullPath);
    stream.on('error', (streamErr) => {
      if (res.headersSent) return;
      console.error('PROOF VIEW ERROR:', streamErr);
      res.status(500).json({ error: 'Failed to open file' });
    });
    return stream.pipe(res);
  }
  return res.download(file.fullPath, file.downloadName, (downloadErr) => {
    if (!downloadErr || downloadErr.code === 'ECONNABORTED') return;
    if (res.headersSent) return;
    console.error('PROOF DOWNLOAD ERROR:', downloadErr);
    res.status(500).json({ error: 'Failed to download file' });
  });
}

function mount(orderRouter) {
  orderRouter.get('/:id/proofs', auth.requireAuth, readers, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id must be a positive integer' });
    try {
      res.json(await proofs.listForUser(req.user, id));
    } catch (err) {
      fail(res, err, 'PROOF LIST ERROR:', 'Failed to load proofs');
    }
  });

  orderRouter.post('/:id/proofs', auth.requireAuth, staff, acceptUpload, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      removeUploaded(req.files);
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    try {
      const result = await proofs.sendProof(req.user, id, req.body || {}, req.files || []);
      return res.status(201).json(result);
    } catch (err) {
      if (!err.filesCommitted) removeUploaded(req.files);
      return fail(res, err, 'PROOF SEND ERROR:', 'Failed to send proof');
    }
  });
}

proofRouter.get('/pending', auth.requireAuth, readers, async (req, res) => {
  try {
    res.json(await proofs.listPending(req.user));
  } catch (err) {
    fail(res, err, 'PROOF PENDING ERROR:', 'Failed to load proofs');
  }
});

proofRouter.post('/:id/approve', auth.requireAuth, customers, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });
  try {
    res.json(await proofs.approve(req.user, id));
  } catch (err) {
    fail(res, err, 'PROOF APPROVE ERROR:', 'Failed to approve proof');
  }
});

proofRouter.post('/:id/changes', auth.requireAuth, customers, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });
  try {
    res.json(await proofs.requestChanges(req.user, id, req.body || {}));
  } catch (err) {
    fail(res, err, 'PROOF CHANGES ERROR:', 'Failed to request changes');
  }
});

fileRouter.get('/:id/download', auth.requireAuth, readers, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });
  try {
    sendProofFile(res, await proofs.prepareFile(req.user, id), 'attachment');
  } catch (err) {
    fail(res, err, 'PROOF DOWNLOAD ERROR:', 'Failed to download file');
  }
});

fileRouter.get('/:id/view', auth.requireAuth, readers, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });
  try {
    sendProofFile(res, await proofs.prepareFile(req.user, id), 'inline');
  } catch (err) {
    fail(res, err, 'PROOF VIEW ERROR:', 'Failed to open file');
  }
});

module.exports = {
  mount,
  proofRouter,
  fileRouter,
};
