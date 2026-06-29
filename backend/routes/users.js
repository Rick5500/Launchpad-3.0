const express = require('express');
const crypto = require('crypto');
const auth = require('../auth');
const db = require('../db');
const router = express.Router();

const validRoles = ['employee', 'manager', 'admin'];

// GET /api/users - List all users (admin only)
router.get('/', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  db.all(
    `SELECT id, username, role, display_name, created_at FROM users ORDER BY created_at DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('USERS LIST ERROR:', err);
        return res.status(500).json({ error: err.message });
      }

      res.json(rows || []);
    }
  );
});

// GET /api/users/:id - Get user by ID (admin only)
router.get('/:id', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const id = req.params.id;
  db.get(
    `SELECT id, username, role, display_name, created_at FROM users WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) {
        console.error('USER LOAD ERROR:', err);
        return res.status(500).json({ error: err.message });
      }

      if (!row) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(row);
    }
  );
});

// POST /api/users - Create new user (admin only)
router.post('/', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const { username, password, role, display_name } = req.body || {};

  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'username is required' });
  }

  if (!password || !password.trim()) {
    return res.status(400).json({ error: 'password is required' });
  }

  const normalizedRole = String(role || 'employee').toLowerCase();
  if (!validRoles.includes(normalizedRole)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
  }

  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  const displayName = display_name ? String(display_name).trim() : username;

  db.run(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)`,
    [username, passwordHash, normalizedRole, displayName],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(409).json({ error: 'Username already exists' });
        }
        console.error('USER CREATE ERROR:', err);
        return res.status(500).json({ error: 'Failed to create user' });
      }

      const newId = this.lastID;
      db.get(
        `SELECT id, username, role, display_name, created_at FROM users WHERE id = ?`,
        [newId],
        (err2, row) => {
          if (err2) return res.status(201).json({ id: newId });
          res.status(201).json(row || { id: newId });
        }
      );
    }
  );
});

// PUT /api/users/:id - Update user (admin only)
router.put('/:id', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const id = req.params.id;
  const { role, display_name, password } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  const normalizedRole = role ? String(role).toLowerCase() : null;
  if (normalizedRole && !validRoles.includes(normalizedRole)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
  }

  const displayName = display_name ? String(display_name).trim() : null;

  let query = 'UPDATE users SET';
  let params = [];
  let updates = [];

  if (normalizedRole) {
    updates.push('role = ?');
    params.push(normalizedRole);
  }

  if (displayName) {
    updates.push('display_name = ?');
    params.push(displayName);
  }

  if (password) {
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    updates.push('password_hash = ?');
    params.push(passwordHash);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'At least one field (role, display_name, password) is required' });
  }

  params.push(id);

  db.run(
    `${query} ${updates.join(', ')} WHERE id = ?`,
    params,
    function (err) {
      if (err) {
        console.error('USER UPDATE ERROR:', err);
        return res.status(500).json({ error: 'Failed to update user' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      db.get(
        `SELECT id, username, role, display_name, created_at FROM users WHERE id = ?`,
        [id],
        (err2, row) => {
          if (err2) return res.status(500).json({ error: 'Failed to load updated user' });
          res.json(row);
        }
      );
    }
  );
});

// DELETE /api/users/:id - Delete user (admin only)
router.delete('/:id', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const id = req.params.id;

  if (!id) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  // Prevent deleting the current user
  if (req.user && req.user.userId === parseInt(id, 10)) {
    return res.status(400).json({ error: 'Cannot delete your own user account' });
  }

  db.run(
    `DELETE FROM users WHERE id = ?`,
    [id],
    function (err) {
      if (err) {
        console.error('USER DELETE ERROR:', err);
        return res.status(500).json({ error: 'Failed to delete user' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ success: true, message: 'User deleted successfully' });
    }
  );
});

module.exports = router;
