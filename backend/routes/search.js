const express = require('express');
const auth = require('../auth');
const search = require('../orderSearch');
const { sendError } = require('../httpError');

const router = express.Router();

router.get('/orders', auth.requireAuth, auth.requireRole('admin', 'operator'), async (req, res) => {
  try {
    res.json(await search.searchOrders(req.query));
  } catch (err) {
    sendError(res, err, 'ORDER SEARCH ERROR:', 'Failed to search orders');
  }
});

module.exports = router;
