const express = require('express');
const auth = require('../auth');
const db = require('../db');
const { WORK_ORDER_STATUSES } = require('../statuses');
const barcodeEvents = require('../barcodeEvents');
const users = require('../userAdmin');
const { loadWorkOrderContext } = require('../orderService');
const { printForWorkOrder } = require('../printWorkOrder');
const proofs = require('../proofs');
const { isPrintableBarcode } = require('../barcodeSvg');
const notifications = require('../notifications');
const activityLog = require('../activityLog');
const shopLocations = require('../shopLocations');
const router = express.Router();

const staffRoles = auth.requireRole('admin', 'manager', 'operator');

function parsePositiveInteger(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) return null;
    return value;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function normalizeWorkOrderStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'complete') return 'completed';
  return normalized;
}

const workOrderFieldList = `
  wo.id,
  wo.external_id,
  wo.description,
  wo.quantity,
  wo.status,
  wo.department,
  wo.stage_id,
  wo.priority,
  wo.assigned_department_id,
  wo.assigned_user_id,
  wo.estimated_hours,
  wo.actual_hours,
  wo.specifications,
  wo.start_date,
  wo.due_date,
  wo.production_line,
  wo.routing_instructions,
  wo.attachments,
  wo.notes,
  wo.order_id,
  wo.service_id,
  wo.next_department,
  wo.requires_approval,
  wo.approval_status,
  wo.proof_status,
  wo.created_at,
  wo.updated_at,
  wo.customer_id,
  wo.location_id,
  o.location_id AS order_location_id,
  l.name AS location_name,
  u.display_name AS customer_name,
  u.username AS customer_username,
  o.order_number,
  o.notes AS order_notes,
  o.project_name,
  o.delivery_method,
  o.ups_account_number,
  o.originals_source,
  o.address_line1,
  o.address_line2,
  o.city,
  o.state,
  o.zip,
  o.payment_method,
  o.return_to,
  o.bill_to_name,
  o.bill_to_phone,
  o.bill_to_email,
  o.bill_to_company,
  o.bill_to_address_line1,
  o.bill_to_address_line2,
  o.bill_to_city,
  o.bill_to_state,
  o.bill_to_zip,
  s.name AS service_name
`;

const workOrderJoins = `
  LEFT JOIN users u ON wo.customer_id = u.id
  LEFT JOIN orders o ON o.id = wo.order_id
  LEFT JOIN locations l ON l.id = COALESCE(wo.location_id, o.location_id)
  LEFT JOIN services s ON s.id = wo.service_id
`;

function recordLocationId(row) {
  if (!row) return null;
  return row.location_id != null ? row.location_id : row.order_location_id;
}

async function staffSeesWorkOrder(user, locationId) {
  if (!user || user.role === 'customer') return true;
  const access = await shopLocations.loadAccess(user.userId);
  return shopLocations.matches(access, locationId);
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalDepartment(name, cb) {
  const text = String(name || '').trim();
  if (!text) return cb(null, text);
  db.get(
    `SELECT name FROM departments
     WHERE lower(trim(name)) = lower(?)
     ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, id
     LIMIT 1`,
    [text, text],
    (err, row) => {
      if (err) return cb(err);
      cb(null, row ? row.name : text);
    }
  );
}

function validateWorkOrder(data) {
  const errors = [];
  const customerId = Number(data.customer_id);

  if (!customerId || !Number.isInteger(customerId) || customerId <= 0) {
    errors.push('customer_id is required');
  }
  if (!data.description || !String(data.description).trim()) {
    errors.push('description is required');
  }
  if (data.quantity == null || Number.isNaN(Number(data.quantity))) {
    errors.push('quantity is required');
  } else if (Number(data.quantity) < 0) {
    errors.push('quantity must be 0 or greater');
  }
  if (!WORK_ORDER_STATUSES.includes(normalizeWorkOrderStatus(data.status))) {
    errors.push('status must be open, in-progress, completed, or on-hold');
  }
  if (!data.department || !String(data.department).trim()) {
    errors.push('department is required');
  }
  if (data.priority && !['Low', 'Normal', 'High', 'Rush'].includes(String(data.priority))) {
    errors.push('priority must be Low, Normal, High, or Rush');
  }
  if (data.external_id != null && String(data.external_id).trim() !== '' && !isPrintableBarcode(data.external_id)) {
    errors.push('external_id must be 1 to 80 printable ASCII characters');
  }

  return errors;
}
router.get('/', auth.requireAuth, async (req, res) => {
  const params = [];
  const clauses = [];
  try {
    if (req.user.role === 'customer') {
      clauses.push('wo.customer_id = ?');
      params.push(req.user.userId);
    } else {
      const access = await shopLocations.loadAccess(req.user.userId);
      const pred = shopLocations.predicate('COALESCE(wo.location_id, o.location_id)', access);
      if (pred.sql) {
        clauses.push(pred.sql);
        params.push(...pred.params);
      }
      const chosen = await shopLocations.boardFilter(access, req.query);
      const extra = shopLocations.filterSql('COALESCE(wo.location_id, o.location_id)', chosen);
      if (extra.sql) {
        clauses.push(extra.sql.replace(/^\s*AND\s+/, ''));
        params.push(...extra.params);
      }
    }
  } catch (err) {
    console.error('WORK ORDER LIST ERROR:', err);
    return res.status(err.status || 500).json({ error: err.publicMessage || err.message || 'Failed to load work orders' });
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  db.all(
    `SELECT ${workOrderFieldList}
     FROM work_orders wo
     ${workOrderJoins}
     ${where}
     ORDER BY wo.created_at DESC`,
    params,
    (err, rows) => {
      if (err) {
        console.error('WORK ORDER LIST ERROR:', err);
        return res.status(500).json({ error: 'Failed to load work orders' });
      }

      res.json(rows);
    }
  );
});

router.get('/:id/print', auth.requireAuth, async (req, res) => {
  try {
    const payload = await printForWorkOrder(req.user, req.params.id);
    if (!payload) return res.status(404).json({ error: 'Work order not found' });
    res.json(payload);
  } catch (err) {
    if (err && err.status && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('WORK ORDER PRINT ERROR:', err);
    return res.status(500).json({ error: 'Failed to load work order' });
  }
});

router.get('/:id', auth.requireAuth, (req, res) => {
  const params = [req.params.id];
  let customerClause = '';
  if (req.user.role === 'customer') {
    customerClause = ' AND wo.customer_id = ?';
    params.push(req.user.userId);
  }

  db.get(
    `SELECT ${workOrderFieldList}
     FROM work_orders wo
     ${workOrderJoins}
     WHERE wo.id = ?${customerClause}`,
    params,
    (err, row) => {
      if (err) {
        console.error('WORK ORDER DETAIL ERROR:', err);
        return res.status(500).json({ error: 'Failed to load work order' });
      }

      if (!row) {
        return res.status(404).json({ error: 'Work order not found' });
      }

      staffSeesWorkOrder(req.user, recordLocationId(row)).then((allowed) => {
        if (!allowed) return res.status(404).json({ error: 'Work order not found' });
      loadWorkOrderContext(row, req.user)
        .then((detailed) => proofs.presentForWorkOrder(detailed.id, detailed.order_id)
          .then((proof) => res.json({ ...detailed, ...proof })))
        .catch((contextErr) => {
          console.error('WORK ORDER DETAIL ERROR:', contextErr);
          return res.status(500).json({ error: 'Failed to load work order' });
        });
      }).catch((guardErr) => {
        console.error('WORK ORDER DETAIL ERROR:', guardErr);
        return res.status(500).json({ error: 'Failed to load work order' });
      });
    }
  );
});

router.get('/:id/events', auth.requireAuth, (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });

  const parsed = barcodeEvents.parseListQuery(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const params = [id];
  let customerClause = '';
  if (req.user.role === 'customer') {
    customerClause = ' AND customer_id = ?';
    params.push(req.user.userId);
  }

  db.get(
    `SELECT wo.id, wo.location_id, o.location_id AS order_location_id
     FROM work_orders wo
     LEFT JOIN orders o ON o.id = wo.order_id
     WHERE wo.id = ?${customerClause.replace('customer_id', 'wo.customer_id')}`,
    params,
    (err, order) => {
      if (err) {
        console.error('WORK ORDER EVENTS ERROR:', err);
        return res.status(500).json({ error: 'Failed to load barcode events' });
      }
      if (!order) return res.status(404).json({ error: 'Work order not found' });

      staffSeesWorkOrder(req.user, recordLocationId(order)).then((allowed) => {
        if (!allowed) return res.status(404).json({ error: 'Work order not found' });
      barcodeEvents.listEvents({ ...parsed.value, workOrderId: id }, (listErr, result) => {
        if (listErr) {
          console.error('WORK ORDER EVENTS ERROR:', listErr);
          return res.status(500).json({ error: 'Failed to load barcode events' });
        }
        res.json(result);
      });
      }).catch((guardErr) => {
        console.error('WORK ORDER EVENTS ERROR:', guardErr);
        return res.status(500).json({ error: 'Failed to load barcode events' });
      });
    }
  );
});

router.post('/', auth.requireAuth, staffRoles, (req, res) => {
  const payload = req.body || {};
  payload.status = normalizeWorkOrderStatus(payload.status);
  const errors = validateWorkOrder(payload);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  canonicalDepartment(payload.department, (canonErr, department) => {
    if (canonErr) return res.status(500).json({ error: 'Failed to create work order' });
    insertWorkOrder(department);
  });

  async function insertWorkOrder(department) {
  let locationId = null;
  try {
    const resolved = await shopLocations.resolveOrderLocation(
      null,
      req.user,
      payload.location_id,
      Number(payload.customer_id)
    );
    locationId = resolved.value;
  } catch (err) {
    const status = err.status && err.status < 500 ? err.status : 500;
    return res.status(status).json({ error: err.publicMessage || err.message || 'Failed to create work order' });
  }
  const {
    external_id,
    customer_id,
    description,
    quantity,
    status,
    stage_id,
    priority,
    assigned_department_id,
    assigned_user_id,
    estimated_hours,
    actual_hours,
    specifications,
    start_date,
    due_date,
    production_line,
    routing_instructions,
    attachments,
    notes,
  } = payload;

  db.run(
    `INSERT INTO work_orders
      (external_id, customer_id, description, quantity, status, department, stage_id, priority, assigned_department_id, assigned_user_id, estimated_hours, actual_hours, specifications, start_date, due_date, production_line, routing_instructions, attachments, notes, location_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      external_id || null,
      Number(customer_id),
      description,
      Number(quantity),
      status,
      department,
      parseOptionalNumber(stage_id),
      priority || 'Normal',
      parseOptionalNumber(assigned_department_id),
      parseOptionalNumber(assigned_user_id),
      parseOptionalNumber(estimated_hours),
      parseOptionalNumber(actual_hours),
      specifications || null,
      start_date || null,
      due_date || null,
      production_line || null,
      routing_instructions || null,
      attachments || null,
      notes || null,
      locationId,
    ],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to create work order' });
      }
      const newId = this.lastID;
      const entries = [
        activityLog.createdEntry({
          actorId: req.user.userId,
          workOrderId: newId,
          externalId: external_id || null,
          department,
        }),
        ...activityLog.transitionEntries({
          actorId: req.user.userId,
          previous: { id: newId, status: 'open', department, external_id: external_id || null },
          next: { id: newId, status, department, external_id: external_id || null },
        }),
      ];
      activityLog.insertEntries(db, entries, (activityErr) => {
        if (activityErr) console.error('WORK ORDER ACTIVITY ERROR:', activityErr);
        db.get(
          `SELECT ${workOrderFieldList}
           FROM work_orders wo
           ${workOrderJoins}
           WHERE wo.id = ?`,
          [newId],
          (err2, row) => {
            const created = row || {
              id: newId,
              status,
              priority: priority || 'Normal',
              customer_id: Number(customer_id),
              external_id: external_id || null,
            };
            notifications.notifyWorkOrderCreated(created, (notifyErr) => {
              if (notifyErr) console.error('WORK ORDER NOTIFICATION ERROR:', notifyErr);
              if (err2) return res.status(201).json({ id: newId });
              res.status(201).json(row || { id: newId });
            });
          }
        );
      });
    }
  );
  }
});

router.put('/:id', auth.requireAuth, staffRoles, (req, res) => {
  const id = req.params.id;
  const payload = req.body || {};
  payload.status = normalizeWorkOrderStatus(payload.status);
  const errors = validateWorkOrder(payload);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  canonicalDepartment(payload.department, (canonErr, department) => {
    if (canonErr) return res.status(500).json({ error: 'Failed to update work order' });
    updateWorkOrder(department);
  });

  function updateWorkOrder(department) {
  const {
    external_id,
    customer_id,
    description,
    quantity,
    status,
    stage_id,
    priority,
    assigned_department_id,
    assigned_user_id,
    estimated_hours,
    actual_hours,
    specifications,
    start_date,
    due_date,
    production_line,
    routing_instructions,
    attachments,
    notes,
  } = payload;

  db.get(
    `SELECT id, status, priority, customer_id, external_id, department, location_id FROM work_orders WHERE id = ?`,
    [id],
    (lookupErr, previous) => {
      if (lookupErr) return res.status(500).json({ error: 'Failed to update work order' });
      if (!previous) return res.status(404).json({ error: 'Work order not found' });
      staffSeesWorkOrder(req.user, previous.location_id).then((allowed) => {
        if (!allowed) return res.status(404).json({ error: 'Work order not found' });

      db.run(
        `UPDATE work_orders SET
          external_id = ?,
          customer_id = ?,
          description = ?,
          quantity = ?,
          status = ?,
          department = ?,
          stage_id = ?,
          priority = ?,
          assigned_department_id = ?,
          assigned_user_id = ?,
          estimated_hours = ?,
          actual_hours = ?,
          specifications = ?,
          start_date = ?,
          due_date = ?,
          production_line = ?,
          routing_instructions = ?,
          attachments = ?,
          notes = ?,
          updated_at = datetime('now')
         WHERE id = ?`,
        [
          external_id || null,
          Number(customer_id),
          description,
          Number(quantity),
          status,
          department,
          parseOptionalNumber(stage_id),
          priority || 'Normal',
          parseOptionalNumber(assigned_department_id),
          parseOptionalNumber(assigned_user_id),
          parseOptionalNumber(estimated_hours),
          parseOptionalNumber(actual_hours),
          specifications || null,
          start_date || null,
          due_date || null,
          production_line || null,
          routing_instructions || null,
          attachments || null,
          notes || null,
          id,
        ],
        function (err) {
          if (err) return res.status(500).json({ error: 'Failed to update work order' });
          if (this.changes === 0) return res.status(404).json({ error: 'Work order not found' });

          const loadUpdated = () => db.get(
            `SELECT ${workOrderFieldList}
             FROM work_orders wo
             ${workOrderJoins}
             WHERE wo.id = ?`,
            [id],
            (err2, row) => {
              if (err2) return res.status(500).json({ error: 'Failed to load updated work order' });
              if (!row) return res.status(404).json({ error: 'Work order not found after update' });
              const entries = activityLog.transitionEntries({
                actorId: req.user.userId,
                previous,
                next: row,
              });
              activityLog.insertEntries(db, entries, (activityErr) => {
                if (activityErr) console.error('WORK ORDER ACTIVITY ERROR:', activityErr);
                notifications.notifyWorkOrderUpdated(previous, row, (notifyErr) => {
                  if (notifyErr) console.error('WORK ORDER NOTIFICATION ERROR:', notifyErr);
                  res.json(row);
                });
              });
            }
          );

          const departmentChanged = String(previous.department || '').trim() !== department;
          if (!departmentChanged) return loadUpdated();

          db.get(
            `SELECT id, next_department FROM departments WHERE lower(name) = lower(?)`,
            [department],
            (routeErr, route) => {
              if (routeErr) console.error('WORK ORDER ROUTE ERROR:', routeErr);
              if (routeErr || !route) return loadUpdated();
              db.run(
                `UPDATE work_orders SET assigned_department_id = ?, next_department = ? WHERE id = ?`,
                [route.id, route.next_department || null, id],
                (routeUpdateErr) => {
                  if (routeUpdateErr) console.error('WORK ORDER ROUTE ERROR:', routeUpdateErr);
                  loadUpdated();
                }
              );
            }
          );
        }
      );
      }).catch((guardErr) => {
        console.error('WORK ORDER UPDATE ERROR:', guardErr);
        return res.status(500).json({ error: 'Failed to update work order' });
      });
    }
  );
  }
});

router.post('/:id/move', auth.requireAuth, auth.requireRole('admin', 'manager'), async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });
  const parsed = barcodeEvents.parseManualMove(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  try {
    const access = await users.loadAccess(req.user.userId);
    if (access.role !== 'admin' && access.role !== 'manager') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const located = await new Promise((resolve, reject) => {
      db.get(
        `SELECT wo.location_id, o.location_id AS order_location_id
         FROM work_orders wo LEFT JOIN orders o ON o.id = wo.order_id WHERE wo.id = ?`,
        [id],
        (err, row) => (err ? reject(err) : resolve(row || null))
      );
    });
    if (!located || !shopLocations.matches(access, recordLocationId(located))) {
      return res.status(404).json({ error: 'Work order not found' });
    }
    const result = await barcodeEvents.moveWorkOrder({
      workOrderId: id,
      department: parsed.department,
      note: parsed.note,
      actorId: req.user.userId,
    });
    res.json(result);
  } catch (err) {
    if (err && err.status && err.publicMessage) {
      return res.status(err.status).json({ error: err.publicMessage });
    }
    console.error('WORK ORDER MOVE ERROR:', err);
    return res.status(500).json({ error: 'Failed to move work order' });
  }
});

router.put('/:id/stage', auth.requireAuth, staffRoles, (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });

  const stageId = parsePositiveInteger(req.body?.stage_id);
  if (!stageId) return res.status(400).json({ error: 'stage_id must be a positive integer' });

  db.get(
    `SELECT wo.location_id, o.location_id AS order_location_id
     FROM work_orders wo LEFT JOIN orders o ON o.id = wo.order_id WHERE wo.id = ?`,
    [id],
    (locateErr, located) => {
      if (locateErr) return res.status(500).json({ error: 'Failed to update work order stage' });
      if (!located) return res.status(404).json({ error: 'Work order not found' });
      staffSeesWorkOrder(req.user, recordLocationId(located)).then((allowed) => {
        if (!allowed) return res.status(404).json({ error: 'Work order not found' });
  db.get('SELECT id FROM production_stages WHERE id = ?', [stageId], (err, stage) => {
    if (err) {
      console.error('WORK ORDER STAGE ERROR:', err);
      return res.status(500).json({ error: 'Failed to update work order stage' });
    }
    if (!stage) return res.status(400).json({ error: 'stage_id is not a valid production stage' });

    db.run(
      `UPDATE work_orders SET stage_id = ?, updated_at = datetime('now') WHERE id = ?`,
      [stageId, id],
      function (updateErr) {
        if (updateErr) {
          console.error('WORK ORDER STAGE ERROR:', updateErr);
          return res.status(500).json({ error: 'Failed to update work order stage' });
        }
        if (this.changes === 0) return res.status(404).json({ error: 'Work order not found' });
        res.json({ success: true, id, stage_id: stageId });
      }
    );
  });
      }).catch((guardErr) => {
        console.error('WORK ORDER STAGE ERROR:', guardErr);
        return res.status(500).json({ error: 'Failed to update work order stage' });
      });
    }
  );
});

router.put('/:id/priority', auth.requireAuth, staffRoles, (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });

  const priority = String(req.body?.priority || 'Normal').trim();
  if (!['Low', 'Normal', 'High', 'Rush'].includes(priority)) {
    return res.status(400).json({ error: 'priority must be Low, Normal, High, or Rush' });
  }

  db.get(
    `SELECT wo.location_id, o.location_id AS order_location_id
     FROM work_orders wo LEFT JOIN orders o ON o.id = wo.order_id WHERE wo.id = ?`,
    [id],
    (locateErr, located) => {
      if (locateErr) return res.status(500).json({ error: 'Failed to update work order priority' });
      if (!located) return res.status(404).json({ error: 'Work order not found' });
      staffSeesWorkOrder(req.user, recordLocationId(located)).then((allowed) => {
        if (!allowed) return res.status(404).json({ error: 'Work order not found' });
  db.run(
    `UPDATE work_orders SET priority = ?, updated_at = datetime('now') WHERE id = ?`,
    [priority, id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to update work order priority' });
      if (this.changes === 0) return res.status(404).json({ error: 'Work order not found' });
      res.json({ success: true, id, priority });
    }
  );
      }).catch((guardErr) => {
        console.error('WORK ORDER PRIORITY ERROR:', guardErr);
        return res.status(500).json({ error: 'Failed to update work order priority' });
      });
    }
  );
});

module.exports = router;
