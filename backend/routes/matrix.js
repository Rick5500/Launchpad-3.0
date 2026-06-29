const express = require('express');
const auth = require('../auth');
const db = require('../db');
const router = express.Router();

// Get all work orders with their department statuses for the matrix
router.get('/work-orders', auth.requireAuth, (req, res) => {
  const { filter } = req.query;

  let where = '';
  if (filter === 'completed') {
    where = "AND ms.is_completed = 1";
  } else if (filter === 'delivery') {
    where = "AND ms.qc_status = 'Complete' AND ms.delivery_type = 'delivery'";
  } else if (filter === 'qc') {
    where = "AND (ms.qc_status != 'Not Required' AND ms.qc_status != 'Complete')";
  }

  const query = `
    SELECT 
      wo.id,
      wo.external_id,
      wo.description,
      wo.quantity,
      wo.status,
      wo.due_date,
      wo.priority,
      u.display_name AS customer_name,
      ms.qc_status,
      ms.delivery_type,
      ms.is_completed
    FROM work_orders wo
    LEFT JOIN users u ON wo.customer_id = u.id
    LEFT JOIN work_order_matrix_state ms ON wo.id = ms.work_order_id
    WHERE wo.status != 'archived'
    ${where}
    ORDER BY wo.due_date ASC, wo.id ASC
    LIMIT 500
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching work orders:', err);
      return res.status(500).json({ error: 'Failed to fetch work orders' });
    }

    if (!rows || rows.length === 0) {
      return res.json({ work_orders: [] });
    }

    // Fetch department statuses for all work orders
    const workOrderIds = rows.map(r => r.id);
    const placeholders = workOrderIds.map(() => '?').join(',');

    const deptQuery = `
      SELECT 
        wds.work_order_id,
        d.id,
        d.name,
        d.color,
        d.icon,
        wds.status
      FROM work_order_department_status wds
      JOIN departments d ON wds.department_id = d.id
      WHERE wds.work_order_id IN (${placeholders})
      ORDER BY d.sort_order ASC
    `;

    db.all(deptQuery, workOrderIds, (err2, deptStatuses) => {
      if (err2) {
        console.error('Error fetching department statuses:', err2);
        return res.status(500).json({ error: 'Failed to fetch department statuses' });
      }

      // Build department status map
      const deptMap = {};
      (deptStatuses || []).forEach(ds => {
        if (!deptMap[ds.work_order_id]) {
          deptMap[ds.work_order_id] = {};
        }
        deptMap[ds.work_order_id][ds.name] = {
          status: ds.status,
          color: ds.color,
          icon: ds.icon,
        };
      });

      // Attach department statuses to work orders
      const result = rows.map(wo => ({
        ...wo,
        department_statuses: deptMap[wo.id] || {},
      }));

      res.json({ work_orders: result });
    });
  });
});

// Update a work order's department status
router.put('/work-orders/:id/department/:deptId/status', auth.requireAuth, (req, res) => {
  const { id, deptId } = req.params;
  const { status } = req.body;

  const validStatuses = ['Not Required', 'Waiting', 'Proof', 'In Progress', 'On Hold', 'Complete'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  // Update or insert department status
  db.run(
    `INSERT INTO work_order_department_status (work_order_id, department_id, status, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(work_order_id, department_id) DO UPDATE SET status = ?, updated_at = CURRENT_TIMESTAMP`,
    [id, deptId, status, status],
    function(err) {
      if (err) {
        console.error('Error updating department status:', err);
        return res.status(500).json({ error: 'Failed to update status' });
      }

      // Check if all required departments are complete, and if so, update QC status
      checkAndUpdateQCStatus(id, (qcErr) => {
        if (qcErr) console.error('Error checking QC status:', qcErr);
        res.json({ success: true });
      });
    }
  );
});

// Helper function to check if QC should be auto-promoted to "Ready for QC"
function checkAndUpdateQCStatus(workOrderId, callback) {
  // Get all department statuses for this work order
  db.all(
    `SELECT status FROM work_order_department_status 
     WHERE work_order_id = ? AND status != 'Not Required'`,
    [workOrderId],
    (err, rows) => {
      if (err) return callback(err);

      if (!rows || rows.length === 0) {
        return callback(null);
      }

      // Check if all required departments are complete
      const allComplete = rows.every(r => r.status === 'Complete');

      if (allComplete) {
        // Update QC status to "Ready for QC"
        db.run(
          `INSERT INTO work_order_matrix_state (work_order_id, qc_status)
           VALUES (?, 'Ready for QC')
           ON CONFLICT(work_order_id) DO UPDATE SET qc_status = 'Ready for QC', updated_at = CURRENT_TIMESTAMP`,
          [workOrderId],
          callback
        );
      } else {
        callback(null);
      }
    }
  );
}

// Update QC status
router.put('/work-orders/:id/qc-status', auth.requireAuth, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['Not Required', 'Waiting', 'Ready for QC', 'In QC', 'On Hold', 'Complete'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid QC status' });
  }

  db.run(
    `INSERT INTO work_order_matrix_state (work_order_id, qc_status, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(work_order_id) DO UPDATE SET qc_status = ?, updated_at = CURRENT_TIMESTAMP`,
    [id, status, status],
    function(err) {
      if (err) {
        console.error('Error updating QC status:', err);
        return res.status(500).json({ error: 'Failed to update QC status' });
      }

      // If QC is now complete, auto-set delivery type if needed
      if (status === 'Complete') {
        db.get(
          'SELECT will_call FROM deliveries WHERE work_order_id = ?',
          [id],
          (delErr, delRow) => {
            if (delErr) console.error('Error checking delivery:', delErr);
            if (delRow) {
              const deliveryType = delRow.will_call ? 'will_call' : 'delivery';
              db.run(
                `UPDATE work_order_matrix_state SET delivery_type = ? WHERE work_order_id = ?`,
                [deliveryType, id],
                (updateErr) => {
                  if (updateErr) console.error('Error updating delivery type:', updateErr);
                  res.json({ success: true });
                }
              );
            } else {
              res.json({ success: true });
            }
          }
        );
      } else {
        res.json({ success: true });
      }
    }
  );
});

// Get dashboard metrics
router.get('/dashboard', auth.requireAuth, (req, res) => {
  const metricsQueries = {
    readyForQC: `SELECT COUNT(*) as count FROM work_order_matrix_state WHERE qc_status = 'Ready for QC'`,
    dueWithinHour: `SELECT COUNT(*) as count FROM work_orders 
      WHERE due_date IS NOT NULL 
      AND due_date <= datetime('now', '+1 hour')
      AND due_date > datetime('now')
      AND status != 'archived'`,
    overdue: `SELECT COUNT(*) as count FROM work_orders 
      WHERE due_date IS NOT NULL 
      AND due_date < datetime('now')
      AND status != 'archived'`,
    deliveryQueue: `SELECT COUNT(*) as count FROM work_order_matrix_state 
      WHERE qc_status = 'Complete' AND delivery_type = 'delivery'`,
    willCallQueue: `SELECT COUNT(*) as count FROM work_order_matrix_state 
      WHERE qc_status = 'Complete' AND delivery_type = 'will_call'`,
    onHold: `SELECT COUNT(*) as count FROM work_order_matrix_state 
      WHERE qc_status = 'On Hold'`,
  };

  const metrics = {};
  let completed = 0;

  Object.entries(metricsQueries).forEach(([key, query]) => {
    db.get(query, [], (err, row) => {
      completed++;
      if (err) {
        console.error(`Error fetching ${key}:`, err);
        metrics[key] = 0;
      } else {
        metrics[key] = row?.count || 0;
      }

      if (completed === Object.keys(metricsQueries).length) {
        res.json(metrics);
      }
    });
  });
});

module.exports = router;
