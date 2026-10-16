const express = require('express');
const auth = require('../auth');
const locations = require('../barcodeLocations');
const { sendError } = require('../httpError');

const router = express.Router();
const staff = auth.requireRole('admin', 'operator');

router.get('/', auth.requireAuth, staff, async (req, res) => {
  try {
    res.json({ locations: await locations.listLocations() });
  } catch (err) {
    sendError(res, err, 'BARCODE LOCATIONS ERROR:', 'Failed to load barcode locations');
  }
});

router.post('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const created = await locations.createLocation(req.user.userId, req.body);
    res.status(201).json(created);
  } catch (err) {
    sendError(res, err, 'BARCODE LOCATIONS ERROR:', 'Failed to create barcode location');
  }
});

router.put('/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await locations.updateLocation(req.user.userId, req.params.id, req.body));
  } catch (err) {
    sendError(res, err, 'BARCODE LOCATIONS ERROR:', 'Failed to update barcode location');
  }
});

router.delete('/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await locations.removeLocation(req.user.userId, req.params.id));
  } catch (err) {
    sendError(res, err, 'BARCODE LOCATIONS ERROR:', 'Failed to remove barcode location');
  }
});

module.exports = router;
