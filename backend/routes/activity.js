const express = require('express');
const auth = require('../auth');
const activity = require('../activityQuery');
const { sendError } = require('../httpError');

const router = express.Router();

router.get('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const result = await activity.listActivity(req.query);
    if (result.format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="activity-log.csv"');
      return res.send(result.csv);
    }
    res.json({
      entries: result.entries,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    });
  } catch (err) {
    sendError(res, err, 'ACTIVITY LIST ERROR:', 'Failed to load activity');
  }
});

module.exports = router;
