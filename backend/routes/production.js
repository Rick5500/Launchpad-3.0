const express = require('express');
const auth = require('../auth');
const db = require('../db');
const shopLocations = require('../shopLocations');
const router = express.Router();

router.use(auth.requireAuth, auth.requireRole('admin', 'manager', 'operator'));

router.get('/', async (req, res) => {
  let where = '';
  let params = [];
  try {
    const access = await shopLocations.loadAccess(req.user.userId);
    const pred = shopLocations.predicate('COALESCE(wo.location_id, o.location_id)', access);
    if (pred.sql) {
      where = `WHERE ${pred.sql}`;
      params = pred.params;
    }
  } catch (err) {
    console.error('PRODUCTION BOARD ERROR:', err);
    return res.status(500).json({ error: 'Failed to load production board data' });
  }
  db.all(
    `SELECT pb.id, wo.external_id, pb.lane, pb.position, pb.status, pb.updated_at
     FROM production_board pb
     LEFT JOIN work_orders wo ON pb.work_order_id = wo.id
     LEFT JOIN orders o ON o.id = wo.order_id
     ${where}
     ORDER BY pb.position ASC LIMIT 20`,
    params,
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to load production board data' });
      res.json(rows);
    }
  );
});

module.exports = router;
