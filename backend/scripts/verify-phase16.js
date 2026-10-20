/**
 * Phase 16 checks: three board categories, print moves a new job into
 * In Production once, and file size counts order-level uploads.
 * Usage (from backend/): node scripts/verify-phase16.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase16-'));
const dbFile = path.join(tmp, 'phase16.db');
const uploadDir = path.join(tmp, 'uploads');
const port = 3136;
const adminPassword = 'AdminPass123';
const zone = 'America/New_York';

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
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  return { run, get, all, close };
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
  // Tomorrow, not today: a 10:00 due on the shop day is already past after 10:00.
  for (let add = 1; add < 12; add += 1) {
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

async function main() {
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
        display_name: 'Phase Sixteen Customer',
        username: 'phase16',
        password: 'CustomerPass1',
        company: 'Phase Sixteen Co',
        contact_name: 'Pat Sixteen',
        phone: '919-555-1616',
        email: 'pat@phase16.example',
      },
    });
    assert(created.status === 201 && created.json.id, `customer create failed: ${created.status} ${created.text}`);
    const customer = await login('phase16', 'CustomerPass1');
    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    assert(options.status === 200, options.text);
    const byName = Object.fromEntries(options.json.services.map((service) => [service.name, service]));
    setServiceNames(byName);
    const order = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: fillOrderLines({
        company: 'Phase Sixteen Co',
        contact_name: 'Pat Sixteen',
        phone: '919-555-1616',
        email: 'pat@phase16.example',
        project_name: 'Print Move',
        notes: 'Move this when printed.',
        originals_source: 'Hardcopy or digital media provided',
        address_line1: '16 Print Lane',
        city: 'Raleigh',
        state: 'NC',
        zip: '27601',
        delivery_method: 'Will Call',
        due_date: weekdayAhead(),
        due_time: '10:00',
        service_ids: [byName['Large Format'].id, byName['Small Format'].id],
        line_items: [
          { description: 'Banner', quantity: '1', service_id: byName['Large Format'].id },
          { description: 'Card', quantity: '1', service_id: byName['Small Format'].id },
        ],
      }),
    });
    assert(order.status === 201, `order create failed: ${order.status} ${order.text}`);
    const ticket = order.json.work_orders.find((row) => String(row.external_id).endsWith('-A'));
    const sibling = order.json.work_orders.find((row) => String(row.external_id).endsWith('-B'));
    assert(ticket && sibling, 'the order should create two work orders');

    await db.run(
      `UPDATE work_orders SET due_date = '2099-06-15 10:00:00', status = 'open', priority = 'Rush' WHERE id = ?`,
      [ticket.id]
    );
    const beforePrint = await db.get(`SELECT status FROM work_orders WHERE id = ?`, [ticket.id]);
    assert(beforePrint.status === 'open', 'the job starts open');

    const customerPrint = await request({
      method: 'GET',
      path: `/api/workorders/${sibling.id}/print`,
      token: customer.token,
    });
    assert(customerPrint.status === 200, `customer print failed: ${customerPrint.status} ${customerPrint.text}`);
    assert(customerPrint.json.work_orders[0].routing.current_status_label === 'Active', 'a customer print should leave the job open');
    const siblingStatus = await db.get(`SELECT status FROM work_orders WHERE id = ?`, [sibling.id]);
    assert(siblingStatus.status === 'open', `a customer print should not move the job, got ${siblingStatus.status}`);
    const siblingPrinted = await db.get(
      `SELECT id FROM production_history WHERE work_order_id = ? AND notes = 'Printed'`,
      [sibling.id]
    );
    const siblingActivity = await db.get(
      `SELECT COUNT(*) AS count FROM activity_log WHERE entity_type = 'work_order' AND entity_id = ? AND action = 'work_order.printed'`,
      [sibling.id]
    );
    assert(!siblingPrinted, 'a customer print should not log a production start');
    assert(siblingActivity.count === 0, 'a customer print should not write work_order.printed');

    const raced = await db.run(
      `INSERT INTO work_orders (external_id, customer_id, order_id, description, quantity, status, department, priority, due_date)
       VALUES ('P16-RACE', ?, ?, 'Race', 1, 'open', 'Large Format', 'Normal', '2099-06-15 10:00:00')`,
      [created.json.id, order.json.order.id]
    );
    const parallel = await Promise.all([0, 1, 2, 3].map(() => request({
      method: 'GET',
      path: `/api/workorders/${raced.lastID}/print`,
      token: admin.token,
    })));
    assert(parallel.every((response) => response.status === 200), 'parallel prints should succeed');
    const racedStatus = await db.get(`SELECT status FROM work_orders WHERE id = ?`, [raced.lastID]);
    assert(racedStatus.status === 'in-progress', `parallel prints should leave the job in progress, got ${racedStatus.status}`);
    const racedHistory = await db.get(
      `SELECT COUNT(*) AS count FROM production_history WHERE work_order_id = ? AND notes = 'Printed'`,
      [raced.lastID]
    );
    const racedActivity = await db.get(
      `SELECT COUNT(*) AS count FROM activity_log WHERE entity_type = 'work_order' AND entity_id = ? AND action = 'work_order.printed'`,
      [raced.lastID]
    );
    assert(racedHistory.count === 1, `four parallel prints should log one Printed row, got ${racedHistory.count}`);
    assert(racedActivity.count === 1, `four parallel prints should write one activity row, got ${racedActivity.count}`);

    const printed = await request({
      method: 'GET',
      path: `/api/workorders/${ticket.id}/print`,
      token: admin.token,
    });
    assert(printed.status === 200, `print failed: ${printed.status} ${printed.text}`);
    assert(printed.json.work_orders[0].routing.current_status_label === 'In Production', 'the ticket should show In Production');
    const detail = await request({
      method: 'GET',
      path: `/api/workorders/${ticket.id}`,
      token: admin.token,
    });
    assert(detail.status === 200, `work order detail failed: ${detail.status} ${detail.text}`);
    assert(detail.json.routing.current_status_label === 'In Production', 'the work order page should call in-progress In Production');
    const after = await db.get(`SELECT status FROM work_orders WHERE id = ?`, [ticket.id]);
    assert(after.status === 'in-progress', `printing should move an open job to in-progress, got ${after.status}`);
    const history = await db.all(
      `SELECT status, notes, scanned_by FROM production_history WHERE work_order_id = ? ORDER BY id`,
      [ticket.id]
    );
    assert(history.some((row) => row.notes === 'Printed' && row.status === 'in-progress'), 'printing should log a Printed history row');
    const activity = await db.all(
      `SELECT action, detail FROM activity_log WHERE entity_type = 'work_order' AND entity_id = ? AND action = 'work_order.printed'`,
      [ticket.id]
    );
    assert(activity.length === 1, `printing should write one activity row, got ${activity.length}`);
    assert(activity[0].detail.includes('In Production'), 'the activity row should say the job moved to In Production');

    const board = await request({
      method: 'GET',
      path: `/api/admin-board/work-orders?q=${encodeURIComponent(ticket.external_id)}`,
      token: admin.token,
    });
    const printedRow = findRow(board.json, ticket.external_id);
    assert(printedRow.retrieved === true, 'printing should set Retrieved');
    assert(printedRow.urgency.category === 'in_production', `a future in-progress job is In Production, got ${printedRow.urgency.category}`);
    assert(printedRow.urgency.signals.join(',') === 'In Production', 'the chip should be In Production only');
    assert(printedRow.priority === 'Rush', 'Rush stays on the work order');
    assert(!printedRow.urgency.signals.includes('Rush'), 'Rush is not a board category');

    const reprint = await request({
      method: 'GET',
      path: `/api/workorders/${ticket.id}/print`,
      token: admin.token,
    });
    assert(reprint.status === 200, reprint.text);
    const historyAfter = await db.all(
      `SELECT id, notes FROM production_history WHERE work_order_id = ? AND notes = 'Printed'`,
      [ticket.id]
    );
    const activityAfter = await db.get(
      `SELECT COUNT(*) AS count FROM activity_log WHERE entity_type = 'work_order' AND entity_id = ? AND action = 'work_order.printed'`,
      [ticket.id]
    );
    const retrievedAfter = await request({
      method: 'GET',
      path: `/api/admin-board/work-orders?q=${encodeURIComponent(ticket.external_id)}`,
      token: admin.token,
    });
    assert(historyAfter.length === 1, 'a reprint should not add another Printed history row');
    assert(activityAfter.count === 1, 'a reprint should not add another activity row');
    assert(findRow(retrievedAfter.json, ticket.external_id).retrieved_at === printedRow.retrieved_at, 'a reprint should keep the first retrieved time');

    const frozen = [
      { id: 'P16-HOLD', status: 'on-hold' },
      { id: 'P16-DONE', status: 'completed' },
      { id: 'P16-CANCEL', status: 'cancelled' },
    ];
    for (const item of frozen) {
      const inserted = await db.run(
        `INSERT INTO work_orders (external_id, customer_id, order_id, description, quantity, status, department, priority, due_date)
         VALUES (?, ?, ?, ?, 1, ?, 'Large Format', 'Normal', '2020-01-06 09:15:00')`,
        [item.id, created.json.id, order.json.order.id, item.id, item.status]
      );
      const response = await request({
        method: 'GET',
        path: `/api/workorders/${inserted.lastID}/print`,
        token: admin.token,
      });
      assert(response.status === 200, `${item.status} print failed: ${response.text}`);
      const stored = await db.get(`SELECT status FROM work_orders WHERE id = ?`, [inserted.lastID]);
      assert(stored.status === item.status, `printing should not move a ${item.status} job, got ${stored.status}`);
      const printedHistory = await db.get(
        `SELECT id FROM production_history WHERE work_order_id = ? AND notes = 'Printed'`,
        [inserted.lastID]
      );
      assert(!printedHistory, `printing a ${item.status} job should not log a production start`);
    }

    const tenMb = 10 * 1024 * 1024;
    const halfMb = 512 * 1024;
    await db.run(
      `INSERT INTO order_files (work_order_id, order_id, original_name, stored_name, size_bytes)
       VALUES (?, ?, 'art.pdf', 'art.pdf', ?)`,
      [ticket.id, order.json.order.id, tenMb]
    );
    await db.run(
      `INSERT INTO order_files (order_id, original_name, stored_name, size_bytes)
       VALUES (?, 'shared.zip', 'shared.zip', ?)`,
      [order.json.order.id, halfMb]
    );
    const sized = await request({
      method: 'GET',
      path: `/api/admin-board/work-orders?q=${encodeURIComponent(ticket.external_id)}&limit=100`,
      token: admin.token,
    });
    const sizedRow = findRow(sized.json, ticket.external_id);
    assert(sizedRow.file_count === 2, `the work order should count its file and the order file, got ${sizedRow.file_count}`);
    assert(sizedRow.files_label === '2 / 10.5 MB', `files should read 2 / 10.5 MB, got ${sizedRow.files_label}`);
    assert(sizedRow.status_label === 'LiveOrder', 'an in-progress job still reads LiveOrder');
    const siblingBoard = await request({
      method: 'GET',
      path: `/api/admin-board/work-orders?q=${encodeURIComponent(sibling.external_id)}`,
      token: admin.token,
    });
    const siblingRow = findRow(siblingBoard.json, sibling.external_id);
    assert(siblingRow && siblingRow.file_count === 1 && siblingRow.files_label === '1 / 512 KB', `an order-level file should read 1 / 512 KB, got ${siblingRow && siblingRow.files_label}`);

    await db.run(`UPDATE orders SET due_date = '', due_time = '' WHERE id = ?`, [order.json.order.id]);
    await db.run(
      `UPDATE work_orders SET status = 'open', priority = 'Rush', due_date = '2020-01-06 09:15:00' WHERE id = ?`,
      [sibling.id]
    );
    const categories = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&category=overdue',
      token: admin.token,
    });
    assert(categories.status === 200, categories.text);
    assert(findRow(categories.json, sibling.external_id), 'an open past-due job should match the overdue filter');
    assert(!findRow(categories.json, ticket.external_id), 'a future in-production job should not match overdue');
    for (const row of categories.json.work_orders) {
      assert(row.urgency.category === 'overdue', `${row.external_id} in the overdue filter is ${row.urgency.category}`);
      assert(!row.urgency.signals.includes('Due today') && !row.urgency.signals.includes('Due soon') && !row.urgency.signals.includes('Rush'), 'due today and rush are not categories');
    }
    const fresh = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&category=new',
      token: admin.token,
    });
    assert(fresh.status === 200 && !findRow(fresh.json, sibling.external_id), 'an overdue job is not also New');

    const summary = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    assert(summary.status === 200, summary.text);
    const names = Object.keys(summary.json.stats.categories || {}).sort();
    assert(names.join(',') === 'in_production,new,overdue', `category counts should be the three categories, got ${names.join(',')}`);
    assert(summary.json.stats.categories.in_production >= 1, 'In Production should be counted once');
    console.log('PASS phase 16 categories, print move, and file size');
  } finally {
    server.stop();
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
