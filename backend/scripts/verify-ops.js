/**
 * Startup mail sweep, SIGTERM drain, and manager mobile-number scope.
 * Usage (from backend/): node scripts/verify-ops.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-ops-'));
const sweepDb = path.join(tmp, 'sweep.db');
const mobileDb = path.join(tmp, 'mobile.db');
const drainDb = path.join(tmp, 'drain.db');
const adminPassword = 'AdminPass123';
const customerPassword = 'CustomerPass123';
const managerPassword = 'ManagerPass123';
const operatorPassword = 'OperatorPass123';

process.env.DATABASE_FILE = sweepDb;
process.env.NODE_ENV = 'test';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '2525';
process.env.SMTP_FROM = 'orders@example.com';
process.env.MAIL_TRANSPORT = 'json';
process.env.PUBLIC_APP_URL = 'https://launchpad.example';
process.env.DELIVERY_TIMEZONE = 'UTC';
process.env.INIT_ADMIN_PASSWORD = adminPassword;
delete process.env.MAIL_TEST_HOLD_MS;
delete process.env.MAIL_TEST_THROW;
delete process.env.EMAIL_NOTIFICATIONS;

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
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  return { run, get, close };
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

function weekdayAhead() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 3);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function orderBody(overrides = {}) {
  return fillOrderLines({
    company: 'Ops Co',
    contact_name: 'Ops Contact',
    phone: '919-555-3333',
    email: 'ops@example.com',
    project_name: 'Ops job',
    notes: 'Dock.',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '10 Dock Street',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Will Call',
    due_date: weekdayAhead(),
    due_time: '10:00',
    payment_method: 'Cash',
    service_ids: [],
    line_items: [],
    ...overrides,
  });
}

function request(port, { method, path: requestPath, token, json }) {
  return new Promise((resolve, reject) => {
    const body = json != null ? Buffer.from(JSON.stringify(json)) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (err) { parsed = null; }
        resolve({ status: res.statusCode, text, json: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function serverEnv(databaseFile, port, extra = {}) {
  return {
    DATABASE_FILE: databaseFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    DELIVERY_TIMEZONE: 'UTC',
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: path.join(tmp, `uploads-${port}`),
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '2525',
    SMTP_FROM: 'orders@example.com',
    MAIL_TRANSPORT: 'json',
    PUBLIC_APP_URL: 'https://launchpad.example',
    TWILIO_ACCOUNT_SID: '',
    TWILIO_AUTH_TOKEN: '',
    TWILIO_FROM_NUMBER: '',
    MAIL_TEST_THROW: '',
    EMAIL_NOTIFICATIONS: '',
    ...extra,
  };
}

function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let settled = false;
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`server did not become ready\n${logs}`));
    }, 20000);
    const poll = async () => {
      if (settled) return;
      try {
        const health = await request(env.PORT, { method: 'GET', path: '/api/health' });
        if (health.status === 200 && health.json && health.json.status === 'ok') {
          settled = true;
          clearTimeout(timer);
          resolve();
          return;
        }
      } catch (err) {
        // still starting
      }
      setTimeout(poll, 100);
    };
    poll();
  });
  return {
    ready,
    logs: () => logs,
    stop() {
      const started = Date.now();
      return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, elapsed: Date.now() - started, logs });
        });
        child.kill('SIGTERM');
      });
    },
  };
}

async function login(port, username, password) {
  const response = await request(port, {
    method: 'POST',
    path: '/api/auth/login',
    json: { username, password },
  });
  assert(response.status === 200 && response.json && response.json.token, `login failed for ${username}: ${response.status} ${response.text}`);
  return response.json;
}

function captureLog() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
    original.apply(console, args);
  };
  return {
    lines,
    restore() { console.log = original; },
  };
}

async function initDatabase(file) {
  const result = await spawnNode('init_db.js', {
    DATABASE_FILE: file,
    INIT_ADMIN_PASSWORD: adminPassword,
  });
  assert(result.code === 0, `init failed for ${file}\n${result.err}\n${result.out}`);
  return result;
}

async function insertUser(db, fields) {
  const inserted = await db.run(
    `INSERT INTO users (username, password_hash, role, display_name, email, company, contact_name, phone, location_id)
     VALUES (?, 'hash', ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.username,
      fields.role || 'customer',
      fields.displayName || fields.username,
      fields.email || null,
      fields.company || null,
      fields.contactName || null,
      fields.phone || null,
      fields.locationId == null ? null : fields.locationId,
    ]
  );
  return inserted.lastID;
}

async function insertOrder(db, fields) {
  const inserted = await db.run(
    `INSERT INTO orders (
       order_number, customer_id, company, contact_name, phone, email,
       delivery_method, due_date, due_time, location_id,
       confirmation_email_status, confirmation_email_sent_at
     ) VALUES (?, ?, 'Ops Co', 'Ops Contact', '919-555-3333', ?, 'Will Call', ?, '10:00', ?, ?, ?)`,
    [
      fields.orderNumber,
      fields.customerId,
      fields.email,
      weekdayAhead(),
      fields.locationId == null ? null : fields.locationId,
      fields.confirmationStatus || null,
      fields.sentAt || null,
    ]
  );
  return inserted.lastID;
}

async function noticeCount(db, orderId, noticeType) {
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM order_notify_log
     WHERE order_id = ? AND channel = 'email' AND notice_type = ?`,
    [orderId, noticeType]
  );
  return row ? row.count : 0;
}

async function runSweepChecks() {
  await initDatabase(sweepDb);
  const markerDb = openDb(sweepDb);
  const marker = await markerDb.run(
    `INSERT INTO mail_outbox (scope, channel, notice_type, status, created_at)
     VALUES ('order', 'email', 'migration-marker', 'done', datetime('now'))`
  );
  await markerDb.close();
  const again = await initDatabase(sweepDb);
  assert(again.code === 0, 'a second init should succeed');
  const keptDb = openDb(sweepDb);
  const kept = await keptDb.get(`SELECT id, status FROM mail_outbox WHERE id = ?`, [marker.lastID]);
  const table = await keptDb.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mail_outbox'`);
  await keptDb.close();
  assert(table, 'mail_outbox should exist after init');
  assert(kept && kept.status === 'done', 'a second init should keep mail_outbox rows');
  console.log('PASS mail_outbox migration is idempotent');

  const db = require('../dbAsync');
  const customerId = await insertUser(db, {
    username: 'sweep-customer',
    email: 'sweep@example.com',
    company: 'Sweep Co',
  });
  const welcomeUser = await insertUser(db, {
    username: 'sweep-welcome',
    email: 'welcome@example.com',
  });
  const welcomed = await insertUser(db, {
    username: 'sweep-welcomed',
    email: 'already@example.com',
  });
  const resetUser = await insertUser(db, {
    username: 'sweep-reset',
    email: 'reset@example.com',
  });
  await db.run(
    `INSERT INTO account_audit_log (user_id, channel, notice_type, recipient, result, created_at)
     VALUES (?, 'email', 'welcome', 'already@example.com', 'sent', datetime('now'))`,
    [welcomed]
  );
  const already = await insertOrder(db, {
    orderNumber: 'SWEEP-SENT',
    customerId,
    email: 'sent@example.com',
    confirmationStatus: 'pending',
  });
  await db.run(
    `INSERT INTO order_notify_log (order_id, channel, notice_type, recipient, result, created_at)
     VALUES (?, 'email', 'confirmation', 'sent@example.com', 'sent', datetime('now'))`,
    [already]
  );
  const pending = await insertOrder(db, {
    orderNumber: 'SWEEP-PENDING',
    customerId,
    email: 'pending@example.com',
    confirmationStatus: 'pending',
  });
  const pickupOrder = await insertOrder(db, {
    orderNumber: 'SWEEP-PICKUP',
    customerId,
    email: 'pickup@example.com',
  });
  await db.run(
    `INSERT INTO pickup_requests (
       customer_id, order_id, contact_name, contact_phone,
       address_line1, city, state, zip, ready_date, status, source
     ) VALUES (?, ?, 'Ops Contact', '919-555-3333', '10 Dock Street', 'Raleigh', 'NC', '27601', ?, 'new', 'order')`,
    [customerId, pickupOrder, weekdayAhead()]
  );
  await db.run(
    `INSERT INTO mail_outbox (scope, user_id, channel, notice_type, status, created_at)
     VALUES ('account', ?, 'email', 'welcome', 'queued', datetime('now'))`,
    [welcomeUser]
  );
  await db.run(
    `INSERT INTO mail_outbox (scope, user_id, channel, notice_type, status, created_at)
     VALUES ('account', ?, 'email', 'welcome', 'queued', datetime('now'))`,
    [welcomed]
  );
  await db.run(
    `INSERT INTO mail_outbox (scope, user_id, channel, notice_type, status, created_at)
     VALUES ('account', ?, 'email', 'password_reset', 'queued', datetime('now'))`,
    [resetUser]
  );
  await db.run(
    `INSERT INTO mail_outbox (scope, order_id, channel, notice_type, status, created_at)
     VALUES ('order', ?, 'email', 'pickup_request', 'queued', datetime('now'))`,
    [pickupOrder]
  );

  const mailSweep = require('../mailSweep');
  const firstLog = captureLog();
  const first = await mailSweep.sweep();
  firstLog.restore();
  const resends = firstLog.lines.filter((line) => line.startsWith('MAIL RESEND:'));
  assert(first.resent === 4, `expected 4 resends, got ${first.resent}: ${resends.join(' | ')}`);
  assert(resends.length === 4, `expected 4 MAIL RESEND lines, got ${resends.join(' | ')}`);
  assert(resends.some((line) => line.includes(`order ${pending}`) && line.includes('confirmation') && line.includes('result=sent')), resends.join(' | '));
  assert(resends.some((line) => line.includes(`user ${welcomeUser}`) && line.includes('welcome') && line.includes('result=sent')), resends.join(' | '));
  assert(resends.some((line) => line.includes(`order ${pickupOrder}`) && line.includes('pickup_request') && line.includes('result=sent')), resends.join(' | '));
  assert(resends.some((line) => line.includes(`user ${resetUser}`) && line.includes('password_reset') && line.includes('result=sent')), resends.join(' | '));
  assert(!resends.some((line) => line.includes(`order ${already}`)), `already-sent confirmation was resent: ${resends.join(' | ')}`);
  assert(!resends.some((line) => line.includes(`user ${welcomed}`)), `welcome that was already logged was resent: ${resends.join(' | ')}`);
  assert(await noticeCount(db, already, 'confirmation') === 1, 'an already logged confirmation must stay a single row');
  assert(await noticeCount(db, pending, 'confirmation') === 1, 'a pending confirmation with no log should be sent once');
  const pendingRow = await db.get(
    `SELECT confirmation_email_status, confirmation_email_sent_at FROM orders WHERE id = ?`,
    [pending]
  );
  assert(pendingRow.confirmation_email_status === 'sent' && pendingRow.confirmation_email_sent_at, 'the resent confirmation should be stamped sent');
  const alreadyRow = await db.get(
    `SELECT confirmation_email_status, confirmation_email_sent_at FROM orders WHERE id = ?`,
    [already]
  );
  assert(alreadyRow.confirmation_email_status === 'sent' && alreadyRow.confirmation_email_sent_at, 'a logged send should be repaired without a second message');
  const welcomeAudit = await db.get(
    `SELECT COUNT(*) AS count FROM account_audit_log WHERE user_id = ? AND notice_type = 'welcome' AND result = 'sent'`,
    [welcomeUser]
  );
  assert(welcomeAudit.count === 1, 'welcome should be recorded once');
  const welcomedAudit = await db.get(
    `SELECT COUNT(*) AS count FROM account_audit_log WHERE user_id = ? AND notice_type = 'welcome'`,
    [welcomed]
  );
  assert(welcomedAudit.count === 1, 'an existing welcome log must not gain another row');
  assert(await noticeCount(db, pickupOrder, 'pickup_request') === 1, 'pickup request mail should be sent once');
  const resetAudit = await db.get(
    `SELECT COUNT(*) AS count FROM account_audit_log WHERE user_id = ? AND notice_type = 'password_reset' AND result = 'sent'`,
    [resetUser]
  );
  assert(resetAudit.count === 1, 'the queued password reset should be sent');
  console.log('PASS startup sweep sends unlogged mail and skips mail already recorded');

  const secondLog = captureLog();
  const second = await mailSweep.sweep();
  secondLog.restore();
  assert(second.resent === 0, `a second sweep should not resend, got ${second.resent}`);
  assert(!secondLog.lines.some((line) => line.startsWith('MAIL RESEND:')), 'a second sweep should not log MAIL RESEND');
  assert(await noticeCount(db, pending, 'confirmation') === 1, 'the confirmation log should still be one row');
  const welcomeStill = await db.get(
    `SELECT COUNT(*) AS count FROM account_audit_log WHERE user_id = ? AND notice_type = 'welcome' AND result = 'sent'`,
    [welcomeUser]
  );
  assert(welcomeStill.count === 1, 'welcome should still be one row');
  console.log('PASS a second sweep does not duplicate sent mail');

  const priorReset = await db.get(
    `SELECT created_at FROM account_audit_log
     WHERE user_id = ? AND notice_type = 'password_reset'
     ORDER BY id DESC LIMIT 1`,
    [resetUser]
  );
  await db.run(
    `INSERT INTO mail_outbox (scope, user_id, channel, notice_type, status, created_at)
     VALUES ('account', ?, 'email', 'password_reset', 'queued', datetime(?, '+2 seconds'))`,
    [resetUser, priorReset.created_at]
  );
  const thirdLog = captureLog();
  const third = await mailSweep.sweep();
  thirdLog.restore();
  assert(third.resent === 1, `a later password reset should send once, got ${third.resent}: ${thirdLog.lines.join(' | ')}`);
  const resetAfter = await db.get(
    `SELECT COUNT(*) AS count FROM account_audit_log WHERE user_id = ? AND notice_type = 'password_reset' AND result = 'sent'`,
    [resetUser]
  );
  assert(resetAfter.count === 2, 'a new password reset is a new notice and is not suppressed by the earlier one');
  console.log('PASS a later password reset is sent without repeating the earlier one');
}

async function runMobileChecks() {
  const port = 3184;
  await initDatabase(mobileDb);
  fs.mkdirSync(path.join(tmp, `uploads-${port}`), { recursive: true });
  const server = startServer(serverEnv(mobileDb, port));
  await server.ready;
  const db = openDb(mobileDb);
  try {
    const customersSource = fs.readFileSync(path.join(backendDir, '..', 'frontend', 'src', 'routes', 'Customers.jsx'), 'utf8');
    assert(customersSource.includes('mobile_phone_visible === false'), 'the customers page should withhold a number the API did not return');
    assert(customersSource.includes('disabled={customer.mobile_phone_visible === false}'), 'Text updates should be disabled when the number is withheld');

    const admin = await login(port, 'admin', adminPassword);
    const config = await request(port, { method: 'GET', path: '/api/auth/config' });
    const raleigh = (config.json.locations || []).find((location) => location.name === 'Raleigh');
    const hickory = (config.json.locations || []).find((location) => location.name === 'Hickory');
    assert(raleigh && hickory, 'Raleigh and Hickory should be listed');
    const options = await request(port, { method: 'GET', path: '/api/orders/options', token: admin.token });
    assert(options.status === 200, options.text);
    setServiceNames(options.json.services || []);
    const large = (options.json.services || []).find((service) => service.name === 'Large Format');
    assert(large, 'Large Format should be seeded');

    async function createCustomer(username, locationId, phone) {
      const created = await request(port, {
        method: 'POST',
        path: '/api/users',
        token: admin.token,
        json: {
          username,
          display_name: username,
          role: 'customer',
          password: customerPassword,
          email: `${username}@example.com`,
          company: username,
          contact_name: username,
          phone,
          location_id: locationId,
        },
      });
      assert(created.status === 201, created.text);
      return created.json;
    }

    const raleighCustomer = await createCustomer('raleighcust', raleigh.id, '919-555-2000');
    const hickoryCustomer = await createCustomer('hickorycust', hickory.id, '919-555-2001');
    const raleighMobile = '+19195550101';
    const hickoryMobile = '+19195550102';
    const raleighText = await request(port, {
      method: 'PUT',
      path: `/api/customers/${raleighCustomer.id}/texting`,
      token: admin.token,
      json: { mobile_phone: '919-555-0101', sms_opt_in: false },
    });
    assert(raleighText.status === 200 && raleighText.json.mobile_phone === raleighMobile, raleighText.text);
    const hickoryText = await request(port, {
      method: 'PUT',
      path: `/api/customers/${hickoryCustomer.id}/texting`,
      token: admin.token,
      json: { mobile_phone: '919-555-0102', sms_opt_in: false },
    });
    assert(hickoryText.status === 200 && hickoryText.json.mobile_phone === hickoryMobile, hickoryText.text);

    const hickoryManager = await request(port, {
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'hickorymgr',
        display_name: 'Hickory Manager',
        role: 'manager',
        password: managerPassword,
        email: 'hickorymgr@example.com',
        location_id: hickory.id,
      },
    });
    assert(hickoryManager.status === 201, hickoryManager.text);
    const allManager = await request(port, {
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'allmgr',
        display_name: 'All Shops Manager',
        role: 'manager',
        password: managerPassword,
        email: 'allmgr@example.com',
      },
    });
    assert(allManager.status === 201, allManager.text);
    const operator = await request(port, {
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'raleighop',
        display_name: 'Raleigh Operator',
        role: 'operator',
        password: operatorPassword,
        location_id: raleigh.id,
      },
    });
    assert(operator.status === 201, operator.text);

    async function place(locationId, customer, project) {
      const created = await request(port, {
        method: 'POST',
        path: '/api/orders',
        token: admin.token,
        json: orderBody({
          customer_id: customer.id,
          location_id: locationId,
          company: project,
          contact_name: project,
          phone: '919-555-3333',
          email: `${project.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.com`,
          project_name: project,
          service_ids: [large.id],
          line_items: [{ description: project, quantity: '1', service_id: large.id }],
        }),
      });
      assert(created.status === 201, created.text);
      return created.json;
    }

    const raleighOrder = await place(raleigh.id, raleighCustomer, 'Raleigh job');
    const hickoryOrder = await place(hickory.id, hickoryCustomer, 'Hickory job');
    await db.run(
      `INSERT INTO order_notify_log (order_id, channel, notice_type, recipient, result, created_at)
       VALUES (?, 'sms', 'ready_for_pickup', ?, 'sent', datetime('now'))`,
      [raleighOrder.order.id, raleighMobile]
    );
    await db.run(
      `INSERT INTO order_notify_log (order_id, channel, notice_type, recipient, result, created_at)
       VALUES (?, 'sms', 'ready_for_pickup', ?, 'sent', datetime('now'))`,
      [hickoryOrder.order.id, hickoryMobile]
    );

    const mgr = await login(port, 'hickorymgr', managerPassword);
    const mgrList = await request(port, { method: 'GET', path: '/api/customers', token: mgr.token });
    assert(mgrList.status === 200 && Array.isArray(mgrList.json), mgrList.text);
    const mgrRaleigh = mgrList.json.find((row) => row.id === raleighCustomer.id);
    const mgrHickory = mgrList.json.find((row) => row.id === hickoryCustomer.id);
    assert(mgrRaleigh && mgrHickory, 'a scoped manager still receives both customer records');
    assert(mgrRaleigh.mobile_phone_visible === false && !Object.prototype.hasOwnProperty.call(mgrRaleigh, 'mobile_phone'), 'the out-of-location customer must not include mobile_phone');
    assert(!mgrList.text.includes(raleighMobile), `the customer list included the Raleigh mobile: ${mgrList.text}`);
    assert(mgrHickory.mobile_phone === hickoryMobile && mgrHickory.mobile_phone_visible === true, 'the in-location mobile should be returned');
    assert(mgrRaleigh.phone === '919-555-2000', 'the office phone is not the mobile number');

    const hiddenEdit = await request(port, {
      method: 'PUT',
      path: `/api/customers/${raleighCustomer.id}/texting`,
      token: mgr.token,
      json: { mobile_phone: '919-555-0199', sms_opt_in: false },
    });
    assert(hiddenEdit.status === 404, `out-of-location texting should be 404, got ${hiddenEdit.status} ${hiddenEdit.text}`);
    assert(!hiddenEdit.text.includes(raleighMobile) && !hiddenEdit.text.includes('9195550101'), hiddenEdit.text);
    const stored = await db.get(`SELECT mobile_phone FROM users WHERE id = ?`, [raleighCustomer.id]);
    assert(stored.mobile_phone === raleighMobile, 'a refused texting update must not change the number');
    const ownEdit = await request(port, {
      method: 'PUT',
      path: `/api/customers/${hickoryCustomer.id}/texting`,
      token: mgr.token,
      json: { mobile_phone: '919-555-0102', sms_opt_in: false },
    });
    assert(ownEdit.status === 200 && ownEdit.json.mobile_phone === hickoryMobile, ownEdit.text);

    const hiddenOrder = await request(port, { method: 'GET', path: `/api/orders/${raleighOrder.order.id}`, token: mgr.token });
    assert(hiddenOrder.status === 404, `an order at another shop should be 404, got ${hiddenOrder.status}`);
    assert(!hiddenOrder.text.includes(raleighMobile), hiddenOrder.text);
    const ownOrder = await request(port, { method: 'GET', path: `/api/orders/${hickoryOrder.order.id}`, token: mgr.token });
    assert(ownOrder.status === 200 && ownOrder.text.includes(hickoryMobile), ownOrder.text);
    const orderList = await request(port, { method: 'GET', path: '/api/orders', token: mgr.token });
    assert(orderList.status === 200 && !orderList.text.includes(raleighMobile), orderList.text);

    const adminList = await request(port, { method: 'GET', path: '/api/customers', token: admin.token });
    assert(adminList.text.includes(raleighMobile) && adminList.text.includes(hickoryMobile), 'an admin should see both mobile numbers');
    const adminOrder = await request(port, { method: 'GET', path: `/api/orders/${raleighOrder.order.id}`, token: admin.token });
    assert(adminOrder.status === 200 && adminOrder.text.includes(raleighMobile), 'an admin should see the order text recipient');

    const everyShop = await login(port, 'allmgr', managerPassword);
    const everyList = await request(port, { method: 'GET', path: '/api/customers', token: everyShop.token });
    assert(everyList.text.includes(raleighMobile) && everyList.text.includes(hickoryMobile), 'a manager with no shop still sees every mobile number');
    const usersForbidden = await request(port, { method: 'GET', path: '/api/users', token: mgr.token });
    assert(usersForbidden.status === 403, 'managers still cannot open the users API');

    const op = await login(port, 'raleighop', operatorPassword);
    const opCustomers = await request(port, { method: 'GET', path: '/api/customers', token: op.token });
    assert(opCustomers.status === 403, 'operators still cannot list customers');
    const opText = await request(port, {
      method: 'PUT',
      path: `/api/customers/${raleighCustomer.id}/texting`,
      token: op.token,
      json: { sms_opt_in: false },
    });
    assert(opText.status === 403, 'operators still cannot edit texting');
    const opOrder = await request(port, { method: 'GET', path: `/api/orders/${raleighOrder.order.id}`, token: op.token });
    assert(opOrder.status === 200 && opOrder.text.includes('919-555-3333'), 'an operator still receives the order contact phone');
    console.log('PASS manager mobile numbers are limited to that manager\'s shop');
  } finally {
    await db.close();
    const stopped = await server.stop();
    assert(stopped.code === 0 && !stopped.signal, `an idle server should exit on SIGTERM, got code ${stopped.code} signal ${stopped.signal} after ${stopped.elapsed}ms\n${stopped.logs}`);
    assert(stopped.elapsed < 2500, `an idle drain took ${stopped.elapsed}ms`);
    console.log('PASS idle SIGTERM exits without waiting out the drain bound');
  }
}

async function runDrainChecks() {
  const port = 3185;
  await initDatabase(drainDb);
  fs.mkdirSync(path.join(tmp, `uploads-${port}`), { recursive: true });
  const held = startServer(serverEnv(drainDb, port, {
    MAIL_TEST_HOLD_MS: '5000',
    DRAIN_TIMEOUT_MS: '800',
  }));
  await held.ready;
  try {
    const admin = await login(port, 'admin', adminPassword);
    const options = await request(port, { method: 'GET', path: '/api/orders/options', token: admin.token });
    setServiceNames(options.json.services || []);
    const large = (options.json.services || []).find((service) => service.name === 'Large Format');
    assert(large, 'Large Format should be seeded');
    const acme = await request(port, { method: 'GET', path: '/api/customers', token: admin.token });
    const customer = acme.json.find((row) => row.username === 'acme');
    assert(customer, 'seeded acme customer should exist');
    const created = await request(port, {
      method: 'POST',
      path: '/api/orders',
      token: admin.token,
      json: orderBody({
        customer_id: customer.id,
        project_name: 'Drain job',
        email: 'drain@example.com',
        service_ids: [large.id],
        line_items: [{ description: 'Drain set', quantity: '1', service_id: large.id }],
      }),
    });
    assert(created.status === 201, created.text);
    assert(created.json.confirmation && created.json.confirmation.email_status === 'pending', 'order create should return before the held confirmation send');
  } catch (err) {
    held.stop();
    throw err;
  }
  const stopped = await held.stop();
  assert(stopped.code === 0 && !stopped.signal, `drain should exit 0, got code ${stopped.code} signal ${stopped.signal}\n${stopped.logs}`);
  assert(stopped.elapsed >= 500 && stopped.elapsed < 2500, `drain elapsed ${stopped.elapsed}ms; expected the bounded timeout rather than the 5s hold or an immediate kill`);
  assert(!stopped.logs.includes('MAIL RESEND:'), 'the interrupted process should not have finished the send');
  console.log('PASS SIGTERM abandons an in-flight send at the drain bound');

  const db = openDb(drainDb);
  const queued = await db.get(
    `SELECT o.id, o.confirmation_email_status, o.confirmation_email_sent_at,
            (SELECT COUNT(*) FROM order_notify_log l WHERE l.order_id = o.id AND l.notice_type = 'confirmation' AND l.result = 'sent') AS sent_logs,
            (SELECT COUNT(*) FROM mail_outbox m WHERE m.order_id = o.id AND m.notice_type = 'confirmation' AND m.status IN ('queued', 'sending')) AS queued_rows
     FROM orders o
     WHERE o.email = 'drain@example.com'`
  );
  assert(queued && queued.sent_logs === 0, `the interrupted send should not be logged: ${JSON.stringify(queued)}`);
  assert(queued.queued_rows >= 1 || queued.confirmation_email_status === 'pending', `the notice should stay queued: ${JSON.stringify(queued)}`);
  await db.close();

  const resumed = startServer(serverEnv(drainDb, port));
  await resumed.ready;
  const resumedLogs = resumed.logs();
  assert(resumedLogs.includes('MAIL RESEND:') && resumedLogs.includes('confirmation') && resumedLogs.includes('result=sent'), resumedLogs);
  const after = openDb(drainDb);
  const sent = await after.get(
    `SELECT COUNT(*) AS count FROM order_notify_log l
     JOIN orders o ON o.id = l.order_id
     WHERE o.email = 'drain@example.com' AND l.notice_type = 'confirmation' AND l.channel = 'email' AND l.result = 'sent'`
  );
  assert(sent.count === 1, `startup should send the interrupted confirmation once, got ${sent.count}`);
  await after.close();
  const resumeStop = await resumed.stop();
  assert(resumeStop.code === 0, 'the resumed server should still drain');
  console.log('PASS the next start sends the interrupted confirmation once');

  const third = startServer(serverEnv(drainDb, port));
  await third.ready;
  assert(!third.logs().includes('MAIL RESEND:'), `a later start resent mail:\n${third.logs()}`);
  const finalDb = openDb(drainDb);
  const still = await finalDb.get(
    `SELECT COUNT(*) AS count FROM order_notify_log l
     JOIN orders o ON o.id = l.order_id
     WHERE o.email = 'drain@example.com' AND l.notice_type = 'confirmation' AND l.result = 'sent'`
  );
  assert(still.count === 1, 'the confirmation must not be sent a second time');
  await finalDb.close();
  await third.stop();
  console.log('PASS a later start does not send the confirmation again');
}

async function main() {
  await runSweepChecks();
  await runMobileChecks();
  await runDrainChecks();
  console.log('All ops checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
