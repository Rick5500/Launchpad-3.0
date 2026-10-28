const express = require('express');
const auth = require('../auth');
const { listAccountAudit } = require('../customerNotices');
const { sendError } = require('../httpError');

const router = express.Router();

router.get('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const limit = req.query && req.query.limit != null ? Number(req.query.limit) : 100;
    const offset = req.query && req.query.offset != null ? Number(req.query.offset) : 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'limit must be an integer from 1 to 200' });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a positive integer or zero' });
    }
    res.json(await listAccountAudit({ limit, offset }));
  } catch (err) {
    sendError(res, err, 'ACCOUNT AUDIT ERROR:', 'Failed to load the account audit log');
  }
});

module.exports = router;
