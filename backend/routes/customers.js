const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const auth = require('../auth');
const db = require('../db');

const router = express.Router();
const BCRYPT_ROUNDS = 10;

function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

router.get('/', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  db.all(
    `SELECT id, username, display_name, role, created_at
     FROM users
     WHERE role = 'customer'
     ORDER BY display_name ASC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('CUSTOMERS LIST ERROR:', err);
        return res.status(500).json({ error: 'Failed to load customers' });
      }
      res.json(rows);
    }
  );
});

// Create a new customer (admin only). Accepts { display_name, username?, password? }.
router.post('/', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const { display_name, username } = req.body || {};
  if (!display_name || !String(display_name).trim()) {
    return res.status(400).json({ error: 'display_name is required' });
  }

  const suppliedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
  const generated = suppliedPassword.length === 0;
  const password = generated ? generatePassword() : suppliedPassword;
  const baseName = username && String(username).trim()
    ? String(username).trim()
    : String(display_name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  function findUnique(nameBase, counter, cb) {
    const tryName = counter > 0 ? `${nameBase}-${counter}` : nameBase;
    db.get('SELECT id FROM users WHERE username = ?', [tryName], (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, tryName);
      findUnique(nameBase, counter + 1, cb);
    });
  }

  findUnique(baseName, 0, (err, uniqueUsername) => {
    if (err) {
      console.error('CUSTOMER CREATE ERROR:', err);
      return res.status(500).json({ error: 'Failed to check username availability' });
    }

    bcrypt.hash(password, BCRYPT_ROUNDS, (hashErr, hash) => {
      if (hashErr) {
        console.error('CUSTOMER CREATE ERROR:', hashErr);
        return res.status(500).json({ error: 'Failed to create customer' });
      }

      db.run(
        `INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES (?,?,?,?,datetime('now'))`,
        [uniqueUsername, hash, 'customer', display_name],
        function (insertErr) {
          if (insertErr) {
            console.error('CUSTOMER CREATE ERROR:', insertErr);
            return res.status(500).json({ error: 'Failed to create customer' });
          }
          const newId = this.lastID;
          db.get('SELECT id, username, display_name FROM users WHERE id = ?', [newId], (err2, row) => {
            const body = row || { id: newId, username: uniqueUsername, display_name };
            if (generated) body.password = password;
            if (err2) return res.status(201).json(body);
            res.status(201).json(body);
          });
        }
      );
    });
  });
});

module.exports = router;
