// Point stored file rows at the current UPLOAD_DIR / UPLOADS_DIR after the
// database and upload files are copied onto a new disk. Dry-run unless --apply.
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('../runtimeConfig').applyPathAliases();

const fileStore = require('../fileStore');

const TABLES = ['order_files', 'shared_files', 'proof_files', 'inbound_email_attachments'];
const apply = process.argv.includes('--apply');

function open(file) {
  const db = new sqlite3.Database(file);
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes });
    });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  return { run, get, all, close };
}

async function columns(db, table) {
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

async function main() {
  const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', '..', 'database', 'launchpad.db');
  const target = fileStore.environmentRoot() || fileStore.defaultRoot();
  if (!target || !path.isAbsolute(target)) {
    console.error('UPLOADS_DIR or UPLOAD_DIR must be an absolute folder on this computer.');
    process.exit(1);
  }
  if (!fs.existsSync(dbFile)) {
    console.error(`Database file not found: ${dbFile}`);
    process.exit(1);
  }
  const db = open(dbFile);
  const summary = { target, apply, updated: 0, already: 0, missing: 0, tables: {} };
  try {
    for (const table of TABLES) {
      const exists = await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
      if (!exists) continue;
      const cols = await columns(db, table);
      if (!cols.has('stored_name') || !cols.has('storage_root')) continue;
      const rows = await db.all(`SELECT id, stored_name, storage_root FROM ${table}`);
      let updated = 0;
      let already = 0;
      let missing = 0;
      for (const row of rows) {
        const name = String(row.stored_name || '');
        if (!/^[a-f0-9]{32}\.[a-z0-9]{1,8}$/.test(name)) {
          missing += 1;
          continue;
        }
        const full = path.join(target, name);
        if (!fs.existsSync(full)) {
          missing += 1;
          continue;
        }
        if (row.storage_root && fileStore.rootsEqual(row.storage_root, target)) {
          already += 1;
          continue;
        }
        updated += 1;
        if (apply) {
          await db.run(`UPDATE ${table} SET storage_root = ? WHERE id = ?`, [target, row.id]);
        }
      }
      summary.tables[table] = { updated, already, missing };
      summary.updated += updated;
      summary.already += already;
      summary.missing += missing;
    }

    let marker = '';
    const markerFile = path.join(target, '.launchpad-storage');
    if (fs.existsSync(markerFile)) {
      const text = fs.readFileSync(markerFile, 'utf8').trim();
      if (/^[a-f0-9]{32}$/.test(text)) marker = text;
    }
    if (apply) {
      if (!marker) {
        marker = require('crypto').randomBytes(16).toString('hex');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(markerFile, `${marker}\n`);
      }
      const map = { [target]: marker };
      await db.run(
        `INSERT INTO system_settings (key, value, updated_at) VALUES ('file_storage_dir', ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        [target]
      );
      await db.run(
        `INSERT INTO system_settings (key, value, updated_at) VALUES ('file_storage_marker', ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        [JSON.stringify(map)]
      );
      await db.run(
        `INSERT INTO file_storage_roots (path, created_at) VALUES (?, datetime('now'))
         ON CONFLICT(path) DO NOTHING`,
        [target]
      );
    }
    summary.marker = marker || null;
    console.log(JSON.stringify(summary, null, 2));
    if (!apply) console.log('Dry run. Pass --apply to update the database.');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
