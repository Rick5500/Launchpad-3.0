const express = require('express');
const auth = require('../auth');
const db = require('../db');
const router = express.Router();

router.get('/', auth.requireAuth, (req, res) => {
  db.all(
    `SELECT wo.id, wo.external_id, wo.description, wo.quantity, wo.status, wo.due_date, u.display_name AS customer_name, wo.department
     FROM work_orders wo
     LEFT JOIN users u ON wo.customer_id = u.id
     ORDER BY wo.due_date ASC LIMIT 20`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to load work orders' });
      res.json(rows);
    }
  );
});

module.exports = router;
