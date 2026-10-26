const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const auth = require('../auth');
const db = require('../db');
const activityLog = require('../activityLog');
const { withTransaction } = require('../dbAsync');
const { parseUsername, updateCustomerAddress, updateCustomerTexting } = require('../userAdmin');
const { parsePostalAddress } = require('../fields');
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
router.get('/lookup', auth.requireAuth, auth.requireRole('admin', 'manager', 'operator'), (req, res) => {
  db.all(
    `SELECT id, username, display_name, company, contact_name, phone, email,
            address_line1, address_line2, city, state, zip, location_id
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

router.get('/', auth.requireAuth, auth.requireRole('admin', 'manager'), (req, res) => {
  db.all(
    `SELECT id, username, display_name, role, company, contact_name, phone, email,
            mobile_phone, sms_opt_in,
            address_line1, address_line2, city, state, zip, created_at
     FROM users
     WHERE role = 'customer'
     ORDER BY display_name ASC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('CUSTOMERS LIST ERROR:', err);
        return res.status(500).json({ error: 'Failed to load customers' });
      }
      res.json((rows || []).map((row) => ({
        ...row,
        mobile_phone: row.mobile_phone || '',
        sms_opt_in: Number(row.sms_opt_in) === 1,
      })));
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

function isUniqueConstraint(err) {
  return Boolean(err) && /UNIQUE constraint failed/i.test(String(err.message || ''));
}

function isUsernameConstraint(err) {
  return isUniqueConstraint(err) && /users\.username/i.test(String(err.message || ''));
}

async function reserveUsername(tx, nameBase, explicit) {
  const taken = (name) => tx.get(
    'SELECT id FROM users WHERE lower(trim(username)) = lower(trim(?))',
    [name]
  );
  if (explicit) {
    const existing = await taken(nameBase);
    if (existing) {
      const error = new Error('Username is already in use');
      error.status = 409;
      error.publicMessage = 'Username is already in use';
      throw error;
    }
    return nameBase;
  }
  for (let counter = 0; counter < 1000; counter += 1) {
    const tryName = counter > 0 ? `${nameBase}-${counter}` : nameBase;
    const existing = await taken(tryName);
    if (!existing) return tryName;
  }
  const error = new Error('Could not assign a username');
  error.status = 409;
  error.publicMessage = 'Could not assign a username';
  throw error;
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
  const address = parsePostalAddress(req.body || {}, false);
  const profileError = [company, contactName, phone, email].find((value) => value && value.error);
  if (profileError) return res.status(400).json({ error: profileError.error });
  if (address.error) return res.status(400).json({ error: address.error });
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
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    let created = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      try {
        created = await withTransaction(async (tx) => {
          const uniqueUsername = await reserveUsername(tx, baseName, Boolean(suppliedName));
          const inserted = await tx.run(
            `INSERT INTO users (
               username, password_hash, role, display_name, company, contact_name, phone, email,
               address_line1, address_line2, city, state, zip, created_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
            [
              uniqueUsername,
              hash,
              'customer',
              String(display_name).trim(),
              company,
              contactName,
              phone,
              email,
              address.value.addressLine1,
              address.value.addressLine2,
              address.value.city,
              address.value.state,
              address.value.zip,
            ]
          );
          await activityLog.recordOn(tx, req.user.userId, 'user.created', 'user', inserted.lastID, {
            username: uniqueUsername,
            role: 'customer',
            message: `Created customer ${uniqueUsername}`,
          });
          const row = await tx.get('SELECT id, username, display_name FROM users WHERE id = ?', [inserted.lastID]);
          return { row, uniqueUsername };
        });
      } catch (err) {
        lastErr = err;
        if (!isUsernameConstraint(err) || attempt === 4) throw err;
      }
    }
    if (!created) throw lastErr || new Error('Failed to create customer');
    const body = created.row || { username: created.uniqueUsername, display_name: String(display_name).trim() };
    if (generated) body.password = password;
    return res.status(201).json(body);
  } catch (err) {
    if (err && err.status && err.publicMessage) {
      return res.status(err.status).json({ error: err.publicMessage });
    }
    if (isUsernameConstraint(err)) {
      return res.status(409).json({ error: 'Username is already in use' });
    }
    if (isUniqueConstraint(err)) {
      return res.status(409).json({ error: 'That value is already in use' });
    }
    console.error('CUSTOMER CREATE ERROR:', err);
    return res.status(500).json({ error: 'Failed to create customer' });
  }
});

// Mobile number and order-status text consent. Admins and managers can edit a customer record.
router.put('/:id/texting', auth.requireAuth, auth.requireRole('admin', 'manager'), async (req, res) => {
  try {
    const updated = await updateCustomerTexting(req.user.userId, req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    if (err && err.status && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('CUSTOMER TEXTING UPDATE ERROR:', err);
    return res.status(500).json({ error: 'Failed to update customer' });
  }
});

// Replace the company address stored on a customer profile. Orders keep the address they snapshotted.
router.put('/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const updated = await updateCustomerAddress(req.user.userId, req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    if (err && err.status && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('CUSTOMER ADDRESS UPDATE ERROR:', err);
    return res.status(500).json({ error: 'Failed to update customer' });
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
