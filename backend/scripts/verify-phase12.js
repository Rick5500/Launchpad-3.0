/**
 * Phase 12 checks: printable work order timing labels for the branded ticket.
 * Rush, overdue, the shop-zone label for the due date, and the existing Code 128 value.
 * Usage (from backend/): node scripts/verify-phase12.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { decodeCode128Svg } = require('../code128');
const { timezoneLabel } = require('../printWorkOrder');
const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase12-'));
const dbFile = path.join(tmp, 'phase12.db');
const uploadDir = path.join(tmp, 'uploads');
const port = 3124;
const adminPassword = 'AdminPass123';

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

function baseEnv() {
  return {
    DATABASE_FILE: dbFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    DELIVERY_TIMEZONE: 'America/New_York',
    DELIVERY_WINDOW_START: '09:00',
    DELIVERY_WINDOW_END: '16:00',
    DELIVERY_SLOT_MINUTES: '15',
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: uploadDir,
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
  };
}

function request({ method, path: requestPath, token, json }) {
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

function weekdayAhead() {
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  for (let add = 0; add < 10; add += 1) {
    const date = new Date(Date.now() + add * 24 * 60 * 60 * 1000);
    const weekday = dayFmt.format(date);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    return dateFmt.format(date);
  }
  throw new Error('no weekday found');
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...baseEnv() },
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

function decodePrinted(svg, expected) {
  let decoded = '';
  try {
    decoded = decodeCode128Svg(svg);
  } catch (err) {
    assert(false, `could not decode Code 128 for ${expected}: ${err.message}`);
  }
  assert(decoded === expected, `decoded barcode ${decoded} did not match ${expected}`);
}

async function main() {
  assert(timezoneLabel('America/New_York', '2020-01-06 09:15') === 'EST', 'a January New York due time should print as EST');
  assert(timezoneLabel('America/New_York', '2026-07-15 12:00') === 'EDT', 'a July New York due time should print as EDT');
  assert(timezoneLabel('America/Detroit', '2020-01-06 09:15') === 'EST', 'Detroit should use the same January offset');
  assert(timezoneLabel('UTC', '2020-01-06 09:15') === 'UTC', 'UTC should keep its short name');
  assert(timezoneLabel('') === '', 'a blank zone should stay blank');
  console.log('PASS timezone labels');

  fs.mkdirSync(uploadDir, { recursive: true });
  const init = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  if (init.code !== 0) throw new Error(`init_db failed (${init.code})\n${init.out}\n${init.err}`);

  const server = startServer();
  const db = openDb(dbFile);
  try {
    await server.ready;
    const admin = await login('admin', adminPassword);
    const created = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Phase Twelve Customer',
        username: 'phase12',
        password: 'CustomerPass1',
        company: 'Phase Twelve Co',
        contact_name: 'Pat Twelve',
        phone: '919-555-1212',
        email: 'pat@phase12.example',
      },
    });
    assert(created.status === 201, `customer create failed: ${created.status} ${created.text}`);
    const customer = await login('phase12', 'CustomerPass1');
    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    assert(options.status === 200, `order options failed: ${options.status} ${options.text}`);
    const byName = Object.fromEntries(options.json.services.map((service) => [service.name, service]));
    setServiceNames(byName);

    const order = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: fillOrderLines({
        company: 'Phase Twelve Co',
        contact_name: 'Pat Twelve',
        phone: '919-555-1212',
        email: 'pat@phase12.example',
        project_name: 'Branded Ticket',
        notes: 'Hold the orange band.',
        originals_source: 'Hardcopy or digital media provided',
        address_line1: '100 Ticket Lane',
        city: 'Raleigh',
        state: 'NC',
        zip: '27601',
        delivery_method: 'Accent Truck',
        ship_to: 'Loading dock',
        due_date: weekdayAhead(),
        due_time: '09:15',
        service_ids: [byName['Large Format'].id, byName['Small Format'].id],
        line_items: [
          { description: 'Site plan', quantity: '2', service_id: byName['Large Format'].id },
          { description: 'Spec book', quantity: '2', service_id: byName['Small Format'].id },
        ],
      }),
    });
    assert(order.status === 201, `order create failed: ${order.status} ${order.text}`);
    const orderId = order.json.order.id;
    const sheets = order.json.work_orders;
    assert(sheets.length === 2, 'two services should create two work orders');
    const first = sheets[0];

    const rush = await request({
      method: 'PUT',
      path: `/api/workorders/${first.id}/priority`,
      token: admin.token,
      json: { priority: 'Rush' },
    });
    assert(rush.status === 200, `priority update failed: ${rush.status} ${rush.text}`);

    await db.run(
      `UPDATE orders SET due_date = '2020-01-06', due_time = '09:15' WHERE id = ?`,
      [orderId]
    );
    await db.run(
      `UPDATE work_orders SET due_date = '2020-01-06 09:15:00', status = 'open' WHERE order_id = ?`,
      [orderId]
    );

    const printed = await request({
      method: 'GET',
      path: `/api/workorders/${first.id}/print`,
      token: admin.token,
    });
    assert(printed.status === 200, `print failed: ${printed.status} ${printed.text}`);
    const sheet = printed.json.work_orders[0];
    assert(sheet.priority === 'Rush', `priority should be Rush, got ${sheet.priority}`);
    assert(sheet.timezone === 'America/New_York', `timezone should follow the shop, got ${sheet.timezone}`);
    assert(sheet.timezone_label === 'EST', `a January due time should say EST, got ${sheet.timezone_label}`);
    assert(sheet.overdue === true, 'a past due time should be overdue');
    assert(sheet.due_date === '2020-01-06' && sheet.due_time === '09:15', 'due date and time should stay the stored wall clock');
    assert(printed.json.shop && printed.json.shop.name && printed.json.shop.phone, 'letterhead should still be present for the footer');
    assert(!printed.text.includes('password_hash'), 'print payload should not name password hashes');
    decodePrinted(sheet.barcode_svg, sheet.external_id);

    const orderPrint = await request({
      method: 'GET',
      path: `/api/orders/${orderId}/print`,
      token: customer.token,
    });
    assert(orderPrint.status === 200, `order print failed: ${orderPrint.status} ${orderPrint.text}`);
    assert(orderPrint.json.work_orders.length === 2, 'an order print should include every work order');
    for (const row of orderPrint.json.work_orders) {
      assert(row.timezone_label === 'EST', 'each January sheet should say EST');
      assert(row.overdue === true, 'each open past-due sheet should be overdue');
      decodePrinted(row.barcode_svg, row.external_id);
    }
    const rushed = orderPrint.json.work_orders.find((row) => row.id === first.id);
    const steady = orderPrint.json.work_orders.find((row) => row.id !== first.id);
    assert(rushed.priority === 'Rush', 'only the updated work order should be Rush');
    assert(steady.priority === 'Normal', `the other work order should stay Normal, got ${steady.priority}`);

    await db.run(`UPDATE work_orders SET status = 'completed' WHERE id = ?`, [first.id]);
    const finished = await request({
      method: 'GET',
      path: `/api/workorders/${first.id}/print`,
      token: admin.token,
    });
    assert(finished.status === 200, finished.text);
    assert(finished.json.work_orders[0].overdue === false, 'a completed work order should not print overdue');
    assert(finished.json.work_orders[0].priority === 'Rush', 'completing the job should leave the Rush priority');

    await db.run(
      `UPDATE orders SET due_date = '2099-01-04', due_time = '15:00' WHERE id = ?`,
      [orderId]
    );
    await db.run(
      `UPDATE work_orders SET status = 'open', due_date = '2099-01-04 15:00:00' WHERE order_id = ?`,
      [orderId]
    );
    const later = await request({
      method: 'GET',
      path: `/api/workorders/${first.id}/print`,
      token: admin.token,
    });
    assert(later.status === 200, later.text);
    assert(later.json.work_orders[0].overdue === false, 'a future due time should not be overdue');
    assert(later.json.work_orders[0].due_soon === false, 'a far future due time should not be due soon');
    decodePrinted(later.json.work_orders[0].barcode_svg, later.json.work_orders[0].external_id);

    const staff = await request({
      method: 'POST',
      path: '/api/workorders',
      token: admin.token,
      json: {
        customer_id: created.json.id,
        description: 'Counter copy',
        quantity: 1,
        status: 'open',
        department: 'Large Format',
        due_date: '2026-10-01 10:00',
      },
    });
    assert(staff.status === 201 && staff.json && staff.json.id, `staff work order create failed: ${staff.status} ${staff.text}`);
    assert(!staff.json.order_id, 'this check needs a work order with no order due time');
    const staffPrint = await request({
      method: 'GET',
      path: `/api/workorders/${staff.json.id}/print`,
      token: admin.token,
    });
    assert(staffPrint.status === 200, `staff print failed: ${staffPrint.status} ${staffPrint.text}`);
    const staffSheet = staffPrint.json.work_orders[0];
    assert(staffSheet.due_date === '2026-10-01', `staff due date should come from the work order, got ${staffSheet.due_date}`);
    assert(staffSheet.due_time === '10:00', `staff due time should come from the work order, got ${staffSheet.due_time}`);
    assert(staffSheet.timezone_label === 'EDT', `October due time should say EDT, got ${staffSheet.timezone_label}`);
    assert(staffSheet.overdue === true, 'a past work-order due time with no order due time should be overdue');
    assert(staffSheet.due_soon === false, 'an overdue work order should not also be due soon');

    await db.run(`UPDATE work_orders SET status = 'cancelled' WHERE id = ?`, [staff.json.id]);
    const cancelled = await request({
      method: 'GET',
      path: `/api/workorders/${staff.json.id}/print`,
      token: admin.token,
    });
    assert(cancelled.status === 200, cancelled.text);
    assert(cancelled.json.work_orders[0].due_time === '10:00', 'cancelling should leave the due time');
    assert(cancelled.json.work_orders[0].overdue === false, 'a cancelled work order should not print overdue');

    await db.run(`UPDATE work_orders SET status = 'on-hold' WHERE id = ?`, [staff.json.id]);
    const held = await request({
      method: 'GET',
      path: `/api/workorders/${staff.json.id}/print`,
      token: admin.token,
    });
    assert(held.status === 200, held.text);
    assert(held.json.work_orders[0].overdue === false, 'an on-hold work order should not print overdue');
    console.log('PASS print timing, rush, overdue, and barcode');
  } finally {
    server.stop();
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
