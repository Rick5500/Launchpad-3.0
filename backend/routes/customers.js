const express = require('express');
const auth = require('../auth');
const db = require('../db');
const router = express.Router();

router.get('/', auth.requireAuth, (req, res) => {
  db.all(
    `SELECT id, username, display_name, role, created_at
     FROM users
     WHERE role = 'customer'
     ORDER BY display_name ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to load customers' });
      res.json(rows);
    }
  );
});

module.exports = router;
