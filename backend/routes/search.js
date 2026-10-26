const express = require('express');
const auth = require('../auth');
const search = require('../orderSearch');
const shopLocations = require('../shopLocations');
const { sendError } = require('../httpError');

const router = express.Router();

router.get('/orders', auth.requireAuth, auth.requireRole('admin', 'manager', 'operator'), async (req, res) => {
  try {
    const access = await shopLocations.loadAccess(req.user.userId);
    res.json(await search.searchOrders(req.query, access));
  } catch (err) {
    sendError(res, err, 'ORDER SEARCH ERROR:', 'Failed to search orders');
  }
});

module.exports = router;
