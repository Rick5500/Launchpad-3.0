const express = require('express');
const auth = require('../auth');
const barcodeEvents = require('../barcodeEvents');
const { createFixedWindowLimiter } = require('../rateLimit');

const router = express.Router();
const staffRoles = auth.requireRole('admin', 'operator');

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

router.get('/config', auth.requireAuth, staffRoles, (req, res) => {
  res.json({
    locationStages: barcodeEvents.locationStageEntries(),
    rateLimit: {
      max: rateSettings.max,
      windowSeconds: rateSettings.windowSeconds,
    },
  });
});

router.get('/events', auth.requireAuth, staffRoles, (req, res) => {
  const parsed = barcodeEvents.parseListQuery(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  barcodeEvents.listEvents(parsed.value, (err, result) => {
    if (err) return sendServiceError(res, err, 'BARCODE LIST ERROR:', 'Failed to load barcode events');
    res.json(result);
  });
});

router.post('/', auth.requireAuth, staffRoles, limitBarcodeScans, (req, res) => {
  const body = req.body || {};
  const scanned = parseOptionalText(body.scanned_value, 'scanned_value', barcodeEvents.MAX_SCANNED_VALUE_LENGTH);
  if (scanned.error) return res.status(400).json({ error: scanned.error });
  if (!scanned.value) return res.status(400).json({ error: 'scanned_value is required' });

  const location = parseOptionalText(body.location, 'location', barcodeEvents.MAX_LOCATION_LENGTH);
  if (location.error) return res.status(400).json({ error: location.error });

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

  barcodeEvents.resolveWorkOrder(scanned.value, (resolveErr, workOrder) => {
    if (resolveErr) return sendServiceError(res, resolveErr, 'BARCODE CREATE ERROR:', 'Failed to record barcode event');
    if (!workOrder) return res.status(404).json({ error: 'Work order not found' });
    if (requestedWorkOrderId && requestedWorkOrderId !== workOrder.id) {
      return res.status(400).json({ error: 'work_order_id does not match the scanned work order' });
    }

    barcodeEvents.recordScan({
      scannedValue: scanned.value,
      location: location.value,
      eventTime: eventTime.value,
      operatorId: req.user.userId,
    }, (err, event) => {
      if (err) return sendServiceError(res, err, 'BARCODE CREATE ERROR:', 'Failed to record barcode event');
      res.status(201).json(event);
    });
  });
});

module.exports = router;
