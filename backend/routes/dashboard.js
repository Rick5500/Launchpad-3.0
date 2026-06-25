const express = require('express');
const auth = require('../auth');
const db = require('../db');
const router = express.Router();

router.get('/', auth.requireAuth, (req, res) => {
  const summary = {};

  db.get('SELECT COUNT(*) AS count FROM work_orders', [], (err, row) => {
    if (err) return res.status(500).json({ error: 'Failed to load dashboard summary' });
    summary.totalWorkOrders = row.count;

    db.get("SELECT COUNT(*) AS count FROM work_orders WHERE status IN ('open','in-progress')", [], (err, row) => {
      if (err) return res.status(500).json({ error: 'Failed to load active work orders' });
      summary.activeWorkOrders = row.count;

      db.get("SELECT COUNT(*) AS count FROM production_board", [], (err, row) => {
        if (err) return res.status(500).json({ error: 'Failed to load production board count' });
        summary.productionBoardItems = row.count;

        db.get("SELECT COUNT(*) AS count FROM users WHERE role = 'customer'", [], (err, row) => {
          if (err) return res.status(500).json({ error: 'Failed to load customers count' });
          summary.customers = row.count;

          db.get("SELECT COUNT(*) AS count FROM deliveries WHERE status != 'complete'", [], (err, row) => {
            if (err) return res.status(500).json({ error: 'Failed to load deliveries count' });
            summary.pendingDeliveries = row.count;

            db.all(
              "SELECT department, COUNT(*) AS count FROM work_orders GROUP BY department ORDER BY count DESC",
              [],
              (err, rows) => {
                if (err) return res.status(500).json({ error: 'Failed to load department summary' });
                summary.departmentSummary = rows;
                res.json(summary);
              }
            );
          });
        });
      });
    });
  });
});

module.exports = router;
