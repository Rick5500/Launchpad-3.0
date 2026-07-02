const express = require('express');
const auth = require('../auth');
const db = require('../db');
const { syncDeliveryMethod } = require('../utils/workOrderHelpers');
const router = express.Router();

// Get all work orders with their department statuses for the matrix
router.get('/work-orders', auth.requireAuth, (req, res) => {
  const { filter } = req.query;

  let departmentFilter = '';
  let departmentJoin = '';

  // Map filter values to department names and conditions
  if (filter === 'graphics') {
    departmentFilter = `
      WHERE EXISTS (
        SELECT 1 FROM work_order_department_status wds2
        JOIN departments d2 ON wds2.department_id = d2.id
        WHERE wds2.work_order_id = wo.id 
        AND d2.name = 'Graphics' 
        AND wds2.status != 'Not Required'
      )
    `;
  } else if (filter === 'small-format') {
    departmentFilter = `
      WHERE EXISTS (
        SELECT 1 FROM work_order_department_status wds2
        JOIN departments d2 ON wds2.department_id = d2.id
        WHERE wds2.work_order_id = wo.id 
        AND d2.name = 'Small Format' 
        AND wds2.status != 'Not Required'
      )
    `;
  } else if (filter === 'reprographics') {
    departmentFilter = `
      WHERE EXISTS (
        SELECT 1 FROM work_order_department_status wds2
        JOIN departments d2 ON wds2.department_id = d2.id
        WHERE wds2.work_order_id = wo.id 
        AND d2.name = 'Reprographics' 
        AND wds2.status != 'Not Required'
      )
    `;
  } else if (filter === 'scanning') {
    departmentFilter = `
      WHERE EXISTS (
        SELECT 1 FROM work_order_department_status wds2
        JOIN departments d2 ON wds2.department_id = d2.id
        WHERE wds2.work_order_id = wo.id 
        AND d2.name = 'Scanning' 
        AND wds2.status != 'Not Required'
      )
    `;
  } else if (filter === 'qc') {
    departmentFilter = `
      WHERE ms.qc_status IN ('Ready for QC', 'In QC', 'On Hold')
    `;
  } else if (filter === 'delivery') {
    departmentFilter = `
      WHERE (ms.qc_status = 'Complete' AND wo.delivery_method IN ('delivery', 'will_call'))
    `;
  } else if (filter === 'completed') {
    departmentFilter = `
      WHERE ms.delivery_status = 'Complete'
    `;
  } else {
    // 'all' - show all active work orders
    departmentFilter = `
      WHERE wo.status = 'open'
    `;
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
      wo.delivery_method,
      u.display_name AS customer_name,
      ms.qc_status,
      ms.delivery_status,
      ms.is_completed
    FROM work_orders wo
    LEFT JOIN users u ON wo.customer_id = u.id
    LEFT JOIN work_order_matrix_state ms ON wo.id = ms.work_order_id
    ${departmentFilter}
    ORDER BY wo.due_date ASC, wo.id ASC
    LIMIT 500
  `;

  // Fetch initial rows
  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching work orders:', err);
      return res.status(500).json({ error: 'Failed to fetch work orders' });
    }

    if (!rows || rows.length === 0) {
      return res.json({ work_orders: [] });
    }

    // Ensure all work orders have QC status initialized to "Waiting"
    const workOrderIds = rows.map(r => r.id);
    
    // Use serialize to ensure sequential execution
    db.serialize(() => {
      // First, update any "Not Required" to "Waiting"
      db.run(
        `UPDATE work_order_matrix_state SET qc_status = 'Waiting' 
         WHERE qc_status = 'Not Required'`,
        (err) => {
          if (err) console.error('Error updating QC status:', err);
        }
      );

      // Then insert any missing records
      workOrderIds.forEach(woId => {
        db.run(
          `INSERT OR IGNORE INTO work_order_matrix_state (work_order_id, qc_status, delivery_status)
           VALUES (?, 'Waiting', 'Pending')`,
          [woId],
          (err) => {
            if (err) console.error('Error inserting QC status:', err);
          }
        );
      });

      // Finally, auto-update delivery_status then re-fetch with updated data
      db.run(
        `UPDATE work_order_matrix_state 
         SET delivery_status = 'Ready' 
         WHERE qc_status = 'Complete' AND delivery_status = 'Pending'`,
        (updateErr) => {
          if (updateErr) console.error('Error auto-updating delivery_status:', updateErr);
          
          // After update, re-fetch with updated data
          db.all(query, [], (err, updatedRows) => {
            if (err) {
              console.error('Error re-fetching work orders:', err);
              return res.status(500).json({ error: 'Failed to re-fetch work orders' });
            }

            if (!updatedRows || updatedRows.length === 0) {
              return res.json({ work_orders: [] });
            }

            const updatedIds = updatedRows.map(r => r.id);
            const placeholders = updatedIds.map(() => '?').join(',');

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

            db.all(deptQuery, updatedIds, (err2, deptStatuses) => {
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
              const result = updatedRows.map(wo => ({
                ...wo,
                department_statuses: deptMap[wo.id] || {},
              }));

              res.json({ work_orders: result });
            });
          });
        }
      );
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
// QC is always required - starts as Waiting and moves to Ready for QC when all departments complete
function checkAndUpdateQCStatus(workOrderId, callback) {
  // Get current QC status
  db.get(
    'SELECT qc_status FROM work_order_matrix_state WHERE work_order_id = ?',
    [workOrderId],
    (err, qcRow) => {
      if (err) return callback(err);
      
      // If QC is already in progress or complete, don't auto-update
      if (qcRow && ['In QC', 'On Hold', 'Complete'].includes(qcRow.qc_status)) {
        return callback(null);
      }

      // Get all department statuses for this work order
      db.all(
        `SELECT status FROM work_order_department_status 
         WHERE work_order_id = ? AND status != 'Not Required'`,
        [workOrderId],
        (err, rows) => {
          if (err) return callback(err);

          if (!rows || rows.length === 0) {
            // No required departments, QC should be Ready
            return db.run(
              `INSERT INTO work_order_matrix_state (work_order_id, qc_status)
               VALUES (?, 'Ready for QC')
               ON CONFLICT(work_order_id) DO UPDATE SET qc_status = 'Ready for QC', updated_at = CURRENT_TIMESTAMP`,
              [workOrderId],
              callback
            );
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
            // At least one department is not complete, QC should be Waiting
            db.run(
              `INSERT INTO work_order_matrix_state (work_order_id, qc_status)
               VALUES (?, 'Waiting')
               ON CONFLICT(work_order_id) DO UPDATE SET qc_status = 'Waiting', updated_at = CURRENT_TIMESTAMP`,
              [workOrderId],
              callback
            );
          }
        }
      );
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
    `INSERT INTO work_order_matrix_state (work_order_id, qc_status, delivery_status, updated_at)
     VALUES (?, ?, 'Pending', CURRENT_TIMESTAMP)
     ON CONFLICT(work_order_id) DO UPDATE SET qc_status = ?, updated_at = CURRENT_TIMESTAMP`,
    [id, status, status],
    function(err) {
      if (err) {
        console.error('Error updating QC status:', err);
        return res.status(500).json({ error: 'Failed to update QC status' });
      }

      // If QC is now complete, set delivery_status to 'Ready' and auto-sync delivery_method
      if (status === 'Complete') {
        db.run(
          `UPDATE work_order_matrix_state SET delivery_status = 'Ready' WHERE work_order_id = ?`,
          [id],
          (updateErr) => {
            if (updateErr) console.error('Error updating delivery_status:', updateErr);
          }
        );
        syncDeliveryMethod(id, (syncErr) => {
          if (syncErr) console.error('Error syncing delivery method:', syncErr);
          res.json({ success: true });
        });
      } else {
        res.json({ success: true });
      }
    }
  );
});

// Mark delivery/will-call as complete - only allowed after QC is complete
router.put('/work-orders/:id/delivery-complete', auth.requireAuth, (req, res) => {
  const { id } = req.params;

  // Check if QC is complete and delivery is ready before allowing delivery completion
  db.get(
    'SELECT qc_status, delivery_status FROM work_order_matrix_state WHERE work_order_id = ?',
    [id],
    (err, row) => {
      if (err) {
        console.error('Error fetching QC status:', err);
        return res.status(500).json({ error: 'Failed to fetch QC status' });
      }

      if (!row || row.qc_status !== 'Complete') {
        return res.status(400).json({ error: 'Cannot mark delivery complete before QC is complete' });
      }

      if (row.delivery_status === 'Complete') {
        return res.status(400).json({ error: 'Delivery already marked as complete' });
      }

      // Use transaction: update matrix state, work order status, and add timeline event
      db.serialize(() => {
        // Update matrix state to mark delivery complete
        db.run(
          `UPDATE work_order_matrix_state 
           SET delivery_status = 'Complete', is_completed = 1, updated_at = CURRENT_TIMESTAMP 
           WHERE work_order_id = ?`,
          [id],
          function(err) {
            if (err) {
              console.error('Error marking delivery complete:', err);
              return res.status(500).json({ error: 'Failed to mark delivery complete' });
            }

            // Update work_orders.status to 'complete'
            db.run(
              `UPDATE work_orders SET status = 'complete', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [id],
              function(err2) {
                if (err2) {
                  console.error('Error updating work order status:', err2);
                  return res.status(500).json({ error: 'Failed to update work order status' });
                }

                // Add timeline event for delivery completion
                db.run(
                  `INSERT INTO work_order_events (work_order_id, event_type, note, created_at)
                   VALUES (?, 'delivery_completed', 'Delivery / Will Call marked as complete', CURRENT_TIMESTAMP)`,
                  [id],
                  function(err3) {
                    if (err3) {
                      console.error('Error adding timeline event:', err3);
                      // Don't fail the request - event logging is nice-to-have
                    }

                    res.json({ success: true, message: 'Delivery marked as complete' });
                  }
                );
              }
            );
          }
        );
      });
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
