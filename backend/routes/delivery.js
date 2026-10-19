const express = require('express');
const auth = require('../auth');
const db = require('../db');
const {
  DELIVERY_STATUSES,
  classifyDelivery,
  getRules,
  normalizeDueTime,
  publicRulesView,
  suggestDueTime,
} = require('../deliveryRules');

const router = express.Router();
const staffRoles = auth.requireRole('admin', 'manager', 'operator');
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_CARRIER_LENGTH = 120;
const MAX_EXTERNAL_ID_LENGTH = 255;
const TIMING_VALUES = ['overdue', 'due_today', 'due_soon', 'upcoming', 'complete', 'unscheduled'];

const deliverySelect = `
  SELECT
    d.id,
    d.work_order_id,
    d.will_call,
    d.due_time,
    d.carrier,
    d.status,
    d.created_at,
    d.updated_at,
    d.order_id,
    wo.external_id,
    wo.description,
    wo.customer_id,
    u.display_name AS customer_name,
    o.ups_account_number,
    o.delivery_method AS order_delivery_method
  FROM deliveries d
  LEFT JOIN work_orders wo ON d.work_order_id = wo.id
  LEFT JOIN users u ON wo.customer_id = u.id
  LEFT JOIN orders o ON o.id = COALESCE(d.order_id, wo.order_id)
`;

function parseLimit(value) {
  if (value == null || value === '') return { value: DEFAULT_LIMIT };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return { error: `limit must be an integer from 1 to ${MAX_LIMIT}` };
  }
  return { value: parsed };
}

function parseOffset(value) {
  if (value == null || value === '') return { value: 0 };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { error: 'offset must be an integer of 0 or greater' };
  }
  return { value: parsed };
}

function parsePositiveId(value, field) {
  if (value == null || value === '') return { value: null };
  const text = String(value).trim();
  if (!/^[1-9]\d*$/.test(text)) return { error: `${field} must be a positive integer` };
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return { error: `${field} must be a positive integer` };
  return { value: parsed };
}

function parseWillCall(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return { value: 1 };
  if (value === false || value === 0 || value === '0' || value === 'false') return { value: 0 };
  return { error: 'will_call must be true or false' };
}

function parseStatus(value) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'status must be pending, scheduled, out-for-delivery, or complete' };
  const status = value.trim().toLowerCase();
  if (!DELIVERY_STATUSES.includes(status)) {
    return { error: 'status must be pending, scheduled, out-for-delivery, or complete' };
  }
  return { value: status };
}

function parseCarrier(value) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'carrier must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > MAX_CARRIER_LENGTH) return { error: 'carrier is too long' };
  if (/[\u0000-\u001F]/.test(trimmed)) return { error: 'carrier contains invalid characters' };
  return { value: trimmed };
}

function parseExternalId(value) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'external_id must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > MAX_EXTERNAL_ID_LENGTH) return { error: 'external_id is too long' };
  if (/[\u0000-\u001F]/.test(trimmed)) return { error: 'external_id contains invalid characters' };
  return { value: trimmed };
}

function annotate(row, now = new Date(), rules = getRules()) {
  const flags = classifyDelivery(row, now, rules);
  return {
    id: row.id,
    work_order_id: row.work_order_id,
    external_id: row.external_id,
    description: row.description,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    will_call: row.will_call ? 1 : 0,
    due_time: row.due_time,
    carrier: row.carrier,
    delivery_method: row.order_delivery_method || row.carrier || null,
    ups_account_number: row.ups_account_number || null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    order_id: row.order_id || null,
    overdue: flags.overdue,
    due_today: flags.due_today,
    due_soon: flags.due_soon,
    timing: flags.timing,
  };
}

function customerClause(user, params) {
  if (user.role !== 'customer') return '';
  params.push(user.userId);
  return ' AND wo.customer_id = ?';
}

function loadDelivery(id, user, cb) {
  const params = [id];
  const scope = customerClause(user, params);
  db.get(`${deliverySelect} WHERE d.id = ?${scope}`, params, (err, row) => {
    if (err) return cb(err);
    if (!row) return cb(null, null);
    cb(null, annotate(row));
  });
}

function resolveWorkOrder(value, cb) {
  if (value.work_order_id && value.external_id) {
    db.get(
      'SELECT id, external_id, customer_id FROM work_orders WHERE id = ?',
      [value.work_order_id],
      (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null, { status: 404, error: 'Work order not found' });
        if (row.external_id !== value.external_id) {
          return cb(null, { status: 400, error: 'work_order_id does not match external_id' });
        }
        cb(null, { workOrder: row });
      }
    );
    return;
  }

  if (value.work_order_id) {
    db.get(
      'SELECT id, external_id, customer_id FROM work_orders WHERE id = ?',
      [value.work_order_id],
      (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null, { status: 404, error: 'Work order not found' });
        cb(null, { workOrder: row });
      }
    );
    return;
  }

  db.get(
    'SELECT id, external_id, customer_id FROM work_orders WHERE external_id = ? ORDER BY id ASC',
    [value.external_id],
    (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, { status: 404, error: 'Work order not found' });
      cb(null, { workOrder: row });
    }
  );
}

router.get('/rules', auth.requireAuth, (req, res) => {
  res.json(publicRulesView(new Date()));
});

router.get('/', auth.requireAuth, (req, res) => {
  const limit = parseLimit(req.query.limit);
  if (limit.error) return res.status(400).json({ error: limit.error });
  const offset = parseOffset(req.query.offset);
  if (offset.error) return res.status(400).json({ error: offset.error });

  const clauses = [];
  const params = [];
  if (req.user.role === 'customer') {
    clauses.push('wo.customer_id = ?');
    params.push(req.user.userId);
  }

  if (req.query.status != null && req.query.status !== '') {
    const status = parseStatus(req.query.status);
    if (status.error || !status.value) {
      return res.status(400).json({ error: status.error || 'status must be pending, scheduled, out-for-delivery, or complete' });
    }
    clauses.push('lower(d.status) = ?');
    params.push(status.value);
  }

  if (req.query.will_call != null && req.query.will_call !== '') {
    const willCall = parseWillCall(req.query.will_call);
    if (willCall.error) return res.status(400).json({ error: willCall.error });
    clauses.push('d.will_call = ?');
    params.push(willCall.value);
  }

  if (req.query.work_order_id != null && req.query.work_order_id !== '') {
    const workOrderId = parsePositiveId(req.query.work_order_id, 'work_order_id');
    if (workOrderId.error) return res.status(400).json({ error: workOrderId.error });
    clauses.push('d.work_order_id = ?');
    params.push(workOrderId.value);
  }

  let timing = null;
  if (req.query.timing != null && req.query.timing !== '') {
    timing = String(req.query.timing).trim();
    if (!TIMING_VALUES.includes(timing)) {
      return res.status(400).json({ error: 'timing must be overdue, due_today, due_soon, upcoming, complete, or unscheduled' });
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  db.all(
    `${deliverySelect}
     ${where}
     ORDER BY CASE WHEN d.due_time IS NULL OR d.due_time = '' THEN 1 ELSE 0 END,
              d.due_time ASC,
              d.id ASC`,
    params,
    (err, rows) => {
      if (err) {
        console.error('DELIVERY LIST ERROR:', err);
        return res.status(500).json({ error: 'Failed to load deliveries' });
      }

      const now = new Date();
      const rules = getRules();
      let deliveries = (rows || []).map((row) => annotate(row, now, rules));
      if (timing) deliveries = deliveries.filter((row) => row.timing === timing);
      const total = deliveries.length;
      res.json({
        deliveries: deliveries.slice(offset.value, offset.value + limit.value),
        total,
        limit: limit.value,
        offset: offset.value,
        evaluated_at: now.toISOString(),
      });
    }
  );
});

router.get('/:id', auth.requireAuth, (req, res) => {
  const id = parsePositiveId(req.params.id, 'id');
  if (id.error || !id.value) return res.status(400).json({ error: 'id must be a positive integer' });

  loadDelivery(id.value, req.user, (err, row) => {
    if (err) {
      console.error('DELIVERY DETAIL ERROR:', err);
      return res.status(500).json({ error: 'Failed to load delivery' });
    }
    if (!row) return res.status(404).json({ error: 'Delivery not found' });
    res.json(row);
  });
});

router.post('/', auth.requireAuth, staffRoles, (req, res) => {
  const body = req.body || {};
  const errors = [];
  const workOrderId = parsePositiveId(body.work_order_id, 'work_order_id');
  if (workOrderId.error) errors.push(workOrderId.error);
  const externalId = parseExternalId(body.external_id);
  if (externalId.error) errors.push(externalId.error);
  if (!workOrderId.value && !externalId.value) errors.push('work_order_id or external_id is required');

  const willCall = parseWillCall(body.will_call == null || body.will_call === '' ? false : body.will_call);
  if (willCall.error) errors.push(willCall.error);

  const hasDueTime = Object.prototype.hasOwnProperty.call(body, 'due_time') && body.due_time != null && body.due_time !== '';
  const dueTime = hasDueTime ? normalizeDueTime(body.due_time) : { value: null };
  if (dueTime.error) errors.push(dueTime.error);

  const carrier = parseCarrier(body.carrier);
  if (carrier.error) errors.push(carrier.error);

  const status = parseStatus(body.status == null || body.status === '' ? 'pending' : body.status);
  if (status.error || !status.value) errors.push(status.error || 'status must be pending, scheduled, out-for-delivery, or complete');

  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  resolveWorkOrder({ work_order_id: workOrderId.value, external_id: externalId.value }, (err, resolved) => {
    if (err) {
      console.error('DELIVERY CREATE ERROR:', err);
      return res.status(500).json({ error: 'Failed to create delivery' });
    }
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    const computedDue = hasDueTime ? dueTime.value : suggestDueTime(willCall.value === 1).dueTime;
    const storedCarrier = carrier.value || (willCall.value ? 'Will Call' : null);

    db.run(
      `INSERT INTO deliveries (work_order_id, will_call, due_time, carrier, status)
       VALUES (?,?,?,?,?)`,
      [resolved.workOrder.id, willCall.value, computedDue, storedCarrier, status.value],
      function onInsert(insertErr) {
        if (insertErr) {
          console.error('DELIVERY CREATE ERROR:', insertErr);
          return res.status(500).json({ error: 'Failed to create delivery' });
        }
        const newId = this.lastID;
        loadDelivery(newId, req.user, (loadErr, row) => {
          if (loadErr || !row) {
            if (loadErr) console.error('DELIVERY CREATE ERROR:', loadErr);
            return res.status(201).json({ id: newId });
          }
          res.status(201).json(row);
        });
      }
    );
  });
});

router.put('/:id', auth.requireAuth, staffRoles, (req, res) => {
  const id = parsePositiveId(req.params.id, 'id');
  if (id.error || !id.value) return res.status(400).json({ error: 'id must be a positive integer' });

  const body = req.body || {};
  const hasWillCall = Object.prototype.hasOwnProperty.call(body, 'will_call');
  const hasDueTime = Object.prototype.hasOwnProperty.call(body, 'due_time');
  const hasCarrier = Object.prototype.hasOwnProperty.call(body, 'carrier');
  const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
  if (!hasWillCall && !hasDueTime && !hasCarrier && !hasStatus) {
    return res.status(400).json({ error: 'No delivery fields to update' });
  }

  const errors = [];
  const willCall = hasWillCall ? parseWillCall(body.will_call) : { value: null };
  if (willCall.error) errors.push(willCall.error);
  const dueTime = hasDueTime ? normalizeDueTime(body.due_time) : { value: undefined };
  if (dueTime.error) errors.push(dueTime.error);
  const carrier = hasCarrier ? parseCarrier(body.carrier) : { value: undefined };
  if (carrier.error) errors.push(carrier.error);
  const status = hasStatus ? parseStatus(body.status) : { value: undefined };
  if (status.error) errors.push(status.error);
  if (hasStatus && !status.value) errors.push('status must be pending, scheduled, out-for-delivery, or complete');
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  db.get('SELECT id, will_call, due_time, carrier, status FROM deliveries WHERE id = ?', [id.value], (err, existing) => {
    if (err) {
      console.error('DELIVERY UPDATE ERROR:', err);
      return res.status(500).json({ error: 'Failed to update delivery' });
    }
    if (!existing) return res.status(404).json({ error: 'Delivery not found' });

    const nextWillCall = hasWillCall ? willCall.value : (existing.will_call ? 1 : 0);
    let nextCarrier = hasCarrier ? carrier.value : existing.carrier;
    if (nextWillCall && !nextCarrier) nextCarrier = 'Will Call';

    let nextDue = existing.due_time;
    if (hasDueTime) {
      nextDue = dueTime.value || suggestDueTime(nextWillCall === 1).dueTime;
    }
    const nextStatus = hasStatus ? status.value : existing.status;

    db.run(
      `UPDATE deliveries
       SET will_call = ?, due_time = ?, carrier = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [nextWillCall, nextDue, nextCarrier, nextStatus, id.value],
      function onUpdate(updateErr) {
        if (updateErr) {
          console.error('DELIVERY UPDATE ERROR:', updateErr);
          return res.status(500).json({ error: 'Failed to update delivery' });
        }
        loadDelivery(id.value, req.user, (loadErr, row) => {
          if (loadErr) {
            console.error('DELIVERY UPDATE ERROR:', loadErr);
            return res.status(500).json({ error: 'Failed to load updated delivery' });
          }
          if (!row) return res.status(404).json({ error: 'Delivery not found' });
          res.json(row);
        });
      }
    );
  });
});

module.exports = router;
