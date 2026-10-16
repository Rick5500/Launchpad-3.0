const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const auth = require('../auth');
const db = require('../db');
const { resetUserPassword } = require('../passwordReset');

const router = express.Router();
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;

function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function parsePositiveInteger(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) return null;
    return value;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

// Read-only directory for staff who create work orders. No role, timestamps, or secrets.
router.get('/lookup', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
  db.all(
    `SELECT id, username, display_name, company, contact_name, phone, email
     FROM users
     WHERE role = 'customer'
     ORDER BY display_name ASC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('CUSTOMERS LOOKUP ERROR:', err);
        return res.status(500).json({ error: 'Failed to load customers' });
      }
      res.json(rows);
    }
  );
});

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

  function optionalProfile(value, field, max) {
    if (value == null || value === '') return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.length > max) return { error: `${field} must be ${max} characters or fewer` };
    return text;
  }

  const company = optionalProfile(req.body?.company, 'company', 160);
  const contactName = optionalProfile(req.body?.contact_name, 'contact_name', 160);
  const phone = optionalProfile(req.body?.phone, 'phone', 40);
  const email = optionalProfile(req.body?.email, 'email', 160);
  const profileError = [company, contactName, phone, email].find((value) => value && value.error);
  if (profileError) return res.status(400).json({ error: profileError.error });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'email is invalid' });
  }

  const suppliedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
  const generated = suppliedPassword.length === 0;
  if (!generated && suppliedPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
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
        `INSERT INTO users (username, password_hash, role, display_name, company, contact_name, phone, email, created_at)
         VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
        [uniqueUsername, hash, 'customer', display_name, company, contactName, phone, email],
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

// Replace a customer password (admin only). Omit password to generate one and return it once.
router.put('/:id/password', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });

  const suppliedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
  const generated = suppliedPassword.length === 0;
  if (!generated && suppliedPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  const password = generated ? generatePassword() : suppliedPassword;

  db.get('SELECT id, username, role FROM users WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('CUSTOMER PASSWORD RESET ERROR:', err);
      return res.status(500).json({ error: 'Failed to reset password' });
    }
    if (!row || row.role !== 'customer') {
      return res.status(404).json({ error: 'Customer not found' });
    }

    resetUserPassword({
      user: row,
      password,
      actorId: req.user.userId,
    })
      .then((result) => res.json(result))
      .catch((resetErr) => {
        if (resetErr && resetErr.status && resetErr.publicMessage) {
          return res.status(resetErr.status).json({ error: resetErr.publicMessage });
        }
        console.error('CUSTOMER PASSWORD RESET ERROR:', resetErr);
        return res.status(500).json({ error: 'Failed to reset password' });
      });
  });
});

module.exports = router;
