const express = require('express');
const auth = require('../auth');
const db = require('../db');
const router = express.Router();

router.get('/', auth.requireAuth, (req, res) => {
  const summary = {};

  db.get('SELECT COUNT(*) AS count FROM work_orders', [], (err, row) => {
    if (err) return res.status(500).json({ error: 'Failed to load dashboard summary' });
    summary.totalWorkOrders = row.count;

    db.get("SELECT COUNT(*) AS count FROM work_orders WHERE status = 'open'", [], (err, row) => {
      if (err) return res.status(500).json({ error: 'Failed to load active work orders' });
      summary.activeWorkOrders = row.count;

      db.get("SELECT COUNT(*) AS count FROM production_board", [], (err, row) => {
        if (err) return res.status(500).json({ error: 'Failed to load production board count' });
        summary.productionBoardItems = row.count;

        db.get("SELECT COUNT(*) AS count FROM users WHERE role = 'customer'", [], (err, row) => {
          if (err) return res.status(500).json({ error: 'Failed to load customers count' });
          summary.customers = row.count;

          // Count delivery queue items (QC Complete with delivery_method = 'delivery')
          db.get(
            `SELECT COUNT(*) AS count FROM work_orders wo
             LEFT JOIN work_order_matrix_state ms ON wo.id = ms.work_order_id
             WHERE wo.status = 'open'
             AND ms.qc_status = 'Complete'
             AND wo.delivery_method = 'delivery'`,
            [],
            (err, row) => {
              if (err) return res.status(500).json({ error: 'Failed to load delivery queue count' });
              summary.deliveryQueue = row?.count || 0;

              // Count will-call queue items (QC Complete with delivery_method = 'will_call')
              db.get(
                `SELECT COUNT(*) AS count FROM work_orders wo
                 LEFT JOIN work_order_matrix_state ms ON wo.id = ms.work_order_id
                 WHERE wo.status = 'open'
                 AND ms.qc_status = 'Complete'
                 AND wo.delivery_method = 'will_call'`,
                [],
                (err, row) => {
                  if (err) return res.status(500).json({ error: 'Failed to load will-call queue count' });
                  summary.willCallQueue = row?.count || 0;

                  // Get department summary from work_order_department_status (operational source of truth)
                  db.all(
                    `SELECT d.name, d.color, COUNT(wods.id) AS count
                     FROM work_order_department_status wods
                     JOIN departments d ON wods.department_id = d.id
                     WHERE wods.status != 'Not Required'
                     AND d.name NOT IN ('Delivery', 'Admin')
                     GROUP BY d.id, d.name, d.color
                     ORDER BY d.sort_order ASC`,
                    [],
                    (err, rows) => {
                      if (err) return res.status(500).json({ error: 'Failed to load department summary' });
                      summary.departmentSummary = rows || [];
                      
                      // Get QC summary
                      db.all(
                        `SELECT qc_status, COUNT(*) AS count
                         FROM work_order_matrix_state
                         WHERE qc_status != 'Not Required'
                         GROUP BY qc_status
                         ORDER BY qc_status ASC`,
                        [],
                        (err, qcRows) => {
                          if (err) return res.status(500).json({ error: 'Failed to load QC summary' });
                          summary.qcSummary = qcRows || [];
                          res.json(summary);
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        });
      });
    });
  });
});

module.exports = router;
