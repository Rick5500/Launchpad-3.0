const fs = require('fs');
const db = require('./db');
const { safeStoredPath } = require('./fileStore');

const DEFAULT_UNATTACHED_LIMIT = 30;
const DEFAULT_ORPHAN_HOURS = 24;
const DEFAULT_SWEEP_INTERVAL_SECONDS = 3600;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function maxUnattachedUploads() {
  const parsed = Number(process.env.MAX_UNATTACHED_UPLOADS);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_UNATTACHED_LIMIT;
  return parsed;
}

function orphanHours() {
  const parsed = Number(process.env.UPLOAD_ORPHAN_HOURS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ORPHAN_HOURS;
  return parsed;
}

function sweepIntervalSeconds() {
  const parsed = Number(process.env.UPLOAD_SWEEP_INTERVAL_SECONDS);
  if (!Number.isFinite(parsed) || parsed < 60) return DEFAULT_SWEEP_INTERVAL_SECONDS;
  return parsed;
}

async function countUnattachedUploads(userId) {
  const row = await get(
    `SELECT COUNT(*) AS count
     FROM order_files
     WHERE order_id IS NULL AND uploaded_by = ?`,
    [userId]
  );
  return row ? row.count : 0;
}

async function sweepOrphanUploads() {
  const hours = orphanHours();
  const rows = await all(
    `SELECT id, stored_name
     FROM order_files
     WHERE order_id IS NULL
       AND datetime(uploaded_at) <= datetime('now', ?)`,
    [`-${hours} hours`]
  );
  for (const row of rows) {
    const deleted = await run(
      'DELETE FROM order_files WHERE id = ? AND order_id IS NULL',
      [row.id]
    );
    if (!deleted.changes) continue;
    const fullPath = safeStoredPath(row.stored_name);
    if (!fullPath) continue;
    fs.unlink(fullPath, (err) => {
      if (err && err.code !== 'ENOENT') console.error('UPLOAD SWEEP ERROR:', err.message);
    });
  }
  return rows.length;
}

function startOrphanSweep() {
  const timer = setInterval(() => {
    sweepOrphanUploads().catch((err) => console.error('UPLOAD SWEEP ERROR:', err));
  }, sweepIntervalSeconds() * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  sweepOrphanUploads().catch((err) => console.error('UPLOAD SWEEP ERROR:', err));
  return timer;
}

module.exports = {
  maxUnattachedUploads,
  countUnattachedUploads,
  sweepOrphanUploads,
  startOrphanSweep,
};
