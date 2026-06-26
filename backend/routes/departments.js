const express = require('express');
const auth = require('../auth');
const db = require('../db');
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
  return res.status(500).json({ error: err.message });
}
      if (!row) return res.status(404).json({ error: 'Department not found' });
      res.json(row);
    }
  );
});

router.post('/', auth.requireAuth, (req, res) => {
  const payload = req.body || {};
  const name = String(payload.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const description = String(payload.description || '').trim();
  const color = String(payload.color || '').trim();
  const icon = String(payload.icon || '').trim();
  const sortOrder = parseSortOrder(payload.sort_order);
  const isActive = parseBoolean(payload.is_active ?? 1);

  db.run(
    `INSERT INTO departments (name, description, color, icon, sort_order, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [name, description, color, icon, sortOrder, isActive],
    function (err) {
      if (err) {
        console.error('DEPARTMENTS ERROR:', err);
        return res.status(500).json({ error: err.message });
      }

      const newId = this.lastID;
      db.get('SELECT * FROM departments WHERE id = ?', [newId], (err2, row) => {
        if (err2) return res.status(201).json({ id: newId });
        res.status(201).json(row || { id: newId });
      });
    }
  );
});

router.put('/:id', auth.requireAuth, (req, res) => {
  const id = req.params.id;
  const payload = req.body || {};
  const name = String(payload.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const description = String(payload.description || '').trim();
  const color = String(payload.color || '').trim();
  const icon = String(payload.icon || '').trim();
  const sortOrder = parseSortOrder(payload.sort_order);
  const isActive = parseBoolean(payload.is_active ?? 1);

  db.run(
    `UPDATE departments
     SET name = ?, description = ?, color = ?, icon = ?, sort_order = ?, is_active = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [name, description, color, icon, sortOrder, isActive, id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to update department' });
      if (this.changes === 0) return res.status(404).json({ error: 'Department not found' });
      db.get('SELECT * FROM departments WHERE id = ?', [id], (err2, row) => {
        if (err2) return res.status(500).json({ error: 'Failed to load updated department' });
        res.json(row);
      });
    }
  );
});

router.delete('/:id', auth.requireAuth, (req, res) => {
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
