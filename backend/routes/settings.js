const express = require('express');
const auth = require('../auth');
const activityLog = require('../activityLog');
const { describeStorage } = require('../fileStore');
const fileStorageMove = require('../fileStorageMove');
const graphMail = require('../graphMail');
const inboundEmail = require('../inboundEmail');
const mailer = require('../mailer');
const settings = require('../systemSettings');
const { sendError } = require('../httpError');

const router = express.Router();

async function withMail(body) {
  let mailbox = null;
  try {
    mailbox = await inboundEmail.syncStatus({ role: 'admin' });
  } catch (err) {
    mailbox = null;
  }
  let fileStorage = null;
  try {
    fileStorage = describeStorage();
    fileStorage.outside_current_folder = await fileStorageMove.countOutside();
  } catch (err) {
    fileStorage = {
      reachable: false,
      warning: 'File storage is unavailable. The storage folder cannot be reached, so uploads are paused.',
      path: null,
      free_bytes: null,
      free_label: null,
      outside_current_folder: null,
    };
  }
  return {
    ...body,
    mail: {
      configured: mailer.isConfigured(),
      from: mailer.publicFrom(),
      public_url_set: Boolean(mailer.publicAppUrl()),
    },
    file_storage: fileStorage,
    inbound_mail: {
      configured: graphMail.isConfigured(),
      mailbox: graphMail.isConfigured() ? graphMail.mailbox() : null,
      folder: graphMail.folderName(),
      poll_seconds: graphMail.pollSeconds(),
      polling_enabled: body.inbound_email_polling_enabled !== false,
      last_attempt_at: mailbox ? mailbox.last_attempt_at : null,
      last_success_at: mailbox ? mailbox.last_success_at : null,
      last_status: mailbox ? mailbox.last_status : null,
      last_error: mailbox ? mailbox.last_error : null,
      last_imported: mailbox ? mailbox.last_imported : null,
    },
  };
}

router.get('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await withMail(await settings.getSettings()));
  } catch (err) {
    sendError(res, err, 'SETTINGS GET ERROR:', 'Failed to load settings');
  }
});

router.put('/file-storage', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'path')) {
      const error = new Error('path is required');
      error.status = 400;
      error.publicMessage = 'path is required';
      throw error;
    }
    res.json(await withMail(await settings.updateFileStorage(req.user.userId, req.body.path)));
  } catch (err) {
    sendError(res, err, 'FILE STORAGE UPDATE ERROR:', 'Failed to update file storage');
  }
});

router.post('/file-storage/move', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const result = await fileStorageMove.moveAll(req.user.userId);
    if (result.conflict) {
      return res.status(409).json({ error: result.error || 'A file move is already running.' });
    }
    let fileStorage = null;
    try {
      fileStorage = describeStorage();
      fileStorage.outside_current_folder = await fileStorageMove.countOutside();
    } catch (err) {
      fileStorage = null;
    }
    const payload = { ...result, file_storage: fileStorage };
    if (result.unavailable) {
      return res.status(503).json({
        ...payload,
        error: result.error || 'File storage is unavailable. The storage folder cannot be reached, so uploads are paused.',
      });
    }
    return res.json(payload);
  } catch (err) {
    sendError(res, err, 'FILE STORAGE MOVE ERROR:', 'Failed to move existing files');
  }
});

router.put('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await withMail(await settings.updateSettings(req.user.userId, req.body)));
  } catch (err) {
    sendError(res, err, 'SETTINGS UPDATE ERROR:', 'Failed to update settings');
  }
});

router.post('/test-email', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  const to = req.body && req.body.to;
  try {
    const result = await mailer.sendTest(req.user.userId, to);
    await activityLog.record(req.user.userId, 'settings.test_email_sent', 'system_settings', null, {
      recipient: result.to,
      message: `Test email sent to ${result.to}`,
    });
    const payload = { status: 'sent', to: result.to };
    if (result.preview) payload.preview = result.preview;
    res.json(payload);
  } catch (err) {
    if (err && err.status === 429) {
      res.set('Retry-After', String(err.retryAfterSeconds || 1));
    }
    if (err && err.status === 502) {
      const recipient = err.recipient || null;
      activityLog.record(req.user.userId, 'settings.test_email_failed', 'system_settings', null, {
        recipient,
        message: recipient ? `Test email to ${recipient} failed` : 'Test email failed',
      }).catch(() => {});
    }
    sendError(res, err, 'TEST EMAIL ERROR:', 'Failed to send test email');
  }
});

module.exports = router;
