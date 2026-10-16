/**
 * Phase 2 checks: admin board roles, counts, filters, pagination, approvals, and activity.
 * Usage (from backend/): node scripts/verify-phase2.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const { classifyDelivery } = require('../deliveryRules');

const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');
const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase2-'));
const oldDb = path.join(tmp, 'old.db');
const freshDb = path.join(tmp, 'fresh.db');
const port = 3108;
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

const ACTIVE_SQL = `
  NOT (lower(trim(coalesce(status, ''))) IN ('completed', 'complete'))
  AND lower(trim(coalesce(department, ''))) != 'complete'
`;
const FINISHED_SQL = `lower(trim(coalesce(status, ''))) IN ('completed', 'complete')`;

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
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
  };
}

function request({ method, path: requestPath, token, json }) {
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
        resolve({ status: res.statusCode, json: parsed, text });
      });
    });
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

function weekdayIso(offset = 0) {
  const now = new Date();
  for (let extra = 0; extra < 10; extra += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset + extra));
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) return date.toISOString().slice(0, 10);
  }
  throw new Error('no weekday');
}

function orderBody(serviceId, overrides = {}) {
  return fillOrderLines({
    company: 'Phase Two Print Co',
    contact_name: 'Jordan Hale',
    phone: '919-555-0148',
    email: 'jordan@phasetwo.example',
    project_name: 'Phase Two Job',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '200 Board Street',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Accent Truck',
    due_date: weekdayIso(1),
    due_time: '10:00',
    service_ids: [serviceId],
    line_items: [{ description: 'Board set', quantity: '2', service_id: serviceId }],
    ...overrides,
  });
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
  await db.close();

  await initDatabase(oldDb);
  await initDatabase(oldDb);

  const check = openDb(oldDb);
  const legacy = await check.get(`SELECT status FROM work_orders WHERE external_id = 'WO-LEGACY'`);
  const legacyCount = await check.get(`SELECT COUNT(*) AS count FROM work_orders WHERE external_id = 'WO-LEGACY'`);
  assert(legacy && legacy.status === 'completed', 'legacy work order should survive init');
  assert(legacyCount.count === 1, 'init should not duplicate the legacy work order');
  const workOrderColumns = await columnNames(check, 'work_orders');
  assert(workOrderColumns.has('approval_by') && workOrderColumns.has('approval_at'), 'approval columns should be added on an older database');
  const scanColumns = await columnNames(check, 'barcode_events');
  assert(scanColumns.has('from_department') && scanColumns.has('to_department'), 'scan department columns should be added on an older database');
  for (const table of ['activity_log', 'system_alerts', 'system_settings']) {
    const row = await check.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
    assert(row, `${table} should exist after migrating an older database`);
  }
  const alerts = await check.get('SELECT COUNT(*) AS count FROM system_alerts');
  assert(alerts.count === 0, 'init should not insert placeholder alerts');
  await check.close();
  console.log('PASS older database migration, twice');
}

async function initFreshTwice() {
  await initDatabase(freshDb);
  const first = openDb(freshDb);
  const departments = await first.get('SELECT COUNT(*) AS count FROM departments');
  await first.close();
  const second = await initDatabase(freshDb);
  assert(/Admin user already exists/.test(second.out), 'second init should keep the existing admin');
  const db = openDb(freshDb);
  const services = await db.get('SELECT COUNT(*) AS count FROM services');
  const departmentsAgain = await db.get('SELECT COUNT(*) AS count FROM departments');
  assert(services.count === 7, 'fresh init twice should leave 7 services');
  assert(departmentsAgain.count === departments.count, 'second init should not duplicate departments');
  const workOrderColumns = await columnNames(db, 'work_orders');
  const scanColumns = await columnNames(db, 'barcode_events');
  assert(workOrderColumns.has('approval_by') && scanColumns.has('from_department'), 'fresh schema should include phase 2 columns');
  const orderColumns = await columnNames(db, 'orders');
  assert(orderColumns.has('payment_method') && orderColumns.has('bill_to_zip'), 'fresh orders should include payment and bill-to columns');
  const fieldCount = await db.get('SELECT COUNT(*) AS count FROM service_fields');
  assert(fieldCount.count === 54, `fresh init twice should leave 54 service fields, found ${fieldCount.count}`);
  const alerts = await db.get('SELECT COUNT(*) AS count FROM system_alerts');
  assert(alerts.count === 0, 'fresh init should not seed fake alerts');
  const operatorHash = await bcrypt.hash('OperatorPass1', 10);
  await db.run(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES ('op1', ?, 'operator', 'Operator One')`,
    [operatorHash]
  );
  await db.close();
  console.log('PASS fresh init_db twice');
}

async function activeCount(db, department) {
  const params = [];
  let departmentSql = '';
  if (department) {
    departmentSql = ` AND lower(trim(coalesce(department, ''))) = lower(?)`;
    params.push(department);
  }
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM work_orders WHERE ${ACTIVE_SQL}${departmentSql}`,
    params
  );
  return row.count;
}

async function runApiChecks() {
  const server = startServer();
  await server.ready;
  console.log('PASS backend startup');
  const db = openDb(freshDb);
  try {
    const unauth = await request({ method: 'GET', path: '/api/admin-board' });
    assert(unauth.status === 401, `unauthenticated board should be 401, got ${unauth.status}`);

    const admin = await login('admin', adminPassword);
    const operator = await login('op1', 'OperatorPass1');
    const customerResponse = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        username: 'phasetwo',
        display_name: 'Phase Two Customer',
        company: 'Phase Two Print Co',
        contact_name: 'Jordan Hale',
        phone: '919-555-0148',
        email: 'jordan@phasetwo.example',
        password: 'CustomerPass1',
      },
    });
    assert(customerResponse.status === 201, `customer create failed: ${customerResponse.status} ${customerResponse.text}`);
    const customer = await login('phasetwo', 'CustomerPass1');
    const deliveryRules = await request({ method: 'GET', path: '/api/delivery/rules', token: admin.token });
    assert(deliveryRules.status === 200, `delivery rules failed: ${deliveryRules.text}`);
    assert(deliveryRules.json.rules.windows.willCall.start === '08:00' && deliveryRules.json.rules.windows.willCall.end === '17:00', 'Will Call hours should be 8:00 AM to 5:00 PM');
    assert(deliveryRules.json.rules.windows.delivery.start === '09:00' && deliveryRules.json.rules.windows.delivery.end === '14:00', 'test delivery hours should follow DELIVERY_WINDOW_END');
    assert(deliveryRules.json.rules.willCallCutoff === '15:00' && deliveryRules.json.rules.carrierCutoff === '14:00', 'same-day cutoffs should stay 15:00 and 14:00');

    for (const pathName of ['/api/admin-board', '/api/admin-board/work-orders', '/api/admin-board/activity', '/api/admin-board/approvals']) {
      const denied = await request({ method: 'GET', path: pathName, token: customer.token });
      assert(denied.status === 403, `${pathName} should be 403 for a customer, got ${denied.status} ${denied.text}`);
    }
    const customerDecision = await request({
      method: 'POST',
      path: '/api/admin-board/approvals/1',
      token: customer.token,
      json: { decision: 'approved' },
    });
    assert(customerDecision.status === 403, 'customer approval should be 403');

    const operatorBoard = await request({ method: 'GET', path: '/api/admin-board', token: operator.token });
    assert(operatorBoard.status === 200, `operator board failed: ${operatorBoard.status} ${operatorBoard.text}`);

    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    assert(options.status === 200, 'order options failed');
    const services = Object.fromEntries(options.json.services.map((service) => [service.name, service]));
    setServiceNames(services);
    const dueDate = weekdayIso(1);

    const createdIds = [];
    for (let index = 0; index < 6; index += 1) {
      const created = await request({
        method: 'POST',
        path: '/api/orders',
        token: customer.token,
        json: orderBody(services['Large Format'].id, {
          due_date: dueDate,
          project_name: `Board job ${index + 1}`,
        }),
      });
      assert(created.status === 201, `order ${index} failed: ${created.status} ${created.text}`);
      createdIds.push(created.json.work_orders[0]);
    }

    const summary = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    assert(summary.status === 200, `admin board failed: ${summary.text}`);
    const bodyText = summary.text;
    assert(!/daily backup completed/i.test(bodyText), 'board must not invent a completed backup');
    assert(!/all systems operational/i.test(bodyText), 'board must not invent an all-clear status');
    const expectedActive = await activeCount(db);
    assert(summary.json.stats.total_active === expectedActive, `total active ${summary.json.stats.total_active} != database ${expectedActive}`);
    const largeFormat = await activeCount(db, 'Large Format');
    const largeTab = summary.json.tabs.find((tab) => tab.key === 'Large Format');
    assert(largeTab && largeTab.count === largeFormat, 'Large Format tab count should match the database');
    const allTab = summary.json.tabs.find((tab) => tab.key === 'All');
    assert(allTab && allTab.count === expectedActive, 'All tab should match total active');
    assert(summary.json.queue.find((row) => row.name === 'Large Format').count === largeFormat, 'queue summary should match the tab');

    const now = new Date();
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01 00:00:00`;
    assert(summary.json.stats.timezone === 'UTC', 'test timezone should be UTC');
    assert(summary.json.stats.month_start === monthStart, `month start ${summary.json.stats.month_start} != ${monthStart}`);
    const monthCount = await db.get(
      `SELECT COUNT(*) AS count FROM work_orders
       WHERE ${FINISHED_SQL}
         AND datetime(coalesce(updated_at, created_at)) >= datetime(?)
         AND datetime(coalesce(updated_at, created_at)) < datetime(?)`,
      [summary.json.stats.month_start, summary.json.stats.month_end]
    );
    assert(summary.json.stats.completed_this_month === monthCount.count, 'completed this month should match the database');

    const emptyAlert = (summary.json.alerts || []).find((alert) => alert.id === 'empty-queues');
    if (emptyAlert) {
      for (const name of emptyAlert.departments || []) {
        assert(name !== 'Complete', 'Complete is not an empty-queue alert');
        const count = await activeCount(db, name);
        assert(count === 0, `${name} was listed as empty but has ${count} active work orders`);
      }
      const small = await activeCount(db, 'Small Format');
      assert(small === 0 && emptyAlert.departments.includes('Small Format'), 'Small Format should be reported empty');
    }
    const backupAlert = (summary.json.alerts || []).find((alert) => alert.id === 'backup');
    assert(backupAlert && /no backup has been recorded/i.test(backupAlert.detail), 'missing backup setting should be reported as not recorded');

    const deliveries = await db.all(`SELECT id, due_time, status FROM deliveries WHERE lower(trim(coalesce(status, ''))) != 'complete'`);
    const overdueCount = deliveries.filter((delivery) => classifyDelivery(delivery).overdue).length;
    const overdueAlert = (summary.json.alerts || []).find((alert) => alert.id === 'overdue-deliveries');
    if (overdueCount === 0) {
      assert(!overdueAlert, 'overdue alert should be omitted when nothing is overdue');
    } else {
      assert(overdueAlert && overdueAlert.count === overdueCount, `overdue alert count ${overdueAlert && overdueAlert.count} != ${overdueCount}`);
    }

    const page = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=1&offset=0',
      token: operator.token,
    });
    assert(page.status === 200 && page.json.work_orders.length === 1, 'limit 1 should return one row');
    assert(page.json.total === expectedActive, 'unfiltered page total should match active work');
    assert(page.json.limit === 1 && page.json.offset === 0, 'page metadata should echo limit and offset');
    const second = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=1&offset=1',
      token: operator.token,
    });
    assert(second.json.work_orders.length === 1 && second.json.work_orders[0].id !== page.json.work_orders[0].id, 'offset should return a different row');
    const defaults = await request({ method: 'GET', path: '/api/admin-board/work-orders', token: admin.token });
    assert(defaults.json.limit === 8, 'default page size should be 8');
    assert(defaults.json.work_orders.length === Math.min(8, defaults.json.total), 'default page should not return every row when more exist');
    assert(defaults.json.total > 8, 'fixture should have more than one page');

    const badLimit = await request({ method: 'GET', path: '/api/admin-board/work-orders?limit=0', token: admin.token });
    assert(badLimit.status === 400, 'limit 0 should be 400');
    const badOffset = await request({ method: 'GET', path: '/api/admin-board/work-orders?offset=-1', token: admin.token });
    assert(badOffset.status === 400, 'negative offset should be 400');
    const badStatus = await request({ method: 'GET', path: '/api/admin-board/work-orders?status=nope', token: admin.token });
    assert(badStatus.status === 400, 'unknown status should be 400');

    const filtered = await request({
      method: 'GET',
      path: `/api/admin-board/work-orders?department=${encodeURIComponent('Large Format')}&q=${encodeURIComponent('Phase Two Print Co')}&due_from=${dueDate}&due_to=${dueDate}`,
      token: admin.token,
    });
    assert(filtered.status === 200, filtered.text);
    assert(filtered.json.total === 6, `expected 6 matching large format orders, got ${filtered.json.total}`);
    assert(filtered.json.work_orders.every((row) => row.department === 'Large Format' && row.company === 'Phase Two Print Co'), 'filter should limit rows');
    assert(filtered.json.work_orders.every((row) => row.process === 'Large Format'), 'process should fall back to the service name');
    const wildcard = await request({
      method: 'GET',
      path: `/api/admin-board/work-orders?q=${encodeURIComponent('%')}`,
      token: admin.token,
    });
    assert(wildcard.status === 200 && wildcard.json.total === 0, 'a percent sign should be a literal search, not a match-all');

    const activity = await request({ method: 'GET', path: '/api/admin-board/activity?limit=100', token: admin.token });
    assert(activity.status === 200, activity.text);
    const createdActivity = activity.json.activity.filter((row) => row.action === 'work_order.created' && row.external_id === createdIds[0].external_id);
    assert(createdActivity.length === 1, 'creating an order should write one activity row per work order');
    assert(/Created in Large Format/.test(createdActivity[0].summary), 'created activity should name the department');

    const detail = await request({ method: 'GET', path: `/api/workorders/${createdIds[0].id}`, token: admin.token });
    const moved = await request({
      method: 'PUT',
      path: `/api/workorders/${createdIds[0].id}`,
      token: operator.token,
      json: {
        customer_id: detail.json.customer_id,
        description: detail.json.description,
        quantity: detail.json.quantity,
        status: detail.json.status,
        department: 'Quality',
        priority: detail.json.priority || 'Normal',
        external_id: detail.json.external_id,
      },
    });
    assert(moved.status === 200 && moved.json.department === 'Quality', `move failed: ${moved.status} ${moved.text}`);
    assert(moved.json.next_department === 'Dispatch', 'moving to Quality should follow the department route');
    const movedActivity = await db.get(
      `SELECT detail FROM activity_log WHERE action = 'work_order.moved' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
      [createdIds[0].id]
    );
    assert(movedActivity && /Moved to Quality/.test(movedActivity.detail), 'a department change should write a move activity');

    const completed = await request({
      method: 'PUT',
      path: `/api/workorders/${createdIds[0].id}`,
      token: admin.token,
      json: {
        customer_id: detail.json.customer_id,
        description: detail.json.description,
        quantity: detail.json.quantity,
        status: 'completed',
        department: 'Quality',
        priority: 'Normal',
        external_id: detail.json.external_id,
      },
    });
    assert(completed.status === 200, completed.text);
    const completedActivity = await db.get(
      `SELECT detail FROM activity_log WHERE action = 'work_order.completed' AND entity_id = ?`,
      [createdIds[0].id]
    );
    assert(completedActivity && /Completed/.test(completedActivity.detail), 'completing a work order should write activity');
    const completedTab = await request({ method: 'GET', path: '/api/admin-board/work-orders?department=Complete&status=completed', token: admin.token });
    assert(completedTab.json.work_orders.some((row) => row.id === createdIds[0].id), 'completed work should appear on the Complete filter');

    const scanned = await request({
      method: 'POST',
      path: '/api/barcode',
      token: operator.token,
      json: { scanned_value: createdIds[1].external_id, location: 'Dispatch' },
    });
    assert(scanned.status === 201, `scan failed: ${scanned.status} ${scanned.text}`);
    assert(scanned.json.from_department === 'Large Format' && scanned.json.to_department === 'Dispatch', 'scan should record from and to departments');
    assert(scanned.json.department_moved === true, 'a department location should move the work order');
    const afterScan = await db.get('SELECT department, next_department FROM work_orders WHERE id = ?', [createdIds[1].id]);
    assert(afterScan.department === 'Dispatch' && afterScan.next_department === 'Delivery', 'scan should move the work order onto the route');
    const scanMove = await db.get(
      `SELECT id FROM activity_log WHERE action = 'work_order.moved' AND entity_id = ? AND detail LIKE '%Dispatch%'`,
      [createdIds[1].id]
    );
    assert(scanMove, 'a department scan should write activity');

    const stageScan = await request({
      method: 'POST',
      path: '/api/barcode',
      token: operator.token,
      json: { scanned_value: createdIds[2].external_id, location: 'Shipping' },
    });
    assert(stageScan.status === 201 && stageScan.json.to_department == null, 'an unconfigured Shipping scan should not move the department');
    assert(stageScan.json.department_move_reason === 'unknown_location', 'an unconfigured location should explain that the department stayed');
    const stillLarge = await db.get('SELECT department FROM work_orders WHERE id = ?', [createdIds[2].id]);
    assert(stillLarge.department === 'Large Format', 'an unconfigured location should leave the department in place');

    const finishScan = await request({
      method: 'POST',
      path: '/api/barcode',
      token: admin.token,
      json: { scanned_value: createdIds[3].external_id, location: 'Complete' },
    });
    assert(finishScan.status === 201 && finishScan.json.status === 'completed', 'scanning into Complete should finish the work order');
    const finishedRow = await db.get('SELECT status, department FROM work_orders WHERE id = ?', [createdIds[3].id]);
    assert(finishedRow.status === 'completed' && finishedRow.department === 'Complete', 'Complete scan should store both fields');

    const archive = await request({
      method: 'POST',
      path: '/api/orders',
      token: operator.token,
      json: orderBody(services['Archive File Request'].id, {
        customer_id: customerResponse.json.id,
        due_date: dueDate,
        line_items: [{ description: 'Old set', quantity: '1', service_id: services['Archive File Request'].id }],
      }),
    });
    assert(archive.status === 201, `archive order failed: ${archive.text}`);
    const archiveWorkOrder = archive.json.work_orders[0];
    assert(archiveWorkOrder.approval_status === 'pending', 'archive requests start pending');
    const pending = await request({ method: 'GET', path: '/api/admin-board/approvals', token: operator.token });
    assert(pending.status === 200 && pending.json.approvals.some((row) => row.id === archiveWorkOrder.id), 'pending archive request should be listed');
    const operatorDenied = await request({
      method: 'POST',
      path: `/api/admin-board/approvals/${archiveWorkOrder.id}`,
      token: operator.token,
      json: { decision: 'approved' },
    });
    assert(operatorDenied.status === 403, 'operators cannot approve');
    const badDecision = await request({
      method: 'POST',
      path: `/api/admin-board/approvals/${archiveWorkOrder.id}`,
      token: admin.token,
      json: { decision: 'yes' },
    });
    assert(badDecision.status === 400, 'unknown decision should be 400');
    const missing = await request({
      method: 'POST',
      path: '/api/admin-board/approvals/999999',
      token: admin.token,
      json: { decision: 'approved' },
    });
    assert(missing.status === 404, 'missing work order should be 404');
    const notPending = await request({
      method: 'POST',
      path: `/api/admin-board/approvals/${createdIds[4].id}`,
      token: admin.token,
      json: { decision: 'approved' },
    });
    assert(notPending.status === 409, 'a normal work order should not be approvable');

    const approved = await request({
      method: 'POST',
      path: `/api/admin-board/approvals/${archiveWorkOrder.id}`,
      token: admin.token,
      json: { decision: 'approved', note: 'Retrieved from the file room' },
    });
    assert(approved.status === 200 && approved.json.approval_status === 'approved', approved.text);
    assert(approved.json.approval_by === admin.user.id, 'approval should record the admin');
    assert(approved.json.approval_at, 'approval should record when');
    const approvedRow = await db.get('SELECT approval_status, approval_by, approval_at FROM work_orders WHERE id = ?', [archiveWorkOrder.id]);
    assert(approvedRow.approval_status === 'approved' && approvedRow.approval_by === admin.user.id && approvedRow.approval_at, 'approval columns should be stored');
    const approvedActivity = await db.get(
      `SELECT actor_id, detail FROM activity_log WHERE action = 'work_order.approved' AND entity_id = ?`,
      [archiveWorkOrder.id]
    );
    assert(approvedActivity && approvedActivity.actor_id === admin.user.id && /Approved/.test(approvedActivity.detail), 'approval should write activity');
    const again = await request({
      method: 'POST',
      path: `/api/admin-board/approvals/${archiveWorkOrder.id}`,
      token: admin.token,
      json: { decision: 'rejected' },
    });
    assert(again.status === 409, 'a decided request cannot be decided again');

    const secondArchive = await request({
      method: 'POST',
      path: '/api/orders',
      token: admin.token,
      json: orderBody(services['Archive File Request'].id, {
        customer_id: customerResponse.json.id,
        due_date: dueDate,
        line_items: [{ description: 'Second set', quantity: '1', service_id: services['Archive File Request'].id }],
      }),
    });
    assert(secondArchive.status === 201, secondArchive.text);
    const rejected = await request({
      method: 'POST',
      path: `/api/admin-board/approvals/${secondArchive.json.work_orders[0].id}`,
      token: admin.token,
      json: { decision: 'rejected' },
    });
    assert(rejected.status === 200 && rejected.json.approval_status === 'rejected', rejected.text);
    const rejectedActivity = await db.get(
      `SELECT id FROM activity_log WHERE action = 'work_order.rejected' AND entity_id = ?`,
      [secondArchive.json.work_orders[0].id]
    );
    assert(rejectedActivity, 'rejection should write activity');
    const stillPending = await request({ method: 'GET', path: '/api/admin-board/approvals', token: admin.token });
    assert(stillPending.json.approvals.every((row) => row.id !== archiveWorkOrder.id && row.id !== secondArchive.json.work_orders[0].id), 'decided requests leave the pending list');

    await db.run(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('last_backup_at', '2026-10-01 02:00:00', datetime('now'))`
    );
    await db.run(
      `INSERT INTO system_alerts (severity, message, detail, is_active) VALUES ('warning', 'Press 2 is down', 'Operator reported a jam', 1)`
    );
    await db.run(
      `INSERT INTO system_alerts (severity, message, detail, is_active) VALUES ('info', 'Hidden alert', 'Should stay hidden', 0)`
    );
    const refreshed = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    const recordedBackup = refreshed.json.alerts.find((alert) => alert.id === 'backup');
    assert(recordedBackup && /2026/.test(recordedBackup.detail) && /no backup has been recorded/i.test(recordedBackup.detail) === false, 'backup alert should use the stored timestamp');
    assert(refreshed.json.alerts.some((alert) => alert.message === 'Press 2 is down'), 'active stored alerts should be included');
    assert(!refreshed.json.alerts.some((alert) => alert.message === 'Hidden alert'), 'inactive stored alerts should be omitted');

    const finalActive = await activeCount(db);
    assert(refreshed.json.stats.total_active === finalActive, 'summary counts should still match after moves and completions');
    console.log('PASS admin board API');
  } finally {
    await db.close();
    server.stop();
  }
}

async function main() {
  process.env.DELIVERY_TIMEZONE = 'UTC';
  await migrateOldDatabase();
  await initFreshTwice();
  await runApiChecks();
  console.log('Phase 2 verification passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
