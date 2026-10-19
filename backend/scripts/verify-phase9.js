/**
 * Phase 9 checks: renaming a department updates live name references in one
 * transaction, leaves history and custom scan locations alone, keeps a
 * restricted operator's board and scan on the new name, rejects a case-only
 * name collision, and does not let a non-JSON activity detail break the board.
 * Usage (from backend/): node scripts/verify-phase9.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase9-'));
const freshDb = path.join(tmp, 'fresh.db');
const collisionDb = path.join(tmp, 'collision.db');
const port = 3121;
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
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  return { run, get, all, close };
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

function departmentBody(name, extra = {}) {
  return {
    name,
    description: extra.description || '',
    color: extra.color || '#335577',
    icon: '',
    sort_order: extra.sort_order == null ? 80 : extra.sort_order,
    is_active: extra.is_active == null ? 1 : extra.is_active,
  };
}

async function createDepartment(token, name) {
  const response = await request({
    method: 'POST',
    path: '/api/departments',
    token,
    json: departmentBody(name),
  });
  assert(response.status === 201 && response.json && response.json.id, `create ${name} failed: ${response.status} ${response.text}`);
  return response.json;
}

async function renameDepartment(token, id, name) {
  return request({
    method: 'PUT',
    path: `/api/departments/${id}`,
    token,
    json: departmentBody(name, { description: 'renamed', sort_order: 81 }),
  });
}

async function nameIndex(db) {
  return db.get(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_departments_name_nocase'`
  );
}

async function checkCaseDuplicateInit() {
  await initDatabase(collisionDb);
  const seeded = openDb(collisionDb);
  await seeded.run('DROP INDEX IF EXISTS idx_departments_name_nocase');
  await seeded.run(
    `INSERT INTO departments (name, description, sort_order, is_active) VALUES ('quality', 'case twin', 90, 1)`
  );
  await seeded.close();

  const again = await initDatabase(collisionDb);
  const second = await initDatabase(collisionDb);
  const logs = `${again.out}\n${again.err}\n${second.out}\n${second.err}`;
  assert(/case-insensitive unique index/i.test(logs), `init should warn and continue when case-only department names exist:\n${logs}`);
  const check = openDb(collisionDb);
  const index = await nameIndex(check);
  const twins = await check.all(`SELECT name FROM departments WHERE lower(name) = 'quality' ORDER BY name`);
  await check.close();
  assert(!index, 'init should leave the case-insensitive index off when duplicates already exist');
  assert(twins.length === 2, `both case variants should remain, found ${twins.map((row) => row.name).join(', ')}`);
}

async function main() {
  await checkCaseDuplicateInit();

  await initDatabase(freshDb);
  await initDatabase(freshDb);
  const before = openDb(freshDb);
  const index = await nameIndex(before);
  assert(index && /NOCASE/i.test(index.sql || ''), `a fresh database should index department names without case: ${index && index.sql}`);
  const qualityRoute = await before.get(`SELECT next_department FROM departments WHERE name = 'Large Format'`);
  assert(qualityRoute && qualityRoute.next_department === 'Quality', 'Large Format should still route to Quality before a rename');
  await before.close();

  const server = startServer(freshDb);
  await server.ready;
  const db = openDb(freshDb);
  try {
    const admin = await login('admin', adminPassword);

    const lowerQuality = await request({
      method: 'POST',
      path: '/api/departments',
      token: admin.token,
      json: departmentBody('quality'),
    });
    assert(lowerQuality.status === 409, `creating quality beside Quality should be 409: ${lowerQuality.status} ${lowerQuality.text}`);
    assert(/already exists/i.test(lowerQuality.text), lowerQuality.text);
    const upperQuality = await request({
      method: 'POST',
      path: '/api/departments',
      token: admin.token,
      json: departmentBody('QUALITY'),
    });
    assert(upperQuality.status === 409, `creating QUALITY should be 409: ${upperQuality.status} ${upperQuality.text}`);

    const bindery = await createDepartment(admin.token, 'P9 Bindery');
    const spare = await createDepartment(admin.token, 'P9 Spare');
    const caps = await createDepartment(admin.token, 'P9 Caps');
    const alpha = await createDepartment(admin.token, 'P9 Alpha');

    const operator = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'p9op',
        display_name: 'Bindery Operator',
        role: 'operator',
        department: 'P9 Bindery',
        password: 'OperatorPass123',
        is_active: true,
      },
    });
    assert(operator.status === 201 && operator.json.department === 'P9 Bindery', `operator create failed: ${operator.text}`);
    const operatorLogin = await login('p9op', 'OperatorPass123');

    await db.run(
      `INSERT INTO users (username, password_hash, role, display_name, department, is_active)
       VALUES ('p9caseuser', 'x', 'operator', 'Case User', 'p9 bindery', 1)`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department, next_department)
       VALUES ('P9-KEEP', 'visible job', 1, 'open', 'P9 Bindery', 'Quality')`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department, next_department)
       VALUES ('P9-NEXT', 'route only', 1, 'open', 'Dispatch', 'P9 Bindery')`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department, next_department)
       VALUES ('P9-BOTH', 'both columns', 1, 'open', 'P9 Bindery', 'P9 Bindery')`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department, next_department)
       VALUES ('P9-DONE', 'finished job', 1, 'completed', 'P9 Bindery', 'Complete')`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department, next_department)
       VALUES ('P9-CASE', 'other case', 1, 'open', 'p9 bindery', 'p9 bindery')`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department, next_department)
       VALUES ('P9-MOVE', 'scan me', 1, 'open', 'Large Format', 'Quality')`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department, next_department)
       VALUES ('P9-OTHER', 'quality job', 1, 'open', 'Quality', 'Dispatch')`
    );
    const keep = await db.get(`SELECT id FROM work_orders WHERE external_id = 'P9-KEEP'`);
    const other = await db.get(`SELECT id FROM work_orders WHERE external_id = 'P9-OTHER'`);
    await db.run(
      `INSERT INTO production_history (work_order_id, department, status, notes)
       VALUES (?, 'P9 Bindery', 'open', 'historical bindery step')`,
      [keep.id]
    );
    await db.run(
      `INSERT INTO barcode_events (scanned_value, work_order_id, location, from_department, to_department)
       VALUES ('P9-HIST', ?, 'P9 Bindery', 'Large Format', 'P9 Bindery')`,
      [keep.id]
    );
    await db.run(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, detail)
       VALUES (?, 'work_order.moved', 'work_order', ?, ?)`,
      [admin.user.id, keep.id, JSON.stringify({
        external_id: 'P9-KEEP',
        to_department: 'P9 Bindery',
        message: 'Moved to P9 Bindery',
      })]
    );
    await db.run(
      `INSERT INTO notifications (type, title, body, dedupe_key)
       VALUES ('work_order_on_hold', 'Hold', 'P9 Bindery is waiting', 'p9-bindery-hold')`
    );
    await db.run(
      `INSERT INTO barcode_locations (location, department_name, stage_name, sort_order, is_active, updated_at)
       VALUES ('P9 Bindery', 'P9 Bindery', NULL, 80, 1, datetime('now'))`
    );
    await db.run(
      `INSERT INTO barcode_locations (location, department_name, stage_name, sort_order, is_active, updated_at)
       VALUES ('Pack Bench', 'P9 Bindery', 'Finishing', 81, 1, datetime('now'))`
    );
    await db.run(
      `INSERT INTO barcode_locations (location, department_name, stage_name, sort_order, is_active, updated_at)
       VALUES ('p9 bindery', 'Dispatch', NULL, 82, 1, datetime('now'))`
    );
    await db.run(
      `INSERT INTO services (name, description, department_name, sort_order, is_active, code, suffix_mode)
       VALUES ('P9 Bindery Service', 'test', 'P9 Bindery', 90, 1, 'P9B', 'sequence')`
    );
    await db.run(
      `INSERT INTO services (name, description, department_name, sort_order, is_active, code, suffix_mode)
       VALUES ('P9 Case Service', 'test', 'p9 bindery', 91, 1, 'P9C', 'sequence')`
    );
    await db.run(
      `INSERT INTO departments (name, description, sort_order, is_active, next_department)
       VALUES ('P9 Upstream', 'points at bindery', 92, 1, 'P9 Bindery')`
    );
    await db.run(
      `INSERT INTO departments (name, description, sort_order, is_active, next_department)
       VALUES ('P9 Case Route', 'points at other case', 93, 1, 'p9 bindery')`
    );

    const historyBefore = await db.get(
      `SELECT department, notes FROM production_history WHERE notes = 'historical bindery step'`
    );
    const eventBefore = await db.get(
      `SELECT location, from_department, to_department FROM barcode_events WHERE scanned_value = 'P9-HIST'`
    );
    const oldActivityBefore = await db.get(
      `SELECT detail FROM activity_log WHERE action = 'work_order.moved' AND entity_id = ?`,
      [keep.id]
    );
    const noticeBefore = await db.get(`SELECT body FROM notifications WHERE dedupe_key = 'p9-bindery-hold'`);

    const renamed = await renameDepartment(admin.token, bindery.id, 'P9 Bindery West');
    assert(renamed.status === 200 && renamed.json.name === 'P9 Bindery West', `rename failed: ${renamed.status} ${renamed.text}`);

    const operatorRow = await db.get(`SELECT department FROM users WHERE username = 'p9op'`);
    const caseUser = await db.get(`SELECT department FROM users WHERE username = 'p9caseuser'`);
    assert(operatorRow && operatorRow.department === 'P9 Bindery West', 'the operator login should follow the rename');
    assert(caseUser && caseUser.department === 'p9 bindery', 'a different casing should not be rewritten');

    async function workOrder(externalId) {
      return db.get(
        `SELECT department, next_department FROM work_orders WHERE external_id = ?`,
        [externalId]
      );
    }
    const kept = await workOrder('P9-KEEP');
    const nextOnly = await workOrder('P9-NEXT');
    const both = await workOrder('P9-BOTH');
    const done = await workOrder('P9-DONE');
    const caseOrder = await workOrder('P9-CASE');
    const moveBefore = await workOrder('P9-MOVE');
    const otherOrder = await workOrder('P9-OTHER');
    assert(kept.department === 'P9 Bindery West' && kept.next_department === 'Quality', 'the current department should move and the next route stay');
    assert(nextOnly.department === 'Dispatch' && nextOnly.next_department === 'P9 Bindery West', 'a work order routed here should follow');
    assert(both.department === 'P9 Bindery West' && both.next_department === 'P9 Bindery West', 'both current columns should follow');
    assert(done.department === 'P9 Bindery West' && done.next_department === 'Complete', 'a finished work order still has a current department');
    assert(caseOrder.department === 'p9 bindery' && caseOrder.next_department === 'p9 bindery', 'a case-different work order should stay');
    assert(moveBefore.department === 'Large Format' && moveBefore.next_department === 'Quality', 'an unrelated work order should stay');
    assert(otherOrder.department === 'Quality' && otherOrder.next_department === 'Dispatch', 'Quality should stay Quality');

    const namedLocation = await db.get(
      `SELECT location, department_name FROM barcode_locations WHERE location = 'P9 Bindery West'`
    );
    const customLocation = await db.get(
      `SELECT location, department_name FROM barcode_locations WHERE location = 'Pack Bench'`
    );
    const caseLocation = await db.get(
      `SELECT location, department_name FROM barcode_locations WHERE location = 'p9 bindery'`
    );
    const qualityLocation = await db.get(
      `SELECT location, department_name FROM barcode_locations WHERE location = 'Quality'`
    );
    assert(namedLocation && namedLocation.department_name === 'P9 Bindery West', 'a location named for the department should be renamed');
    assert(!await db.get(`SELECT id FROM barcode_locations WHERE location = 'P9 Bindery'`), 'the old location name should be gone');
    assert(customLocation && customLocation.department_name === 'P9 Bindery West', 'a custom location should keep its name and follow the department');
    assert(caseLocation && caseLocation.department_name === 'Dispatch', 'a case-different location should stay');
    assert(qualityLocation && qualityLocation.department_name === 'Quality', 'Quality scan location should stay');

    const binderyService = await db.get(`SELECT department_name FROM services WHERE name = 'P9 Bindery Service'`);
    const caseService = await db.get(`SELECT department_name FROM services WHERE name = 'P9 Case Service'`);
    const largeService = await db.get(`SELECT department_name FROM services WHERE name = 'Large Format'`);
    assert(binderyService && binderyService.department_name === 'P9 Bindery West', 'the service default department should follow');
    assert(caseService && caseService.department_name === 'p9 bindery', 'a case-different service department should stay');
    assert(largeService && largeService.department_name === 'Large Format', 'Large Format service should stay');

    const upstream = await db.get(`SELECT next_department, updated_at FROM departments WHERE name = 'P9 Upstream'`);
    const caseRoute = await db.get(`SELECT next_department FROM departments WHERE name = 'P9 Case Route'`);
    const largeRoute = await db.get(`SELECT next_department FROM departments WHERE name = 'Large Format'`);
    assert(upstream && upstream.next_department === 'P9 Bindery West' && upstream.updated_at, 'the shop route should follow and be marked updated');
    assert(caseRoute && caseRoute.next_department === 'p9 bindery', 'a case-different route target should stay');
    assert(largeRoute && largeRoute.next_department === 'Quality', 'Large Format should still route to Quality');

    const historyAfter = await db.get(
      `SELECT department, notes FROM production_history WHERE notes = 'historical bindery step'`
    );
    const eventAfter = await db.get(
      `SELECT location, from_department, to_department FROM barcode_events WHERE scanned_value = 'P9-HIST'`
    );
    const oldActivityAfter = await db.get(
      `SELECT detail FROM activity_log WHERE action = 'work_order.moved' AND entity_id = ?`,
      [keep.id]
    );
    const noticeAfter = await db.get(`SELECT body FROM notifications WHERE dedupe_key = 'p9-bindery-hold'`);
    assert(historyAfter.department === historyBefore.department && historyAfter.notes === historyBefore.notes, 'production history should stay as written');
    assert(
      eventAfter.location === eventBefore.location
        && eventAfter.from_department === eventBefore.from_department
        && eventAfter.to_department === eventBefore.to_department,
      'barcode event from/to/location should stay as written'
    );
    assert(oldActivityAfter.detail === oldActivityBefore.detail, 'an older activity detail should stay as written');
    assert(noticeAfter.body === noticeBefore.body, 'notification text should stay as written');

    const renameRows = await db.all(
      `SELECT detail FROM activity_log WHERE action = 'department.updated' AND entity_id = ?`,
      [bindery.id]
    );
    assert(renameRows.length === 1, `a rename should write one activity row, found ${renameRows.length}`);
    const renameDetail = JSON.parse(renameRows[0].detail);
    assert(renameDetail.previous_name === 'P9 Bindery' && renameDetail.name === 'P9 Bindery West', 'the activity should name both departments');
    assert(renameDetail.users_updated === 1 && renameDetail.changes && renameDetail.changes.users === 1, `user count ${JSON.stringify(renameDetail.changes)}`);
    assert(renameDetail.changes.work_orders === 4, `work order count ${renameDetail.changes.work_orders}`);
    assert(renameDetail.changes.barcode_locations === 2, `location count ${renameDetail.changes.barcode_locations}`);
    assert(renameDetail.changes.services === 1, `service count ${renameDetail.changes.services}`);
    assert(renameDetail.changes.departments === 1, `route count ${renameDetail.changes.departments}`);

    const sameName = await request({
      method: 'PUT',
      path: `/api/departments/${bindery.id}`,
      token: admin.token,
      json: departmentBody('P9 Bindery West', { description: 'still west', sort_order: 81 }),
    });
    assert(sameName.status === 200 && sameName.json.description === 'still west', `same-name save failed: ${sameName.text}`);
    const renameRowsAfterEdit = await db.get(
      `SELECT COUNT(*) AS count FROM activity_log WHERE action = 'department.updated' AND entity_id = ?`,
      [bindery.id]
    );
    assert(renameRowsAfterEdit.count === 1, 'saving a department without renaming it should not write another rename row');

    const board = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&department=Dispatch&scope=all&q=P9-',
      token: operatorLogin.token,
    });
    assert(board.status === 200, board.text);
    assert(board.json.viewer && board.json.viewer.restricted === true, 'the operator should stay restricted');
    assert(board.json.viewer.department === 'P9 Bindery West', `the board should use the renamed department: ${JSON.stringify(board.json.viewer)}`);
    const boardIds = (board.json.work_orders || []).map((row) => row.external_id);
    assert(boardIds.includes('P9-KEEP') && boardIds.includes('P9-BOTH'), `the operator should still see their orders: ${boardIds.join(',')}`);
    assert(!boardIds.includes('P9-OTHER') && !boardIds.includes('P9-CASE') && !boardIds.includes('P9-MOVE'), `other queues should stay hidden: ${boardIds.join(',')}`);
    assert((board.json.work_orders || []).every((row) => row.department === 'P9 Bindery West'), 'every visible row should be the renamed department');

    const scanned = await request({
      method: 'POST',
      path: '/api/barcode',
      token: operatorLogin.token,
      json: { scanned_value: 'P9-MOVE', location: 'Dispatch' },
    });
    assert(scanned.status === 201, `scan failed: ${scanned.status} ${scanned.text}`);
    assert(
      scanned.json.location === 'P9 Bindery West'
        && scanned.json.to_department === 'P9 Bindery West'
        && scanned.json.department_moved === true,
      `the header scan should move into the renamed department: ${scanned.text}`
    );
    const moved = await workOrder('P9-MOVE');
    assert(moved.department === 'P9 Bindery West', 'the scanned work order should be stored in the renamed department');
    const boardAfterScan = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100&q=P9-MOVE',
      token: operatorLogin.token,
    });
    const afterIds = (boardAfterScan.json.work_orders || []).map((row) => row.external_id);
    assert(afterIds.includes('P9-MOVE'), 'the renamed department board should show the scanned order');

    const spareClash = await renameDepartment(admin.token, spare.id, 'p9 bindery west');
    assert(spareClash.status === 409, `a case-only rename should be 409: ${spareClash.status} ${spareClash.text}`);
    assert(/already exists/i.test(spareClash.text), spareClash.text);
    const spareRow = await db.get(`SELECT name FROM departments WHERE id = ?`, [spare.id]);
    assert(spareRow && spareRow.name === 'P9 Spare', 'a rejected rename should leave the department name');
    const operatorStill = await db.get(`SELECT department FROM users WHERE username = 'p9op'`);
    assert(operatorStill.department === 'P9 Bindery West', 'a rejected rename should not move other logins');

    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department)
       VALUES ('P9-CAPS', 'exact caps', 1, 'open', 'P9 Caps')`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department)
       VALUES ('P9-CAPS-OTHER', 'other caps', 1, 'open', 'P9 CAPS')`
    );
    const capsRename = await renameDepartment(admin.token, caps.id, 'p9 caps');
    assert(capsRename.status === 200 && capsRename.json.name === 'p9 caps', `same-row case rename failed: ${capsRename.text}`);
    const capsOrder = await workOrder('P9-CAPS');
    const capsOther = await workOrder('P9-CAPS-OTHER');
    assert(capsOrder.department === 'p9 caps', 'the exact old name should follow a case-only rename of the same department');
    assert(capsOther.department === 'P9 CAPS', 'a third casing should stay put');

    await db.run(
      `INSERT INTO users (username, password_hash, role, display_name, department, is_active)
       VALUES ('p9alpha', 'x', 'operator', 'Alpha User', 'P9 Alpha', 1)`
    );
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department, next_department)
       VALUES ('P9-ALPHA', 'rollback job', 1, 'open', 'P9 Alpha', 'P9 Alpha')`
    );
    await db.run(
      `INSERT INTO barcode_locations (location, department_name, sort_order, is_active, updated_at)
       VALUES ('P9 Alpha', 'P9 Alpha', 94, 1, datetime('now'))`
    );
    await db.run(
      `INSERT INTO barcode_locations (location, department_name, sort_order, is_active, updated_at)
       VALUES ('P9 Taken', 'Dispatch', 95, 1, datetime('now'))`
    );
    await db.run(
      `INSERT INTO services (name, description, department_name, sort_order, is_active, code, suffix_mode)
       VALUES ('P9 Alpha Service', 'test', 'P9 Alpha', 96, 1, 'P9A', 'sequence')`
    );
    await db.run(
      `UPDATE departments SET next_department = 'P9 Alpha' WHERE name = 'P9 Spare'`
    );
    const blocked = await renameDepartment(admin.token, alpha.id, 'P9 Taken');
    assert(blocked.status === 409, `a taken scan location should be 409: ${blocked.status} ${blocked.text}`);
    assert(/scan location/i.test(blocked.text), blocked.text);
    const alphaRow = await db.get(`SELECT name FROM departments WHERE id = ?`, [alpha.id]);
    const alphaUser = await db.get(`SELECT department FROM users WHERE username = 'p9alpha'`);
    const alphaOrder = await workOrder('P9-ALPHA');
    const alphaLocation = await db.get(
      `SELECT location, department_name FROM barcode_locations WHERE department_name = 'P9 Alpha' OR location = 'P9 Alpha'`
    );
    const alphaService = await db.get(`SELECT department_name FROM services WHERE name = 'P9 Alpha Service'`);
    const spareRoute = await db.get(`SELECT next_department FROM departments WHERE id = ?`, [spare.id]);
    const alphaActivity = await db.get(
      `SELECT COUNT(*) AS count FROM activity_log WHERE action = 'department.updated' AND entity_id = ?`,
      [alpha.id]
    );
    assert(alphaRow && alphaRow.name === 'P9 Alpha', 'the department rename should roll back');
    assert(alphaUser && alphaUser.department === 'P9 Alpha', 'the user update should roll back with the rename');
    assert(alphaOrder.department === 'P9 Alpha' && alphaOrder.next_department === 'P9 Alpha', 'the work order update should roll back');
    assert(alphaLocation && alphaLocation.location === 'P9 Alpha' && alphaLocation.department_name === 'P9 Alpha', 'the location update should roll back');
    assert(alphaService && alphaService.department_name === 'P9 Alpha', 'the service update should roll back');
    assert(spareRoute && spareRoute.next_department === 'P9 Alpha', 'the route update should roll back');
    assert(alphaActivity.count === 0, 'a rolled-back rename should not leave an activity row');

    await db.run(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, detail)
       VALUES (?, 'work_order.moved', 'work_order', ?, 'moved by hand')`,
      [admin.user.id, keep.id]
    );
    await db.run(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, detail)
       VALUES (?, 'work_order.moved', 'work_order', ?, '{')`,
      [admin.user.id, other.id]
    );
    const restrictedBoard = await request({
      method: 'GET',
      path: '/api/admin-board',
      token: operatorLogin.token,
    });
    assert(restrictedBoard.status === 200, `non-JSON activity detail should not break the board: ${restrictedBoard.status} ${restrictedBoard.text}`);
    assert(/moved by hand/.test(restrictedBoard.text), 'the plain-text activity row should still be readable');
    const restrictedActivity = await request({
      method: 'GET',
      path: '/api/admin-board/activity?limit=100',
      token: operatorLogin.token,
    });
    assert(restrictedActivity.status === 200, `non-JSON activity detail should not break the activity list: ${restrictedActivity.status} ${restrictedActivity.text}`);
    assert(/moved by hand/.test(restrictedActivity.text), 'the activity list should include the plain-text row');
    const summaries = (restrictedActivity.json.activity || []).map((row) => row.summary || '');
    assert(!summaries.some((summary) => summary === '{'), 'a malformed row for another department should stay out of the restricted list');
  } finally {
    await db.close();
    await server.stop();
  }

  console.log('Phase 9 checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
