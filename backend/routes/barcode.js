const express = require('express');
const auth = require('../auth');
const barcodeEvents = require('../barcodeEvents');
const barcodeLocations = require('../barcodeLocations');
const users = require('../userAdmin');
const shopLocations = require('../shopLocations');
const { createFixedWindowLimiter } = require('../rateLimit');

const router = express.Router();
const staffRoles = auth.requireRole('admin', 'manager', 'operator');

function positiveIntEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const rateSettings = {
  max: positiveIntEnv('BARCODE_RATE_LIMIT_MAX', 60),
  windowSeconds: positiveIntEnv('BARCODE_RATE_LIMIT_WINDOW_SECONDS', 60),
};

const scanLimiter = createFixedWindowLimiter({
  windowMs: rateSettings.windowSeconds * 1000,
  max: rateSettings.max,
});

function sendServiceError(res, err, logLabel, fallback) {
  if (err && err.status && err.publicMessage) {
    return res.status(err.status).json({ error: err.publicMessage });
  }
  console.error(logLabel, err);
  return res.status(500).json({ error: fallback });
}

function limitBarcodeScans(req, res, next) {
  const result = scanLimiter.check(String(req.user.userId));
  if (!result.allowed) {
    res.set('Retry-After', String(result.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many barcode scans. Try again later.' });
  }
  next();
}

function parseOptionalText(value, field, maxLength) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > maxLength) return { error: `${field} is too long` };
  if (/[\u0000-\u001F]/.test(trimmed)) return { error: `${field} contains invalid characters` };
  return { value: trimmed };
}

router.use('/locations', require('./barcodeLocations'));

router.get('/config', auth.requireAuth, staffRoles, (req, res) => {
  const payload = {
    locationStages: barcodeEvents.locationStageEntries(),
    locations: [],
    rateLimit: {
      max: rateSettings.max,
      windowSeconds: rateSettings.windowSeconds,
    },
  };
  barcodeLocations.listLocations()
    .then((rows) => {
      payload.locations = rows.filter((row) => row.is_active);
      res.json(payload);
    })
    .catch((err) => {
      console.error('BARCODE CONFIG ERROR:', err);
      res.json(payload);
    });
});

router.post('/dry-run', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const body = req.body || {};
  const scanned = parseOptionalText(body.scanned_value, 'scanned_value', barcodeEvents.MAX_SCANNED_VALUE_LENGTH);
  if (scanned.error) return res.status(400).json({ error: scanned.error });
  if (!scanned.value) return res.status(400).json({ error: 'scanned_value is required' });
  const location = parseOptionalText(body.location, 'location', barcodeEvents.MAX_LOCATION_LENGTH);
  if (location.error) return res.status(400).json({ error: location.error });
  barcodeEvents.previewScan({
    scannedValue: scanned.value,
    location: location.value,
  }, (err, result) => {
    if (err) return sendServiceError(res, err, 'BARCODE DRY RUN ERROR:', 'Failed to resolve scan');
    res.json(result);
  });
});

router.get('/events', auth.requireAuth, staffRoles, async (req, res) => {
  const parsed = barcodeEvents.parseListQuery(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const access = await users.loadAccess(req.user.userId);
    if (access.role === 'operator' && access.department) {
      parsed.value.departmentLock = access.department;
    }
    const shop = await shopLocations.boardFilter(access, req.query);
    if (shop.locationId != null) {
      parsed.value.shopLocationId = shop.locationId;
      parsed.value.shopLocationNull = shop.includeNull;
    }
  } catch (err) {
    return sendServiceError(res, err, 'BARCODE LIST ERROR:', 'Failed to load barcode events');
  }

  barcodeEvents.listEvents(parsed.value, (err, result) => {
    if (err) return sendServiceError(res, err, 'BARCODE LIST ERROR:', 'Failed to load barcode events');
    res.json(result);
  });
});

router.post('/', auth.requireAuth, staffRoles, limitBarcodeScans, async (req, res) => {
  const body = req.body || {};
  const scanned = parseOptionalText(body.scanned_value, 'scanned_value', barcodeEvents.MAX_SCANNED_VALUE_LENGTH);
  if (scanned.error) return res.status(400).json({ error: scanned.error });
  if (!scanned.value) return res.status(400).json({ error: 'scanned_value is required' });

  const location = parseOptionalText(body.location, 'location', barcodeEvents.MAX_LOCATION_LENGTH);
  if (location.error) return res.status(400).json({ error: location.error });
  let scanLocation = location.value;
  try {
    const access = await users.loadAccess(req.user.userId);
    if (access.role !== 'manager' && access.department) scanLocation = access.department;
  } catch (err) {
    return sendServiceError(res, err, 'BARCODE CREATE ERROR:', 'Failed to record barcode event');
  }

  const eventTime = barcodeEvents.parseEventTime(body.event_time);
  if (eventTime.error) return res.status(400).json({ error: eventTime.error });

  if (body.operator_id != null && body.operator_id !== '') {
    const operatorText = String(body.operator_id).trim();
    if (!/^[1-9]\d*$/.test(operatorText) || Number(operatorText) !== req.user.userId) {
      return res.status(400).json({ error: 'operator_id does not match the signed-in user' });
    }
  }

  let requestedWorkOrderId = null;
  if (body.work_order_id != null && body.work_order_id !== '') {
    const text = String(body.work_order_id).trim();
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
      return res.status(400).json({ error: 'work_order_id must be a positive integer' });
    }
    requestedWorkOrderId = Number(text);
  }

  barcodeEvents.resolveWorkOrder(scanned.value, async (resolveErr, workOrder) => {
    if (resolveErr) return sendServiceError(res, resolveErr, 'BARCODE CREATE ERROR:', 'Failed to record barcode event');
    if (!workOrder) return res.status(404).json({ error: 'Work order not found' });
    try {
      const access = await shopLocations.loadAccess(req.user.userId);
      shopLocations.assertVisible(access, workOrder.location_id, 'Work order not found');
    } catch (guardErr) {
      if (guardErr && guardErr.status) {
        return res.status(guardErr.status).json({ error: guardErr.publicMessage || guardErr.message });
      }
      return sendServiceError(res, guardErr, 'BARCODE CREATE ERROR:', 'Failed to record barcode event');
    }
    if (requestedWorkOrderId && requestedWorkOrderId !== workOrder.id) {
      return res.status(400).json({ error: 'work_order_id does not match the scanned work order' });
    }

    barcodeEvents.recordScan({
      scannedValue: scanned.value,
      location: scanLocation,
      eventTime: eventTime.value,
      operatorId: req.user.userId,
    }, (err, event) => {
      if (err) return sendServiceError(res, err, 'BARCODE CREATE ERROR:', 'Failed to record barcode event');
      res.status(201).json(event);
    });
  });
});

module.exports = router;
