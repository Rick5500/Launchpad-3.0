const express = require('express');
const auth = require('../auth');
const db = require('../db');
const router = express.Router();

// GET /api/workorders/:id/events - Get all events for a work order
router.get('/', auth.requireAuth, (req, res) => {
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

// POST /api/workorders/:id/events - Create a new event for a work order
router.post('/', auth.requireAuth, (req, res) => {
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
