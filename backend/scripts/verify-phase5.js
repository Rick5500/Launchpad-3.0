/**
 * Phase 5 checks: per-service line fields, payment, bill-to, return, and legacy rows.
 * Usage (from backend/): node scripts/verify-phase5.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase5-'));
const oldDb = path.join(tmp, 'old.db');
const freshDb = path.join(tmp, 'fresh.db');
const uploadDir = path.join(tmp, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const port = 3105;
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
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  delivery_method TEXT NOT NULL,
  due_date TEXT NOT NULL,
  due_time TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
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
    UPLOAD_DIR: uploadDir,
    DELIVERY_TIMEZONE: 'UTC',
    DELIVERY_WINDOW_START: '09:00',
    DELIVERY_WINDOW_END: '14:00',
    DELIVERY_SLOT_MINUTES: '15',
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

function weekdayIso() {
  for (let offset = 0; offset < 7; offset += 1) {
    const date = utcDate(offset);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) return isoDate(date);
  }
  return isoDate(utcDate(0));
}

function request({ method, path: requestPath, token, json, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const body = json != null ? Buffer.from(JSON.stringify(json)) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json != null) headers['Content-Type'] = 'application/json';
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
        const text = buffer.toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
        resolve({ status: res.statusCode, json: parsed, text });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

async function initDatabase(databaseFile) {
  const result = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv(databaseFile));
  if (result.code !== 0) throw new Error(`init_db failed (${result.code})\n${result.out}\n${result.err}`);
  return result;
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

function largeFields(size = 'Full Size') {
  return {
    originals: '2',
    sets: '3',
    size,
    process: 'Black & White',
    media: 'Bond',
    binding: 'Staple',
  };
}

function orderBody(serviceId, extra = {}) {
  return {
    company: 'Phase Five Co',
    contact_name: 'Riley Chen',
    phone: '919-555-0155',
    email: 'riley@phasefive.example',
    project_name: 'Phase Five Job',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '500 Field Road',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Accent Truck',
    due_date: weekdayIso(),
    due_time: '10:00',
    payment_method: 'Accent Account',
    service_ids: [serviceId],
    line_items: [{
      description: 'Large set',
      service_id: serviceId,
      field_values: largeFields(),
    }],
    ...extra,
  };
}

function shipFields(via) {
  return {
    qty: 1,
    via,
    contact_name: 'Pat',
    contact_phone: '919-555-0199',
    contact_email: 'pat@ship.example',
    company_name: 'Other Shop',
    addr1: '9 Dock Street',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
  };
}

function cloneFields(fields) {
  return fields.map((field) => {
    const copy = {
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      is_active: field.is_active,
      sort_order: field.sort_order,
    };
    if (field.type === 'select') {
      copy.options = (field.options || []).map((option) => ({
        value: option.value,
        active: option.active !== false,
      }));
    }
    return copy;
  });
}

async function migrateOldDatabase() {
  const db = openDb(oldDb);
  await db.exec(OLD_SCHEMA);
  const hash = await bcrypt.hash('LegacyPass123', 10);
  await db.run(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES ('legacy', ?, 'customer', 'Legacy Co')`,
    [hash]
  );
  await db.run(
    `INSERT INTO orders (order_number, customer_id, company, contact_name, phone, email, delivery_method, due_date, due_time)
     VALUES ('LEGACY-PICKUP', 1, 'Legacy Co', 'Pat', '919-555-0100', 'pat@legacy.example', 'Customer Pickup', '2020-01-06', '18:00')`
  );
  await db.run(
    `INSERT INTO order_line_items (order_id, line_number, description, mount, laminate)
     VALUES (1, 1, 'Legacy banner', 1, 0)`
  );
  await db.close();
  await initDatabase(oldDb);
  await initDatabase(oldDb);
  const check = openDb(oldDb);
  const columns = await check.all(`PRAGMA table_info(order_line_items)`);
  const names = new Set(columns.map((row) => row.name));
  assert(names.has('field_values'), 'field_values should be added to an older line-item table');
  const banner = await check.get(`SELECT description, mount, laminate, field_values FROM order_line_items WHERE description = 'Legacy banner'`);
  assert(banner && banner.mount === 1 && banner.laminate === 0 && banner.field_values == null, 'the legacy banner row should stay intact');
  const orderColumns = await check.all(`PRAGMA table_info(orders)`);
  const orderNames = new Set(orderColumns.map((row) => row.name));
  assert(orderNames.has('payment_method') && orderNames.has('bill_to_name') && orderNames.has('return_to'), 'payment and bill-to columns should be added');
  const pickup = await check.get(`SELECT payment_method, delivery_method FROM orders WHERE order_number = 'LEGACY-PICKUP'`);
  assert(pickup.payment_method == null && pickup.delivery_method === 'Customer Pickup', 'legacy payment stays null and the delivery label stays');
  const fields = await check.get('SELECT COUNT(*) AS count FROM service_fields');
  assert(fields.count === 54, `two inits should leave 54 service fields, found ${fields.count}`);
  await check.close();
  console.log('PASS older database migration, twice');
}

async function keepOwnerEdits() {
  await initDatabase(freshDb);
  const db = openDb(freshDb);
  const note = await db.get(
    `SELECT service_fields.id FROM service_fields
     JOIN services ON services.id = service_fields.service_id
     WHERE services.name = 'Large Format' AND service_fields.key = 'note'`
  );
  assert(note, 'Large Format note field should be seeded');
  await db.run(`UPDATE service_fields SET label = 'Shop Note' WHERE id = ?`, [note.id]);
  await db.close();
  await initDatabase(freshDb);
  const again = openDb(freshDb);
  const kept = await again.get(`SELECT label FROM service_fields WHERE id = ?`, [note.id]);
  const count = await again.get('SELECT COUNT(*) AS count FROM service_fields');
  assert(kept && kept.label === 'Shop Note', 'a second init should not overwrite an owner field label');
  assert(count.count === 54, `a second init should not duplicate fields, found ${count.count}`);
  await again.close();
  console.log('PASS init keeps owner field edits');
}

async function main() {
  await migrateOldDatabase();
  await keepOwnerEdits();
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
      json: {
        display_name: 'Phase Five Customer',
        username: 'phase5cust',
        password: 'CustomerPass1',
        company: 'Phase Five Co',
        contact_name: 'Riley Chen',
        phone: '919-555-0155',
        email: 'riley@phasefive.example',
      },
    });
    assert(customerResponse.status === 201, `customer create failed: ${customerResponse.text}`);
    const otherResponse = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Other Five',
        username: 'phase5other',
        password: 'CustomerPass1',
        company: 'Other Five',
        contact_name: 'Other',
        phone: '919-555-0166',
        email: 'other@phasefive.example',
      },
    });
    assert(otherResponse.status === 201, `second customer failed: ${otherResponse.text}`);
    const customer = await login('phase5cust', 'CustomerPass1');
    const other = await login('phase5other', 'CustomerPass1');
    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    assert(options.status === 200, 'options should load');
    assert((options.json.payment_methods || []).includes('Accent Account') && options.json.payment_methods.includes('Discover'), 'payment methods should be listed');
    const byName = Object.fromEntries(options.json.services.map((service) => [service.name, service]));
    const large = byName['Large Format'];
    assert(large && (large.fields || []).some((field) => field.key === 'size' && field.options.includes('Full Size')), 'Large Format options should include its size list');
    assert(!options.json.services.some((service) => /mounting and lamination/i.test(service.name)), 'mounting and lamination is not its own service');

    const missingPayment = orderBody(large.id);
    delete missingPayment.payment_method;
    const noPay = await request({ method: 'POST', path: '/api/orders', token: customer.token, json: missingPayment });
    assert(noPay.status === 400 && /payment_method is required/.test(noPay.json.error), noPay.text);
    const badPay = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, { payment_method: 'Bitcoin' }),
    });
    assert(badPay.status === 400 && /payment_method must be one of/.test(badPay.json.error), badPay.text);
    const badSelect = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, {
        line_items: [{ description: 'Bad size', service_id: large.id, field_values: largeFields('Poster') }],
      }),
    });
    assert(badSelect.status === 400 && /Size must be one of/.test(badSelect.json.error), badSelect.text);
    const missingRequired = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, {
        line_items: [{
          description: 'Missing originals',
          service_id: large.id,
          field_values: { sets: '1', size: 'Full Size', process: 'Color Line', media: 'Bond', binding: 'None' },
        }],
      }),
    });
    assert(missingRequired.status === 400 && /Originals is required/.test(missingRequired.json.error), missingRequired.text);
    const dirty = orderBody(large.id, {
      line_items: [{
        description: 'Dirty',
        service_id: large.id,
        field_values: { ...largeFields(), originals: '2\u0001' },
      }],
    });
    const dirtyResponse = await request({ method: 'POST', path: '/api/orders', token: customer.token, json: dirty });
    assert(dirtyResponse.status === 400 && /invalid characters/.test(dirtyResponse.json.error), dirtyResponse.text);
    const unknown = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, {
        line_items: [{
          description: 'Unknown',
          service_id: large.id,
          field_values: { ...largeFields(), foo: 'x' },
        }],
      }),
    });
    assert(unknown.status === 400 && /foo is not used/.test(unknown.json.error), unknown.text);

    const seeNote = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, {
        payment_method: 'Cash',
        line_items: [{ description: 'See note set', service_id: large.id, field_values: largeFields('See Note') }],
      }),
    });
    assert(seeNote.status === 201, `See Note should be accepted while active: ${seeNote.text}`);
    assert(seeNote.json.order.payment_method === 'Cash', 'payment method should be stored');

    const operatorFields = await request({ method: 'GET', path: `/api/services/${large.id}/fields`, token: operator.token });
    assert(operatorFields.status === 403, `operator should not read field config, got ${operatorFields.status}`);
    const customerFields = await request({ method: 'PUT', path: `/api/services/${large.id}/fields`, token: customer.token, json: { fields: [] } });
    assert(customerFields.status === 403, `customer should not edit fields, got ${customerFields.status}`);
    const operatorPut = await request({ method: 'PUT', path: `/api/services/${large.id}/fields`, token: operator.token, json: { fields: [] } });
    assert(operatorPut.status === 403, `operator should not edit fields, got ${operatorPut.status}`);

    const current = await request({ method: 'GET', path: `/api/services/${large.id}/fields`, token: admin.token });
    assert(current.status === 200 && current.json.fields.length >= 7, current.text);
    const baseFields = cloneFields(current.json.fields);
    const payloadA = { fields: cloneFields(baseFields).map((field) => (field.key === 'note' ? { ...field, label: 'Note A' } : field)) };
    const payloadB = {
      fields: cloneFields(baseFields).map((field) => {
        if (field.key === 'note') return { ...field, label: 'Note B' };
        if (field.key === 'size') return { ...field, options: [...field.options, { value: 'Proof', active: true }] };
        return field;
      }),
    };
    const raced = await Promise.all([
      request({ method: 'PUT', path: `/api/services/${large.id}/fields`, token: admin.token, json: payloadA, timeoutMs: 20000 }),
      request({ method: 'PUT', path: `/api/services/${large.id}/fields`, token: admin.token, json: payloadB, timeoutMs: 20000 }),
    ]);
    assert(raced.every((row) => row.status === 200), `concurrent field saves should succeed: ${raced.map((row) => row.text).join(' | ')}`);
    const afterRace = await request({ method: 'GET', path: `/api/services/${large.id}/fields`, token: admin.token });
    const racedNote = afterRace.json.fields.find((field) => field.key === 'note');
    const racedSize = afterRace.json.fields.find((field) => field.key === 'size');
    const proof = (racedSize.options || []).some((option) => option.value === 'Proof');
    const consistent = (racedNote.label === 'Note A' && !proof) || (racedNote.label === 'Note B' && proof);
    assert(consistent, `concurrent field saves should leave one complete set, label ${racedNote.label} proof ${proof}`);

    const live = await request({ method: 'GET', path: `/api/services/${large.id}/fields`, token: admin.token });
    const deactivated = {
      fields: cloneFields(live.json.fields).map((field) => {
        if (field.key !== 'size') return field;
        return {
          ...field,
          options: field.options.map((option) => (
            option.value === 'See Note' ? { ...option, active: false } : option
          )),
        };
      }),
    };
    const saved = await request({ method: 'PUT', path: `/api/services/${large.id}/fields`, token: admin.token, json: deactivated });
    assert(saved.status === 200, `admin field save failed: ${saved.text}`);
    const activity = await db.get(
      `SELECT actor_id FROM activity_log WHERE action = 'service.fields_updated' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
      [large.id]
    );
    assert(activity && activity.actor_id === admin.user.id, 'field edits should be activity-logged for the admin');
    const rejected = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, {
        line_items: [{ description: 'Retired option', service_id: large.id, field_values: largeFields('See Note') }],
      }),
    });
    assert(rejected.status === 400 && /See Note/.test(rejected.json.error) === false && /Size must be one of/.test(rejected.json.error), rejected.text);
    const still = await request({ method: 'GET', path: `/api/orders/${seeNote.json.order.id}`, token: customer.token });
    const storedSize = (still.json.order.line_items[0].fields || []).find((field) => field.key === 'size');
    assert(storedSize && storedSize.display === 'See Note', 'a deactivated option should still display on the old order');
    const freshSize = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, { payment_method: 'Check' }),
    });
    assert(freshSize.status === 201 && freshSize.json.order.line_items[0].field_values.size === 'Full Size', freshSize.text);

    const cityOnly = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, { bill_to_city: 'Raleigh' }),
    });
    assert(cityOnly.status === 400 && /bill_to_address_line1 is required/.test(cityOnly.json.error), cityOnly.text);
    const badEmail = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, { bill_to_email: 'not-an-email' }),
    });
    assert(badEmail.status === 400 && /bill_to_email is invalid/.test(badEmail.json.error), badEmail.text);
    const billed = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, {
        payment_method: 'Visa',
        bill_to_name: 'Accounts',
        bill_to_company: '=1+1',
        bill_to_address_line1: '1 Invoice Way',
        bill_to_city: 'Raleigh',
        bill_to_state: 'NC',
        bill_to_zip: '27601',
      }),
    });
    assert(billed.status === 201, `bill-to order failed: ${billed.text}`);
    assert(billed.json.order.bill_to && billed.json.order.bill_to.company === '=1+1', 'bill-to company should be stored');
    assert(billed.json.order.payment_method_label === 'Visa', 'payment label should be the method');
    const companyOnly = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, { bill_to_company: 'Accounts Only' }),
    });
    assert(companyOnly.status === 201 && companyOnly.json.order.bill_to.company === 'Accounts Only' && companyOnly.json.order.bill_to.address_line1 == null, companyOnly.text);
    const ownBills = await request({ method: 'GET', path: '/api/orders/bill-tos?customer_id=1', token: customer.token });
    assert(ownBills.status === 200 && ownBills.json.bill_tos.some((row) => row.company === '=1+1'), `customer should see their own bill-to entries: ${ownBills.text}`);
    assert(ownBills.json.bill_tos.every((row) => row.company !== 'Hidden Co'), 'customer bill-to list should not include another customer');
    const otherBills = await request({ method: 'GET', path: '/api/orders/bill-tos', token: other.token });
    assert(otherBills.status === 200 && otherBills.json.bill_tos.length === 0, `another customer should not see the bill-to list: ${otherBills.text}`);
    const staffMissing = await request({ method: 'GET', path: '/api/orders/bill-tos', token: admin.token });
    assert(staffMissing.status === 400 && /customer_id is required/.test(staffMissing.json.error), staffMissing.text);
    const staffBills = await request({
      method: 'GET',
      path: `/api/orders/bill-tos?customer_id=${customerResponse.json.id}`,
      token: operator.token,
    });
    assert(staffBills.status === 200 && staffBills.json.bill_tos.some((row) => row.company === '=1+1'), staffBills.text);

    const printed = await request({ method: 'GET', path: `/api/orders/${billed.json.order.id}/print`, token: customer.token });
    assert(printed.status === 200 && printed.json.work_orders[0].payment_method_label === 'Visa', 'print sheet should include payment');
    assert(printed.json.work_orders[0].bill_to.company === '=1+1', 'print sheet should include bill-to when present');
    const searched = await request({
      method: 'GET',
      path: `/api/search/orders?order_number=${encodeURIComponent(billed.json.order_number)}`,
      token: admin.token,
    });
    assert(searched.status === 200 && searched.json.orders.length === 1 && searched.json.orders[0].payment_method_label === 'Visa', searched.text);
    assert((searched.json.orders[0].line_details || []).some((line) => line.includes('Full Size')), 'search should include the service field values');

    const ship = byName['Ship To (3rd Party)'];
    const derived = orderBody(ship.id, {
      line_items: [
        { description: 'First stop', service_id: ship.id, field_values: shipFields('1 day') },
        { description: 'Second stop', service_id: ship.id, field_values: shipFields('Ground') },
      ],
    });
    delete derived.delivery_method;
    const shipped = await request({ method: 'POST', path: '/api/orders', token: customer.token, json: derived });
    assert(shipped.status === 201, `ship-to order failed: ${shipped.text}`);
    assert(shipped.json.order.return_to === 'See ShipTo', 'selecting Ship To should default return to See ShipTo');
    assert(shipped.json.order.delivery_method === 'UPS', `via 1 day should use UPS, got ${shipped.json.order.delivery_method}`);
    assert(shipped.json.order.line_items.length === 2, 'multiple recipients should be multiple lines');
    const forced = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, { return_to: 'See ShipTo' }),
    });
    assert(forced.status === 400 && /See ShipTo requires/.test(forced.json.error), forced.text);
    const toMe = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(large.id, { return_to: 'To Me', delivery_method: 'Will Call', due_time: '08:00' }),
    });
    assert(toMe.status === 201 && toMe.json.order.return_to === 'To Me' && toMe.json.order.delivery_method === 'Will Call', toMe.text);

    const archive = byName['Archive File Request'];
    const archived = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(archive.id, {
        line_items: [{
          description: 'Pull file',
          service_id: archive.id,
          field_values: { add_retrieve: 'Retrieve', save_as: 'PDF', save_to: 'Email', sheets: 'All' },
        }],
      }),
    });
    assert(archived.status === 201, `archive order failed: ${archived.text}`);
    const archiveWork = await request({
      method: 'GET',
      path: `/api/workorders/${archived.json.work_orders[0].id}`,
      token: admin.token,
    });
    assert(archiveWork.json.approval_status === 'pending' || archiveWork.json.requires_approval, 'archive requests should keep the approval gate');

    const legacyOrder = await db.run(
      `INSERT INTO orders (order_number, customer_id, company, contact_name, phone, email, delivery_method, due_date, due_time, project_name, originals_source, address_line1, city, state, zip)
       VALUES ('LEGACY-PAY', ?, 'Phase Five Co', 'Riley Chen', '919-555-0155', 'riley@phasefive.example', 'Accent Truck', ?, '10:00', 'Legacy', 'Hardcopy or digital media provided', '500 Field Road', 'Raleigh', 'NC', '27601')`,
      [customerResponse.json.id, weekdayIso()]
    );
    await db.run(
      `INSERT INTO order_line_items (order_id, line_number, description, mount, laminate)
       VALUES (?, 1, 'Legacy banner', 1, 0)`,
      [legacyOrder.lastID]
    );
    const legacyLoaded = await request({ method: 'GET', path: `/api/orders/${legacyOrder.lastID}`, token: customer.token });
    assert(legacyLoaded.json.order.payment_method_label === 'Not specified', 'a null payment should display as Not specified');
    assert(legacyLoaded.json.order.line_items[0].mount_label === 'Yes', 'legacy mount should still display Yes');

    const csv = await request({ method: 'GET', path: '/api/reports/deliveries?format=csv', token: admin.token });
    assert(csv.status === 200 && /payment_method/.test(csv.text) && /bill_to_company/.test(csv.text), `delivery CSV should include the new columns: ${csv.text.slice(0, 240)}`);
    if (weekdayIso() === isoDate(utcDate(0))) {
      assert(csv.text.includes(`'=1+1`), `CSV cells that start with = should be prefixed: ${csv.text}`);
    }

    const created = await Promise.all(Array.from({ length: 6 }, (_, index) => request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      timeoutMs: 20000,
      json: orderBody(large.id, { project_name: `Concurrent ${index}`, payment_method: 'Master Card' }),
    })));
    assert(created.every((row) => row.status === 201), `concurrent orders should succeed: ${created.map((row) => row.text).join(' | ')}`);
    const numbers = new Set(created.map((row) => row.json.order_number));
    assert(numbers.size === 6, 'concurrent orders should receive distinct numbers');
    console.log('PASS phase 5 field, payment, bill-to, and return checks');
  } finally {
    await db.close();
    server.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
