const express = require('express');
const auth = require('../auth');
const activityLog = require('../activityLog');
const mailer = require('../mailer');
const settings = require('../systemSettings');
const { sendError } = require('../httpError');

const router = express.Router();

function withMail(body) {
  return {
    ...body,
    mail: {
      configured: mailer.isConfigured(),
      from: mailer.publicFrom(),
      public_url_set: Boolean(mailer.publicAppUrl()),
    },
  };
}

router.get('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(withMail(await settings.getSettings()));
  } catch (err) {
    sendError(res, err, 'SETTINGS GET ERROR:', 'Failed to load settings');
  }
});

router.put('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(withMail(await settings.updateSettings(req.user.userId, req.body)));
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
