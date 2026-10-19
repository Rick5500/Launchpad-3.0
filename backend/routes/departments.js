const express = require('express');
const auth = require('../auth');
const db = require('../db');
const { withTransaction } = require('../dbAsync');
const activityLog = require('../activityLog');
const { httpError } = require('../httpError');
const { cascadeDepartmentRename } = require('../departmentRename');
const router = express.Router();

function parseBoolean(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  return 1;
}

function parseSortOrder(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isUniqueConstraint(err) {
  return Boolean(err && /UNIQUE constraint failed/i.test(err.message || ''));
}

function respondDepartmentWriteError(res, err, action) {
  if (err && err.status && err.publicMessage) {
    return res.status(err.status).json({ error: err.publicMessage });
  }
  if (isUniqueConstraint(err)) {
    const message = /barcode_locations\.location/i.test(err.message || '')
      ? 'A scan location already uses that name'
      : 'A department with that name already exists';
    return res.status(409).json({ error: message });
  }
  console.error(`DEPARTMENTS ${action.toUpperCase()} ERROR:`, err);
  return res.status(500).json({ error: `Failed to ${action} department` });
}

router.get('/', auth.requireAuth, (req, res) => {
  db.all(
    `SELECT id, name, description, color, icon, sort_order, is_active, created_at, updated_at
     FROM departments
     ORDER BY is_active DESC, sort_order ASC, name ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to load departments' });
      res.json(rows);
    }
  );
});

router.get('/:id', auth.requireAuth, (req, res) => {
  const id = req.params.id;
  db.get(
    `SELECT id, name, description, color, icon, sort_order, is_active, created_at, updated_at
     FROM departments
     WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) {
        console.error('DEPARTMENTS LOAD ERROR:', err);
        return res.status(500).json({ error: 'Failed to load department' });
      }
      if (!row) return res.status(404).json({ error: 'Department not found' });
      res.json(row);
    }
  );
});

router.post('/', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const payload = req.body || {};
  const name = String(payload.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const description = String(payload.description || '').trim();
  const color = String(payload.color || '').trim();
  const icon = String(payload.icon || '').trim();
  const sortOrder = parseSortOrder(payload.sort_order);
  const isActive = parseBoolean(payload.is_active ?? 1);

  db.get(
    'SELECT id FROM departments WHERE lower(name) = lower(?)',
    [name],
    (lookupErr, collision) => {
      if (lookupErr) return respondDepartmentWriteError(res, lookupErr, 'create');
      if (collision) {
        return res.status(409).json({ error: 'A department with that name already exists' });
      }
      insertDepartment();
    }
  );

  function insertDepartment() {
    db.run(
      `INSERT INTO departments (name, description, color, icon, sort_order, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [name, description, color, icon, sortOrder, isActive],
      function (err) {
        if (err) return respondDepartmentWriteError(res, err, 'create');

        const newId = this.lastID;
        db.get('SELECT * FROM departments WHERE id = ?', [newId], (err2, row) => {
          if (err2) return res.status(201).json({ id: newId });
          res.status(201).json(row || { id: newId });
        });
      }
    );
  }
});

router.put('/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  const id = req.params.id;
  const payload = req.body || {};
  const name = String(payload.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const description = String(payload.description || '').trim();
  const color = String(payload.color || '').trim();
  const icon = String(payload.icon || '').trim();
  const sortOrder = parseSortOrder(payload.sort_order);
  const isActive = parseBoolean(payload.is_active ?? 1);

  try {
    const row = await withTransaction(async (tx) => {
      const existing = await tx.get('SELECT * FROM departments WHERE id = ?', [id]);
      if (!existing) return null;
      const previousName = String(existing.name || '');
      const collision = await tx.get(
        'SELECT id FROM departments WHERE id != ? AND lower(name) = lower(?)',
        [existing.id, name]
      );
      if (collision) {
        throw httpError(409, 'A department with that name already exists');
      }
      await tx.run(
        `UPDATE departments
         SET name = ?, description = ?, color = ?, icon = ?, sort_order = ?, is_active = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [name, description, color, icon, sortOrder, isActive, id]
      );
      if (previousName !== name) {
        const changes = await cascadeDepartmentRename(tx, previousName, name);
        await activityLog.recordOn(tx, req.user.userId, 'department.updated', 'department', existing.id, {
          previous_name: previousName,
          name,
          users_updated: changes.users,
          changes,
          message: `Renamed department ${previousName} to ${name}`,
        });
      }
      return tx.get('SELECT * FROM departments WHERE id = ?', [id]);
    });
    if (!row) return res.status(404).json({ error: 'Department not found' });
    res.json(row);
  } catch (err) {
    return respondDepartmentWriteError(res, err, 'update');
  }
});

router.delete('/:id', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const id = req.params.id;
  db.run(
    `UPDATE departments SET is_active = 0, updated_at = datetime('now') WHERE id = ?`,
    [id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to deactivate department' });
      if (this.changes === 0) return res.status(404).json({ error: 'Department not found' });
      db.get('SELECT * FROM departments WHERE id = ?', [id], (err2, row) => {
        if (err2) return res.status(500).json({ error: 'Failed to load department' });
        res.json(row);
      });
    }
  );
});

module.exports = router;
