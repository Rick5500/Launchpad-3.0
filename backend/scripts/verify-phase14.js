/**
 * Phase 14 checks: production-board urgency on the admin board.
 * Overdue, due today, due soon, and rush use the shop timezone.
 * Department scope, customer isolation, and manual moves stay in place.
 * Usage (from backend/): node scripts/verify-phase14.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { classifyDelivery, zonedParts, zonedTimeToUtc } = require('../deliveryRules');
const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase14-'));
const dbFile = path.join(tmp, 'phase14.db');
const uploadDir = path.join(tmp, 'uploads');
const port = 3134;
const adminPassword = 'AdminPass123';
const zone = 'America/New_York';
const rules = { timezone: zone, dueSoonHours: 1 };

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.name = 'AssertionError';
    throw error;
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateKey(parts) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function wallClock(parts) {
  return `${dateKey(parts)} ${pad(parts.hour)}:${pad(parts.minute)}:00`;
}

function addMinutes(parts, minutes) {
  const utc = zonedTimeToUtc({ ...parts, second: 0 }, zone);
  return zonedParts(new Date(utc.getTime() + minutes * 60 * 1000), zone);
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
    DELIVERY_TIMEZONE: zone,
    DUE_SOON_HOURS: '1',
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
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' });
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

function findRow(body, externalId) {
  return (body.work_orders || []).find((row) => row.external_id === externalId) || null;
}

function assertUrgency(row, expected, label) {
  assert(row, `${label} should be on the board`);
  const urgency = row.urgency || {};
  assert(urgency.overdue === expected.overdue, `${label} overdue should be ${expected.overdue}, got ${urgency.overdue}`);
  assert(urgency.due_today === expected.due_today, `${label} due_today should be ${expected.due_today}, got ${urgency.due_today}`);
  assert(urgency.due_soon === expected.due_soon, `${label} due_soon should be ${expected.due_soon}, got ${urgency.due_soon}`);
  assert(urgency.rush === expected.rush, `${label} rush should be ${expected.rush}, got ${urgency.rush}`);
  assert(urgency.tone === expected.tone, `${label} tone should be ${expected.tone}, got ${urgency.tone}`);
  assert(JSON.stringify(urgency.signals) === JSON.stringify(expected.signals), `${label} signals should be ${expected.signals.join(', ')}, got ${(urgency.signals || []).join(', ')}`);
}

async function insertWorkOrder(db, fields) {
  const result = await db.run(
    `INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department, priority, due_date, notes)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      fields.externalId,
      fields.customerId,
      fields.externalId,
      fields.status,
      fields.department,
      fields.priority,
      fields.due,
      fields.notes || null,
    ]
  );
  return result.lastID;
}

async function main() {
  fs.mkdirSync(uploadDir, { recursive: true });
  const init = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  if (init.code !== 0) throw new Error(`init_db failed (${init.code})\n${init.out}\n${init.err}`);
  const again = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  if (again.code !== 0) throw new Error(`second init_db failed (${again.code})\n${again.out}\n${again.err}`);

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
        display_name: 'Phase Fourteen Customer',
        username: 'phase14',
        password: 'CustomerPass1',
        company: 'Phase Fourteen Co',
        contact_name: 'Pat Thirteen',
        phone: '919-555-1313',
        email: 'pat@phase14.example',
      },
    });
    assert(created.status === 201 && created.json.id, `customer create failed: ${created.status} ${created.text}`);
    const other = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Other Thirteen Customer',
        username: 'phase14other',
        password: 'CustomerPass1',
        company: 'Other Fourteen Co',
        contact_name: 'Other Pat',
        phone: '919-555-1314',
        email: 'other@phase14.example',
      },
    });
    assert(other.status === 201, `second customer failed: ${other.status} ${other.text}`);

    const staff = [
      { username: 'phase14mgr', display_name: 'Phase Fourteen Manager', role: 'manager', password: 'ManagerPass123' },
      { username: 'phase14op', display_name: 'Phase Fourteen Operator', role: 'operator', password: 'OperatorPass123', department: 'Large Format' },
      { username: 'phase14dept', display_name: 'Phase Fourteen Dept Admin', role: 'admin', password: 'AdminPass456', department: 'Small Format' },
    ];
    for (const person of staff) {
      const response = await request({
        method: 'POST',
        path: '/api/users',
        token: admin.token,
        json: { is_active: true, ...person },
      });
      assert(response.status === 201, `create ${person.username} failed: ${response.status} ${response.text}`);
    }

    const customer = await login('phase14', 'CustomerPass1');
    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    assert(options.status === 200, options.text);
    const byName = Object.fromEntries(options.json.services.map((service) => [service.name, service]));
    setServiceNames(byName);
    const order = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: fillOrderLines({
        company: 'Phase Fourteen Co',
        contact_name: 'Pat Thirteen',
        phone: '919-555-1313',
        email: 'pat@phase14.example',
        project_name: 'Board Detail',
        notes: 'Keep the navy header.',
        originals_source: 'Hardcopy or digital media provided',
        address_line1: '100 Board Lane',
        city: 'Raleigh',
        state: 'NC',
        zip: '27601',
        delivery_method: 'Will Call',
        due_date: weekdayAhead(),
        due_time: '10:00',
        service_ids: [byName['Large Format'].id],
        line_items: [{ description: 'Floor plan', quantity: '3', service_id: byName['Large Format'].id }],
      }),
    });
    assert(order.status === 201, `order create failed: ${order.status} ${order.text}`);
    const ticket = order.json.work_orders[0];
    await db.run(
      `UPDATE orders SET due_date = '2020-01-06', due_time = '09:15' WHERE id = ?`,
      [order.json.order.id]
    );
    await db.run(
      `UPDATE work_orders SET due_date = '2020-01-06 09:15:00', status = 'open', priority = 'Rush', department = 'Large Format' WHERE id = ?`,
      [ticket.id]
    );

    const nowParts = zonedParts(new Date(), zone);
    const soonParts = addMinutes(nowParts, 20);
    const laterParts = addMinutes(nowParts, 180);
    const today = dateKey(nowParts);
    await insertWorkOrder(db, {
      externalId: 'P13-SOON',
      customerId: created.json.id,
      status: 'open',
      department: 'Large Format',
      priority: 'Normal',
      due: wallClock(soonParts),
    });
    await insertWorkOrder(db, {
      externalId: 'P13-LATER',
      customerId: created.json.id,
      status: 'in-progress',
      department: 'Large Format',
      priority: 'Normal',
      due: wallClock(laterParts),
    });
    await insertWorkOrder(db, {
      externalId: 'P13-TODAY',
      customerId: created.json.id,
      status: 'open',
      department: 'Small Format',
      priority: 'Normal',
      due: today,
    });
    await insertWorkOrder(db, {
      externalId: 'P13-DATE',
      customerId: created.json.id,
      status: 'open',
      department: 'Small Format',
      priority: 'Normal',
      due: '2020-01-06',
    });
    await insertWorkOrder(db, {
      externalId: 'P13-RUSH',
      customerId: created.json.id,
      status: 'open',
      department: 'Small Format',
      priority: 'Rush',
      due: '2099-06-15 10:00:00',
    });
    await insertWorkOrder(db, {
      externalId: 'P13-HOLD',
      customerId: created.json.id,
      status: 'on-hold',
      department: 'Large Format',
      priority: 'Rush',
      due: '2020-01-06 09:15:00',
      notes: 'Waiting on the customer.',
    });
    await insertWorkOrder(db, {
      externalId: 'P13-DONE',
      customerId: created.json.id,
      status: 'completed',
      department: 'Complete',
      priority: 'Normal',
      due: '2020-01-06 09:15:00',
    });

    const board = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&sort=due&direction=asc',
      token: admin.token,
    });
    assert(board.status === 200, board.text);
    assert(board.json.timezone === zone, `board timezone should be ${zone}, got ${board.json.timezone}`);
    assert(typeof board.json.evaluated_at === 'string' && board.json.evaluated_at.length > 0, 'the board should say when urgency was evaluated');

    const soonFlags = classifyDelivery({ status: 'pending', due_time: wallClock(soonParts) }, new Date(), rules);
    const laterFlags = classifyDelivery({ status: 'pending', due_time: wallClock(laterParts) }, new Date(), rules);
    assertUrgency(findRow(board.json, ticket.external_id), {
      overdue: true,
      due_today: false,
      due_soon: false,
      rush: true,
      tone: 'overdue',
      signals: ['Overdue', 'Rush'],
    }, 'past rush job');
    assertUrgency(findRow(board.json, 'P13-SOON'), {
      overdue: false,
      due_today: soonFlags.due_today,
      due_soon: true,
      rush: false,
      tone: 'due_soon',
      signals: ['Due soon'],
    }, 'due soon job');
    assert(soonFlags.due_soon === true, 'a job 20 minutes out should be inside the due-soon window');
    const laterTone = laterFlags.overdue ? 'overdue' : (laterFlags.due_soon ? 'due_soon' : (laterFlags.due_today ? 'due_today' : null));
    const laterSignals = [];
    if (laterFlags.overdue) laterSignals.push('Overdue');
    else if (laterFlags.due_soon) laterSignals.push('Due soon');
    else if (laterFlags.due_today) laterSignals.push('Due today');
    assertUrgency(findRow(board.json, 'P13-LATER'), {
      overdue: laterFlags.overdue,
      due_today: laterFlags.due_today,
      due_soon: laterFlags.due_soon,
      rush: false,
      tone: laterTone,
      signals: laterSignals,
    }, 'later job');
    assertUrgency(findRow(board.json, 'P13-TODAY'), {
      overdue: false,
      due_today: true,
      due_soon: false,
      rush: false,
      tone: 'due_today',
      signals: ['Due today'],
    }, 'date-only today');
    assertUrgency(findRow(board.json, 'P13-DATE'), {
      overdue: true,
      due_today: false,
      due_soon: false,
      rush: false,
      tone: 'overdue',
      signals: ['Overdue'],
    }, 'date-only past');
    assertUrgency(findRow(board.json, 'P13-RUSH'), {
      overdue: false,
      due_today: false,
      due_soon: false,
      rush: true,
      tone: 'rush',
      signals: ['Rush'],
    }, 'future rush');
    assertUrgency(findRow(board.json, 'P13-HOLD'), {
      overdue: false,
      due_today: false,
      due_soon: false,
      rush: true,
      tone: 'rush',
      signals: ['Rush'],
    }, 'on-hold rush');
    assert(!findRow(board.json, 'P13-DONE'), 'a completed job should stay off the active board');

    const completed = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&status=completed&q=P13-DONE',
      token: admin.token,
    });
    assert(completed.status === 200, completed.text);
    assertUrgency(findRow(completed.json, 'P13-DONE'), {
      overdue: false,
      due_today: false,
      due_soon: false,
      rush: false,
      tone: null,
      signals: [],
    }, 'completed job');

    const searched = await request({
      method: 'GET',
      path: `/api/admin-board/work-orders?q=${encodeURIComponent(ticket.external_id)}`,
      token: admin.token,
    });
    assert(searched.status === 200 && findRow(searched.json, ticket.external_id), 'search should still find the work order number');

    const manager = await login('phase14mgr', 'ManagerPass123');
    const managerBoard = await request({ method: 'GET', path: '/api/admin-board/work-orders?limit=100', token: manager.token });
    assert(managerBoard.status === 200, managerBoard.text);
    assert(managerBoard.json.viewer.restricted === false && managerBoard.json.viewer.department == null, 'a manager still sees every department');
    assert(findRow(managerBoard.json, 'P13-RUSH') && findRow(managerBoard.json, ticket.external_id), 'a manager should see both departments');

    const operator = await login('phase14op', 'OperatorPass123');
    const operatorBoard = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&scope=all',
      token: operator.token,
    });
    assert(operatorBoard.status === 200, operatorBoard.text);
    assert(operatorBoard.json.viewer.restricted === true && operatorBoard.json.viewer.can_clear === false, 'an operator cannot widen the board');
    assert(operatorBoard.json.viewer.department === 'Large Format', operatorBoard.text);
    assert(findRow(operatorBoard.json, ticket.external_id), 'an operator should see their department');
    assert(!findRow(operatorBoard.json, 'P13-RUSH'), 'an operator should not see another department');
    assert((operatorBoard.json.work_orders || []).every((row) => String(row.department).toLowerCase() === 'large format'), 'every operator row should be Large Format');

    const deptAdmin = await login('phase14dept', 'AdminPass456');
    const narrowed = await request({ method: 'GET', path: '/api/admin-board/work-orders?limit=100', token: deptAdmin.token });
    assert(narrowed.json.viewer.restricted === true && narrowed.json.viewer.can_clear === true, 'an admin with a department can clear it');
    assert(!findRow(narrowed.json, ticket.external_id), 'a Small Format admin should not see Large Format until they ask for all');
    const widened = await request({ method: 'GET', path: '/api/admin-board/work-orders?limit=100&scope=all', token: deptAdmin.token });
    assert(widened.json.viewer.restricted === false && findRow(widened.json, ticket.external_id), 'scope=all should show every department to that admin');

    const blocked = await request({ method: 'GET', path: '/api/admin-board', token: customer.token });
    assert(blocked.status === 403, `a customer should still be blocked from the board, got ${blocked.status}`);
    const ownDetail = await request({ method: 'GET', path: `/api/workorders/${ticket.id}`, token: customer.token });
    assert(ownDetail.status === 200 && ownDetail.json.line_items && ownDetail.json.line_items.length === 1, 'the customer should still read their own work order');
    const stranger = await login('phase14other', 'CustomerPass1');
    const hidden = await request({ method: 'GET', path: `/api/workorders/${ticket.id}`, token: stranger.token });
    assert(hidden.status === 404, `another customer should get 404, got ${hidden.status}`);

    const staffDetail = await request({ method: 'GET', path: `/api/workorders/${ticket.id}`, token: admin.token });
    assert(staffDetail.status === 200, staffDetail.text);
    assert(staffDetail.json.line_items.length === 1 && staffDetail.json.line_items[0].description === 'Floor plan', 'the detail payload should include the line');
    assert(staffDetail.json.order_notes === 'Keep the navy header.', 'instructions should stay on the order notes');
    assert(Array.isArray(staffDetail.json.production_history) && staffDetail.json.production_history.length > 0, 'history should include the created row');
    const holdDetail = await request({
      method: 'GET',
      path: `/api/admin-board/work-orders?q=P13-HOLD`,
      token: admin.token,
    });
    const hold = findRow(holdDetail.json, 'P13-HOLD');
    const holdRecord = await request({ method: 'GET', path: `/api/workorders/${hold.id}`, token: operator.token });
    assert(holdRecord.status === 200 && holdRecord.json.notes === 'Waiting on the customer.', 'a staff detail read should include work order notes');

    const operatorMove = await request({
      method: 'POST',
      path: `/api/workorders/${ticket.id}/move`,
      token: operator.token,
      json: { department: 'Quality' },
    });
    assert(operatorMove.status === 403, `an operator still cannot move a work order, got ${operatorMove.status}`);
    const managerMove = await request({
      method: 'POST',
      path: `/api/workorders/${findRow(managerBoard.json, 'P13-RUSH').id}/move`,
      token: manager.token,
      json: { department: 'Quality', note: 'From the board' },
    });
    assert(managerMove.status === 200, `a manager should still move a work order: ${managerMove.status} ${managerMove.text}`);
    const moved = await db.get(`SELECT department, status FROM work_orders WHERE external_id = 'P13-RUSH'`);
    assert(moved.department === 'Quality' && moved.status === 'open', `the rush job should sit in Quality, got ${moved.department} ${moved.status}`);

    console.log('PASS phase 14 board urgency');
  } finally {
    await db.close();
    server.stop();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
