const express = require('express');
const auth = require('../auth');
const activityLog = require('../activityLog');
const shopLocations = require('../shopLocations');
const { sendError } = require('../httpError');

const router = express.Router();

router.get('/', auth.requireAuth, async (req, res) => {
  try {
    const includeInactive = req.user.role === 'admin' && String(req.query.all || '') === '1';
    res.json({ locations: await shopLocations.listLocations({ includeInactive }) });
  } catch (err) {
    sendError(res, err, 'LOCATIONS LIST ERROR:', 'Unable to load locations');
  }
});

router.post('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const location = await shopLocations.createLocation(req.body || {});
    await activityLog.record(req.user.userId, 'location.created', 'location', location.id, {
      name: location.name,
      message: `Added location ${location.name}`,
    });
    res.status(201).json(location);
  } catch (err) {
    sendError(res, err, 'LOCATION CREATE ERROR:', 'Unable to add the location');
  }
});

router.put('/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const location = await shopLocations.updateLocation(req.params.id, req.body || {});
    await activityLog.record(req.user.userId, 'location.updated', 'location', location.id, {
      name: location.name,
      is_active: location.is_active,
      message: `Updated location ${location.name}`,
    });
    res.json(location);
  } catch (err) {
    sendError(res, err, 'LOCATION UPDATE ERROR:', 'Unable to update the location');
  }
});

module.exports = router;
