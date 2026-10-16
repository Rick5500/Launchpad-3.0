const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const auth = require('../auth');
const db = require('../db');
const activityLog = require('../activityLog');
const { withTransaction } = require('../dbAsync');
const { parseUsername } = require('../userAdmin');
const { resetUserPassword, passwordPolicyError } = require('../passwordReset');

const router = express.Router();
const BCRYPT_ROUNDS = 10;

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
     WHERE role = 'customer' AND COALESCE(is_active, 1) = 1
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

function optionalProfile(value, field, max) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) return { error: `${field} must be ${max} characters or fewer` };
  return text;
}

function findUniqueUsername(nameBase, counter) {
  const tryName = counter > 0 ? `${nameBase}-${counter}` : nameBase;
  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM users WHERE username = ?', [tryName], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(tryName);
      resolve(findUniqueUsername(nameBase, counter + 1));
    });
  });
}

// Create a new customer (admin only). Accepts { display_name, username?, password? }.
router.post('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  const { display_name, username } = req.body || {};
  if (!display_name || !String(display_name).trim()) {
    return res.status(400).json({ error: 'display_name is required' });
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
  if (!generated) {
    const policyError = passwordPolicyError(suppliedPassword);
    if (policyError) return res.status(400).json({ error: policyError });
  }
  const password = generated ? generatePassword() : suppliedPassword;
  const suppliedName = username && String(username).trim() ? String(username).trim() : '';
  if (suppliedName) {
    const parsed = parseUsername(suppliedName, true);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
  }
  const baseName = suppliedName
    || String(display_name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  if (!suppliedName) {
    const parsed = parseUsername(baseName, true);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
  }

  try {
    const uniqueUsername = await findUniqueUsername(baseName, 0);
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const row = await withTransaction(async (tx) => {
      const inserted = await tx.run(
        `INSERT INTO users (username, password_hash, role, display_name, company, contact_name, phone, email, created_at)
         VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
        [uniqueUsername, hash, 'customer', String(display_name).trim(), company, contactName, phone, email]
      );
      await activityLog.recordOn(tx, req.user.userId, 'user.created', 'user', inserted.lastID, {
        username: uniqueUsername,
        role: 'customer',
        message: `Created customer ${uniqueUsername}`,
      });
      return tx.get('SELECT id, username, display_name FROM users WHERE id = ?', [inserted.lastID]);
    });
    const body = row || { username: uniqueUsername, display_name: String(display_name).trim() };
    if (generated) body.password = password;
    return res.status(201).json(body);
  } catch (err) {
    console.error('CUSTOMER CREATE ERROR:', err);
    return res.status(500).json({ error: 'Failed to create customer' });
  }
});

// Replace a customer password (admin only). Omit password to generate one and return it once.
router.put('/:id/password', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) return res.status(400).json({ error: 'id must be a positive integer' });

  const suppliedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
  const generated = suppliedPassword.length === 0;
  if (!generated) {
    const policyError = passwordPolicyError(suppliedPassword);
    if (policyError) return res.status(400).json({ error: policyError });
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
