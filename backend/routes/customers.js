const express = require('express');
const auth = require('../auth');
const db = require('../db');
const crypto = require('crypto');
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

// Create a new customer (admin usage). Accepts { display_name, username? }
router.post('/', auth.requireAuth, (req, res) => {
  const { display_name, username } = req.body || {};
  if (!display_name || !String(display_name).trim()) {
    return res.status(400).json({ error: 'display_name is required' });
  }

  const baseName = username && String(username).trim() ? String(username).trim() : String(display_name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  function findUnique(nameBase, counter, cb) {
    const tryName = counter > 0 ? `${nameBase}-${counter}` : nameBase;
    db.get('SELECT id FROM users WHERE username = ?', [tryName], (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, tryName);
      findUnique(nameBase, counter + 1, cb);
    });
  }

  findUnique(baseName, 0, (err, uniqueUsername) => {
    if (err) return res.status(500).json({ error: 'Failed to check username availability' });

    const pwd = Math.random().toString(36).slice(2, 12);
    const hash = crypto.createHash('sha256').update(pwd).digest('hex');

    db.run(
      'INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES (?,?,?,?,datetime("now"))',
      [uniqueUsername, hash, 'customer', display_name],
      function (err) {
        if (err) return res.status(500).json({ error: 'Failed to create customer' });
        const newId = this.lastID;
        db.get('SELECT id, username, display_name FROM users WHERE id = ?', [newId], (err2, row) => {
          if (err2) return res.status(201).json({ id: newId });
          res.status(201).json(row || { id: newId });
        });
      }
    );
  });
});

module.exports = router;
