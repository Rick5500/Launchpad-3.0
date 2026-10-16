/**
 * Phase 4 checks: admin pages, roles, validation, last-admin protection,
 * settings, activity writes, order search, and barcode dry run.
 * Usage (from backend/): node scripts/verify-phase4.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase4-'));
const oldDb = path.join(tmp, 'old.db');
const freshDb = path.join(tmp, 'fresh.db');
const port = 3114;
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
  due_date DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY(customer_id) REFERENCES users(id)
);
CREATE TABLE barcode_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned_value TEXT NOT NULL,
  work_order_id INTEGER,
  operator_id INTEGER,
  location TEXT,
  event_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER,
  will_call BOOLEAN DEFAULT 0,
  due_time DATETIME,
  carrier TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function baseEnv(databaseFile) {
  return {
    DATABASE_FILE: databaseFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    DELIVERY_TIMEZONE: 'UTC',
    DELIVERY_WINDOW_START: '09:00',
    DELIVERY_WINDOW_END: '14:00',
    DELIVERY_SLOT_MINUTES: '15',
    DUE_SOON_HOURS: '1',
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
  };
}

function request({ method, path: requestPath, token, json, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const body = json != null ? Buffer.from(JSON.stringify(json)) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    }
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
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
        resolve({ status: res.statusCode, json: parsed, text, headers: res.headers });
      });
    });
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`request timed out after ${timeoutMs}ms: ${method} ${requestPath}`));
      });
    }
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
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

function weekdayIso(offset = 1) {
  const now = new Date();
  for (let extra = 0; extra < 10; extra += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset + extra));
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) return date.toISOString().slice(0, 10);
  }
  throw new Error('no weekday');
}

function orderBody(serviceId, customerId, overrides = {}) {
  return {
    customer_id: customerId,
    company: 'Phase Four Print Co',
    contact_name: 'Avery Cole',
    phone: '919-555-0144',
    email: 'avery@phasefour.example',
    delivery_method: 'Accent Truck',
    due_date: weekdayIso(1),
    due_time: '10:00',
    service_ids: [serviceId],
    line_items: [{ description: 'Phase four set', quantity: '2', service_id: serviceId }],
    ...overrides,
  };
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
        // still starting
      }
      setTimeout(poll, 200);
    };
    poll();
  });
  return {
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

async function assertMigration(file, label) {
  const db = openDb(file);
  const userColumns = await columnNames(db, 'users');
  assert(userColumns.has('is_active'), `${label} users.is_active should exist`);
  const serviceColumns = await columnNames(db, 'services');
  assert(serviceColumns.has('code') && serviceColumns.has('suffix_mode') && serviceColumns.has('default_turnaround_hours'), `${label} service columns should exist`);
  const services = await db.get('SELECT COUNT(*) AS count FROM services');
  assert(services.count === 7, `${label} should keep 7 seeded services, found ${services.count}`);
  const coded = await db.get(`SELECT code, suffix_mode FROM services WHERE name = 'Large Format'`);
  assert(coded && coded.code === 'LF' && coded.suffix_mode === 'sequence', `${label} Large Format should keep sequence suffix LF`);
  const locations = await db.get(`SELECT COUNT(*) AS count FROM barcode_locations WHERE lower(location) = 'large format'`);
  assert(locations.count === 1, `${label} Large Format location should be seeded once, found ${locations.count}`);
  const shipping = await db.get(`SELECT department_name, stage_name FROM barcode_locations WHERE lower(location) = 'shipping'`);
  assert(shipping && !shipping.department_name && shipping.stage_name === 'Shipping', `${label} Shipping should advance a stage and not move a department`);
  const letterhead = await db.get(`SELECT value FROM system_settings WHERE key = 'company_name'`);
  assert(letterhead && letterhead.value === 'Accent Imaging, Inc.', `${label} letterhead default should be seeded`);
  const letterheadCount = await db.get(`SELECT COUNT(*) AS count FROM system_settings WHERE key = 'company_name'`);
  assert(letterheadCount.count === 1, `${label} letterhead should not duplicate`);
  const inApp = await db.get(`SELECT enabled, channel FROM notification_settings WHERE event_key = 'delivery_overdue'`);
  assert(inApp && inApp.channel === 'in_app' && inApp.enabled === 1, `${label} in-app events should start enabled`);
  const email = await db.get(`SELECT enabled, channel FROM notification_settings WHERE event_key = 'order_submitted'`);
  assert(email && email.channel === 'email' && email.enabled === 0, `${label} email stubs should stay off`);
  await db.close();
}

async function main() {
  const old = openDb(oldDb);
  await old.exec(OLD_SCHEMA);
  const legacyHash = await bcrypt.hash('LegacyPass123', 10);
  await old.run(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES ('legacy', ?, 'customer', 'Legacy Co')`,
    [legacyHash]
  );
  await old.close();
  await initDatabase(oldDb);
  await initDatabase(oldDb);
  const migrated = openDb(oldDb);
  const legacy = await migrated.get(`SELECT username, role, is_active FROM users WHERE username = 'legacy'`);
  assert(legacy && legacy.role === 'customer' && legacy.is_active === 1, 'legacy user should survive migration and stay active');
  await migrated.close();
  await assertMigration(oldDb, 'migrated database');

  await initDatabase(freshDb);
  await initDatabase(freshDb);
  await assertMigration(freshDb, 'fresh database');
  const seeded = openDb(freshDb);
  const seedFlag = await seeded.get(`SELECT value FROM system_settings WHERE key = 'barcode_locations_seeded'`);
  assert(seedFlag && seedFlag.value === '1', 'barcode location seed should be recorded');
  await seeded.run(`DELETE FROM barcode_locations WHERE lower(location) = 'shipping'`);
  await seeded.close();
  await initDatabase(freshDb);
  const reseeded = openDb(freshDb);
  const restored = await reseeded.get(`SELECT id FROM barcode_locations WHERE lower(location) = 'shipping'`);
  assert(!restored, 'init should not restore a barcode location an admin deleted');
  const kept = await reseeded.get(`SELECT COUNT(*) AS count FROM barcode_locations WHERE lower(location) = 'large format'`);
  assert(kept.count === 1, 'other seeded locations should remain after init');
  await reseeded.close();

  const server = startServer();
  await server.ready;
  const db = openDb(freshDb);
  try {
    const admin = await login('admin', adminPassword);
    const operatorHash = await bcrypt.hash('OperatorPass123', 10);
    await db.run(
      `INSERT INTO users (username, password_hash, role, display_name, is_active) VALUES ('op1', ?, 'operator', 'Operator One', 1)`,
      [operatorHash]
    );
    const operator = await login('op1', 'OperatorPass123');
    const customerResponse = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: { display_name: 'Phase Four Customer', username: 'phase4cust', password: 'CustomerPass1', phone: '919-555-0144', email: 'avery@phasefour.example' },
    });
    assert(customerResponse.status === 201, `customer create failed: ${customerResponse.text}`);
    const customer = await login('phase4cust', 'CustomerPass1');

    const forbidden = [
      ['GET', '/api/services'],
      ['POST', '/api/services'],
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
      ['GET', '/api/activity'],
      ['GET', '/api/search/orders'],
      ['GET', '/api/barcode/locations'],
      ['POST', '/api/barcode/dry-run'],
      ['GET', '/api/notifications/settings'],
      ['PUT', '/api/notifications/settings'],
    ];
    for (const [method, requestPath] of forbidden) {
      const response = await request({ method, path: requestPath, token: customer.token, json: method === 'GET' ? undefined : {} });
      assert(response.status === 403, `customer ${method} ${requestPath} should be 403, got ${response.status}`);
    }

    const operatorForbidden = [
      ['POST', '/api/services'],
      ['GET', '/api/users'],
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
      ['GET', '/api/activity'],
      ['POST', '/api/barcode/locations'],
      ['POST', '/api/barcode/dry-run'],
      ['GET', '/api/notifications/settings'],
    ];
    for (const [method, requestPath] of operatorForbidden) {
      const response = await request({ method, path: requestPath, token: operator.token, json: method === 'GET' ? undefined : {} });
      assert(response.status === 403, `operator ${method} ${requestPath} should be 403, got ${response.status}`);
    }
    const operatorSearch = await request({ method: 'GET', path: '/api/search/orders', token: operator.token });
    assert(operatorSearch.status === 200, 'operator should search orders');
    const operatorLocations = await request({ method: 'GET', path: '/api/barcode/locations', token: operator.token });
    assert(operatorLocations.status === 200, 'operator should read barcode locations');
    const operatorReport = await request({ method: 'GET', path: '/api/reports/work-orders/status', token: operator.token });
    assert(operatorReport.status === 200, 'operator should open reports');

    const badSort = await request({ method: 'GET', path: '/api/search/orders?sort=id;drop', token: admin.token });
    assert(badSort.status === 400, 'unknown sort should be rejected');

    const badService = await request({
      method: 'POST',
      path: '/api/services',
      token: admin.token,
      json: { name: '', code: 'ZZ', suffix_mode: 'code', department_name: 'Large Format' },
    });
    assert(badService.status === 400, 'blank service name should be rejected');
    const badMode = await request({
      method: 'POST',
      path: '/api/services',
      token: admin.token,
      json: { name: 'Bad Mode', code: 'BM', suffix_mode: 'alpha', department_name: 'Large Format', is_active: true },
    });
    assert(badMode.status === 400, 'unknown suffix mode should be rejected');
    const badDepartment = await request({
      method: 'POST',
      path: '/api/services',
      token: admin.token,
      json: { name: 'Bad Dept', code: 'BD', suffix_mode: 'sequence', department_name: 'Not A Department', is_active: true },
    });
    assert(badDepartment.status === 400, 'unknown department should be rejected');
    const badTurnaround = await request({
      method: 'POST',
      path: '/api/services',
      token: admin.token,
      json: { name: 'Bad Hours', code: 'BH', suffix_mode: 'sequence', department_name: 'Large Format', default_turnaround_hours: 0, is_active: true },
    });
    assert(badTurnaround.status === 400, 'zero turnaround should be rejected');

    const createdService = await request({
      method: 'POST',
      path: '/api/services',
      token: admin.token,
      json: {
        name: 'Phase Four Special',
        code: 'ZZ',
        suffix_mode: 'code',
        department_name: 'Large Format',
        description: 'Special',
        sort_order: 20,
        default_turnaround_hours: 48,
        requires_approval: false,
        is_active: true,
      },
    });
    assert(createdService.status === 201, `service create failed: ${createdService.text}`);
    assert(!Object.prototype.hasOwnProperty.call(createdService.json, 'password_hash'), 'service response should not include a hash');
    const serviceActivity = await db.get(
      `SELECT action, actor_id FROM activity_log WHERE action = 'service.created' AND entity_id = ?`,
      [createdService.json.id]
    );
    assert(serviceActivity && serviceActivity.actor_id === admin.user.id, 'creating a service should write activity for the admin');

    const order = await request({
      method: 'POST',
      path: '/api/orders',
      token: admin.token,
      json: orderBody(createdService.json.id, customerResponse.json.id),
    });
    assert(order.status === 201, `order create failed: ${order.text}`);
    const externalId = order.json.work_orders[0].external_id;
    const orderId = order.json.order.id;
    const workOrderId = order.json.work_orders[0].id;
    assert(externalId.endsWith('-ZZ'), `code suffix should be used, got ${externalId}`);

    const deactivated = await request({
      method: 'PUT',
      path: `/api/services/${createdService.json.id}`,
      token: admin.token,
      json: {
        name: 'Phase Four Special',
        code: 'ZZ',
        suffix_mode: 'code',
        department_name: 'Large Format',
        description: 'Special',
        sort_order: 20,
        default_turnaround_hours: 48,
        requires_approval: false,
        is_active: false,
      },
    });
    assert(deactivated.status === 200 && deactivated.json.is_active === false, 'service should deactivate');
    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    assert(options.status === 200, 'customer options should load');
    assert(!options.json.services.some((row) => row.id === createdService.json.id), 'deactivated service should leave the order form');
    const stillThere = await request({ method: 'GET', path: `/api/orders/${orderId}`, token: customer.token });
    assert(
      stillThere.status === 200 && stillThere.json.work_orders.some((row) => row.external_id === externalId),
      `existing order should keep the deactivated service: ${stillThere.status} ${stillThere.text}`
    );

    const found = await request({
      method: 'GET',
      path: `/api/search/orders?company=${encodeURIComponent('Phase Four')}&phone=555-0144&order_number=${encodeURIComponent(order.json.order_number)}&work_order_number=${encodeURIComponent(externalId)}&email=avery@phasefour.example&contact=Avery&service=${createdService.json.id}`,
      token: operator.token,
    });
    assert(found.status === 200 && found.json.orders.length === 1, `search should find the order: ${found.text}`);
    assert(found.json.orders[0].detail_path === `/orders/${orderId}`, 'search should link the order');
    assert(found.json.orders[0].work_orders[0].print_path === `/work-orders/${workOrderId}/print`, 'search should link the printable work order');

    const badPhone = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: { company_phone: 'call me' },
    });
    assert(badPhone.status === 400, 'invalid phone should be rejected');
    const savedSettings = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: {
        company_name: 'Phase Four Press',
        company_address: '100 Settings Lane\nRaleigh, NC 27617',
        company_phone: '919-555-0199',
        due_soon_hours: 4,
        last_backup_at: '2026-06-09 02:00:00',
      },
    });
    assert(savedSettings.status === 200, `settings save failed: ${savedSettings.text}`);
    assert(savedSettings.json.due_soon_hours.value === 4 && savedSettings.json.due_soon_hours.source === 'settings', 'due soon hours should be stored');
    assert(savedSettings.json.last_backup_at === '2026-06-09 02:00:00', 'backup timestamp should be stored');
    assert(savedSettings.json.read_only.delivery_timezone === 'UTC', 'timezone should stay read from the environment');
    assert(savedSettings.json.read_only.max_upload_mb != null, 'upload limit should be displayed');
    assert(savedSettings.json.letterhead.company_name === 'Phase Four Press', 'letterhead name should be stored');
    const printed = await request({
      method: 'GET',
      path: `/api/workorders/${workOrderId}/print`,
      token: admin.token,
    });
    assert(printed.status === 200, `print failed: ${printed.status} ${printed.text}`);
    assert(printed.json.shop.name === 'Phase Four Press', 'print should use the saved company name');
    assert(printed.json.shop.address_lines[0] === '100 Settings Lane', 'print should use the saved street');
    assert(printed.json.shop.phone === '919-555-0199', 'print should use the saved phone');
    const rules = await request({ method: 'GET', path: '/api/delivery/rules', token: admin.token });
    assert(rules.json.rules.dueSoonHours === 4, 'stored due-soon hours should drive delivery rules');
    const settingsActivity = await db.get(`SELECT id FROM activity_log WHERE action = 'settings.updated' AND actor_id = ?`, [admin.user.id]);
    assert(settingsActivity, 'settings changes should write activity');
    const clearedDue = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: { due_soon_hours: null },
    });
    assert(clearedDue.status === 200 && clearedDue.json.due_soon_hours.source === 'environment', 'clearing due soon should return to the environment');

    const selfRole = await request({
      method: 'PUT',
      path: `/api/users/${admin.user.id}`,
      token: admin.token,
      json: { username: 'admin', display_name: 'Administrator', role: 'operator', is_active: true },
    });
    assert(selfRole.status === 400 && /own role/i.test(selfRole.json.error), `self demotion should be blocked: ${selfRole.text}`);
    const selfActive = await request({
      method: 'PUT',
      path: `/api/users/${admin.user.id}`,
      token: admin.token,
      json: { username: 'admin', display_name: 'Administrator', role: 'admin', is_active: false },
    });
    assert(selfActive.status === 400 && /deactivate your own/i.test(selfActive.json.error), `self deactivation should be blocked: ${selfActive.text}`);

    const secondAdmin = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: { username: 'admin2', display_name: 'Second Admin', role: 'admin', password: 'SecondPass123' },
    });
    assert(secondAdmin.status === 201, `second admin failed: ${secondAdmin.text}`);
    assert(!secondAdmin.json.password, 'a supplied password should not be echoed');
    await db.run(`UPDATE users SET role = 'operator' WHERE username = 'admin'`);
    const lastAdmin = await request({
      method: 'PUT',
      path: `/api/users/${secondAdmin.json.id}`,
      token: admin.token,
      json: { username: 'admin2', display_name: 'Second Admin', role: 'operator', is_active: true },
    });
    assert(lastAdmin.status === 400 && /last active administrator/i.test(lastAdmin.json.error), `last admin should be protected: ${lastAdmin.text}`);
    const stillAdmin = await db.get(`SELECT role, is_active FROM users WHERE username = 'admin2'`);
    assert(stillAdmin.role === 'admin' && stillAdmin.is_active === 1, 'rejected demotion should not change the last admin');
    await db.run(`UPDATE users SET role = 'admin' WHERE username = 'admin'`);

    const reset = await request({
      method: 'PUT',
      path: `/api/users/${customerResponse.json.id}/password`,
      token: admin.token,
      json: {},
    });
    assert(reset.status === 200 && reset.json.password && reset.json.username === 'phase4cust', 'password reset should return a password once');
    const listed = await request({ method: 'GET', path: '/api/users?limit=100', token: admin.token });
    assert(listed.status === 200, 'user list should load');
    const listedText = JSON.stringify(listed.json);
    assert(!listedText.includes('password_hash') && !listedText.includes(reset.json.password), 'user list should not expose hashes or the reset password');
    const resetActivity = await db.get(`SELECT detail FROM activity_log WHERE action = 'user.password_reset' AND entity_id = ?`, [customerResponse.json.id]);
    assert(resetActivity && !resetActivity.detail.includes(reset.json.password), 'activity should record the reset without the password');
    const inactive = await request({
      method: 'PUT',
      path: `/api/users/${customerResponse.json.id}`,
      token: admin.token,
      json: { username: 'phase4cust', display_name: 'Phase Four Customer', role: 'customer', is_active: false },
    });
    assert(inactive.status === 200, `customer deactivate failed: ${inactive.text}`);
    const hiddenLookup = await request({ method: 'GET', path: '/api/customers/lookup', token: operator.token });
    assert(hiddenLookup.status === 200 && Array.isArray(hiddenLookup.json), 'customer lookup should load');
    assert(!hiddenLookup.json.some((row) => row.username === 'phase4cust'), 'deactivated customers should leave lookup');
    const locked = await request({ method: 'POST', path: '/api/auth/login', json: { username: 'phase4cust', password: reset.json.password } });
    assert(locked.status === 401, 'deactivated user should not log in');
    await request({
      method: 'PUT',
      path: `/api/users/${customerResponse.json.id}`,
      token: admin.token,
      json: { username: 'phase4cust', display_name: 'Phase Four Customer', role: 'customer', is_active: true },
    });

    const emailOn = await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { order_submitted: true } },
    });
    assert(emailOn.status === 400, 'email notifications should stay off');
    const disabledRush = await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { work_order_rush: false } },
    });
    assert(disabledRush.status === 200 && disabledRush.json.in_app.find((row) => row.event_key === 'work_order_rush').enabled === false, 'in-app rush events should toggle off');
    assert(disabledRush.json.email.every((row) => row.enabled === false && row.locked === true), 'email rows should remain locked off');
    const quietRush = await request({
      method: 'POST',
      path: '/api/workorders',
      token: admin.token,
      json: {
        customer_id: customerResponse.json.id,
        description: 'Quiet rush',
        quantity: 1,
        status: 'open',
        department: 'Large Format',
        priority: 'Rush',
        external_id: 'P4-QUIET-RUSH',
      },
    });
    assert(quietRush.status === 201, `quiet rush create failed: ${quietRush.text}`);
    const quietNotes = await db.get(`SELECT id FROM notifications WHERE type = 'work_order_rush' AND work_order_id = ?`, [quietRush.json.id]);
    assert(!quietNotes, 'disabled in-app events should not be stored');
    await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { work_order_rush: true } },
    });
    const loudRush = await request({
      method: 'POST',
      path: '/api/workorders',
      token: admin.token,
      json: {
        customer_id: customerResponse.json.id,
        description: 'Loud rush',
        quantity: 1,
        status: 'open',
        department: 'Large Format',
        priority: 'Rush',
        external_id: 'P4-LOUD-RUSH',
      },
    });
    assert(loudRush.status === 201, `loud rush create failed: ${loudRush.text}`);
    const loudNotes = await db.get(`SELECT id FROM notifications WHERE type = 'work_order_rush' AND work_order_id = ?`, [loudRush.json.id]);
    assert(loudNotes, 'enabled in-app events should be stored');

    const beforeEvents = await db.get('SELECT COUNT(*) AS count FROM barcode_events');
    const beforeActivity = await db.get('SELECT COUNT(*) AS count FROM activity_log');
    const beforeDept = await db.get('SELECT department FROM work_orders WHERE external_id = ?', [externalId]);
    const dry = await request({
      method: 'POST',
      path: '/api/barcode/dry-run',
      token: admin.token,
      json: { scanned_value: externalId, location: 'Dispatch' },
    });
    assert(dry.status === 200 && dry.json.dry_run === true, `dry run failed: ${dry.text}`);
    assert(dry.json.work_order && dry.json.work_order.print_path.endsWith('/print'), 'dry run should link the printable work order');
    assert(dry.json.location.matched === true && dry.json.location.would_move_department === true, 'Dispatch should resolve as a department move');
    assert(dry.json.location.would_advance_stage === false, 'Dispatch should not advance a stage');
    const afterEvents = await db.get('SELECT COUNT(*) AS count FROM barcode_events');
    const afterActivity = await db.get('SELECT COUNT(*) AS count FROM activity_log');
    const afterDept = await db.get('SELECT department FROM work_orders WHERE external_id = ?', [externalId]);
    assert(beforeEvents.count === afterEvents.count && beforeActivity.count === afterActivity.count, 'dry run should not write scans or activity');
    assert(beforeDept.department === afterDept.department, 'dry run should not move the work order');

    const badLocation = await request({
      method: 'POST',
      path: '/api/barcode/locations',
      token: admin.token,
      json: { location: 'Nowhere' },
    });
    assert(badLocation.status === 400, 'a location with no department or stage should be rejected');
    const added = await request({
      method: 'POST',
      path: '/api/barcode/locations',
      token: admin.token,
      json: { location: 'Packing', department_name: 'Dispatch', stage_name: 'Finishing', sort_order: 30, is_active: true },
    });
    assert(added.status === 201, `location create failed: ${added.text}`);
    const removed = await request({ method: 'DELETE', path: `/api/barcode/locations/${added.json.id}`, token: admin.token });
    assert(removed.status === 200, 'location remove should succeed');
    const missing = await request({
      method: 'POST',
      path: '/api/barcode/dry-run',
      token: admin.token,
      json: { scanned_value: externalId, location: 'Packing' },
    });
    assert(missing.status === 200 && missing.json.location.matched === false && missing.json.location.would_move_department === false, 'removed locations should not resolve');

    const customerActivity = await db.get(
      `SELECT id FROM activity_log WHERE action = 'user.created' AND detail LIKE '%phase4cust%'`
    );
    assert(customerActivity, 'customer create should write activity');
    const badUsername = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: { display_name: 'Bad Name', username: 'bad name', password: 'CustomerPass1' },
    });
    assert(badUsername.status === 400 && /username/.test(badUsername.json.error || ''), `bad customer username should be rejected: ${badUsername.text}`);
    const longPassword = 'a'.repeat(73);
    const longUser = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: { username: 'longpass', display_name: 'Long Pass', role: 'operator', password: longPassword },
    });
    assert(longUser.status === 400 && /72 bytes/.test(longUser.json.error || ''), `long password should be rejected: ${longUser.text}`);
    const longReset = await request({
      method: 'PUT',
      path: `/api/users/${customerResponse.json.id}/password`,
      token: admin.token,
      json: { password: longPassword },
    });
    assert(longReset.status === 400 && /72 bytes/.test(longReset.json.error || ''), `long reset should be rejected: ${longReset.text}`);
    const longChange = await request({
      method: 'PUT',
      path: `/api/customers/${customerResponse.json.id}/password`,
      token: admin.token,
      json: { password: longPassword },
    });
    assert(longChange.status === 400 && /72 bytes/.test(longChange.json.error || ''), `long customer password change should be rejected: ${longChange.text}`);

    const createdUsers = await Promise.all(Array.from({ length: 20 }, (_, index) => request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: `stress${String(index).padStart(2, '0')}`,
        display_name: `Stress ${index}`,
        role: 'operator',
        password: 'StressPass123',
      },
    })));
    assert(createdUsers.every((row) => row.status === 201), `concurrent user creates should succeed: ${createdUsers.map((row) => row.status).join(',')}`);
    const mixed = await Promise.all([
      request({
        method: 'PUT',
        path: '/api/settings',
        token: admin.token,
        json: { company_phone: '919-782-3332' },
      }),
      request({
        method: 'PUT',
        path: '/api/notifications/settings',
        token: admin.token,
        json: { events: { work_order_on_hold: true } },
      }),
      request({
        method: 'POST',
        path: '/api/users',
        token: admin.token,
        json: { username: 'stressmix1', display_name: 'Stress Mix 1', role: 'operator', password: 'StressPass123' },
      }),
      request({
        method: 'POST',
        path: '/api/users',
        token: admin.token,
        json: { username: 'stressmix2', display_name: 'Stress Mix 2', role: 'operator', password: 'StressPass123' },
      }),
    ]);
    assert(mixed.every((row) => row.status < 500), `mixed admin writes should not 500: ${mixed.map((row) => `${row.status} ${row.text}`).join(' | ')}`);

    const rivalA = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: { username: 'rivala', display_name: 'Rival A', role: 'admin', password: 'RivalPass123' },
    });
    const rivalB = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: { username: 'rivalb', display_name: 'Rival B', role: 'admin', password: 'RivalPass123' },
    });
    assert(rivalA.status === 201 && rivalB.status === 201, 'rival admins should be created');
    await db.run(`UPDATE users SET role = 'operator' WHERE username IN ('admin', 'admin2')`);
    const loginA = await login('rivala', 'RivalPass123');
    const loginB = await login('rivalb', 'RivalPass123');
    const [demoteB, deactivateA] = await Promise.all([
      request({
        method: 'PUT',
        path: `/api/users/${rivalB.json.id}`,
        token: loginA.token,
        json: { username: 'rivalb', display_name: 'Rival B', role: 'operator', is_active: true },
      }),
      request({
        method: 'PUT',
        path: `/api/users/${rivalA.json.id}`,
        token: loginB.token,
        json: { username: 'rivala', display_name: 'Rival A', role: 'admin', is_active: false },
      }),
    ]);
    const rivalResults = [demoteB, deactivateA];
    assert(rivalResults.every((row) => row.status < 500), `rival admin writes should not 500: ${rivalResults.map((row) => row.text).join(' | ')}`);
    assert(rivalResults.some((row) => row.status === 200), 'one rival admin change should succeed');
    assert(rivalResults.some((row) => row.status >= 400 && row.status < 500), `the losing rival change should be a 4xx: ${rivalResults.map((row) => row.status).join(',')}`);
    const activeAdmins = await db.get(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND COALESCE(is_active, 1) = 1`);
    assert(activeAdmins.count >= 1, 'concurrent demotion must leave an active administrator');
    await db.run(`UPDATE users SET role = 'admin', is_active = 1 WHERE username IN ('admin', 'admin2')`);

    const sameName = await Promise.all(Array.from({ length: 10 }, () => request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      timeoutMs: 25000,
      json: { display_name: 'Same Name Shop', password: 'CustomerPass1' },
    })));
    assert(sameName.every((row) => row.status < 500), `concurrent same-name customer creates should not 500: ${sameName.map((row) => `${row.status} ${row.text}`).join(' | ')}`);
    assert(sameName.every((row) => row.status === 201), `concurrent same-name customer creates should succeed: ${sameName.map((row) => row.status).join(',')}`);
    const sameUsernames = new Set(sameName.map((row) => row.json && row.json.username));
    assert(sameUsernames.size === 10, `same-name creates should receive distinct usernames: ${[...sameUsernames].join(',')}`);

    const largeFormat = await db.get(`SELECT id FROM services WHERE name = 'Large Format' AND COALESCE(is_active, 1) = 1`);
    assert(largeFormat && largeFormat.id, 'Large Format should stay active for the mixed load');
    const loadStarted = Date.now();
    const mixedLoad = await Promise.all([
      ...Array.from({ length: 40 }, (_, index) => request({
        method: 'POST',
        path: '/api/orders',
        token: admin.token,
        timeoutMs: 25000,
        json: orderBody(largeFormat.id, customerResponse.json.id, { project_name: `Load ${index}` }),
      })),
      ...Array.from({ length: 40 }, () => request({
        method: 'POST',
        path: '/api/barcode',
        token: admin.token,
        timeoutMs: 25000,
        json: { scanned_value: externalId, location: 'Quality Control' },
      })),
      ...Array.from({ length: 10 }, (_, index) => request({
        method: 'PUT',
        path: '/api/settings',
        token: admin.token,
        timeoutMs: 25000,
        json: { last_backup_at: `2026-06-09 03:00:${String(index).padStart(2, '0')}` },
      })),
    ]);
    const loadMs = Date.now() - loadStarted;
    const loadFailures = mixedLoad.filter((row) => row.status >= 500);
    assert(loadFailures.length === 0, `mixed load should not 500 (${loadMs}ms): ${loadFailures.map((row) => row.text).join(' | ')}\n${server.logs()}`);
    assert(loadMs < 20000, `mixed load of 40 orders, 40 scans, and 10 admin writes should finish well under 30s, took ${loadMs}ms`);
    const loadOrders = mixedLoad.slice(0, 40);
    const loadScans = mixedLoad.slice(40, 80);
    const loadWrites = mixedLoad.slice(80);
    assert(loadOrders.every((row) => row.status === 201), `load orders should succeed: ${loadOrders.map((row) => row.status).join(',')}`);
    assert(loadScans.every((row) => row.status === 201), `load scans should succeed: ${loadScans.map((row) => `${row.status} ${row.text}`).join(' | ')}`);
    assert(loadWrites.every((row) => row.status === 200), `load admin writes should succeed: ${loadWrites.map((row) => `${row.status} ${row.text}`).join(' | ')}`);

    const csv = await request({ method: 'GET', path: '/api/activity?format=csv&type=service.created', token: admin.token });
    assert(csv.status === 200 && /text\/csv/.test(String(csv.headers['content-type'])) && csv.text.includes('service.created'), 'activity csv should export the filtered rows');
    const operatorCsv = await request({ method: 'GET', path: '/api/activity?format=csv', token: operator.token });
    assert(operatorCsv.status === 403, 'operators should not export the activity log');

    console.log('Phase 4 checks passed.');
  } finally {
    server.stop();
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
