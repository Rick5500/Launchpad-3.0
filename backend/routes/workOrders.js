const express = require('express');
const auth = require('../auth');
const db = require('../db');
const router = express.Router();

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

// Helper: Get work order line items with product info and required departments
function getWorkOrderLineItems(workOrderId, callback) {
  db.all(
    `SELECT 
      woli.id, woli.work_order_id, woli.product_id, woli.description, woli.quantity, woli.notes,
      p.name as product_name, p.category_id, pc.name as category_name,
      p.proof_required, p.qc_required, p.barcode_required, p.default_turnaround_hours,
      prd.id as dept_id, prd.department_id, d.name as department_name, d.color, d.icon
     FROM work_order_line_items woli
     LEFT JOIN products p ON woli.product_id = p.id
     LEFT JOIN product_categories pc ON p.category_id = pc.id
     LEFT JOIN product_required_departments prd ON p.id = prd.product_id
     LEFT JOIN departments d ON prd.department_id = d.id
     WHERE woli.work_order_id = ?
     AND d.id NOT IN (SELECT id FROM departments WHERE name IN ('Delivery', 'Admin'))
     ORDER BY woli.created_at ASC, prd.sort_order ASC`,
    [workOrderId],
    (err, rows) => {
      if (err) return callback(err);
      
      // Group line items and their departments
      const lineItemsMap = {};
      rows.forEach(row => {
        if (!lineItemsMap[row.id]) {
          lineItemsMap[row.id] = {
            id: row.id,
            work_order_id: row.work_order_id,
            product_id: row.product_id,
            product_name: row.product_name,
            description: row.description,
            quantity: row.quantity,
            notes: row.notes,
            category_name: row.category_name,
            proof_required: row.proof_required,
            qc_required: row.qc_required,
            barcode_required: row.barcode_required,
            default_turnaround_hours: row.default_turnaround_hours,
            required_departments: []
          };
        }
        if (row.department_id) {
          lineItemsMap[row.id].required_departments.push({
            id: row.dept_id,
            department_id: row.department_id,
            department_name: row.department_name,
            color: row.color,
            icon: row.icon
          });
        }
      });
      
      callback(null, Object.values(lineItemsMap));
    }
  );
}

// Helper: Get product required departments
function getProductRequiredDepartments(productId, callback) {
  db.all(
    `SELECT d.id, d.name
     FROM product_required_departments prd
     LEFT JOIN departments d ON prd.department_id = d.id
     WHERE prd.product_id = ? AND d.id NOT IN (SELECT id FROM departments WHERE name IN ('Delivery', 'Admin'))
     ORDER BY prd.sort_order ASC`,
    [productId],
    callback
  );
}

// Helper: Sync work_order_department_status based on line items
function syncDepartmentStatusFromLineItems(workOrderId, callback) {
  // Get all product line items
  db.all(
    `SELECT DISTINCT prd.department_id
     FROM work_order_line_items woli
     LEFT JOIN product_required_departments prd ON woli.product_id = prd.product_id
     WHERE woli.work_order_id = ? AND prd.department_id IS NOT NULL`,
    [workOrderId],
    (err, requiredDepts) => {
      if (err) return callback(err);
      
      if (!requiredDepts || requiredDepts.length === 0) {
        return callback(null); // No line items or departments
      }

      // Delete old department statuses (except those already set by user)
      db.run(
        `DELETE FROM work_order_department_status 
         WHERE work_order_id = ? AND status = 'Not Required'`,
        [workOrderId],
        (delErr) => {
          if (delErr) return callback(delErr);

          // Insert new department statuses
          let index = 0;
          const insertNext = () => {
            if (index >= requiredDepts.length) return callback(null);
            const dept = requiredDepts[index++];
            db.run(
              `INSERT OR IGNORE INTO work_order_department_status 
               (work_order_id, department_id, status, created_at, updated_at)
               VALUES (?, ?, 'Not Required', datetime('now'), datetime('now'))`,
              [workOrderId, dept.department_id],
              (insertErr) => {
                if (insertErr) return callback(insertErr);
                insertNext();
              }
            );
          };
          insertNext();
        }
      );
    }
  );
}

// Helper: Save work order line items and sync departments
function saveWorkOrderLineItems(workOrderId, lineItems, callback) {
  // Delete existing line items
  db.run(
    `DELETE FROM work_order_line_items WHERE work_order_id = ?`,
    [workOrderId],
    (delErr) => {
      if (delErr) return callback(delErr);

      // Insert new line items
      let index = 0;
      const insertNext = () => {
        if (index >= lineItems.length) {
          return syncDepartmentStatusFromLineItems(workOrderId, callback);
        }

        const item = lineItems[index++];
        db.run(
          `INSERT INTO work_order_line_items 
           (work_order_id, product_id, description, quantity, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
          [
            workOrderId,
            Number(item.product_id),
            item.description || null,
            Number(item.quantity) || 1,
            item.notes || null,
          ],
          (insertErr) => {
            if (insertErr) return callback(insertErr);
            insertNext();
          }
        );
      };
      insertNext();
    }
  );
}

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
  if (!data.status || !String(data.status).trim()) {
    errors.push('status is required');
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
  db.all(
    `SELECT ${workOrderFieldList}
     FROM work_orders wo
     LEFT JOIN users u ON wo.customer_id = u.id
     ORDER BY wo.created_at DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('WORK ORDER LIST ERROR:', err);
        return res.status(500).json({ error: err.message });
      }

      res.json(rows);
    }
  );
});

router.get('/:id', auth.requireAuth, (req, res) => {
  db.get(
    `SELECT ${workOrderFieldList}
     FROM work_orders wo
     LEFT JOIN users u ON wo.customer_id = u.id
     WHERE wo.id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) {
        console.error('WORK ORDER DETAIL ERROR:', err);
        return res.status(500).json({ error: err.message });
      }

      if (!row) {
        return res.status(404).json({ error: 'Work order not found' });
      }

      // Get line items
      getWorkOrderLineItems(req.params.id, (err2, lineItems) => {
        if (err2) {
          console.error('LINE ITEMS ERROR:', err2);
          return res.json(row); // Return work order without line items if there's an error
        }
        row.line_items = lineItems || [];
        res.json(row);
      });
    }
  );
});

router.post('/', auth.requireAuth, (req, res) => {
  const payload = req.body || {};
  
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
    line_items,
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

      // Save line items if provided
      if (Array.isArray(line_items) && line_items.length > 0) {
        return saveWorkOrderLineItems(newId, line_items, (itemErr) => {
          if (itemErr) {
            console.error('Failed to save line items:', itemErr);
            return res.status(500).json({ error: 'Work order created but line items failed' });
          }

          db.get(
            `SELECT ${workOrderFieldList}
             FROM work_orders wo
             LEFT JOIN users u ON wo.customer_id = u.id
             WHERE wo.id = ?`,
            [newId],
            (err2, row) => {
              if (err2) return res.status(201).json({ id: newId });
              getWorkOrderLineItems(newId, (err3, lineItems) => {
                if (!err3) row.line_items = lineItems || [];
                res.status(201).json(row || { id: newId });
              });
            }
          );
        });
      }

      db.get(
        `SELECT ${workOrderFieldList}
         FROM work_orders wo
         LEFT JOIN users u ON wo.customer_id = u.id
         WHERE wo.id = ?`,
        [newId],
        (err2, row) => {
          if (err2) return res.status(201).json({ id: newId });
          row.line_items = [];
          res.status(201).json(row || { id: newId });
        }
      );
    }
  );
});

router.put('/:id', auth.requireAuth, (req, res) => {
  const id = req.params.id;
  const payload = req.body || {};
  
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
    line_items,
  } = payload;

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

      // Save line items if provided
      if (Array.isArray(line_items)) {
        return saveWorkOrderLineItems(id, line_items, (itemErr) => {
          if (itemErr) {
            console.error('Failed to save line items:', itemErr);
            return res.status(500).json({ error: 'Work order updated but line items failed' });
          }

          db.get(
            `SELECT ${workOrderFieldList}
             FROM work_orders wo
             LEFT JOIN users u ON wo.customer_id = u.id
             WHERE wo.id = ?`,
            [id],
            (err2, row) => {
              if (err2) return res.status(500).json({ error: 'Failed to load updated work order' });
              if (!row) return res.status(404).json({ error: 'Work order not found after update' });
              getWorkOrderLineItems(id, (err3, lineItems) => {
                if (!err3) row.line_items = lineItems || [];
                res.json(row);
              });
            }
          );
        });
      }

      db.get(
        `SELECT ${workOrderFieldList}
         FROM work_orders wo
         LEFT JOIN users u ON wo.customer_id = u.id
         WHERE wo.id = ?`,
        [id],
        (err2, row) => {
          if (err2) return res.status(500).json({ error: 'Failed to load updated work order' });
          if (!row) return res.status(404).json({ error: 'Work order not found after update' });
          row.line_items = [];
          res.json(row);
        }
      );
    }
  );
});

router.put('/:id/stage', auth.requireAuth, (req, res) => {
  const id = req.params.id;
  const stageId = req.body?.stage_id == null || req.body?.stage_id === '' ? null : Number(req.body.stage_id);

  db.run(
    `UPDATE work_orders SET stage_id = ?, updated_at = datetime('now') WHERE id = ?`,
    [stageId, id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to update work order stage' });
      if (this.changes === 0) return res.status(404).json({ error: 'Work order not found' });
      res.json({ success: true, id, stage_id: stageId });
    }
  );
});

router.put('/:id/priority', auth.requireAuth, (req, res) => {
  const id = req.params.id;
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

// GET /:id/events - Get all events for a work order
router.get('/:id/events', auth.requireAuth, (req, res) => {
  const workOrderId = req.params.id;

  db.all(
    `SELECT 
      e.id,
      e.work_order_id,
      e.event_type,
      e.from_stage_id,
      e.to_stage_id,
      e.from_department_id,
      e.to_department_id,
      e.note,
      e.created_at,
      fs.name as from_stage_name,
      ts.name as to_stage_name,
      fd.name as from_department_name,
      td.name as to_department_name
     FROM work_order_events e
     LEFT JOIN production_stages fs ON e.from_stage_id = fs.id
     LEFT JOIN production_stages ts ON e.to_stage_id = ts.id
     LEFT JOIN departments fd ON e.from_department_id = fd.id
     LEFT JOIN departments td ON e.to_department_id = td.id
     WHERE e.work_order_id = ?
     ORDER BY e.created_at DESC`,
    [workOrderId],
    (err, rows) => {
      if (err) {
        console.error('WORK ORDER EVENTS LIST ERROR:', err);
        return res.status(500).json({ error: err.message });
      }

      res.json(rows || []);
    }
  );
});

// POST /:id/events - Create a new event for a work order
router.post('/:id/events', auth.requireAuth, (req, res) => {
  const workOrderId = req.params.id;
  const {
    event_type,
    from_stage_id,
    to_stage_id,
    from_department_id,
    to_department_id,
    note,
  } = req.body || {};

  if (!event_type) {
    return res.status(400).json({ error: 'event_type is required' });
  }

  db.run(
    `INSERT INTO work_order_events (work_order_id, event_type, from_stage_id, to_stage_id, from_department_id, to_department_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      workOrderId,
      event_type,
      from_stage_id || null,
      to_stage_id || null,
      from_department_id || null,
      to_department_id || null,
      note || null,
    ],
    function (err) {
      if (err) {
        console.error('WORK ORDER EVENT CREATE ERROR:', err);
        return res.status(500).json({ error: 'Failed to create event' });
      }

      const newId = this.lastID;
      db.get(
        `SELECT 
          e.id,
          e.work_order_id,
          e.event_type,
          e.from_stage_id,
          e.to_stage_id,
          e.from_department_id,
          e.to_department_id,
          e.note,
          e.created_at,
          fs.name as from_stage_name,
          ts.name as to_stage_name,
          fd.name as from_department_name,
          td.name as to_department_name
         FROM work_order_events e
         LEFT JOIN production_stages fs ON e.from_stage_id = fs.id
         LEFT JOIN production_stages ts ON e.to_stage_id = ts.id
         LEFT JOIN departments fd ON e.from_department_id = fd.id
         LEFT JOIN departments td ON e.to_department_id = td.id
         WHERE e.id = ?`,
        [newId],
        (err2, row) => {
          if (err2) return res.status(201).json({ id: newId });
          res.status(201).json(row || { id: newId });
        }
      );
    }
  );
});

module.exports = router;
