const express = require('express');
const auth = require('../auth');
const db = require('../db');
const router = express.Router();

router.get('/', auth.requireAuth, (req, res) => {
  db.all(
    `SELECT d.id, wo.external_id, d.due_time, d.carrier, d.status, d.will_call
     FROM deliveries d
     LEFT JOIN work_orders wo ON d.work_order_id = wo.id
     ORDER BY d.due_time ASC LIMIT 20`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to load deliveries' });
      res.json(rows);
    }
  );
});

module.exports = router;
