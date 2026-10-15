const express = require('express');
const auth = require('../auth');
const notifications = require('../notifications');

const router = express.Router();

function sendServiceError(res, err, logLabel, fallback) {
  if (err && err.status && err.publicMessage) {
    return res.status(err.status).json({ error: err.publicMessage });
  }
  console.error(logLabel, err);
  return res.status(500).json({ error: fallback });
}

router.get('/', auth.requireAuth, (req, res) => {
  notifications.listNotifications(req.user, req.query, (err, result) => {
    if (err) return sendServiceError(res, err, 'NOTIFICATION LIST ERROR:', 'Failed to load notifications');
    res.json(result);
  });
});

router.post('/read-all', auth.requireAuth, (req, res) => {
  notifications.markAllRead(req.user, (err, result) => {
    if (err) return sendServiceError(res, err, 'NOTIFICATION READ ERROR:', 'Failed to mark notifications read');
    res.json(result);
  });
});

router.post('/:id/read', auth.requireAuth, (req, res) => {
  notifications.markRead(req.user, req.params.id, (err, result) => {
    if (err) return sendServiceError(res, err, 'NOTIFICATION READ ERROR:', 'Failed to mark notification read');
    res.json(result);
  });
});

module.exports = router;
