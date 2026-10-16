const express = require('express');
const auth = require('../auth');
const catalog = require('../serviceCatalog');
const serviceFields = require('../serviceFields');
const { get } = require('../dbAsync');
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

router.get('/:id/fields', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const serviceId = Number(req.params.id);
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    const service = await get('SELECT id, name FROM services WHERE id = ?', [serviceId]);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const fields = await serviceFields.listServiceFields(serviceId, true);
    res.json({ service_id: service.id, name: service.name, fields });
  } catch (err) {
    sendError(res, err, 'SERVICE FIELDS ERROR:', 'Failed to load service fields');
  }
});

router.put('/:id/fields', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await serviceFields.replaceServiceFields(req.user.userId, req.params.id, req.body));
  } catch (err) {
    sendError(res, err, 'SERVICE FIELDS UPDATE ERROR:', 'Failed to update service fields');
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
