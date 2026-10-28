const express = require('express');
const auth = require('../auth');
const pickupRequests = require('../pickupRequests');
const { sendError } = require('../httpError');

const router = express.Router();

router.get('/', auth.requireAuth, async (req, res) => {
  try {
    res.json(await pickupRequests.list(req.user, req.query));
  } catch (err) {
    sendError(res, err, 'PICKUP LIST ERROR:', 'Unable to load pickup requests');
  }
});

router.post('/', auth.requireAuth, async (req, res) => {
  try {
    const created = await pickupRequests.createForCustomer(req.user, req.body);
    res.status(201).json(created);
  } catch (err) {
    sendError(res, err, 'PICKUP CREATE ERROR:', 'Unable to request a pickup');
  }
});

router.get('/:id', auth.requireAuth, async (req, res) => {
  try {
    res.json(await pickupRequests.getOne(req.user, req.params.id));
  } catch (err) {
    sendError(res, err, 'PICKUP GET ERROR:', 'Unable to load that pickup request');
  }
});

router.put('/:id', auth.requireAuth, async (req, res) => {
  try {
    res.json(await pickupRequests.updateStatus(req.user, req.params.id, req.body || {}));
  } catch (err) {
    sendError(res, err, 'PICKUP UPDATE ERROR:', 'Unable to update that pickup request');
  }
});

module.exports = router;
