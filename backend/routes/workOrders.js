const express = require('express');
const auth = require('../auth');
const db = require('../db');
const { WORK_ORDER_STATUSES } = require('../statuses');
const barcodeEvents = require('../barcodeEvents');
const notifications = require('../notifications');
const router = express.Router();

const staffRoles = auth.requireRole('admin', 'operator');

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
  wo.created_at,
  wo.updated_at,
  wo.customer_id,
  u.display_name AS customer_name,
  u.username AS customer_username
`;

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

  return errors;
}
router.get('/', auth.requireAuth, (req, res) => {
  const params = [];
  let where = '';
  if (req.user.role === 'customer') {
    where = 'WHERE wo.customer_id = ?';
    params.push(req.user.userId);
  }

  db.all(
    `SELECT ${workOrderFieldList}
     FROM work_orders wo
     LEFT JOIN users u ON wo.customer_id = u.id
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
     LEFT JOIN users u ON wo.customer_id = u.id
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

      res.json(row);
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
    `SELECT id FROM work_orders WHERE id = ?${customerClause}`,
    params,
    (err, order) => {
      if (err) {
        console.error('WORK ORDER EVENTS ERROR:', err);
        return res.status(500).json({ error: 'Failed to load barcode events' });
      }
      if (!order) return res.status(404).json({ error: 'Work order not found' });

      barcodeEvents.listEvents({ ...parsed.value, workOrderId: id }, (listErr, result) => {
        if (listErr) {
          console.error('WORK ORDER EVENTS ERROR:', listErr);
          return res.status(500).json({ error: 'Failed to load barcode events' });
        }
        res.json(result);
      });
    }
  );
});

router.post('/', auth.requireAuth, staffRoles, (req, res) => {
  const payload = req.body || {};
  payload.status = normalizeWorkOrderStatus(payload.status);
  const errors = validateWorkOrder(payload);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const {
    external_id,
    customer_id,
    description,
    quantity,
    status,
    department,
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
      (external_id, customer_id, description, quantity, status, department, stage_id, priority, assigned_department_id, assigned_user_id, estimated_hours, actual_hours, specifications, start_date, due_date, production_line, routing_instructions, attachments, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    ],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to create work order' });
      }
      const newId = this.lastID;
      db.get(
        `SELECT ${workOrderFieldList}
         FROM work_orders wo
         LEFT JOIN users u ON wo.customer_id = u.id
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
    }
  );
});

router.put('/:id', auth.requireAuth, staffRoles, (req, res) => {
  const id = req.params.id;
  const payload = req.body || {};
  payload.status = normalizeWorkOrderStatus(payload.status);
  const errors = validateWorkOrder(payload);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const {
    external_id,
    customer_id,
    description,
    quantity,
    status,
    department,
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
    `SELECT id, status, priority, customer_id, external_id FROM work_orders WHERE id = ?`,
    [id],
    (lookupErr, previous) => {
      if (lookupErr) return res.status(500).json({ error: 'Failed to update work order' });
      if (!previous) return res.status(404).json({ error: 'Work order not found' });

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

          db.get(
            `SELECT ${workOrderFieldList}
             FROM work_orders wo
             LEFT JOIN users u ON wo.customer_id = u.id
             WHERE wo.id = ?`,
            [id],
            (err2, row) => {
              if (err2) return res.status(500).json({ error: 'Failed to load updated work order' });
              if (!row) return res.status(404).json({ error: 'Work order not found after update' });
              notifications.notifyWorkOrderUpdated(previous, row, (notifyErr) => {
                if (notifyErr) console.error('WORK ORDER NOTIFICATION ERROR:', notifyErr);
                res.json(row);
              });
            }
          );
        }
      );
    }
  );
});

router.put('/:id/stage', auth.requireAuth, staffRoles, (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });

  const stageId = parsePositiveInteger(req.body?.stage_id);
  if (!stageId) return res.status(400).json({ error: 'stage_id must be a positive integer' });

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
});

router.put('/:id/priority', auth.requireAuth, staffRoles, (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });

  const priority = String(req.body?.priority || 'Normal').trim();
  if (!['Low', 'Normal', 'High', 'Rush'].includes(priority)) {
    return res.status(400).json({ error: 'priority must be Low, Normal, High, or Rush' });
  }

  db.run(
    `UPDATE work_orders SET priority = ?, updated_at = datetime('now') WHERE id = ?`,
    [priority, id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to update work order priority' });
      if (this.changes === 0) return res.status(404).json({ error: 'Work order not found' });
      res.json({ success: true, id, priority });
    }
  );
});

module.exports = router;
