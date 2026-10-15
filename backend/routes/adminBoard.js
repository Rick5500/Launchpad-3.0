const express = require('express');
const auth = require('../auth');
const adminBoard = require('../adminBoard');

const router = express.Router();

router.use(auth.requireAuth, auth.requireRole('admin', 'operator'));

function sendError(res, err, label, fallback) {
  if (err && err.status && err.message && err.name !== 'SqliteError') {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(label, err);
  return res.status(500).json({ error: fallback });
}

router.get('/', async (req, res) => {
  try {
    res.json(await adminBoard.loadSummary());
  } catch (err) {
    sendError(res, err, 'ADMIN BOARD ERROR:', 'Failed to load the admin board');
  }
});

router.get('/work-orders', async (req, res) => {
  try {
    res.json(await adminBoard.listWorkOrders(req.query));
  } catch (err) {
    sendError(res, err, 'ADMIN BOARD WORK ORDERS ERROR:', 'Failed to load work orders');
  }
});

router.get('/activity', async (req, res) => {
  try {
    res.json(await adminBoard.listActivity(req.query, false));
  } catch (err) {
    sendError(res, err, 'ADMIN BOARD ACTIVITY ERROR:', 'Failed to load activity');
  }
});

router.get('/approvals', async (req, res) => {
  try {
    res.json(await adminBoard.listApprovals(req.query, false));
  } catch (err) {
    sendError(res, err, 'ADMIN BOARD APPROVALS ERROR:', 'Failed to load approvals');
  }
});

router.post('/approvals/:id', auth.requireRole('admin'), async (req, res) => {
  try {
    const result = await adminBoard.decideApproval({
      workOrderId: req.params.id,
      decision: req.body?.decision,
      note: req.body?.note,
      actorId: req.user.userId,
    });
    res.json(result);
  } catch (err) {
    sendError(res, err, 'ADMIN BOARD APPROVAL ERROR:', 'Failed to update the approval');
  }
});

module.exports = router;
