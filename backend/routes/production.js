const express = require('express');
const auth = require('../auth');
const db = require('../db');
const router = express.Router();

router.get('/', auth.requireAuth, (req, res) => {
  db.all(
    `SELECT pb.id, wo.external_id, pb.lane, pb.position, pb.status, pb.updated_at
     FROM production_board pb
     LEFT JOIN work_orders wo ON pb.work_order_id = wo.id
     ORDER BY pb.position ASC LIMIT 20`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to load production board data' });
      res.json(rows);
    }
  );
});

module.exports = router;
