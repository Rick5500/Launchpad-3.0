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

router.get('/:id', auth.requireAuth, (req, res) => {
  const id = req.params.id;
  db.get(
    `SELECT wo.id, wo.external_id, wo.description, wo.quantity, wo.status, wo.department, wo.due_date, wo.created_at, wo.updated_at,
      wo.customer_id, u.display_name AS customer_name, u.username AS customer_username
     FROM work_orders wo
     LEFT JOIN users u ON wo.customer_id = u.id
     WHERE wo.id = ?`,
    [id],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'Failed to load work order' });
      if (!row) return res.status(404).json({ error: 'Work order not found' });
      res.json(row);
    }
  );
});

router.put('/:id', auth.requireAuth, (req, res) => {
  // Future implementation for work order editing
  res.status(204).send();
});

module.exports = router;
