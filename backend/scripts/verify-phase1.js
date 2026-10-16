/**
 * Phase 1 checks: migrations, order API, role rules, upload limits, and customer isolation.
 * Usage (from backend/): node scripts/verify-phase1.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();

const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');
const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase1-'));
const oldDb = path.join(tmp, 'old.db');
const freshDb = path.join(tmp, 'fresh.db');
const uploadDir = path.join(tmp, 'uploads');
const port = 3099;
const adminPassword = 'AdminPass123';

const OLD_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  display_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  color TEXT DEFAULT '#90caf9',
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);
CREATE TABLE production_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#90caf9',
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);
CREATE TABLE work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  customer_id INTEGER,
  description TEXT,
  quantity INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open',
  department TEXT DEFAULT 'General',
  stage_id INTEGER,
  priority TEXT DEFAULT 'Normal',
  assigned_department_id INTEGER,
  assigned_user_id INTEGER,
  estimated_hours REAL,
  actual_hours REAL,
  specifications TEXT,
  start_date DATETIME,
  due_date DATETIME,
  production_line TEXT,
  routing_instructions TEXT,
  attachments TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY(customer_id) REFERENCES users(id)
);
CREATE TABLE production_board (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL,
  lane TEXT,
  position INTEGER,
  status TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE barcode_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned_value TEXT NOT NULL,
  work_order_id INTEGER,
  operator_id INTEGER,
  location TEXT,
  event_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  stage_id INTEGER
);
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER,
  will_call BOOLEAN DEFAULT 0,
  due_time DATETIME,
  carrier TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);
`;

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.name = 'AssertionError';
    throw error;
  }
}

function openDb(file) {
  const db = new sqlite3.Database(file);
  db.configure('busyTimeout', 8000);
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  const exec = (sql) => new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  return { run, get, all, exec, close };
}

function spawnNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: backendDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err, child }));
    return child;
  });
}

function baseEnv(databaseFile) {
  return {
    DATABASE_FILE: databaseFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    UPLOAD_DIR: uploadDir,
    MAX_UPLOAD_MB: '0.02',
    MAX_UPLOAD_FILES: '5',
    DELIVERY_TIMEZONE: 'UTC',
    DELIVERY_WINDOW_START: '09:00',
    DELIVERY_WINDOW_END: '14:00',
    DELIVERY_SLOT_MINUTES: '15',
    MAX_UNATTACHED_UPLOADS: '8',
    UPLOAD_ORPHAN_HOURS: '24',
    PORT: String(port),
    NODE_ENV: 'test',
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
  };
}

function utcDate(offsetDays = 0) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateKey(date) {
  return isoDate(date).replace(/-/g, '');
}

function upcomingWeekday(weekday) {
  for (let offset = 1; offset <= 7; offset += 1) {
    const date = utcDate(offset);
    if (date.getUTCDay() === weekday) return isoDate(date);
  }
  throw new Error('no weekday found');
}

function request({ method, path: requestPath, token, json, raw, contentType }) {
  return new Promise((resolve, reject) => {
    const body = json != null ? Buffer.from(JSON.stringify(json)) : raw;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json != null) headers['Content-Type'] = 'application/json';
    if (contentType) headers['Content-Type'] = contentType;
    if (body) headers['Content-Length'] = body.length;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let parsed = null;
        const text = buffer.toString('utf8');
        try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
        resolve({ status: res.statusCode, json: parsed, text, buffer, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function multipartBody(files) {
  const boundary = `----Launchpad${Date.now()}`;
  const parts = [];
  for (const file of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
    ));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    raw: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function initDatabase(databaseFile) {
  const result = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv(databaseFile));
  if (result.code !== 0) {
    throw new Error(`init_db failed (${result.code})\n${result.out}\n${result.err}`);
  }
  return result;
}

async function columnNames(db, table) {
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

async function migrateOldDatabase() {
  const db = openDb(oldDb);
  await db.exec(OLD_SCHEMA);
  await db.run(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES ('legacy', 'x', 'customer', 'Legacy Co')`
  );
  await db.run(
    `INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department)
     VALUES ('WO-LEGACY', 1, 'Legacy job', 3, 'complete', 'Quality')`
  );
  await db.exec(`
    CREATE TABLE delivery_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      will_call INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO delivery_methods (name, will_call, sort_order, is_active) VALUES
      ('Accent Truck', 0, 1, 1),
      ('Will Call', 1, 2, 1),
      ('Customer Pickup', 1, 3, 1),
      ('UPS', 0, 4, 1),
      ('FedEx', 0, 5, 1),
      ('Common Carrier', 0, 6, 1);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      company TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      po_number TEXT,
      project_number TEXT,
      project_name TEXT,
      notes TEXT,
      delivery_method TEXT NOT NULL,
      ship_to TEXT,
      attention TEXT,
      due_date TEXT NOT NULL,
      due_time TEXT NOT NULL,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    );
  `);
  await db.run(
    `INSERT INTO orders (
      order_number, customer_id, company, contact_name, phone, email, delivery_method, due_date, due_time
    ) VALUES ('LEGACY-PICKUP', 1, 'Legacy Co', 'Pat', '919-555-0100', 'pat@legacy.example', 'Customer Pickup', '2020-01-06', '18:00')`
  );
  await db.run(
    `INSERT INTO orders (
      order_number, customer_id, company, contact_name, phone, email, delivery_method, due_date, due_time
    ) VALUES ('LEGACY-FEDEX', 1, 'Legacy Co', 'Pat', '919-555-0100', 'pat@legacy.example', 'FedEx', '2020-01-06', '16:30')`
  );
  await db.exec(`
    CREATE TABLE order_line_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      service_id INTEGER,
      work_order_id INTEGER,
      line_number INTEGER NOT NULL,
      description TEXT NOT NULL,
      size TEXT,
      quantity TEXT,
      media TEXT,
      color TEXT,
      binding_finish TEXT,
      finishing TEXT,
      mount INTEGER DEFAULT 0,
      laminate INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.run(
    `INSERT INTO order_line_items (order_id, line_number, description, mount, laminate)
     SELECT id, 1, 'Legacy banner', 1, 0 FROM orders WHERE order_number = 'LEGACY-PICKUP'`
  );
  await db.close();

  await initDatabase(oldDb);
  await initDatabase(oldDb);

  const check = openDb(oldDb);
  const legacy = await check.get(`SELECT external_id, status FROM work_orders WHERE external_id = 'WO-LEGACY'`);
  assert(legacy && legacy.status === 'completed', 'legacy work order should survive init and normalize complete -> completed');
  const legacyCount = await check.get(`SELECT COUNT(*) AS count FROM work_orders WHERE external_id = 'WO-LEGACY'`);
  assert(legacyCount.count === 1, 'init should not duplicate the legacy work order');

  const ordersTable = await check.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orders'`);
  assert(ordersTable, 'orders table should be created on an older database');
  for (const table of ['services', 'order_line_items', 'order_files', 'delivery_methods', 'order_sequences', 'production_history', 'activity_log']) {
    const row = await check.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
    assert(row, `${table} should exist after migrating an older database`);
  }

  const userColumns = await columnNames(check, 'users');
  assert(userColumns.has('company') && userColumns.has('email'), 'user profile columns should be added');
  const workOrderColumns = await columnNames(check, 'work_orders');
  assert(workOrderColumns.has('order_id') && workOrderColumns.has('service_id') && workOrderColumns.has('next_department'), 'work order order columns should be added');
  const deliveryColumns = await columnNames(check, 'deliveries');
  assert(deliveryColumns.has('order_id'), 'deliveries.order_id should be added');

  const services = await check.get('SELECT COUNT(*) AS count FROM services');
  assert(services.count === 7, `expected 7 services after two inits, found ${services.count}`);
  const departments = await check.all('SELECT name FROM departments');
  const names = new Set(departments.map((row) => row.name));
  for (const name of ['Large Format', 'Planroom', 'Archive File', 'Quality', 'Dispatch', 'Complete', 'Reprographics', 'Admin']) {
    assert(names.has(name), `department ${name} should exist after migration`);
  }
  const route = await check.get(`SELECT next_department FROM departments WHERE name = 'Large Format'`);
  assert(route && route.next_department === 'Quality', 'Large Format should route to Quality');
  const externalIndex = await check.get(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_orders_external_id'`
  );
  assert(externalIndex, 'unique external_id index should be created when existing values are unique');
  const notifications = await check.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`);
  assert(notifications, 'notifications table should be created on an older database');
  const orderColumns = await columnNames(check, 'orders');
  assert(orderColumns.has('ups_account_number'), 'orders.ups_account_number should be added on an older database');
  assert(orderColumns.has('originals_source') && orderColumns.has('address_line1') && orderColumns.has('zip'), 'order originals and address columns should be added on an older database');
  assert(userColumns.has('address_line1') && userColumns.has('city') && userColumns.has('state') && userColumns.has('zip'), 'user address columns should be added on an older database');
  const pickup = await check.get(`SELECT delivery_method, due_time, ups_account_number FROM orders WHERE order_number = 'LEGACY-PICKUP'`);
  assert(pickup && pickup.delivery_method === 'Customer Pickup' && pickup.due_time === '18:00', 'legacy Customer Pickup label and time should stay');
  assert(pickup.ups_account_number == null, 'migrated orders should leave the new account column empty');
  assert(orderColumns.has('payment_method') && orderColumns.has('return_to') && orderColumns.has('bill_to_name') && orderColumns.has('bill_to_zip'), 'payment, return, and bill-to columns should be added on an older database');
  const pickupPayment = await check.get(`SELECT payment_method, bill_to_company FROM orders WHERE order_number = 'LEGACY-PICKUP'`);
  assert(pickupPayment.payment_method == null && pickupPayment.bill_to_company == null, 'migrated orders should leave payment and bill-to empty');
  const lineColumns = await columnNames(check, 'order_line_items');
  assert(lineColumns.has('field_values'), 'order_line_items.field_values should be added on an older database');
  const banner = await check.get(`SELECT description, mount, laminate, field_values FROM order_line_items WHERE description = 'Legacy banner'`);
  assert(banner && banner.description === 'Legacy banner' && banner.mount === 1 && banner.laminate === 0 && banner.field_values == null, 'a pre-existing line item should stay intact with a null field_values column');
  const fieldCount = await check.get('SELECT COUNT(*) AS count FROM service_fields');
  assert(fieldCount.count === 54, `expected 54 seeded service fields after two inits, found ${fieldCount.count}`);
  const fieldsTable = await check.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'service_fields'`);
  assert(fieldsTable, 'service_fields should exist after migrating an older database');
  const fedex = await check.get(`SELECT delivery_method, due_time FROM orders WHERE order_number = 'LEGACY-FEDEX'`);
  assert(fedex && fedex.delivery_method === 'FedEx' && fedex.due_time === '16:30', 'legacy FedEx label should stay');
  const methodRows = await check.all(`SELECT name, is_active FROM delivery_methods ORDER BY name`);
  assert(methodRows.length === 6, `retired methods should be kept, found ${methodRows.length}`);
  const inactive = new Set(methodRows.filter((row) => row.is_active === 0).map((row) => row.name));
  assert(inactive.has('Customer Pickup') && inactive.has('FedEx') && inactive.has('Common Carrier'), 'retired methods should be inactive, not deleted');
  const activeNames = methodRows.filter((row) => row.is_active === 1).map((row) => row.name).sort().join(',');
  assert(activeNames === 'Accent Truck,UPS,Will Call', `active methods were ${activeNames}`);
  await check.close();
  console.log('PASS older database migration, twice');
}

async function migrateDuplicateExternalIds() {
  const dupDb = path.join(tmp, 'dup.db');
  const db = openDb(dupDb);
  await db.exec(OLD_SCHEMA);
  await db.run(`INSERT INTO work_orders (external_id, description, quantity, status) VALUES ('DUP-1', 'one', 1, 'open')`);
  await db.run(`INSERT INTO work_orders (external_id, description, quantity, status) VALUES ('DUP-1', 'two', 1, 'open')`);
  await db.close();

  const result = await initDatabase(dupDb);
  assert(/Skipping unique index on work_orders.external_id/.test(`${result.out}\n${result.err}`), 'duplicate external ids should log a warning and continue');
  const check = openDb(dupDb);
  const index = await check.get(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_orders_external_id'`
  );
  assert(!index, 'unique external_id index should be skipped when duplicates exist');
  const dupes = await check.get(`SELECT COUNT(*) AS count FROM work_orders WHERE external_id = 'DUP-1'`);
  assert(dupes.count === 2, 'duplicate work orders should be left in place');
  await check.close();
  console.log('PASS duplicate external_id index skip');
}

async function checkOrphanSweep() {
  const sqliteDb = openDb(freshDb);
  const customer = await sqliteDb.get(`SELECT id FROM users WHERE role = 'customer' LIMIT 1`);
  assert(customer, 'seeded customer should exist before the sweep check');
  const order = await sqliteDb.run(
    `INSERT INTO orders (
      order_number, customer_id, company, contact_name, phone, email, delivery_method, due_date, due_time
    ) VALUES ('19990101-001', ?, 'Sweep Co', 'Sweep', '919-555-0100', 'sweep@example.com', 'Accent Truck', '1999-01-04', '09:00')`,
    [customer.id]
  );
  const oldName = `${'a'.repeat(32)}.pdf`;
  const keepName = `${'b'.repeat(32)}.pdf`;
  const attachedName = `${'c'.repeat(32)}.pdf`;
  fs.writeFileSync(path.join(uploadDir, oldName), 'old');
  fs.writeFileSync(path.join(uploadDir, keepName), 'keep');
  fs.writeFileSync(path.join(uploadDir, attachedName), 'attached');
  await sqliteDb.run(
    `INSERT INTO order_files (original_name, stored_name, size_bytes, uploaded_at)
     VALUES ('old.pdf', ?, 3, datetime('now', '-48 hours'))`,
    [oldName]
  );
  await sqliteDb.run(
    `INSERT INTO order_files (original_name, stored_name, size_bytes, uploaded_at)
     VALUES ('keep.pdf', ?, 4, datetime('now'))`,
    [keepName]
  );
  await sqliteDb.run(
    `INSERT INTO order_files (order_id, original_name, stored_name, size_bytes, uploaded_at)
     VALUES (?, 'attached.pdf', ?, 8, datetime('now', '-48 hours'))`,
    [order.lastID, attachedName]
  );
  await sqliteDb.close();

  process.env.DATABASE_FILE = freshDb;
  process.env.UPLOAD_DIR = uploadDir;
  process.env.UPLOAD_ORPHAN_HOURS = '24';
  const { sweepOrphanUploads } = require('../uploadMaintenance');
  const shared = require('../db');
  await sweepOrphanUploads();
  await new Promise((resolve, reject) => shared.close((err) => (err ? reject(err) : resolve())));

  const after = openDb(freshDb);
  const oldRow = await after.get('SELECT id FROM order_files WHERE stored_name = ?', [oldName]);
  const keepRow = await after.get('SELECT id FROM order_files WHERE stored_name = ?', [keepName]);
  const attachedRow = await after.get('SELECT id FROM order_files WHERE stored_name = ?', [attachedName]);
  assert(!oldRow, 'old unattached upload should be swept');
  assert(keepRow, 'recent unattached upload should remain');
  assert(attachedRow, 'old attached upload should remain');
  assert(!fs.existsSync(path.join(uploadDir, oldName)), 'swept file should be removed from disk');
  assert(fs.existsSync(path.join(uploadDir, attachedName)), 'attached file should stay on disk');
  await after.close();
  console.log('PASS orphan upload sweep');
}

async function initFreshTwice() {
  await initDatabase(freshDb);
  const second = await initDatabase(freshDb);
  assert(/Admin user already exists/.test(second.out), 'second init should keep the existing admin');
  assert(!/Generated admin password/.test(second.out), 'second init should not print a new admin password');
  const db = openDb(freshDb);
    const services = await db.get('SELECT COUNT(*) AS count FROM services');
  assert(services.count === 7, 'fresh init twice should leave 7 services');
  const methods = await db.all(`SELECT name, is_active FROM delivery_methods ORDER BY name`);
  assert(methods.length === 3, `fresh init should seed 3 delivery methods, found ${methods.length}`);
  assert(methods.every((row) => row.is_active === 1), 'fresh methods should be active');
  assert(methods.map((row) => row.name).join(',') === 'Accent Truck,UPS,Will Call', `fresh methods were ${methods.map((row) => row.name).join(',')}`);
  const orderColumns = await columnNames(db, 'orders');
  assert(orderColumns.has('ups_account_number'), 'fresh orders table should include ups_account_number');
  assert(orderColumns.has('originals_source') && orderColumns.has('address_line1') && orderColumns.has('address_line2') && orderColumns.has('city') && orderColumns.has('state') && orderColumns.has('zip'), 'fresh orders table should include originals and address columns');
  assert(orderColumns.has('payment_method') && orderColumns.has('return_to') && orderColumns.has('bill_to_company') && orderColumns.has('bill_to_zip'), 'fresh orders table should include payment, return, and bill-to columns');
  const lineColumns = await columnNames(db, 'order_line_items');
  assert(lineColumns.has('field_values'), 'fresh line items should include field_values');
  const fieldCount = await db.get('SELECT COUNT(*) AS count FROM service_fields');
  assert(fieldCount.count === 54, `fresh init twice should leave 54 service fields, found ${fieldCount.count}`);
  const freshUsers = await columnNames(db, 'users');
  assert(freshUsers.has('address_line1') && freshUsers.has('zip'), 'fresh users table should include address columns');
  const externalIndex = await db.get(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_orders_external_id'`
  );
  assert(externalIndex, 'fresh database should have a unique external_id index');
  await db.close();
  console.log('PASS fresh init_db twice');
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...baseEnv(freshDb) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let stopped = false;
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopped = true;
      reject(new Error(`server did not become ready\n${logs}`));
    }, 15000);
    const poll = async () => {
      if (stopped) return;
      try {
        const health = await request({ method: 'GET', path: '/api/health' });
        if (health.status === 200 && health.json && health.json.status === 'ok') {
          stopped = true;
          clearTimeout(timer);
          resolve();
          return;
        }
      } catch (err) {
        // server still starting
      }
      setTimeout(poll, 200);
    };
    poll();
  });
  return {
    child,
    ready,
    logs: () => logs,
    stop() {
      stopped = true;
      child.kill('SIGTERM');
    },
  };
}

async function login(username, password) {
  const response = await request({
    method: 'POST',
    path: '/api/auth/login',
    json: { username, password },
  });
  assert(response.status === 200 && response.json && response.json.token, `login failed for ${username}: ${response.status} ${response.text}`);
  return response.json;
}

function orderBody(overrides = {}) {
  return fillOrderLines({
    company: 'Acme Construction',
    contact_name: 'John Smith',
    phone: '919-555-1234',
    email: 'jsmith@acmeconstruction.com',
    po_number: 'PO-5521',
    project_number: '20045',
    project_name: 'New City Center',
    notes: 'Please deliver to loading dock.',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '1234 Builder Way',
    address_line2: 'Suite 200',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Accent Truck',
    ship_to: 'Acme Construction\n1234 Builder Way\nRaleigh, NC 27601',
    attention: 'Receiving Dock',
    due_date: isoDate(utcDate(0)),
    due_time: '13:30',
    service_ids: [],
    line_items: [{ description: 'Default line', quantity: '1' }],
    ...overrides,
  });
}

async function runApiChecks() {
  const server = startServer();
  await server.ready;
  console.log('PASS backend startup');
  try {
    const unauth = await request({ method: 'POST', path: '/api/orders', json: orderBody() });
    assert(unauth.status === 401, `unauthenticated order create should be 401, got ${unauth.status}`);
    const unauthList = await request({ method: 'GET', path: '/api/orders' });
    assert(unauthList.status === 401, 'unauthenticated order list should be 401');
    const unauthUpload = await request({
      method: 'POST',
      path: '/api/uploads',
      ...multipartBody([{ name: 'note.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4') }]),
    });
    assert(unauthUpload.status === 401, 'unauthenticated upload should be 401');

    const adminLogin = await login('admin', adminPassword);
    const adminToken = adminLogin.token;
    const customer = await request({
      method: 'POST',
      path: '/api/customers',
      token: adminToken,
      json: {
        display_name: 'Acme Construction',
        username: 'jsmith',
        password: 'CustomerPass1',
        company: 'Acme Construction',
        contact_name: 'John Smith',
        phone: '919-555-1234',
        email: 'jsmith@acmeconstruction.com',
      },
    });
    assert(customer.status === 201, `customer create failed: ${customer.status} ${customer.text}`);
    const other = await request({
      method: 'POST',
      path: '/api/customers',
      token: adminToken,
      json: {
        display_name: 'Other Co',
        username: 'otherco',
        password: 'OtherPass123',
        company: 'Other Co',
        contact_name: 'Other Person',
      },
    });
    assert(other.status === 201, `second customer create failed: ${other.text}`);

    const db = openDb(freshDb);
    const operatorHash = await bcrypt.hash('OperatorPass1', 10);
    await db.run(
      `INSERT INTO users (username, password_hash, role, display_name) VALUES ('op1', ?, 'operator', 'Operator One')`,
      [operatorHash]
    );
    await db.run(
      `INSERT INTO order_sequences (order_date, last_number) VALUES (?, 40)`,
      [dateKey(utcDate(0))]
    );
    await db.run(`INSERT INTO order_sequences (order_date, last_number) VALUES ('19990101', 7)`);
    await db.close();

    const customerLogin = await login('jsmith', 'CustomerPass1');
    const customerToken = customerLogin.token;
    assert(customerLogin.user.company === 'Acme Construction', 'login should include company for prefill');
    assert(customerLogin.user.contact_name === 'John Smith', 'login should include contact name');

    const forbiddenDashboard = await request({ method: 'GET', path: '/api/dashboard', token: customerToken });
    assert(forbiddenDashboard.status === 403, 'customer should still be forbidden from the staff dashboard');
    const forbiddenCustomers = await request({ method: 'GET', path: '/api/customers', token: customerToken });
    assert(forbiddenCustomers.status === 403, 'customer should still be forbidden from customer admin');

    const servicesResponse = await request({ method: 'GET', path: '/api/orders/options', token: customerToken });
    assert(servicesResponse.status === 200, 'options should load for a customer');
    const byName = Object.fromEntries(servicesResponse.json.services.map((service) => [service.name, service]));
    setServiceNames(byName);
    assert(byName['Large Format'] && byName['Small Format'] && byName['Signs & Graphics'], 'seeded services should be listed');
    assert(servicesResponse.json.due_window.slots.includes('09:00'), 'window should include 9:00 AM');
    assert(servicesResponse.json.due_window.slots.includes('14:00'), 'window should include 2:00 PM');
    assert(!servicesResponse.json.due_window.slots.includes('15:00'), 'window should stop at 2:00 PM');
    assert(!servicesResponse.json.due_window.slots.includes('13:07'), 'window should use 15 minute increments');
    const methodNames = servicesResponse.json.delivery_methods.map((method) => method.name);
    assert(methodNames.includes('Accent Truck') && methodNames.includes('Will Call') && methodNames.includes('UPS'), `selectable methods were ${methodNames.join(',')}`);
    assert(!methodNames.some((name) => /customer pickup|fedex|common carrier/i.test(name)), 'retired methods must not be selectable');
    assert(servicesResponse.json.due_windows.will_call.slots.includes('08:00'), 'Will Call should open at 8:00 AM');
    assert(servicesResponse.json.due_windows.will_call.slots.includes('17:00'), 'Will Call should include 5:00 PM');
    assert(!servicesResponse.json.due_windows.will_call.slots.includes('17:15'), 'Will Call should stop at 5:00 PM');
    assert(!servicesResponse.json.due_windows.delivery.slots.includes('08:00'), 'delivery hours should not open at 8:00 AM');

    const missing = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: { company: 'Only Co' },
    });
    assert(missing.status === 400, `missing fields should be 400, got ${missing.status} ${missing.text}`);

    const badEmail = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ email: 'not-an-email', service_ids: [byName['Large Format'].id] }),
    });
    assert(badEmail.status === 400 && /email/.test(badEmail.json.error), 'invalid email should be rejected');

    const badSlot = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ due_time: '13:07', service_ids: [byName['Large Format'].id] }),
    });
    assert(badSlot.status === 400 && /due_time/.test(badSlot.json.error), 'off-grid due time should be rejected');

    const afterWindow = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ due_time: '15:00', service_ids: [byName['Large Format'].id] }),
    });
    assert(afterWindow.status === 400 && /due_time/.test(afterWindow.json.error), '3:00 PM should be outside the window');

    for (const removed of ['Customer Pickup', 'FedEx', 'Common Carrier', 'fedex', 'customer pickup']) {
      const rejected = await request({
        method: 'POST',
        path: '/api/orders',
        token: customerToken,
        json: orderBody({ delivery_method: removed, service_ids: [byName['Large Format'].id] }),
      });
      assert(rejected.status === 400 && /no longer available/i.test(rejected.json.error), `${removed} should be rejected, got ${rejected.status} ${rejected.text}`);
    }
    const earlyDelivery = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ due_time: '08:00', service_ids: [byName['Large Format'].id] }),
    });
    assert(earlyDelivery.status === 400 && /due_time/.test(earlyDelivery.json.error), '8:00 AM should be outside delivery hours');
    const earlyWillCall = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ due_time: '07:45', delivery_method: 'Will Call', service_ids: [byName['Large Format'].id] }),
    });
    assert(earlyWillCall.status === 400 && /Will Call/.test(earlyWillCall.json.error), '7:45 AM should be outside Will Call hours');
    const lateWillCall = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ due_time: '17:15', delivery_method: 'Will Call', service_ids: [byName['Large Format'].id] }),
    });
    assert(lateWillCall.status === 400 && /due_time/.test(lateWillCall.json.error), '5:15 PM should be outside Will Call hours');
    const upsOnTruck = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ ups_account_number: 'AB-12', service_ids: [byName['Large Format'].id] }),
    });
    assert(upsOnTruck.status === 400 && /ups_account_number/.test(upsOnTruck.json.error), 'a UPS account should be rejected on Accent Truck');
    const badAccount = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ delivery_method: 'UPS', ups_account_number: 'AB_12!', service_ids: [byName['Large Format'].id] }),
    });
    assert(badAccount.status === 400 && /ups_account_number/.test(badAccount.json.error), 'invalid UPS account characters should be rejected');
    const longAccount = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ delivery_method: 'UPS', ups_account_number: '1234567890123456789012345678901', service_ids: [byName['Large Format'].id] }),
    });
    assert(longAccount.status === 400 && /30 characters/.test(longAccount.json.error), 'a 31 character UPS account should be rejected');

    const weekend = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ due_date: upcomingWeekday(6), service_ids: [byName['Large Format'].id] }),
    });
    assert(weekend.status === 400 && /weekday/.test(weekend.json.error), 'Saturday due date should be rejected');

    const past = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ due_date: '2020-01-06', service_ids: [byName['Large Format'].id] }),
    });
    assert(past.status === 400 && /before today/.test(past.json.error), 'past due date should be rejected');

    const internal = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ status: 'completed', service_ids: [byName['Large Format'].id] }),
    });
    assert(internal.status === 400 && /internal fields/.test(internal.json.error), 'customers cannot set internal fields');

    const otherCustomer = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ customer_id: other.json.id, service_ids: [byName['Large Format'].id] }),
    });
    assert(otherCustomer.status === 403, `customer ordering for someone else should be 403, got ${otherCustomer.status} ${otherCustomer.text}`);

    const upload = await request({
      method: 'POST',
      path: '/api/uploads',
      token: customerToken,
      ...multipartBody([{ name: '../../etc/passwd.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 plans') }]),
    });
    assert(upload.status === 201, `pdf upload failed: ${upload.status} ${upload.text}`);
    const uploaded = upload.json.files[0];
    assert(!String(uploaded.original_name).includes('..'), 'stored display name should drop path segments');
    assert(uploaded.original_name === 'passwd.pdf', `sanitized name was ${uploaded.original_name}`);

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const image = await request({
      method: 'POST',
      path: '/api/uploads',
      token: customerToken,
      ...multipartBody([{ name: 'plan.png', type: 'image/png', data: png }]),
    });
    assert(image.status === 201, `png upload failed: ${image.text}`);

    for (const name of ['drawing.dwg', 'pack.zip', 'plot.plt']) {
      const allowed = await request({
        method: 'POST',
        path: '/api/uploads',
        token: customerToken,
        ...multipartBody([{ name, type: 'application/octet-stream', data: Buffer.from('ok') }]),
      });
      assert(allowed.status === 201, `${name} should be accepted, got ${allowed.status} ${allowed.text}`);
    }

    const textFile = await request({
      method: 'POST',
      path: '/api/uploads',
      token: customerToken,
      ...multipartBody([{ name: 'notes.txt', type: 'text/plain', data: Buffer.from('nope') }]),
    });
    assert(textFile.status === 400, `txt should be rejected, got ${textFile.status}`);

    const exe = await request({
      method: 'POST',
      path: '/api/uploads',
      token: customerToken,
      ...multipartBody([{ name: 'run.exe', type: 'application/octet-stream', data: Buffer.from('MZ') }]),
    });
    assert(exe.status === 400, 'exe should be rejected');

    const empty = await request({
      method: 'POST',
      path: '/api/uploads',
      token: customerToken,
      ...multipartBody([{ name: 'empty.pdf', type: 'application/pdf', data: Buffer.alloc(0) }]),
    });
    assert(empty.status === 400, `empty file should be rejected, got ${empty.status} ${empty.text}`);

    const oversized = await request({
      method: 'POST',
      path: '/api/uploads',
      token: customerToken,
      ...multipartBody([{ name: 'big.pdf', type: 'application/pdf', data: Buffer.alloc(40 * 1024, 1) }]),
    });
    assert(oversized.status === 413, `oversized file should be 413, got ${oversized.status} ${oversized.text}`);

    const extraIds = [];
    let quotaBlocked = null;
    for (let i = 0; i < 6; i += 1) {
      const extra = await request({
        method: 'POST',
        path: '/api/uploads',
        token: customerToken,
        ...multipartBody([{ name: `extra-${i}.pdf`, type: 'application/pdf', data: Buffer.from('%PDF-1.4 extra') }]),
      });
      if (extra.status === 201) extraIds.push(extra.json.files[0].id);
      else {
        quotaBlocked = extra;
        break;
      }
    }
    assert(extraIds.length === 3, `expected 3 uploads before the unattached quota, got ${extraIds.length}`);
    assert(quotaBlocked && quotaBlocked.status === 400 && /waiting to be attached/.test(quotaBlocked.json.error), `quota should reject the next upload: ${quotaBlocked && quotaBlocked.text}`);
    const removedWaiting = await request({ method: 'DELETE', path: `/api/uploads/${extraIds[0]}`, token: customerToken });
    assert(removedWaiting.status === 200, `customer should delete an unattached file: ${removedWaiting.text}`);

    const namesOnDisk = fs.readdirSync(uploadDir);
    assert(namesOnDisk.every((name) => /^[a-f0-9]{32}\.[a-z0-9]+$/.test(name)), `upload names should be random: ${namesOnDisk.join(', ')}`);
    assert(!namesOnDisk.some((name) => name.includes('passwd') || name.includes('..')), 'disk names must not use the client filename');

    const missingService = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        service_ids: [byName['Large Format'].id, byName['Small Format'].id],
        line_items: [{ description: 'No service chosen', quantity: '1' }],
      }),
    });
    assert(missingService.status === 400 && /must include a service/.test(missingService.json.error), `line item without a service should be 400, got ${missingService.status} ${missingService.text}`);

    const serviceIds = [byName['Signs & Graphics'].id, byName['Small Format'].id, byName['Large Format'].id];
    const created = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        service_ids: serviceIds,
        line_items: [
          {
            description: 'Civil Plans',
            size: '24x36',
            quantity: '5 Sets',
            media: 'Bond',
            color: 'B&W',
            binding_finish: 'Fold / Staple',
            mount: false,
            laminate: false,
            service_id: byName['Large Format'].id,
            file_ids: [uploaded.id],
          },
          {
            description: 'Project Specifications',
            size: '8.5x11',
            quantity: '5 Sets',
            media: 'Premium',
            color: 'B&W',
            binding_finish: 'Bind (Left)',
            mount: 'No',
            laminate: 'No',
            service_id: byName['Small Format'].id,
          },
          {
            description: 'Site Banner',
            size: '96x36',
            quantity: '1',
            media: 'Vinyl',
            color: 'Color',
            binding_finish: 'Trim / Grommets',
            mount: 'Yes',
            laminate: 'Yes',
            service_id: byName['Signs & Graphics'].id,
            file_ids: [image.json.files[0].id],
          },
        ],
      }),
    });
    assert(created.status === 201, `order create failed: ${created.status} ${created.text}`);
    const todayKey = dateKey(utcDate(0));
    assert(created.json.order_number === `${todayKey}-041`, `expected ${todayKey}-041, got ${created.json.order_number}`);
    assert(created.json.confirmation.email_sent === false, 'email must not be sent');
    assert(created.json.confirmation.email_status === 'disabled', 'email status should be disabled');
    assert(!/confirmation email has been sent/i.test(created.text), 'response must not claim an email was sent');
    const suffixes = created.json.work_orders.map((row) => row.external_id);
    assert(suffixes.join(',') === `${todayKey}-041-A,${todayKey}-041-B,${todayKey}-041-C`, `work order suffixes were ${suffixes.join(',')}`);
    const bySuffix = Object.fromEntries(created.json.work_orders.map((row) => [row.external_id.slice(-1), row]));
    assert(bySuffix.A.service_name === 'Large Format' && bySuffix.A.department === 'Large Format', 'A should be Large Format by service sort, not request order');
    assert(bySuffix.B.service_name === 'Small Format', 'B should be Small Format');
    assert(bySuffix.C.service_name === 'Signs & Graphics', 'C should be Signs & Graphics');
    assert(bySuffix.A.next_department === 'Quality', 'production services route to Quality');
    assert(created.json.delivery && created.json.delivery.carrier === 'Accent Truck', 'delivery record should use the delivery method');
    assert(created.json.delivery.will_call === false, 'Accent Truck is not will-call');
    assert(String(created.json.delivery.due_time).includes('13:30'), 'delivery due time should keep the selected slot');

    const detail = await request({ method: 'GET', path: `/api/workorders/${bySuffix.A.id}`, token: customerToken });
    assert(detail.status === 200, `work order detail failed: ${detail.text}`);
    assert(detail.json.routing.department === 'Large Format', 'routing department missing');
    assert(detail.json.routing.current_status_label === 'Active', 'open work orders show as Active');
    assert(detail.json.routing.next_department === 'Quality', 'next department missing');
    const spec = (detail.json.specification_lines || []).find((line) => line.title === 'Civil Plans');
    assert(spec, 'large format line item should be on its work order');
    const specMap = Object.fromEntries(spec.fields.map((field) => [field.label, field.value]));
    assert(specMap.Size === 'Full Size' && specMap.Media === 'Bond' && specMap.Mounting === 'No' && specMap.Lamination === 'No', 'spec fields should match the line item');
    assert((detail.json.files || []).some((file) => file.original_name === 'passwd.pdf'), 'line item file should show on the work order');
    const customerHistory = detail.json.production_history || [];
    assert(customerHistory.some((row) => row.department === 'Submitted' && row.status === 'Submitted' && row.event_time), 'customer history should include department, status, and time');
    assert(customerHistory.every((row) => Object.keys(row).sort().join(',') === 'department,event_time,id,status'), 'customer history should hide scanned_by and notes');
    const staffDetail = await request({ method: 'GET', path: `/api/workorders/${bySuffix.A.id}`, token: adminToken });
    assert(staffDetail.status === 200, `staff work order detail failed: ${staffDetail.text}`);
    assert((staffDetail.json.production_history || []).some((row) => row.scanned_by === 'System Auto' && row.notes === 'Order Created'), 'staff history should keep scanned_by and notes');
    assert(!detail.text.includes(uploadDir), 'API must not reveal the upload directory');

    const ownDownload = await request({ method: 'GET', path: `/api/uploads/${uploaded.id}/download`, token: customerToken });
    assert(ownDownload.status === 200 && ownDownload.buffer.includes(Buffer.from('%PDF-1.4')), 'owner should download the file');
    const deleteAttached = await request({ method: 'DELETE', path: `/api/uploads/${uploaded.id}`, token: customerToken });
    assert(deleteAttached.status === 403, `customer should not delete a file attached to an order, got ${deleteAttached.status} ${deleteAttached.text}`);
    const stillThere = await request({ method: 'GET', path: `/api/uploads/${uploaded.id}/download`, token: customerToken });
    assert(stillThere.status === 200, 'attached file should remain downloadable');

    const secondOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        due_time: '09:00',
        service_ids: [byName['Scanning'].id],
        line_items: [{ description: 'Scan set', quantity: '2' }],
      }),
    });
    assert(secondOrder.status === 201 && secondOrder.json.order_number === `${todayKey}-042`, `second order number was ${secondOrder.json && secondOrder.json.order_number}`);
    const assumed = await request({
      method: 'GET',
      path: `/api/workorders/${secondOrder.json.work_orders[0].id}`,
      token: customerToken,
    });
    assert(assumed.status === 200 && (assumed.json.line_items || []).some((item) => item.description === 'Scan set'), 'a single-service order should assume the line item service');

    const willCall = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ due_time: '14:00', delivery_method: 'Will Call', service_ids: [byName.Planroom.id] }),
    });
    assert(willCall.status === 201 && willCall.json.order_number === `${todayKey}-043`, '14:00 should be accepted and continue the sequence');
    assert(willCall.json.delivery.will_call === true, 'Will Call should set will_call');

    const otherLogin = await login('otherco', 'OtherPass123');
    const hidden = await request({ method: 'GET', path: `/api/orders/${created.json.order.id}`, token: otherLogin.token });
    assert(hidden.status === 404, 'customers must not read another customer order');
    const hiddenList = await request({ method: 'GET', path: '/api/orders', token: otherLogin.token });
    assert(hiddenList.status === 200 && hiddenList.json.orders.every((row) => row.order_number !== created.json.order_number), 'order list must be isolated');
    const hiddenFile = await request({ method: 'GET', path: `/api/uploads/${uploaded.id}/download`, token: otherLogin.token });
    assert(hiddenFile.status === 404, 'customers must not download another customer file');
    const hiddenWorkOrder = await request({ method: 'GET', path: `/api/workorders/${bySuffix.A.id}`, token: otherLogin.token });
    assert(hiddenWorkOrder.status === 404, 'customers must not read another customer work order');

    const operatorLogin = await login('op1', 'OperatorPass1');
    const operatorOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: operatorLogin.token,
      json: orderBody({
        customer_id: customer.json.id,
        service_ids: [byName['Archive File Request'].id],
        line_items: [{ description: 'Old drawings', quantity: '1', service_id: byName['Archive File Request'].id }],
      }),
    });
    assert(operatorOrder.status === 201, `operator order failed: ${operatorOrder.text}`);
    assert(operatorOrder.json.work_orders[0].department === 'Archive File', 'archive requests route to Archive File');
    assert(operatorOrder.json.work_orders[0].approval_status === 'pending', 'archive requests should be pending approval');
    const operatorCustomers = await request({ method: 'GET', path: '/api/customers', token: operatorLogin.token });
    assert(operatorCustomers.status === 403, 'operators still cannot administer customers');

    const adminOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: adminToken,
      json: orderBody({
        customer_id: other.json.id,
        company: 'Other Co',
        contact_name: 'Other Person',
        email: 'other@example.com',
        service_ids: [byName['Ship To (3rd Party)'].id],
      }),
    });
    assert(adminOrder.status === 201, `admin order failed: ${adminOrder.text}`);
    assert(adminOrder.json.work_orders[0].department === 'Delivery', 'ship-to service maps to Delivery');
    assert(adminOrder.json.work_orders[0].next_department === 'Complete', 'Delivery routes to Complete');
    const customerCannotSeeAdminOrder = await request({
      method: 'GET',
      path: `/api/orders/${adminOrder.json.order.id}`,
      token: customerToken,
    });
    assert(customerCannotSeeAdminOrder.status === 404, 'first customer should not see the other company order');

    const concurrent = await Promise.all([
      ...Array.from({ length: 12 }, () => request({
        method: 'POST',
        path: '/api/orders',
        token: customerToken,
        json: orderBody({
          service_ids: [byName['Large Format'].id],
          line_items: [{ description: 'Concurrent set', quantity: '1' }],
        }),
      })),
      request({
        method: 'PUT',
        path: `/api/workorders/${bySuffix.A.id}/priority`,
        token: adminToken,
        json: { priority: 'High' },
      }),
    ]);
    const priorityUpdate = concurrent[concurrent.length - 1];
    const createdTogether = concurrent.slice(0, 12);
    assert(priorityUpdate.status === 200, `priority update during order creates failed: ${priorityUpdate.status} ${priorityUpdate.text}`);
    assert(
      createdTogether.every((row) => row.status === 201),
      `12 simultaneous orders should all return 201: ${createdTogether.map((row) => `${row.status} ${row.text}`).join(' | ')}`
    );
    const numbers = createdTogether.map((row) => row.json.order_number);
    assert(new Set(numbers).size === 12, `concurrent order numbers must be unique: ${numbers.join(', ')}`);
    const expectedNumbers = [];
    for (let n = 46; n <= 57; n += 1) expectedNumbers.push(`${todayKey}-${String(n).padStart(3, '0')}`);
    const sortedNumbers = numbers.slice().sort();
    assert(
      sortedNumbers.join(',') === expectedNumbers.join(','),
      `concurrent orders should take the next numbers without gaps: expected ${expectedNumbers.join(',')} got ${sortedNumbers.join(',')}`
    );

    const customerReports = await request({ method: 'GET', path: '/api/reports/work-orders/status', token: customerToken });
    assert(customerReports.status === 403, `customers should not open reports, got ${customerReports.status}`);
    const adminReports = await request({ method: 'GET', path: '/api/reports/work-orders/status', token: adminToken });
    assert(adminReports.status === 200 && Array.isArray(adminReports.json.rows), `admin status report failed: ${adminReports.status} ${adminReports.text}`);
    const customerNotes = await request({ method: 'GET', path: '/api/notifications', token: customerToken });
    assert(customerNotes.status === 200 && typeof customerNotes.json.unread_count === 'number', `customer notifications failed: ${customerNotes.status} ${customerNotes.text}`);
    const adminNotes = await request({ method: 'GET', path: '/api/notifications', token: adminToken });
    assert(adminNotes.status === 200 && typeof adminNotes.json.unread_count === 'number', `admin notifications failed: ${adminNotes.status} ${adminNotes.text}`);

    const sequence = openDb(freshDb);
    const today = await sequence.get('SELECT last_number FROM order_sequences WHERE order_date = ?', [todayKey]);
    const oldDay = await sequence.get(`SELECT last_number FROM order_sequences WHERE order_date = '19990101'`);
    assert(today.last_number === 57, `today's sequence should be 57 after 17 orders, got ${today && today.last_number}`);
    assert(oldDay.last_number === 7, 'another day sequence must stay untouched');
    await sequence.close();

    const willCallOpen = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ due_time: '08:00', delivery_method: 'Will Call', service_ids: [byName.Planroom.id] }),
    });
    assert(willCallOpen.status === 201 && willCallOpen.json.delivery.will_call === true, `8:00 AM Will Call should be accepted: ${willCallOpen.text}`);
    assert(willCallOpen.json.order.delivery_hours.start === '08:00' && willCallOpen.json.order.delivery_hours.end === '17:00', 'Will Call hours should be 8:00 AM to 5:00 PM');
    const willCallClose = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ due_time: '17:00', delivery_method: 'Will Call', service_ids: [byName.Planroom.id] }),
    });
    assert(willCallClose.status === 201, `5:00 PM Will Call should be accepted: ${willCallClose.text}`);

    const upsBlank = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ delivery_method: 'UPS', ups_account_number: '   ', service_ids: [byName['Large Format'].id] }),
    });
    assert(upsBlank.status === 201 && upsBlank.json.order.ups_account_number == null, `UPS without an account should be accepted: ${upsBlank.text}`);
    const upsSaved = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        delivery_method: 'UPS',
        ups_account_number: '  AB-12 9 ',
        service_ids: [byName['Large Format'].id],
        line_items: [{ description: 'UPS set', quantity: '1' }],
      }),
    });
    assert(upsSaved.status === 201 && upsSaved.json.order.ups_account_number === 'AB-12 9', `UPS account should be trimmed and stored: ${upsSaved.text}`);
    assert(upsSaved.json.order.delivery_method === 'UPS', 'UPS should stay the stored method');
    const upsDetail = await request({ method: 'GET', path: `/api/orders/${upsSaved.json.order.id}`, token: customerToken });
    assert(upsDetail.status === 200 && upsDetail.json.order.ups_account_number === 'AB-12 9', 'the owner should see the UPS account');
    const upsHidden = await request({ method: 'GET', path: `/api/orders/${upsSaved.json.order.id}`, token: otherLogin.token });
    assert(upsHidden.status === 404 && !upsHidden.text.includes('AB-12 9'), 'another customer must not see the UPS account');
    const upsWorkOrder = await request({
      method: 'GET',
      path: `/api/workorders/${upsSaved.json.work_orders[0].id}`,
      token: adminToken,
    });
    assert(upsWorkOrder.status === 200 && upsWorkOrder.json.ups_account_number === 'AB-12 9', 'staff work order detail should include the UPS account');
    const upsEdit = await request({
      method: 'PUT',
      path: `/api/workorders/${upsSaved.json.work_orders[0].id}`,
      token: adminToken,
      json: {
        customer_id: customer.json.id,
        description: upsWorkOrder.json.description,
        quantity: upsWorkOrder.json.quantity,
        status: 'open',
        department: upsWorkOrder.json.department,
      },
    });
    assert(upsEdit.status === 200, `editing the work order should not force a delivery change: ${upsEdit.text}`);
    const upsStill = await request({ method: 'GET', path: `/api/orders/${upsSaved.json.order.id}`, token: adminToken });
    assert(upsStill.json.order.delivery_method === 'UPS' && upsStill.json.order.ups_account_number === 'AB-12 9', 'an edit should leave the UPS order unchanged');

    const legacyDb = openDb(freshDb);
    const legacyOrder = await legacyDb.run(
      `INSERT INTO orders (
        order_number, customer_id, company, contact_name, phone, email, delivery_method, due_date, due_time
      ) VALUES ('LEGACY-PICKUP', ?, 'Acme Construction', 'John Smith', '919-555-1234', 'jsmith@acmeconstruction.com', 'Customer Pickup', ?, '18:00')`,
      [customer.json.id, isoDate(utcDate(0))]
    );
    const legacyWorkOrder = await legacyDb.run(
      `INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department, order_id)
       VALUES ('LEGACY-PICKUP-A', ?, 'Legacy pickup', 1, 'open', 'Large Format', ?)`,
      [customer.json.id, legacyOrder.lastID]
    );
    await legacyDb.run(
      `INSERT INTO deliveries (work_order_id, order_id, will_call, due_time, carrier, status)
       VALUES (?, ?, 1, ?, 'Customer Pickup', 'pending')`,
      [legacyWorkOrder.lastID, legacyOrder.lastID, `${isoDate(utcDate(0))} 18:00:00`]
    );
    await legacyDb.run(
      `INSERT INTO order_line_items (order_id, work_order_id, line_number, description, mount, laminate)
       VALUES (?, ?, 1, 'Legacy banner', 1, 0)`,
      [legacyOrder.lastID, legacyWorkOrder.lastID]
    );
    await legacyDb.close();
    const legacyLoaded = await request({ method: 'GET', path: `/api/orders/${legacyOrder.lastID}`, token: customerToken });
    assert(legacyLoaded.status === 200 && legacyLoaded.json.order.delivery_method === 'Customer Pickup', `legacy Customer Pickup should load: ${legacyLoaded.text}`);
    assert(legacyLoaded.json.order.payment_method == null && legacyLoaded.json.order.payment_method_label === 'Not specified', 'legacy orders should show payment as Not specified');
    assert(legacyLoaded.json.order.due_time === '18:00', 'legacy due time outside the new window should stay');
    assert(legacyLoaded.json.order.delivery_hours.start === '08:00', 'Customer Pickup should use Will Call hours');
    assert(legacyLoaded.json.order.project_name == null, 'an older order without a project name should still load');
    assert(legacyLoaded.json.order.originals_source == null && legacyLoaded.json.order.originals_source_label === 'Not specified', 'legacy originals should display as Not specified');
    assert(legacyLoaded.json.order.address_line1 == null && legacyLoaded.json.order.city == null && legacyLoaded.json.order.zip == null, 'legacy address should stay blank');
    const legacyLine = (legacyLoaded.json.order.line_items || []).find((item) => item.description === 'Legacy banner');
    assert(legacyLine && legacyLine.mount === true && legacyLine.mount_label === 'Yes' && legacyLine.laminate_label === 'No', 'legacy mount Yes/No should still display');
    assert(legacyLine.field_values && Object.keys(legacyLine.field_values).length === 0, 'a legacy line should keep an empty field_values object');
    const legacyEdited = await request({
      method: 'PUT',
      path: `/api/workorders/${legacyWorkOrder.lastID}`,
      token: adminToken,
      json: {
        customer_id: customer.json.id,
        description: 'Legacy pickup updated',
        quantity: 1,
        status: 'open',
        department: 'Large Format',
      },
    });
    assert(legacyEdited.status === 200, `legacy work order edit failed: ${legacyEdited.text}`);
    const legacyAfterEdit = await request({ method: 'GET', path: `/api/orders/${legacyOrder.lastID}`, token: adminToken });
    assert(legacyAfterEdit.json.order.delivery_method === 'Customer Pickup' && legacyAfterEdit.json.order.due_time === '18:00', 'editing a legacy order must not rewrite the method');

    const deliveryCsv = await request({ method: 'GET', path: '/api/reports/deliveries?format=csv', token: adminToken });
    assert(deliveryCsv.status === 200 && /ups_account_number/.test(deliveryCsv.text), `delivery CSV should include the account column: ${deliveryCsv.status} ${deliveryCsv.text.slice(0, 300)}`);
    assert(deliveryCsv.text.includes('AB-12 9'), 'delivery CSV should include the stored UPS account');
    assert(deliveryCsv.text.includes('Customer Pickup'), 'delivery CSV should keep the legacy carrier label');

    const missingProject = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ project_name: '   ', service_ids: [byName['Large Format'].id] }),
    });
    assert(missingProject.status === 400 && /project_name is required/.test(missingProject.json.error), `blank project name should be rejected: ${missingProject.text}`);
    const badProject = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ project_name: 'City\u0001Center', service_ids: [byName['Large Format'].id] }),
    });
    assert(badProject.status === 400 && /project_name contains invalid characters/.test(badProject.json.error), badProject.text);

    const emptyLarge = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        service_ids: [byName['Large Format'].id, byName['Small Format'].id],
        line_items: [{ description: 'Only large', quantity: '1', service_id: byName['Large Format'].id }],
      }),
    });
    assert(emptyLarge.status === 400 && emptyLarge.json.error === 'Small Format is empty. Please add lines or deselect it.', emptyLarge.text);

    const archiveBare = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        notes: '',
        service_ids: [byName['Archive File Request'].id],
        line_items: [],
      }),
    });
    assert(archiveBare.status === 400 && /Archive File Request is empty/.test(archiveBare.json.error), archiveBare.text);
    const archiveNotes = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        notes: 'Please pull job 4421 from archive.',
        service_ids: [byName['Archive File Request'].id],
        line_items: [],
      }),
    });
    assert(archiveNotes.status === 201 && archiveNotes.json.order.line_items.length === 0, `archive notes should satisfy the service: ${archiveNotes.text}`);

    const shipBare = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        ship_to: '   ',
        service_ids: [byName['Ship To (3rd Party)'].id],
        line_items: [],
      }),
    });
    assert(shipBare.status === 400 && /Ship To \(3rd Party\) is empty/.test(shipBare.json.error), shipBare.text);
    const shipDetails = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        ship_to: 'Other Shop\n9 Dock Street',
        service_ids: [byName['Ship To (3rd Party)'].id],
        line_items: [],
      }),
    });
    assert(shipDetails.status === 201, `ship-to details should satisfy the service: ${shipDetails.text}`);

    const filesMissing = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        originals_source: 'Files attached below',
        service_ids: [byName['Large Format'].id],
      }),
    });
    assert(filesMissing.status === 400 && /Attach at least one file/.test(filesMissing.json.error), filesMissing.text);
    const badOriginals = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ originals_source: 'Email me the files', service_ids: [byName['Large Format'].id] }),
    });
    assert(badOriginals.status === 400 && /originals_source must be one of/.test(badOriginals.json.error), badOriginals.text);
    const badZip = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ zip: '=1+1', service_ids: [byName['Large Format'].id] }),
    });
    assert(badZip.status === 400 && /zip is invalid/.test(badZip.json.error), badZip.text);
    const badCity = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ city: 'Ral\u0000eigh', service_ids: [byName['Large Format'].id] }),
    });
    assert(badCity.status === 400 && /city contains invalid characters/.test(badCity.json.error), badCity.text);
    const missingAddr = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({ address_line1: '  ', service_ids: [byName['Large Format'].id] }),
    });
    assert(missingAddr.status === 400 && /address_line1 is required/.test(missingAddr.json.error), missingAddr.text);
    const badFinish = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        service_ids: [byName['Large Format'].id],
        line_items: [{ description: 'Banner', quantity: '1', finishing: 'Gold leaf' }],
      }),
    });
    assert(badFinish.status === 400 && /finishing must be one of/.test(badFinish.json.error), badFinish.text);

    const finishUpload = await request({
      method: 'POST',
      path: '/api/uploads',
      token: customerToken,
      ...multipartBody([{ name: 'plans.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 finish') }]),
    });
    assert(finishUpload.status === 201, `finishing upload failed: ${finishUpload.text}`);
    const finished = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        originals_source: 'Files attached below',
        service_ids: [byName['Large Format'].id],
        line_items: [{
          description: 'Grommet banner',
          quantity: '1',
          finishing: 'Grommets',
          file_ids: [finishUpload.json.files[0].id],
        }],
      }),
    });
    assert(finished.status === 201, `finished order failed: ${finished.text}`);
    assert(finished.json.order.line_items[0].finishing === 'Grommets', 'finishing should be stored and returned');
    assert(finished.json.order.originals_source === 'Files attached below', 'originals source should be stored');
    assert(finished.json.order.address_line1 === '1234 Builder Way' && finished.json.order.address_line2 === 'Suite 200', 'address lines should be snapshotted');
    assert(finished.json.order.city === 'Raleigh' && finished.json.order.state === 'NC' && finished.json.order.zip === '27601', 'city, state, and zip should be snapshotted');
    const otherFinish = await request({ method: 'GET', path: `/api/orders/${finished.json.order.id}`, token: otherLogin.token });
    assert(otherFinish.status === 404, 'another customer must not read the snapshotted address');

    const pickupOriginals = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerToken,
      json: orderBody({
        originals_source: 'Send a vehicle to pick up originals',
        delivery_method: 'Will Call',
        due_time: '10:00',
        service_ids: [byName['Large Format'].id],
      }),
    });
    assert(pickupOriginals.status === 201 && pickupOriginals.json.order.originals_pickup === true, pickupOriginals.text);
    assert(pickupOriginals.json.order.delivery_method === 'Will Call', 'inbound originals pickup must stay separate from the delivery method');
    const boardRow = await request({
      method: 'GET',
      path: `/api/admin-board/work-orders?q=${encodeURIComponent(pickupOriginals.json.order_number)}`,
      token: adminToken,
    });
    assert(boardRow.status === 200 && boardRow.json.work_orders.some((row) => row.originals_source_label === 'Send a vehicle to pick up originals'), `admin board should show originals: ${boardRow.text}`);

    const addressSaved = await request({
      method: 'PUT',
      path: `/api/customers/${customer.json.id}`,
      token: adminToken,
      json: { address_line1: '  50 Plant Road ', address_line2: '', city: 'Cary', state: 'NC', zip: '27511' },
    });
    assert(addressSaved.status === 200 && addressSaved.json.address_line1 === '50 Plant Road' && addressSaved.json.city === 'Cary', addressSaved.text);
    const me = await request({ method: 'GET', path: '/api/auth/me', token: customerToken });
    assert(me.status === 200 && me.json.user.address_line1 === '50 Plant Road' && me.json.user.zip === '27511', `profile address should prefill: ${me.text}`);
    const badAddress = await request({
      method: 'PUT',
      path: `/api/customers/${customer.json.id}`,
      token: adminToken,
      json: { address_line1: '9\u0007 Main', city: 'Cary', state: 'NC', zip: '27511' },
    });
    assert(badAddress.status === 400 && /invalid characters/.test(badAddress.json.error), badAddress.text);
    const operatorAddress = await request({
      method: 'PUT',
      path: `/api/customers/${customer.json.id}`,
      token: operatorLogin.token,
      json: { address_line1: 'Nope', city: 'Cary', state: 'NC', zip: '27511' },
    });
    assert(operatorAddress.status === 403, 'operators cannot edit a customer address');
    const addressActivity = await request({ method: 'GET', path: '/api/activity?type=user.updated&format=csv', token: adminToken });
    assert(addressActivity.status === 200 && /Updated address for jsmith/.test(addressActivity.text), `address edits should be logged: ${addressActivity.text}`);
    assert(!addressActivity.text.includes('50 Plant Road'), 'activity CSV should not repeat the street address');

    console.log('PASS order API, roles, sequence, concurrency, uploads, reports, and customer isolation');
  } finally {
    server.stop();
  }
}

async function main() {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log(`Temp workspace ${tmp}`);
  await migrateOldDatabase();
  await migrateDuplicateExternalIds();
  await initFreshTwice();
  await checkOrphanSweep();
  await runApiChecks();
  console.log('All phase 1 checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
