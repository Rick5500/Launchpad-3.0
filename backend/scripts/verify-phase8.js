/**
 * Phase 8 checks: a department on each staff login, upgrade-safe migration,
 * board restriction, department scan location, and customer isolation.
 * Usage (from backend/): node scripts/verify-phase8.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase8-'));
const oldDb = path.join(tmp, 'old.db');
const freshDb = path.join(tmp, 'fresh.db');
const port = 3120;
const adminPassword = 'AdminPass123';

const ACTIVE_SQL = `NOT (lower(trim(coalesce(status, ''))) IN ('completed', 'complete'))
  AND NOT (lower(trim(coalesce(department, ''))) = 'complete')`;

const OLD_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  display_name TEXT,
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

function baseEnv(databaseFile) {
  return {
    DATABASE_FILE: databaseFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    DELIVERY_TIMEZONE: 'UTC',
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
  };
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
        resolve({ status: res.statusCode, json: parsed, text, headers: res.headers });
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

function startServer(databaseFile) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...baseEnv(databaseFile) },
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
    }, 15000);
    const poll = async () => {
      if (settled) return;
      try {
        const health = await request({ method: 'GET', path: '/api/health' });
        if (health.status === 200 && health.json && health.json.status === 'ok') {
          settled = true;
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
      return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
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

async function departmentColumn(db) {
  const rows = await db.all(`PRAGMA table_info(users)`);
  return rows.filter((row) => row.name === 'department');
}

async function activeCount(db, department) {
  const params = [];
  let sql = `SELECT COUNT(*) AS count FROM work_orders WHERE ${ACTIVE_SQL}`;
  if (department) {
    sql += ` AND lower(trim(coalesce(department, ''))) = lower(?)`;
    params.push(department);
  }
  const row = await db.get(sql, params);
  return row ? row.count : 0;
}

function staffBody(extra) {
  return {
    display_name: 'Phase Eight',
    is_active: true,
    ...extra,
  };
}

async function main() {
  const legacy = openDb(oldDb);
  await legacy.exec(OLD_SCHEMA);
  await legacy.run(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES ('legacy', 'x', 'operator', 'Legacy Op')`
  );
  await legacy.close();
  await initDatabase(oldDb);
  await initDatabase(oldDb);
  const upgraded = openDb(oldDb);
  const upgradedColumns = await departmentColumn(upgraded);
  assert(upgradedColumns.length === 1, 'an upgraded database should gain users.department once');
  assert(upgradedColumns[0].notnull === 0, 'users.department should stay nullable');
  const legacyUser = await upgraded.get(`SELECT username, role, department FROM users WHERE username = 'legacy'`);
  assert(legacyUser && legacyUser.role === 'operator' && legacyUser.department == null, 'an existing user should keep a null department');
  const upgradedAdmin = await upgraded.get(`SELECT department FROM users WHERE username = 'admin'`);
  assert(upgradedAdmin && upgradedAdmin.department == null, 'the seeded admin should not be assigned a department');
  await upgraded.close();

  await initDatabase(freshDb);
  await initDatabase(freshDb);
  const fresh = openDb(freshDb);
  const freshColumns = await departmentColumn(fresh);
  assert(freshColumns.length === 1 && freshColumns[0].notnull === 0, 'a fresh database should include a nullable users.department');
  const freshAdmin = await fresh.get(`SELECT department FROM users WHERE username = 'admin'`);
  assert(freshAdmin && freshAdmin.department == null, 'a fresh admin should see every department');
  await fresh.close();

  const server = startServer(freshDb);
  await server.ready;
  const db = openDb(freshDb);
  try {
    const admin = await login('admin', adminPassword);
    assert(admin.user.department == null, 'login should return a null department for an unrestricted admin');
    const me = await request({ method: 'GET', path: '/api/auth/me', token: admin.token });
    assert(me.status === 200 && me.json.user.department == null, `auth/me should return department: ${me.text}`);

    const badDepartment = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({ username: 'baddept', role: 'operator', department: 'Not A Department', password: 'OperatorPass123' }),
    });
    assert(badDepartment.status === 400, `unknown department should be rejected: ${badDepartment.text}`);
    assert(
      /Large Format/.test(badDepartment.json.error || '') && /Complete/.test(badDepartment.json.error || ''),
      `unknown department should list valid names: ${badDepartment.text}`
    );
    const manufacturing = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({ username: 'legacydept', role: 'operator', department: 'Manufacturing', password: 'OperatorPass123' }),
    });
    assert(manufacturing.status === 400, `Manufacturing should stay unassignable: ${manufacturing.text}`);
    assert(
      /Large Format/.test(manufacturing.json.error || '') && !/\bManufacturing\b/.test(manufacturing.json.error || ''),
      `the error should list departments from the table, not legacy board names: ${manufacturing.text}`
    );
    const assembly = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({ username: 'assemblydept', role: 'operator', department: 'Assembly', password: 'OperatorPass123' }),
    });
    assert(
      assembly.status === 400 && /Quality/.test(assembly.json.error || '') && !/\bAssembly\b/.test(assembly.json.error || ''),
      `Assembly should stay unassignable: ${assembly.text}`
    );

    const customerDepartment = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({ username: 'custdept', role: 'customer', department: 'Quality', password: 'CustomerPass1' }),
    });
    assert(customerDepartment.status === 400, `a customer department should be rejected: ${customerDepartment.text}`);

    const created = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({ username: 'qualityop', display_name: 'Quality Operator', role: 'operator', department: 'quality', password: 'OperatorPass123' }),
    });
    assert(created.status === 201, `operator create failed: ${created.text}`);
    assert(created.json.department === 'Quality', 'department should be stored with the canonical name');
    assert(!JSON.stringify(created.json).includes('password_hash'), 'user create should not return a password hash');
    const createdActivity = await db.get(
      `SELECT detail FROM activity_log WHERE action = 'user.created' AND entity_id = ?`,
      [created.json.id]
    );
    assert(createdActivity && /Quality/.test(createdActivity.detail), 'creating a department should be in the activity log');

    const listed = await request({ method: 'GET', path: '/api/users?limit=100', token: admin.token });
    const listedOp = (listed.json.users || []).find((row) => row.username === 'qualityop');
    assert(listedOp && listedOp.department === 'Quality', 'the user list should include department');

    const updated = await request({
      method: 'PUT',
      path: `/api/users/${created.json.id}`,
      token: admin.token,
      json: staffBody({ username: 'qualityop', display_name: 'Quality Operator', role: 'operator', department: 'Dispatch' }),
    });
    assert(updated.status === 200 && updated.json.department === 'Dispatch', `department update failed: ${updated.text}`);
    const updateActivity = await db.get(
      `SELECT detail FROM activity_log WHERE action = 'user.updated' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
      [created.json.id]
    );
    assert(updateActivity && /Dispatch/.test(updateActivity.detail) && /department/.test(updateActivity.detail), 'a department change should be logged');

    const cleared = await request({
      method: 'PUT',
      path: `/api/users/${created.json.id}`,
      token: admin.token,
      json: staffBody({ username: 'qualityop', display_name: 'Quality Operator', role: 'operator', department: '' }),
    });
    assert(cleared.status === 200 && cleared.json.department == null, `clearing department failed: ${cleared.text}`);
    const restored = await request({
      method: 'PUT',
      path: `/api/users/${created.json.id}`,
      token: admin.token,
      json: staffBody({ username: 'qualityop', display_name: 'Quality Operator', role: 'operator', department: 'Quality' }),
    });
    assert(restored.status === 200 && restored.json.department === 'Quality', restored.text);

    const deptAdmin = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({ username: 'qualityadmin', display_name: 'Quality Admin', role: 'admin', department: 'Quality', password: 'AdminPass456' }),
    });
    assert(deptAdmin.status === 201 && deptAdmin.json.department === 'Quality', deptAdmin.text);

    const customer = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({ username: 'phase8cust', display_name: 'Phase Eight Customer', role: 'customer', password: 'CustomerPass1' }),
    });
    assert(customer.status === 201 && customer.json.department == null, `customer create failed: ${customer.text}`);
    const otherCustomer = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({ username: 'phase8other', display_name: 'Other Customer', role: 'customer', password: 'CustomerPass1' }),
    });
    assert(otherCustomer.status === 201, otherCustomer.text);

    await db.run(
      `INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department)
       VALUES ('P8-QUAL', ?, 'Quality job', 1, 'open', 'Quality')`,
      [customer.json.id]
    );
    await db.run(
      `INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department)
       VALUES ('P8-DISP', ?, 'Dispatch job', 1, 'open', 'Dispatch')`,
      [otherCustomer.json.id]
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department)
       VALUES ('P8-DONE', 'Finished quality job', 1, 'completed', 'Quality')`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department)
       VALUES ('P8-MOVE', 'Scan me', 1, 'open', 'Large Format')`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department)
       VALUES ('P8-OTHER', 'Other scan', 1, 'open', 'Large Format')`
    );

    const operatorLogin = await login('qualityop', 'OperatorPass123');
    assert(operatorLogin.user.department === 'Quality', 'operator login should return the department');
    const operatorMe = await request({ method: 'GET', path: '/api/auth/me', token: operatorLogin.token });
    assert(operatorMe.status === 200 && operatorMe.json.user.department === 'Quality', operatorMe.text);

    const qualityActive = await activeCount(db, 'Quality');
    const operatorBoard = await request({ method: 'GET', path: '/api/admin-board', token: operatorLogin.token });
    assert(operatorBoard.status === 200, operatorBoard.text);
    assert(operatorBoard.json.viewer && operatorBoard.json.viewer.restricted === true, 'a department operator should be restricted');
    assert(operatorBoard.json.viewer.department === 'Quality' && operatorBoard.json.viewer.can_clear === false, 'an operator cannot clear the department');
    assert(operatorBoard.json.stats.total_active === qualityActive, `operator active count ${operatorBoard.json.stats.total_active} != ${qualityActive}`);
    assert(operatorBoard.json.tabs.length === 1 && operatorBoard.json.tabs[0].key === 'Quality', 'operator tabs should be only their department');
    assert(operatorBoard.json.queue.length === 1 && operatorBoard.json.queue[0].name === 'Quality', 'operator queue should be only their department');
    assert((operatorBoard.json.stats.departments || []).length === 0, 'operator stat cards should not list other departments');

    const operatorRows = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&department=Dispatch&scope=all&q=P8-',
      token: operatorLogin.token,
    });
    assert(operatorRows.status === 200, operatorRows.text);
    assert(operatorRows.json.viewer.restricted === true, 'a query param should not clear an operator restriction');
    const operatorIds = (operatorRows.json.work_orders || []).map((row) => row.external_id);
    assert(operatorIds.includes('P8-QUAL'), 'the operator should see the Quality work order');
    assert(!operatorIds.includes('P8-DISP'), 'the operator should not see Dispatch work');
    assert(!operatorIds.includes('P8-DONE'), 'completed work should stay out of the active table');
    assert(operatorRows.json.work_orders.every((row) => row.department === 'Quality'), 'every operator row should be Quality');

    const adminAll = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&q=P8-',
      token: admin.token,
    });
    const adminIds = (adminAll.json.work_orders || []).map((row) => row.external_id);
    assert(adminAll.json.viewer.restricted === false && adminAll.json.viewer.department == null, 'a null department admin should be unrestricted');
    assert(adminIds.includes('P8-QUAL') && adminIds.includes('P8-DISP'), 'an unrestricted admin should see every department');
    assert(!adminIds.includes('P8-DONE'), 'the active table should omit completed work for an admin too');
    const adminDispatch = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&department=Dispatch&q=P8-',
      token: admin.token,
    });
    const dispatchIds = (adminDispatch.json.work_orders || []).map((row) => row.external_id);
    assert(dispatchIds.includes('P8-DISP') && !dispatchIds.includes('P8-QUAL'), 'an unrestricted admin keeps the department filter');

    const qualityAdmin = await login('qualityadmin', 'AdminPass456');
    const restrictedAdmin = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&department=Dispatch&q=P8-',
      token: qualityAdmin.token,
    });
    assert(restrictedAdmin.json.viewer.restricted === true && restrictedAdmin.json.viewer.can_clear === true, 'an admin with a department can clear it');
    assert((restrictedAdmin.json.work_orders || []).every((row) => row.department === 'Quality'), 'the admin default should stay on their department');
    assert(!(restrictedAdmin.json.work_orders || []).some((row) => row.external_id === 'P8-DISP'), 'a department param should not widen an admin who has not asked for every department');
    const clearedAdmin = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&scope=all&q=P8-',
      token: qualityAdmin.token,
    });
    const clearedIds = (clearedAdmin.json.work_orders || []).map((row) => row.external_id);
    assert(clearedAdmin.json.viewer.restricted === false && clearedAdmin.json.viewer.department === 'Quality', 'scope=all should open the admin board');
    assert(clearedIds.includes('P8-QUAL') && clearedIds.includes('P8-DISP'), 'All departments should include both queues');

    const forced = await request({
      method: 'POST',
      path: '/api/barcode',
      token: operatorLogin.token,
      json: { scanned_value: 'P8-MOVE', location: 'Dispatch' },
    });
    assert(forced.status === 201, `department scan failed: ${forced.status} ${forced.text}`);
    assert(forced.json.location === 'Quality' && forced.json.to_department === 'Quality' && forced.json.department_moved === true, 'a department login should scan into that department');
    const moved = await db.get(`SELECT department FROM work_orders WHERE external_id = 'P8-MOVE'`);
    assert(moved && moved.department === 'Quality', 'the work order should be stored in Quality');

    const otherScan = await request({
      method: 'POST',
      path: '/api/barcode',
      token: admin.token,
      json: { scanned_value: 'P8-OTHER', location: 'Dispatch' },
    });
    assert(otherScan.status === 201 && otherScan.json.to_department === 'Dispatch', `admin scan failed: ${otherScan.text}`);
    const operatorEvents = await request({ method: 'GET', path: '/api/barcode/events?limit=50', token: operatorLogin.token });
    assert(operatorEvents.status === 200, operatorEvents.text);
    const eventValues = (operatorEvents.json.events || []).map((row) => row.scanned_value);
    assert(eventValues.includes('P8-MOVE'), 'the operator should see their department scan');
    assert(!eventValues.includes('P8-OTHER'), 'the operator should not see another department scan');
    assert((operatorEvents.json.events || []).every((row) => {
      const names = [row.location, row.from_department, row.to_department].map((value) => String(value || '').toLowerCase());
      return names.includes('quality');
    }), 'every operator scan event should touch Quality');
    const operatorBoardScans = await request({ method: 'GET', path: '/api/admin-board', token: operatorLogin.token });
    assert((operatorBoardScans.json.scans || []).every((row) => {
      const names = [row.location, row.from_department, row.to_department].map((value) => String(value || '').toLowerCase());
      return names.includes('quality');
    }), 'Scan Activity should stay on the operator department');

    const qualRow = await db.get(`SELECT id FROM work_orders WHERE external_id = 'P8-QUAL'`);
    const dispRow = await db.get(`SELECT id FROM work_orders WHERE external_id = 'P8-DISP'`);
    await db.run(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, detail)
       VALUES (?, 'work_order.moved', 'work_order', ?, ?)`,
      [admin.user.id, qualRow.id, JSON.stringify({
        external_id: 'P8-QUAL',
        from_department: 'Large Format',
        to_department: 'Quality',
        message: 'Moved to Quality',
      })]
    );
    await db.run(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, detail)
       VALUES (?, 'work_order.moved', 'work_order', ?, ?)`,
      [admin.user.id, dispRow.id, JSON.stringify({
        external_id: 'P8-DISP',
        from_department: 'Large Format',
        to_department: 'Dispatch',
        message: 'Moved to Dispatch',
      })]
    );
    await db.run(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, detail)
       VALUES (?, 'user.created', 'user', ?, ?)`,
      [admin.user.id, created.json.id, JSON.stringify({
        department: 'Quality',
        message: 'Created operator qualityop in Quality',
      })]
    );
    await db.run(
      `UPDATE work_orders
       SET requires_approval = 1, approval_status = 'pending'
       WHERE external_id IN ('P8-QUAL', 'P8-DISP')`
    );

    function activityText(body) {
      return (body.activity || []).map((row) => `${row.action} ${row.external_id || ''} ${row.summary || ''}`).join('\n');
    }
    const operatorActivity = await request({
      method: 'GET',
      path: '/api/admin-board/activity?limit=100&scope=all',
      token: operatorLogin.token,
    });
    assert(operatorActivity.status === 200, operatorActivity.text);
    const operatorActivityText = activityText(operatorActivity.json);
    assert(/P8-QUAL/.test(operatorActivityText), `operator activity should include the Quality work order: ${operatorActivityText}`);
    assert(!/P8-DISP/.test(operatorActivityText), `operator activity should omit Dispatch-only events: ${operatorActivityText}`);
    assert(!/Created operator/.test(operatorActivityText), `operator activity should omit user events: ${operatorActivityText}`);
    assert((operatorActivity.json.activity || []).every((row) => row.entity_type === 'work_order'), 'restricted activity should be work order events');
    const operatorSummary = await request({ method: 'GET', path: '/api/admin-board', token: operatorLogin.token });
    const operatorSummaryText = activityText(operatorSummary.json);
    assert(/P8-QUAL/.test(operatorSummaryText) && !/Created operator/.test(operatorSummaryText),
      `the activity panel should stay on Quality: ${operatorSummaryText}`);
    const adminActivity = await request({
      method: 'GET',
      path: '/api/admin-board/activity?limit=100',
      token: admin.token,
    });
    const adminActivityText = activityText(adminActivity.json);
    assert(/Created operator qualityop in Quality/.test(adminActivityText), 'an unrestricted admin still sees user events');
    assert(/P8-DISP/.test(adminActivityText) && /P8-QUAL/.test(adminActivityText), 'an unrestricted admin still sees every department');
    const widenedActivity = await request({
      method: 'GET',
      path: '/api/admin-board/activity?limit=100&scope=all',
      token: qualityAdmin.token,
    });
    assert(/Created operator/.test(activityText(widenedActivity.json)), 'scope=all should restore the full activity list for an admin');

    function approvalIds(body) {
      return (body.approvals || []).map((row) => row.external_id);
    }
    const operatorApprovals = await request({
      method: 'GET',
      path: '/api/admin-board/approvals?limit=100',
      token: operatorLogin.token,
    });
    assert(operatorApprovals.status === 200, operatorApprovals.text);
    assert(approvalIds(operatorApprovals.json).includes('P8-QUAL'), 'the operator should see a Quality approval');
    assert(!approvalIds(operatorApprovals.json).includes('P8-DISP'), 'the operator should not see a Dispatch approval');
    assert(
      (operatorSummary.json.approvals || []).every((row) => String(row.department || '').toLowerCase() === 'quality')
        && !approvalIds(operatorSummary.json).includes('P8-DISP'),
      'the approval preview should stay on the operator department'
    );
    const adminApprovals = await request({
      method: 'GET',
      path: '/api/admin-board/approvals?limit=100',
      token: admin.token,
    });
    assert(approvalIds(adminApprovals.json).includes('P8-QUAL') && approvalIds(adminApprovals.json).includes('P8-DISP'),
      'an unrestricted admin should see approvals in every department');

    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department, created_at, updated_at)
       VALUES ('P8-NEW', 'Completed today', 1, 'completed', 'Complete', datetime('now', '-1 hour'), datetime('now'))`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department, created_at, updated_at)
       VALUES ('P8-OLDER', 'Completed earlier today', 1, 'completed', 'Dispatch', datetime('now', '-3 hours'), datetime('now', '-2 hours'))`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department, created_at, updated_at)
       VALUES ('P8-LASTYEAR', 'Old completed job', 1, 'completed', 'Complete', '2020-06-01 12:00:00', '2020-06-01 12:00:00')`
    );
    const completeUser = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({ username: 'completeop', display_name: 'Complete Operator', role: 'operator', department: 'Complete', password: 'OperatorPass123' }),
    });
    assert(completeUser.status === 201 && completeUser.json.department === 'Complete', completeUser.text);
    const completeLogin = await login('completeop', 'OperatorPass123');
    const completeBoard = await request({ method: 'GET', path: '/api/admin-board', token: completeLogin.token });
    assert(completeBoard.status === 200, completeBoard.text);
    assert(completeBoard.json.viewer.department === 'Complete' && completeBoard.json.viewer.restricted === true, 'a Complete login should stay restricted');
    assert(completeBoard.json.viewer.filter === 'completed this month', 'the Complete chip should name the default filter');
    assert(completeBoard.json.tabs.length === 1 && completeBoard.json.tabs[0].key === 'Complete', 'the Complete board should keep a Complete tab');
    const completeRows = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&sort=arrived&direction=desc&q=P8-',
      token: completeLogin.token,
    });
    assert(completeRows.status === 200, completeRows.text);
    const completeIds = (completeRows.json.work_orders || []).map((row) => row.external_id);
    assert(completeIds[0] === 'P8-NEW' && completeIds.includes('P8-OLDER'), `completed this month should be newest first: ${completeIds.join(',')}`);
    assert(completeIds.indexOf('P8-NEW') < completeIds.indexOf('P8-OLDER'), 'newer completed work should come first');
    assert(!completeIds.includes('P8-LASTYEAR'), 'a Complete login should not default to older completed work');
    assert(!completeIds.includes('P8-QUAL') && !completeIds.includes('P8-DISP'), 'open work should stay off the Complete default');
    const adminComplete = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&department=Complete&q=P8-',
      token: admin.token,
    });
    const adminCompleteIds = (adminComplete.json.work_orders || []).map((row) => row.external_id);
    assert(adminCompleteIds.includes('P8-LASTYEAR') && adminCompleteIds.includes('P8-NEW'), 'an unrestricted Complete tab should keep its existing scope');
    const adminActive = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&q=P8-',
      token: admin.token,
    });
    const adminActiveIds = (adminActive.json.work_orders || []).map((row) => row.external_id);
    assert(!adminActiveIds.includes('P8-NEW') && !adminActiveIds.includes('P8-LASTYEAR'), 'the active table should still omit completed work');

    const tempDepartment = await request({
      method: 'POST',
      path: '/api/departments',
      token: admin.token,
      json: { name: 'P8 Temp', sort_order: 80 },
    });
    assert(tempDepartment.status === 201 && tempDepartment.json.id, `department create failed: ${tempDepartment.text}`);
    const tempUser = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({ username: 'p8temp', display_name: 'Temp Op', role: 'operator', department: 'P8 Temp', password: 'OperatorPass123' }),
    });
    assert(tempUser.status === 201 && tempUser.json.department === 'P8 Temp', tempUser.text);
    const renamed = await request({
      method: 'PUT',
      path: `/api/departments/${tempDepartment.json.id}`,
      token: admin.token,
      json: { name: 'P8 Renamed', description: 'renamed', color: '#112233', sort_order: 81, is_active: 1 },
    });
    assert(renamed.status === 200 && renamed.json.name === 'P8 Renamed', `department rename failed: ${renamed.text}`);
    const renamedUser = await db.get(`SELECT department FROM users WHERE username = 'p8temp'`);
    const untouchedUser = await db.get(`SELECT department FROM users WHERE username = 'qualityop'`);
    assert(renamedUser && renamedUser.department === 'P8 Renamed', 'renaming a department should update assigned logins');
    assert(untouchedUser && untouchedUser.department === 'Quality', 'a rename should leave other departments alone');
    const renameActivity = await db.get(
      `SELECT action, detail FROM activity_log WHERE action = 'department.updated' AND entity_id = ?`,
      [tempDepartment.json.id]
    );
    assert(
      renameActivity && /P8 Temp/.test(renameActivity.detail) && /P8 Renamed/.test(renameActivity.detail),
      'a department rename should be logged in the same change'
    );

    const customerLogin = await login('phase8cust', 'CustomerPass1');
    assert(customerLogin.user.department == null, 'a customer login should not carry a department');
    const customerBoard = await request({ method: 'GET', path: '/api/admin-board', token: customerLogin.token });
    assert(customerBoard.status === 403, 'a customer should not open the admin board');
    const customerOrders = await request({ method: 'GET', path: '/api/admin-board/work-orders', token: customerLogin.token });
    assert(customerOrders.status === 403, 'a customer should not list board work orders');
    const customerScan = await request({
      method: 'POST',
      path: '/api/barcode',
      token: customerLogin.token,
      json: { scanned_value: 'P8-QUAL', location: 'Quality' },
    });
    assert(customerScan.status === 403, 'a customer should not scan');
    const ownOrders = await request({ method: 'GET', path: '/api/workorders', token: customerLogin.token });
    assert(ownOrders.status === 200 && Array.isArray(ownOrders.json), ownOrders.text);
    const ownIds = ownOrders.json.map((row) => row.external_id);
    assert(ownIds.includes('P8-QUAL'), 'a customer should still see their own work order');
    assert(!ownIds.includes('P8-DISP'), 'a customer should not see another customer work order');
  } finally {
    await db.close();
    await server.stop();
  }

  console.log('Phase 8 checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
