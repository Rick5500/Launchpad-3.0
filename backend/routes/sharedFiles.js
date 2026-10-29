const express = require('express');
const path = require('path');
const auth = require('../auth');
const shared = require('../sharedFiles');
const { sendError } = require('../httpError');
const {
  finishRemoveUploaded,
  removeUploaded,
  uploadMiddleware,
  uploadErrorStatus,
  uploadErrorMessage,
  sendStoredDownload,
} = require('../fileStore');

const fileRouter = express.Router();
const readers = auth.requireRole('admin', 'manager', 'operator', 'customer');
const staff = auth.requireRole('admin', 'manager', 'operator');

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
      finishRemoveUploaded(req.files, () => {
        res.status(uploadErrorStatus(err)).json({ error: uploadErrorMessage(err) });
      });
      return;
    }
    return next();
  });
}

function mount(orderRouter) {
  orderRouter.get('/:id/shared-files', auth.requireAuth, readers, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id must be a positive integer' });
    try {
      res.json(await shared.listForUser(req.user, id, req.query.work_order_id));
    } catch (err) {
      fail(res, err, 'SHARED FILES LIST ERROR:', 'Failed to load files');
    }
  });

  orderRouter.post('/:id/shared-files', auth.requireAuth, staff, acceptUpload, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      await Promise.resolve(removeUploaded(req.files));
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    try {
      const result = await shared.shareFiles(req.user, id, req.body || {}, req.files || []);
      return res.status(201).json(result);
    } catch (err) {
      if (!err.filesCommitted) await Promise.resolve(removeUploaded(req.files));
      return fail(res, err, 'SHARED FILES SEND ERROR:', 'Failed to share files');
    }
  });
}

fileRouter.get('/:id/download', auth.requireAuth, readers, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });
  try {
    const file = await shared.prepareDownload(req.user, id);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', file.contentType);
    res.set('Cache-Control', 'private, no-store');
    return await Promise.resolve(sendStoredDownload(res, file.fullPath, file.downloadName, path.dirname(file.fullPath)));
  } catch (err) {
    return fail(res, err, 'SHARED DOWNLOAD ERROR:', 'Failed to download file');
  }
});

fileRouter.delete('/:id', auth.requireAuth, staff, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });
  try {
    res.json(await shared.removeFile(req.user, id));
  } catch (err) {
    fail(res, err, 'SHARED DELETE ERROR:', 'Failed to delete file');
  }
});

fileRouter.post('/:id/replace', auth.requireAuth, staff, acceptUpload, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    await Promise.resolve(removeUploaded(req.files));
    return res.status(400).json({ error: 'id must be a positive integer' });
  }
  try {
    const result = await shared.replaceFile(req.user, id, req.body || {}, req.files || []);
    return res.json(result);
  } catch (err) {
    if (!err.filesCommitted) await Promise.resolve(removeUploaded(req.files));
    return fail(res, err, 'SHARED REPLACE ERROR:', 'Failed to replace file');
  }
});

const transferRouter = express.Router();

transferRouter.get('/', auth.requireAuth, readers, async (req, res) => {
  try {
    res.json(await shared.listTransfers(req.user, req.query || {}));
  } catch (err) {
    fail(res, err, 'FILE TRANSFER LIST ERROR:', 'Failed to load files');
  }
});

transferRouter.get('/:id', auth.requireAuth, readers, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });
  try {
    res.json(await shared.getTransfer(req.user, id));
  } catch (err) {
    fail(res, err, 'FILE TRANSFER ERROR:', 'Failed to load files');
  }
});

transferRouter.post('/', auth.requireAuth, staff, acceptUpload, async (req, res) => {
  try {
    const result = await shared.createTransfer(req.user, req.body || {}, req.files || []);
    return res.status(201).json(result);
  } catch (err) {
    if (!err.filesCommitted) await Promise.resolve(removeUploaded(req.files));
    return fail(res, err, 'FILE TRANSFER SEND ERROR:', 'Failed to send files');
  }
});

module.exports = {
  mount,
  fileRouter,
  transferRouter,
};
