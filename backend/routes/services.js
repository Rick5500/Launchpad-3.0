const express = require('express');
const auth = require('../auth');
const catalog = require('../serviceCatalog');
const { sendError } = require('../httpError');

const router = express.Router();

router.get('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await catalog.listServices(req.query));
  } catch (err) {
    sendError(res, err, 'SERVICES LIST ERROR:', 'Failed to load services');
  }
});

router.post('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const created = await catalog.createService(req.user.userId, req.body);
    res.status(201).json(created);
  } catch (err) {
    sendError(res, err, 'SERVICES CREATE ERROR:', 'Failed to create service');
  }
});

router.put('/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await catalog.updateService(req.user.userId, req.params.id, req.body));
  } catch (err) {
    sendError(res, err, 'SERVICES UPDATE ERROR:', 'Failed to update service');
  }
});

module.exports = router;
