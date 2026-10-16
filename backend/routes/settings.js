const express = require('express');
const auth = require('../auth');
const settings = require('../systemSettings');
const { sendError } = require('../httpError');

const router = express.Router();

router.get('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await settings.getSettings());
  } catch (err) {
    sendError(res, err, 'SETTINGS GET ERROR:', 'Failed to load settings');
  }
});

router.put('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await settings.updateSettings(req.user.userId, req.body));
  } catch (err) {
    sendError(res, err, 'SETTINGS UPDATE ERROR:', 'Failed to update settings');
  }
});

module.exports = router;
