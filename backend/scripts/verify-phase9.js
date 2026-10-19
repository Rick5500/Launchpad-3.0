/**
 * Phase 9 checks: renaming a department updates live name references in one
 * transaction, leaves history and custom scan locations alone, keeps a
 * restricted operator's board and scan on the new name, rejects a case-only
 * name collision, and does not let a non-JSON activity detail break the board.
 * Init records seeded department names so a renamed default is not recreated.
 * Quality, Dispatch, and Complete cannot be renamed. Work orders follow a
 * case-insensitive trimmed match and store the canonical department name.
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
const seedDb = path.join(tmp, 'seed.db');
const SEEDED_DEPARTMENTS = [
  'Large Format',
  'Small Format',
  'Signs & Graphics',
  'Scanning',
  'Planroom',
  'Archive File',
  'Quality',
  'Dispatch',
  'Delivery',
  'Complete',
  'Reprographics',
  'Admin',
];
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

function checkNoticeQueue({
  NOTICE_SEVERE_CAP,
  NOTICE_ALONE_MS,
  NOTICE_QUEUED_MS,
  reduceNotice,
  advanceNotice,
}) {
  let current = null;
  for (let i = 1; i <= 8; i += 1) {
    current = reduceNotice(current, { id: i, severity: 'success', message: `ok ${i}` });
  }
  assert(current && current.message === 'ok 1', 'the first success stays on screen');
  assert(
    current.queue.length === 1 && current.queue[0].message === 'ok 8',
    `pending successes should collapse to the latest, got ${JSON.stringify(current.queue)}`
  );

  current = null;
  for (let i = 1; i <= 8; i += 1) {
    current = reduceNotice(current, { id: i, severity: 'error', message: `e${i}` });
  }
  assert(current && current.message === 'e1', 'the first error stays on screen');
  assert(current.queue.length === NOTICE_SEVERE_CAP, `pending errors should cap at ${NOTICE_SEVERE_CAP}`);
  assert(
    current.queue.map((item) => item.message).join(',') === 'e4,e5,e6,e7,e8',
    `the oldest pending errors should drop, got ${current.queue.map((item) => item.message).join(',')}`
  );

  current = reduceNotice(null, { id: 1, severity: 'warning', message: 'warn' }, 0);
  current = reduceNotice(current, { id: 2, severity: 'success', message: 'ok early' }, 10);
  current = reduceNotice(current, { id: 3, severity: 'error', message: 'bad' }, 20);
  assert(current.severity === 'error' && current.message === 'bad', 'a more severe result should take the screen');
  assert(
    current.queue.map((item) => item.message).join(',') === 'ok early',
    `a notice already on screen should not be queued again, got ${JSON.stringify(current.queue)}`
  );
  current = reduceNotice(current, { id: 4, severity: 'success', message: 'ok later' }, 30);
  assert(
    current.queue.map((item) => item.message).join(',') === 'ok later',
    `a later success should replace the pending success, got ${JSON.stringify(current.queue)}`
  );

  const severities = ['warning', 'success', 'error'];
  const events = [];
  for (let i = 0; i < 20; i += 1) {
    events.push({
      id: i + 1,
      time: i * 1500,
      severity: severities[i % severities.length],
      message: `scan ${i + 1}`,
    });
  }
  let state = null;
  const shown = new Map();
  let lastShownAt = null;
  function countVisible(item, time) {
    shown.set(item.message, (shown.get(item.message) || 0) + 1);
    lastShownAt = time;
  }
  function drain(until) {
    while (state) {
      const due = state.shownAt + (state.queue && state.queue.length ? NOTICE_QUEUED_MS : NOTICE_ALONE_MS);
      if (due > until) break;
      state = advanceNotice(state, state.id, due);
      if (state) countVisible(state, due);
    }
  }
  for (const event of events) {
    drain(event.time);
    const previousId = state && state.id;
    state = reduceNotice(state, event, event.time);
    if (state && state.id !== previousId) countVisible(state, event.time);
  }
  const lastScan = events[events.length - 1].time;
  drain(lastScan + 60000);
  for (const [message, count] of shown) {
    assert(count === 1, `${message} was shown ${count} times`);
  }
  assert(shown.size > 0, 'the scan mix should show a notice');
  assert(
    lastShownAt != null && lastShownAt - lastScan <= 5000,
    `the last notice should be within 5s of the last scan (${lastShownAt} vs ${lastScan})`
  );
}

async function departmentNames(db) {
  const rows = await db.all('SELECT name FROM departments ORDER BY name');
  return rows.map((row) => row.name);
}

async function checkDepartmentSeed() {
  await initDatabase(seedDb);
  const seeded = openDb(seedDb);
  const planroom = await seeded.get(`SELECT id FROM departments WHERE name = 'Planroom'`);
  assert(planroom, 'a fresh database should seed Planroom');
  await seeded.run(
    `UPDATE departments SET name = 'File Room', updated_at = datetime('now') WHERE id = ?`,
    [planroom.id]
  );
  await seeded.close();

  await initDatabase(seedDb);
  await initDatabase(seedDb);
  const renamed = openDb(seedDb);
  let names = await departmentNames(renamed);
  assert(names.includes('File Room'), 'the renamed department should stay after init');
  assert(!names.includes('Planroom'), `init should not recreate Planroom: ${names.join(', ')}`);
  assert(names.filter((name) => name === 'File Room').length === 1, 'a second init should not duplicate File Room');

  await renamed.run(`DELETE FROM system_settings WHERE key = 'departments_seeded'`);
  await renamed.close();
  await initDatabase(seedDb);
  await initDatabase(seedDb);
  const upgraded = openDb(seedDb);
  names = await departmentNames(upgraded);
  assert(!names.includes('Planroom'), 'an older database should not recreate a renamed department');
  assert(names.includes('File Room'), 'the renamed department should survive the upgrade');
  const flag = await upgraded.get(`SELECT value FROM system_settings WHERE key = 'departments_seeded'`);
  assert(flag && flag.value, 'upgrade should record departments_seeded');
  const tracked = JSON.parse(flag.value);
  for (const name of SEEDED_DEPARTMENTS) {
    assert(tracked.includes(name), `departments_seeded should record ${name}`);
  }

  const withoutAdmin = tracked.filter((name) => name !== 'Admin');
  await upgraded.run(
    `UPDATE system_settings SET value = ? WHERE key = 'departments_seeded'`,
    [JSON.stringify(withoutAdmin)]
  );
  await upgraded.run(`DELETE FROM departments WHERE name = 'Admin'`);
  await upgraded.close();
  await initDatabase(seedDb);
  const added = openDb(seedDb);
  const admin = await added.get(`SELECT name FROM departments WHERE name = 'Admin'`);
  assert(admin, 'a default that was never recorded should be inserted once');
  await added.run(`DELETE FROM departments WHERE name = 'Quality'`);
  const beforeSecond = await added.get('SELECT COUNT(*) AS count FROM departments');
  await added.close();
  await initDatabase(seedDb);
  await initDatabase(seedDb);
  const kept = openDb(seedDb);
  const quality = await kept.get(`SELECT id FROM departments WHERE name = 'Quality'`);
  const afterSecond = await kept.get('SELECT COUNT(*) AS count FROM departments');
  await kept.close();
  assert(!quality, 'a recorded seed name that was removed should not be inserted again');
  assert(afterSecond.count === beforeSecond.count, 'init should stay idempotent after the upgrade');
}

async function checkShowOnBoardUpgrade() {
  const boardDb = path.join(tmp, 'board.db');
  await initDatabase(boardDb);
  const seeded = openDb(boardDb);
  const repro = await seeded.get(`SELECT show_on_board FROM departments WHERE name = 'Reprographics'`);
  const adminRow = await seeded.get(`SELECT show_on_board FROM departments WHERE name = 'Admin'`);
  const large = await seeded.get(`SELECT show_on_board FROM departments WHERE name = 'Large Format'`);
  assert(repro && repro.show_on_board === 0 && adminRow && adminRow.show_on_board === 0, 'a fresh database should hide Reprographics and Admin');
  assert(large && large.show_on_board === 1, 'a fresh database should show Large Format');
  await seeded.run('ALTER TABLE departments DROP COLUMN show_on_board');
  await seeded.close();

  await initDatabase(boardDb);
  const upgraded = openDb(boardDb);
  const reproUp = await upgraded.get(`SELECT show_on_board FROM departments WHERE name = 'Reprographics'`);
  const adminUp = await upgraded.get(`SELECT show_on_board FROM departments WHERE name = 'Admin'`);
  const largeUp = await upgraded.get(`SELECT show_on_board FROM departments WHERE name = 'Large Format'`);
  assert(reproUp && reproUp.show_on_board === 0 && adminUp && adminUp.show_on_board === 0, 'an upgraded database should hide Reprographics and Admin');
  assert(largeUp && largeUp.show_on_board === 1, 'an upgraded database should keep Large Format on the board');
  await upgraded.run(`UPDATE departments SET show_on_board = 1 WHERE name = 'Reprographics'`);
  await upgraded.close();
  await initDatabase(boardDb);
  const toggled = openDb(boardDb);
  const reproKept = await toggled.get(`SELECT show_on_board FROM departments WHERE name = 'Reprographics'`);
  assert(reproKept && reproKept.show_on_board === 1, 'a later init should leave the board toggle alone');

  await toggled.run(`UPDATE departments SET name = 'reprographics' WHERE name = 'Reprographics'`);
  const flag = JSON.parse((await toggled.get(`SELECT value FROM system_settings WHERE key = 'departments_seeded'`)).value);
  await toggled.run(
    `UPDATE system_settings SET value = ? WHERE key = 'departments_seeded'`,
    [JSON.stringify(flag.filter((name) => name !== 'Reprographics'))]
  );
  await toggled.close();
  await initDatabase(boardDb);
  const cased = openDb(boardDb);
  const rows = await cased.all(`SELECT name FROM departments WHERE lower(name) = 'reprographics' ORDER BY name`);
  await cased.close();
  assert(rows.length === 1 && rows[0].name === 'reprographics', `a case-only existing department should not be seeded again: ${rows.map((row) => row.name).join(', ')}`);
}

async function main() {
  const notice = await import('../../frontend/src/components/headerScanNotice.mjs');
  checkNoticeQueue(notice);
  await checkDepartmentSeed();
  await checkShowOnBoardUpgrade();
  await checkCaseDuplicateInit();

  await initDatabase(freshDb);
  await initDatabase(freshDb);
  const before = openDb(freshDb);
  const index = await nameIndex(before);
  assert(index && /NOCASE/i.test(index.sql || ''), `a fresh database should index department names without case: ${index && index.sql}`);
  const qualityRoute = await before.get(`SELECT next_department FROM departments WHERE name = 'Large Format'`);
  assert(qualityRoute && qualityRoute.next_department === 'Quality', 'Large Format should still route to Quality before a rename');
  const seededNames = await departmentNames(before);
  for (const name of SEEDED_DEPARTMENTS) {
    assert(seededNames.includes(name), `a fresh database should seed ${name}`);
  }
  assert(
    seededNames.length === SEEDED_DEPARTMENTS.length,
    `a fresh database should seed each default once, found ${seededNames.join(', ')}`
  );
  const seedFlag = await before.get(`SELECT value FROM system_settings WHERE key = 'departments_seeded'`);
  const seedTracked = JSON.parse(seedFlag.value);
  for (const name of SEEDED_DEPARTMENTS) {
    assert(seedTracked.includes(name), `a fresh database should record seeded ${name}`);
  }
  await before.close();

  const server = startServer(freshDb);
  await server.ready;
  const db = openDb(freshDb);
  try {
    const admin = await login('admin', adminPassword);

    const openingBoard = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    assert(openingBoard.status === 200, openingBoard.text);
    const openingTabs = (openingBoard.json.tabs || []).map((tab) => tab.key);
    assert(openingTabs.includes('Large Format') && openingTabs.includes('Delivery'), `the old board departments should stay: ${openingTabs.join(', ')}`);
    assert(!openingTabs.includes('Reprographics') && !openingTabs.includes('Admin'), `empty off-board departments should stay hidden: ${openingTabs.join(', ')}`);
    assert(openingTabs.includes('Manufacturing') || openingTabs.includes('Assembly'), `legacy departments with work should still appear: ${openingTabs.join(', ')}`);
    const openingEmpty = ((openingBoard.json.alerts || []).find((alert) => alert.id === 'empty-queues') || {}).departments || [];
    assert(!openingEmpty.includes('Reprographics') && !openingEmpty.includes('Admin'), `the empty-queue alert should match the old board: ${openingEmpty.join(', ')}`);
    assert(!/Reprographics/.test((openingBoard.json.alerts || []).map((alert) => alert.detail || '').join(' ')), 'the empty-queue text should not name Reprographics');

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
    assert(Number(bindery.show_on_board) === 1, 'a new department should show on the board unless told otherwise');
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
       VALUES ('P9-SPACE', 'padded name', 1, 'open', '  P9 Bindery  ', '  P9 Bindery  ')`
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
    const spacedOrder = await workOrder('P9-SPACE');
    const moveBefore = await workOrder('P9-MOVE');
    const otherOrder = await workOrder('P9-OTHER');
    assert(kept.department === 'P9 Bindery West' && kept.next_department === 'Quality', 'the current department should move and the next route stay');
    assert(nextOnly.department === 'Dispatch' && nextOnly.next_department === 'P9 Bindery West', 'a work order routed here should follow');
    assert(both.department === 'P9 Bindery West' && both.next_department === 'P9 Bindery West', 'both current columns should follow');
    assert(done.department === 'P9 Bindery West' && done.next_department === 'Complete', 'a finished work order still has a current department');
    assert(caseOrder.department === 'P9 Bindery West' && caseOrder.next_department === 'P9 Bindery West', 'a case-different work order should follow');
    assert(spacedOrder.department === 'P9 Bindery West' && spacedOrder.next_department === 'P9 Bindery West', 'a padded work order department should follow');
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
    assert(renameDetail.changes.work_orders === 6, `work order count ${renameDetail.changes.work_orders}`);
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
    assert(
      boardIds.includes('P9-KEEP') && boardIds.includes('P9-BOTH') && boardIds.includes('P9-CASE') && boardIds.includes('P9-SPACE'),
      `the operator should still see their orders: ${boardIds.join(',')}`
    );
    assert(!boardIds.includes('P9-OTHER') && !boardIds.includes('P9-MOVE'), `other queues should stay hidden: ${boardIds.join(',')}`);
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
    assert(capsOther.department === 'p9 caps', 'a stray-cased work order should follow a case-only rename');

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

    for (const systemName of ['Quality', 'Dispatch', 'Complete']) {
      const systemRow = await db.get(`SELECT id, name FROM departments WHERE name = ?`, [systemName]);
      const blockedName = systemName === 'Quality' ? 'QA Review' : `${systemName} Desk`;
      const blockedRename = await renameDepartment(admin.token, systemRow.id, blockedName);
      assert(blockedRename.status === 400, `${systemName} rename should be 400: ${blockedRename.status} ${blockedRename.text}`);
      assert(/system department/i.test(blockedRename.text), blockedRename.text);
      const stillNamed = await db.get(`SELECT name FROM departments WHERE id = ?`, [systemRow.id]);
      assert(stillNamed && stillNamed.name === systemName, `${systemName} should keep its name`);
    }
    const qualityRow = await db.get(`SELECT id FROM departments WHERE name = 'Quality'`);
    const qualityCase = await renameDepartment(admin.token, qualityRow.id, 'quality');
    assert(qualityCase.status === 400, `a case-only Quality rename should be 400: ${qualityCase.status} ${qualityCase.text}`);
    const qualityStill = await db.get(`SELECT name FROM departments WHERE id = ?`, [qualityRow.id]);
    assert(qualityStill && qualityStill.name === 'Quality', 'Quality should stay Quality');

    const spareFilled = await request({
      method: 'PUT',
      path: `/api/departments/${spare.id}`,
      token: admin.token,
      json: {
        name: 'P9 Spare',
        description: 'keep me',
        color: '#abc123',
        icon: 'print',
        sort_order: 44,
        is_active: 1,
      },
    });
    assert(spareFilled.status === 200, spareFilled.text);
    const spareNameOnly = await request({
      method: 'PUT',
      path: `/api/departments/${spare.id}`,
      token: admin.token,
      json: { name: 'P9 Spare' },
    });
    assert(spareNameOnly.status === 200, spareNameOnly.text);
    assert(spareNameOnly.json.description === 'keep me', 'an omitted description should stay');
    assert(spareNameOnly.json.color === '#abc123', 'an omitted color should stay');
    assert(spareNameOnly.json.icon === 'print', 'an omitted icon should stay');
    assert(Number(spareNameOnly.json.sort_order) === 44, 'an omitted sort order should stay');
    assert(Number(spareNameOnly.json.is_active) === 1, 'an omitted active flag should stay');
    assert(Number(spareNameOnly.json.show_on_board) === 1, 'an omitted board flag should stay');
    const spareCleared = await request({
      method: 'PUT',
      path: `/api/departments/${spare.id}`,
      token: admin.token,
      json: { name: 'P9 Spare', description: '', color: '', icon: '' },
    });
    assert(spareCleared.status === 200, spareCleared.text);
    assert(spareCleared.json.description === '' && spareCleared.json.color === '' && spareCleared.json.icon === '', 'an empty string should clear a text field');
    assert(Number(spareCleared.json.sort_order) === 44, 'clearing text should leave sort order alone');

    const customer = await db.get(`SELECT id FROM users WHERE role = 'customer' LIMIT 1`);
    assert(customer && customer.id, 'a seeded customer should exist');
    const canonicalCreate = await request({
      method: 'POST',
      path: '/api/workorders',
      token: admin.token,
      json: {
        customer_id: customer.id,
        description: 'canonical department',
        quantity: 1,
        status: 'open',
        department: '  p9 bindery west  ',
      },
    });
    assert(canonicalCreate.status === 201, canonicalCreate.text);
    assert(canonicalCreate.json.department === 'P9 Bindery West', `create should store the canonical department: ${canonicalCreate.json.department}`);
    const canonicalUpdate = await request({
      method: 'PUT',
      path: `/api/workorders/${canonicalCreate.json.id}`,
      token: admin.token,
      json: {
        customer_id: customer.id,
        description: 'canonical department',
        quantity: 1,
        status: 'open',
        department: 'P9 BINDERY WEST',
      },
    });
    assert(canonicalUpdate.status === 200 && canonicalUpdate.json.department === 'P9 Bindery West', `update should keep the canonical department: ${canonicalUpdate.text}`);
    const unknownDepartment = await request({
      method: 'POST',
      path: '/api/workorders',
      token: admin.token,
      json: {
        customer_id: customer.id,
        description: 'unknown department',
        quantity: 1,
        status: 'open',
        department: '  Manufacturing  ',
      },
    });
    assert(unknownDepartment.status === 201 && unknownDepartment.json.department === 'Manufacturing', `an unknown department should stay trimmed: ${unknownDepartment.text}`);

    const beforeBoard = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    assert(beforeBoard.status === 200, beforeBoard.text);
    const beforeTabs = (beforeBoard.json.tabs || []).map((tab) => tab.key);
    const planroomIndex = beforeTabs.indexOf('Planroom');
    const scanningIndex = beforeTabs.indexOf('Scanning');
    assert(planroomIndex > 0 && planroomIndex === scanningIndex + 1, `Planroom should follow Scanning: ${beforeTabs.join(', ')}`);
    assert((beforeBoard.json.stats.departments || []).some((card) => card.name === 'Planroom'), 'Planroom should keep an entry-queue card');
    const beforeEmpty = ((beforeBoard.json.alerts || []).find((alert) => alert.id === 'empty-queues') || {}).departments || [];
    const planroom = await db.get(`SELECT id FROM departments WHERE name = 'Planroom'`);
    const renamedPlanroom = await request({
      method: 'PUT',
      path: `/api/departments/${planroom.id}`,
      token: admin.token,
      json: { name: 'File Room' },
    });
    assert(renamedPlanroom.status === 200 && renamedPlanroom.json.name === 'File Room', renamedPlanroom.text);
    assert(Number(renamedPlanroom.json.sort_order) === 5, 'a name-only rename should keep the tab position');
    const afterBoard = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    const afterTabs = (afterBoard.json.tabs || []).map((tab) => tab.key);
    assert(afterTabs.indexOf('File Room') === planroomIndex, `File Room should keep Planroom's tab: ${afterTabs.join(', ')}`);
    assert(!afterTabs.includes('Planroom'), 'the old department name should leave the board');
    assert((afterBoard.json.stats.departments || []).some((card) => card.name === 'File Room'), 'the entry-queue card should follow the rename');
    assert(!(afterBoard.json.stats.departments || []).some((card) => card.name === 'Planroom'), 'the old stat card name should be gone');
    const afterEmpty = ((afterBoard.json.alerts || []).find((alert) => alert.id === 'empty-queues') || {}).departments || [];
    if (beforeEmpty.includes('Planroom')) {
      assert(afterEmpty.includes('File Room'), `the empty-queue alert should follow the rename: ${afterEmpty.join(', ')}`);
      assert(!afterEmpty.includes('Planroom'), 'the old name should leave the empty-queue alert');
    }
    const planroomService = await db.get(`SELECT department_name FROM services WHERE name = 'Planroom'`);
    assert(planroomService && planroomService.department_name === 'File Room', 'the Planroom service should follow the rename');

    const reprographics = await db.get(`SELECT id FROM departments WHERE name = 'Reprographics'`);
    const showRepro = await request({
      method: 'PUT',
      path: `/api/departments/${reprographics.id}`,
      token: admin.token,
      json: { name: 'Reprographics', show_on_board: 1 },
    });
    assert(showRepro.status === 200 && Number(showRepro.json.show_on_board) === 1, showRepro.text);
    assert(showRepro.json.description, 'turning the board flag on should leave the description');
    const shownBoard = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    const shownTabs = (shownBoard.json.tabs || []).map((tab) => tab.key);
    const shownEmpty = ((shownBoard.json.alerts || []).find((alert) => alert.id === 'empty-queues') || {}).departments || [];
    assert(shownTabs.includes('Reprographics'), `showing Reprographics should add its tab: ${shownTabs.join(', ')}`);
    assert(shownEmpty.includes('Reprographics'), 'an empty department shown on the board should be in the empty-queue alert');
    const hideRepro = await request({
      method: 'PUT',
      path: `/api/departments/${reprographics.id}`,
      token: admin.token,
      json: { name: 'Reprographics', show_on_board: 0 },
    });
    assert(hideRepro.status === 200 && Number(hideRepro.json.show_on_board) === 0, hideRepro.text);
    await db.run(
      `INSERT INTO work_orders (external_id, description, quantity, status, department)
       VALUES ('P9-REPRO', 'repro job', 1, 'open', 'Reprographics')`
    );
    const workBoard = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    const workTabs = (workBoard.json.tabs || []).map((tab) => tab.key);
    const workEmpty = ((workBoard.json.alerts || []).find((alert) => alert.id === 'empty-queues') || {}).departments || [];
    assert(workTabs.includes('Reprographics'), `a hidden department with work should still appear: ${workTabs.join(', ')}`);
    assert(!workEmpty.includes('Reprographics'), 'a hidden department should stay out of the empty-queue alert');
    assert(!workTabs.includes('Admin'), 'Admin should stay off the board while it has no work');
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
