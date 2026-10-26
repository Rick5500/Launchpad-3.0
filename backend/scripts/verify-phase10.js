/**
 * Phase 10 checks: the manager role, an upgrade-safe role migration,
 * manual work-order moves, and customer isolation.
 * Usage (from backend/): node scripts/verify-phase10.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase10-'));
const checkedDb = path.join(tmp, 'checked.db');
const allowedDb = path.join(tmp, 'allowed.db');
const freshDb = path.join(tmp, 'fresh.db');
const port = 3122;
const adminPassword = 'AdminPass123';

const CHECKED_SCHEMA = `
PRAGMA foreign_keys = OFF;
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('admin', 'operator', 'customer')),
  display_name TEXT,
  badge TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (badge IS NULL OR length(badge) <= 20),
  UNIQUE (display_name, badge)
);
CREATE INDEX idx_users_badge ON users(badge);
CREATE TABLE user_pins (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id)
);
CREATE TABLE user_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT
);
CREATE TRIGGER users_audit
AFTER INSERT ON users
BEGIN
  INSERT INTO user_audit (user_id, action) VALUES (NEW.id, 'insert');
END;
`;

const ALREADY_ALLOWS_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'operator', 'customer')),
  display_name TEXT,
  kept TEXT
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

function staffBody(extra) {
  return {
    display_name: 'Phase Ten',
    is_active: true,
    ...extra,
  };
}

async function insertBlockedManager(db) {
  try {
    await db.run(
      `INSERT INTO users (username, password_hash, role, display_name) VALUES ('blockedmgr', 'x', 'manager', 'Blocked')`
    );
    return null;
  } catch (err) {
    return err;
  }
}

async function workOrderState(db, externalId) {
  return db.get(
    `SELECT wo.id, wo.department, wo.next_department, wo.status, wo.assigned_department_id, ps.name AS stage_name
     FROM work_orders wo
     LEFT JOIN production_stages ps ON ps.id = wo.stage_id
     WHERE wo.external_id = ?`,
    [externalId]
  );
}

async function main() {
  const checked = openDb(checkedDb);
  await checked.exec(CHECKED_SCHEMA);
  await checked.run(
    `INSERT INTO users (username, password_hash, role, display_name, badge) VALUES ('legacyop', 'x', 'operator', 'Legacy Op', 'gold')`
  );
  await checked.run(
    `INSERT INTO users (username, password_hash, role, display_name, badge) VALUES ('legacycust', 'x', 'customer', 'Legacy Customer', 'blue')`
  );
  const legacyOp = await checked.get(`SELECT id FROM users WHERE username = 'legacyop'`);
  await checked.run(`INSERT INTO user_pins (id, user_id) VALUES (1, ?)`, [legacyOp.id]);
  const blocked = await insertBlockedManager(checked);
  assert(blocked && /CHECK constraint failed/i.test(blocked.message), `a role check should reject manager before init: ${blocked && blocked.message}`);
  await checked.close();

  const firstInit = await initDatabase(checkedDb);
  assert(/Relaxed users\.role/.test(firstInit.out), `init should report the role rebuild:\n${firstInit.out}`);
  const secondInit = await initDatabase(checkedDb);
  assert(!/Relaxed users\.role/.test(secondInit.out), 'a second init should not rebuild users again');

  const upgraded = openDb(checkedDb);
  await upgraded.exec('PRAGMA foreign_keys = ON');
  const tableSql = await upgraded.get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`);
  assert(tableSql && /COLLATE\s+NOCASE/i.test(tableSql.sql), `the rebuild should keep the username collation: ${tableSql && tableSql.sql}`);
  assert(tableSql && /CHECK\s*\(\s*badge IS NULL OR length\s*\(\s*badge\s*\)\s*<=\s*20\s*\)/i.test(tableSql.sql), `the rebuild should keep the badge check: ${tableSql && tableSql.sql}`);
  assert(tableSql && /UNIQUE\s*\(\s*display_name\s*,\s*badge\s*\)/i.test(tableSql.sql), `the rebuild should keep the composite unique: ${tableSql && tableSql.sql}`);
  assert(tableSql && !/CHECK\s*\([^)]*\brole\b/i.test(tableSql.sql), `the rebuild should drop the role check: ${tableSql && tableSql.sql}`);
  const legacy = await upgraded.get(`SELECT username, role, badge, password_hash FROM users WHERE username = 'legacyop'`);
  assert(legacy && legacy.role === 'operator' && legacy.badge === 'gold' && legacy.password_hash === 'x', 'the rebuild should keep the operator row');
  const legacyCustomer = await upgraded.get(`SELECT role, badge FROM users WHERE username = 'legacycust'`);
  assert(legacyCustomer && legacyCustomer.role === 'customer' && legacyCustomer.badge === 'blue', 'the rebuild should keep the customer row');
  const badgeIndex = await upgraded.get(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_badge'`
  );
  assert(badgeIndex && /badge/i.test(badgeIndex.sql), 'the rebuild should keep idx_users_badge');
  const trigger = await upgraded.get(
    `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'users_audit'`
  );
  assert(trigger && /user_audit/i.test(trigger.sql), 'the rebuild should keep the users trigger');
  const pin = await upgraded.get(`SELECT user_id FROM user_pins WHERE id = 1`);
  assert(pin && pin.user_id === legacyOp.id, 'the child foreign key row should still point at the user');
  const fkProblems = await upgraded.all('PRAGMA foreign_key_check');
  assert(fkProblems.length === 0, `foreign_key_check should be empty: ${JSON.stringify(fkProblems)}`);
  const managerInsert = await upgraded.run(
    `INSERT INTO users (username, password_hash, role, display_name, badge) VALUES ('sqlmgr', 'x', 'manager', 'SQL Manager', 'green')`
  );
  assert(managerInsert.lastID > 0, 'manager should insert after the rebuild');
  const duplicate = await upgraded.run(
    `INSERT INTO users (username, password_hash, role) VALUES ('legacyop', 'y', 'operator')`
  ).then(() => null).catch((err) => err);
  assert(duplicate && /UNIQUE constraint failed/i.test(duplicate.message), 'username should stay unique');
  const caseDuplicate = await upgraded.run(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES ('LegacyOp', 'y', 'operator', 'Other')`
  ).then(() => null).catch((err) => err);
  assert(caseDuplicate && /UNIQUE constraint failed/i.test(caseDuplicate.message), `username collation should stay NOCASE: ${caseDuplicate && caseDuplicate.message}`);
  const longBadge = await upgraded.run(
    `INSERT INTO users (username, password_hash, role, display_name, badge) VALUES ('longbadge', 'x', 'operator', 'Long Badge', '123456789012345678901')`
  ).then(() => null).catch((err) => err);
  assert(longBadge && /CHECK constraint failed/i.test(longBadge.message), `the badge check should still reject a long badge: ${longBadge && longBadge.message}`);
  const composite = await upgraded.run(
    `INSERT INTO users (username, password_hash, role, display_name, badge) VALUES ('dupname', 'x', 'operator', 'Legacy Op', 'gold')`
  ).then(() => null).catch((err) => err);
  assert(composite && /UNIQUE constraint failed/i.test(composite.message), `the composite unique should still reject a repeated display name and badge: ${composite && composite.message}`);
  let orphanFailed = false;
  try {
    await upgraded.run(`INSERT INTO user_pins (id, user_id) VALUES (2, 999999)`);
  } catch (err) {
    orphanFailed = /FOREIGN KEY constraint failed/i.test(err.message);
  }
  assert(orphanFailed, 'a foreign key to users should still be enforced');
  const auditBefore = await upgraded.get(`SELECT COUNT(*) AS count FROM user_audit`);
  await upgraded.run(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES ('auditmgr', 'x', 'manager', 'Audit Manager')`
  );
  const auditAfter = await upgraded.get(`SELECT COUNT(*) AS count FROM user_audit`);
  assert(auditAfter.count === auditBefore.count + 1, 'the restored trigger should record a new user');
  const userCount = await upgraded.get(`SELECT COUNT(*) AS count FROM users`);
  await upgraded.close();

  const thirdInit = await initDatabase(checkedDb);
  assert(thirdInit.code === 0 && !/Relaxed users\.role/.test(thirdInit.out), 'init after a manager exists should stay quiet');
  const settled = openDb(checkedDb);
  const settledCount = await settled.get(`SELECT COUNT(*) AS count FROM users`);
  assert(settledCount.count === userCount.count, 'another init should not add or drop users');
  const settledManager = await settled.get(`SELECT role, badge FROM users WHERE username = 'sqlmgr'`);
  assert(settledManager && settledManager.role === 'manager' && settledManager.badge === 'green', 'the manager row should survive another init');
  const adminRows = await settled.get(`SELECT COUNT(*) AS count FROM users WHERE username = 'admin'`);
  assert(adminRows.count === 1, 'init should not create a second admin');
  await settled.close();

  const clearing = openDb(checkedDb);
  await clearing.run(
    `INSERT INTO users (username, password_hash, role, display_name, department) VALUES ('deptmgr', 'x', 'manager', 'Dept Manager', 'Quality')`
  );
  await clearing.run(
    `INSERT INTO users (username, password_hash, role, display_name, department) VALUES ('deptop', 'x', 'operator', 'Dept Operator', 'Dispatch')`
  );
  await clearing.close();
  const clearInit = await initDatabase(checkedDb);
  assert(/Cleared department on 1 manager/.test(clearInit.out), `init should clear a manager department:\n${clearInit.out}`);
  const cleared = openDb(checkedDb);
  const deptMgr = await cleared.get(`SELECT department FROM users WHERE username = 'deptmgr'`);
  const deptOp = await cleared.get(`SELECT department FROM users WHERE username = 'deptop'`);
  assert(deptMgr && deptMgr.department == null, 'init should clear a manager department');
  assert(deptOp && deptOp.department === 'Dispatch', 'init should leave an operator department');
  await cleared.close();
  const clearAgain = await initDatabase(checkedDb);
  assert(!/Cleared department/.test(clearAgain.out), 'a second init should not clear manager departments again');

  const allowed = openDb(allowedDb);
  await allowed.exec(ALREADY_ALLOWS_SCHEMA);
  await allowed.run(
    `INSERT INTO users (username, password_hash, role, display_name, kept) VALUES ('ready', 'x', 'manager', 'Ready', 'yes')`
  );
  await allowed.close();
  const allowedInit = await initDatabase(allowedDb);
  assert(!/Relaxed users\.role/.test(allowedInit.out), 'a check that already allows manager should not rebuild');
  await initDatabase(allowedDb);
  const allowedAfter = openDb(allowedDb);
  const ready = await allowedAfter.get(`SELECT role, kept FROM users WHERE username = 'ready'`);
  const allowedSql = await allowedAfter.get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`);
  assert(ready && ready.role === 'manager' && ready.kept === 'yes', 'an allowed manager should stay, with the extra column');
  assert(allowedSql && /\bmanager\b/i.test(allowedSql.sql) && /\bCHECK\b/i.test(allowedSql.sql), 'an already-valid role check should remain');
  await allowedAfter.close();

  await initDatabase(freshDb);
  const fresh = openDb(freshDb);
  const freshSql = await fresh.get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`);
  assert(freshSql && !/\bCHECK\s*\(/i.test(freshSql.sql), `a new database should not check users.role: ${freshSql && freshSql.sql}`);
  await fresh.run(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES ('freshmgr', 'x', 'manager', 'Fresh Manager')`
  );
  const freshCount = await fresh.get(`SELECT COUNT(*) AS count FROM users`);
  await fresh.close();
  const freshAgain = await initDatabase(freshDb);
  assert(!/Relaxed users\.role/.test(freshAgain.out), 'a current database should not rebuild users');
  const freshAfter = openDb(freshDb);
  const freshManager = await freshAfter.get(`SELECT role FROM users WHERE username = 'freshmgr'`);
  const freshCountAfter = await freshAfter.get(`SELECT COUNT(*) AS count FROM users`);
  assert(freshManager && freshManager.role === 'manager', 'a manager on a current database should survive init');
  assert(freshCountAfter.count === freshCount.count, 'init should not duplicate users on a current database');
  await freshAfter.close();

  const server = startServer(checkedDb);
  await server.ready;
  const db = openDb(checkedDb);
  try {
    const admin = await login('admin', adminPassword);
    const created = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({
        username: 'qualitymgr',
        display_name: 'Quality Manager',
        role: 'manager',
        department: 'Quality',
        password: 'ManagerPass123',
      }),
    });
    assert(created.status === 201 && created.json.role === 'manager' && created.json.department == null, created.text);
    const edited = await request({
      method: 'PUT',
      path: `/api/users/${created.json.id}`,
      token: admin.token,
      json: staffBody({
        username: 'qualitymgr',
        display_name: 'Quality Manager',
        role: 'manager',
        department: 'Dispatch',
      }),
    });
    assert(edited.status === 200 && edited.json.department == null, edited.text);
    const badRole = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({ username: 'nope', role: 'supervisor', password: 'ManagerPass123' }),
    });
    assert(badRole.status === 400 && /manager/.test(badRole.text), badRole.text);

    const floater = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({
        username: 'floater',
        display_name: 'Floater Manager',
        role: 'manager',
        department: '',
        password: 'ManagerPass123',
      }),
    });
    assert(floater.status === 201 && floater.json.department == null, floater.text);
    const deptAdmin = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({
        username: 'qualityadmin',
        display_name: 'Quality Admin',
        role: 'admin',
        department: 'Quality',
        password: 'AdminPass456',
      }),
    });
    assert(deptAdmin.status === 201, deptAdmin.text);
    const operator = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({
        username: 'op1',
        display_name: 'Operator One',
        role: 'operator',
        department: 'Quality',
        password: 'OperatorPass123',
      }),
    });
    assert(operator.status === 201, operator.text);
    const stationed = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({
        username: 'opdept',
        display_name: 'Stationed Operator',
        role: 'operator',
        department: 'Quality',
        password: 'OperatorPass123',
      }),
    });
    assert(stationed.status === 201 && stationed.json.department === 'Quality', stationed.text);
    const promoted = await request({
      method: 'PUT',
      path: `/api/users/${stationed.json.id}`,
      token: admin.token,
      json: staffBody({
        username: 'opdept',
        display_name: 'Stationed Operator',
        role: 'manager',
        department: 'Quality',
      }),
    });
    assert(promoted.status === 200 && promoted.json.role === 'manager' && promoted.json.department == null, promoted.text);
    const customer = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({
        username: 'phase10cust',
        display_name: 'Phase Ten Customer',
        role: 'customer',
        password: 'CustomerPass1',
      }),
    });
    assert(customer.status === 201 && customer.json.department == null, customer.text);
    const otherCustomer = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: staffBody({
        username: 'phase10other',
        display_name: 'Other Customer',
        role: 'customer',
        password: 'CustomerPass1',
      }),
    });
    assert(otherCustomer.status === 201, otherCustomer.text);

    const manager = await login('qualitymgr', 'ManagerPass123');
    assert(manager.user && manager.user.department == null, 'a manager login should not carry a department');
    const operatorLogin = await login('op1', 'OperatorPass123');
    const floaterLogin = await login('floater', 'ManagerPass123');
    const qualityAdmin = await login('qualityadmin', 'AdminPass456');
    const customerLogin = await login('phase10cust', 'CustomerPass1');

    const allowedPaths = [
      ['GET', '/api/admin-board'],
      ['GET', '/api/search/orders'],
      ['GET', '/api/barcode/locations'],
      ['GET', '/api/barcode/config'],
      ['GET', '/api/reports/work-orders/status'],
      ['GET', '/api/customers/lookup'],
      ['GET', '/api/dashboard'],
      ['GET', '/api/production'],
      ['GET', '/api/production-board'],
      ['GET', '/api/delivery'],
      ['GET', '/api/notifications'],
      ['GET', '/api/workorders'],
      ['GET', '/api/orders'],
      ['GET', '/api/orders/options'],
      ['GET', '/api/customers'],
    ];
    for (const [method, requestPath] of allowedPaths) {
      const response = await request({ method, path: requestPath, token: manager.token });
      assert(response.status === 200, `manager ${method} ${requestPath} should be 200, got ${response.status} ${response.text}`);
    }
    const forbiddenPaths = [
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['GET', '/api/services'],
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
      ['GET', '/api/activity'],
      ['POST', '/api/barcode/locations'],
      ['POST', '/api/barcode/dry-run'],
      ['GET', '/api/notifications/settings'],
      ['PUT', '/api/notifications/settings'],
      ['POST', '/api/departments'],
      ['POST', '/api/customers'],
      ['POST', '/api/admin-board/approvals/1'],
    ];
    for (const [method, requestPath] of forbiddenPaths) {
      const response = await request({
        method,
        path: requestPath,
        token: manager.token,
        json: method === 'GET' ? undefined : {},
      });
      assert(response.status === 403, `manager ${method} ${requestPath} should be 403, got ${response.status} ${response.text}`);
    }

    const managerBoard = await request({ method: 'GET', path: '/api/admin-board', token: manager.token });
    assert(managerBoard.json.viewer.restricted === false && managerBoard.json.viewer.can_clear === false, 'a manager board should match an admin with no department');
    assert(managerBoard.json.viewer.department == null, managerBoard.text);
    const operatorBoard = await request({ method: 'GET', path: '/api/admin-board?scope=all', token: operatorLogin.token });
    assert(operatorBoard.json.viewer.restricted === true && operatorBoard.json.viewer.can_clear === false, 'an operator still cannot clear the department');

    async function insertOrder(externalId, customerId, department) {
      await db.run(
        `INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department)
         VALUES (?, ?, ?, 1, 'open', ?)`,
        [externalId, customerId, externalId, department]
      );
    }
    await insertOrder('P10-QUAL', customer.json.id, 'Large Format');
    await insertOrder('P10-DISP', customer.json.id, 'Large Format');
    await insertOrder('P10-DONE', customer.json.id, 'Dispatch');
    await insertOrder('P10-SAME', customer.json.id, 'Quality');
    await insertOrder('P10-MGR', customer.json.id, 'Quality');
    await insertOrder('P10-OTHER', otherCustomer.json.id, 'Dispatch');
    await insertOrder('P10-ADMIN', otherCustomer.json.id, 'Small Format');
    await db.run(
      `INSERT INTO departments (name, description, sort_order, is_active) VALUES ('P10 Inactive', 'closed', 40, 0)`
    );

    const same = await workOrderState(db, 'P10-SAME');
    const operatorMove = await request({
      method: 'POST',
      path: `/api/workorders/${same.id}/move`,
      token: operatorLogin.token,
      json: { department: 'Dispatch' },
    });
    assert(operatorMove.status === 403, `operator move should be 403, got ${operatorMove.status}`);
    const customerMove = await request({
      method: 'POST',
      path: `/api/workorders/${same.id}/move`,
      token: customerLogin.token,
      json: { department: 'Dispatch' },
    });
    assert(customerMove.status === 403, `customer move should be 403, got ${customerMove.status}`);
    const missing = await request({
      method: 'POST',
      path: `/api/workorders/${same.id}/move`,
      token: admin.token,
      json: {},
    });
    assert(missing.status === 400 && /department is required/.test(missing.text), missing.text);
    const unknown = await request({
      method: 'POST',
      path: `/api/workorders/${same.id}/move`,
      token: admin.token,
      json: { department: 'Not A Department' },
    });
    assert(unknown.status === 400 && /active department/.test(unknown.text), unknown.text);
    const inactive = await request({
      method: 'POST',
      path: `/api/workorders/${same.id}/move`,
      token: admin.token,
      json: { department: 'P10 Inactive' },
    });
    assert(inactive.status === 400 && /active department/.test(inactive.text), inactive.text);
    const sameDept = await request({
      method: 'POST',
      path: `/api/workorders/${same.id}/move`,
      token: admin.token,
      json: { department: ' quality ' },
    });
    assert(sameDept.status === 409 && /already in Quality/.test(sameDept.text), sameDept.text);
    const sameStill = await workOrderState(db, 'P10-SAME');
    assert(sameStill.department === 'Quality' && sameStill.status === 'open', 'a rejected move should leave the work order');

    const managerRows = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?limit=100',
      token: manager.token,
    });
    const managerIds = (managerRows.json.work_orders || []).map((row) => row.external_id);
    assert(managerIds.includes('P10-SAME') && managerIds.includes('P10-OTHER'), 'a manager should see every department');
    assert(managerRows.json.viewer.restricted === false && managerRows.json.viewer.department == null, managerRows.text);

    await db.run(`UPDATE users SET department = 'Quality' WHERE username = 'qualitymgr'`);
    const stuckBoard = await request({ method: 'GET', path: '/api/admin-board', token: manager.token });
    assert(stuckBoard.json.viewer.restricted === false && stuckBoard.json.viewer.can_clear === false && stuckBoard.json.viewer.department == null, 'a stored department should not restrict a manager');
    const other = await workOrderState(db, 'P10-OTHER');
    const crossMove = await request({
      method: 'POST',
      path: `/api/workorders/${other.id}/move`,
      token: manager.token,
      json: { department: 'Quality', note: 'from dispatch' },
    });
    assert(crossMove.status === 200 && crossMove.json.department === 'Quality', crossMove.text);
    const otherMoved = await workOrderState(db, 'P10-OTHER');
    assert(otherMoved.department === 'Quality', 'a manager should move a work order that is not in one department');
    await insertOrder('P10-MSCAN', customer.json.id, 'Large Format');
    const managerScan = await request({
      method: 'POST',
      path: '/api/barcode',
      token: manager.token,
      json: { scanned_value: 'P10-MSCAN', location: 'Dispatch' },
    });
    assert(managerScan.status === 201 && managerScan.json.location === 'Dispatch' && managerScan.json.to_department === 'Dispatch', managerScan.text);

    const eventsBefore = await db.get(`SELECT COUNT(*) AS count FROM barcode_events`);
    const qual = await workOrderState(db, 'P10-QUAL');
    const qualMove = await request({
      method: 'POST',
      path: `/api/workorders/${qual.id}/move`,
      token: admin.token,
      json: { department: 'Quality', note: 'hold for proof' },
    });
    assert(qualMove.status === 200, qualMove.text);
    assert(qualMove.json.department === 'Quality' && qualMove.json.manual === true && qualMove.json.note === 'hold for proof', qualMove.text);
    assert(qualMove.json.stage_name === 'Quality Control' && qualMove.json.next_department === 'Dispatch', qualMove.text);
    const qualStored = await workOrderState(db, 'P10-QUAL');
    assert(qualStored.department === 'Quality' && qualStored.stage_name === 'Quality Control', 'Quality should advance Quality Control');
    assert(qualStored.next_department === 'Dispatch' && qualStored.assigned_department_id, 'the move should store the route');
    const qualActivity = await db.get(
      `SELECT actor_id, detail FROM activity_log WHERE action = 'work_order.moved' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
      [qual.id]
    );
    const qualDetail = JSON.parse(qualActivity.detail);
    assert(qualActivity.actor_id === admin.user.id, 'the activity row should name the signed-in user');
    assert(qualDetail.manual === true && qualDetail.note === 'hold for proof', JSON.stringify(qualDetail));
    assert(qualDetail.from_department === 'Large Format' && qualDetail.to_department === 'Quality', JSON.stringify(qualDetail));
    const qualHistory = await db.get(
      `SELECT notes, scanned_by FROM production_history WHERE work_order_id = ? ORDER BY id DESC LIMIT 1`,
      [qual.id]
    );
    assert(qualHistory.notes.startsWith('Manual move') && qualHistory.notes.includes('hold for proof'), qualHistory.notes);
    assert(qualHistory.scanned_by === 'Administrator', 'history should name the person who moved it');
    const eventsAfter = await db.get(`SELECT COUNT(*) AS count FROM barcode_events`);
    assert(eventsAfter.count === eventsBefore.count, 'a manual move should not write a barcode event');

    const disp = await workOrderState(db, 'P10-DISP');
    const dispMove = await request({
      method: 'POST',
      path: `/api/workorders/${disp.id}/move`,
      token: admin.token,
      json: { department: 'Dispatch' },
    });
    assert(dispMove.status === 200 && dispMove.json.stage_name === 'Shipping' && dispMove.json.next_department === 'Delivery', dispMove.text);
    const done = await workOrderState(db, 'P10-DONE');
    const doneMove = await request({
      method: 'POST',
      path: `/api/workorders/${done.id}/move`,
      token: admin.token,
      json: { department: 'Complete', note: 'packed' },
    });
    assert(doneMove.status === 200 && doneMove.json.status === 'completed', doneMove.text);
    const doneStored = await workOrderState(db, 'P10-DONE');
    assert(doneStored.status === 'completed' && doneStored.department === 'Complete', 'Complete should finish the work order');
    const completedActivity = await db.get(
      `SELECT detail FROM activity_log WHERE action = 'work_order.completed' AND entity_id = ?`,
      [done.id]
    );
    assert(completedActivity, 'moving into Complete should write work_order.completed');

    const locationList = await request({ method: 'GET', path: '/api/barcode/locations', token: admin.token });
    assert(locationList.status === 200 && Array.isArray(locationList.json.locations), locationList.text);
    const deliveryLocation = locationList.json.locations.find((row) => row.location === 'Delivery');
    const qualityLocation = locationList.json.locations.find((row) => row.location === 'Quality');
    assert(deliveryLocation && qualityLocation, 'Quality and Delivery should have barcode locations');
    const deliveryUpdate = await request({
      method: 'PUT',
      path: `/api/barcode/locations/${deliveryLocation.id}`,
      token: admin.token,
      json: {
        location: 'Delivery',
        department_name: 'Delivery',
        stage_name: 'Shipping',
        is_active: true,
        sort_order: deliveryLocation.sort_order,
      },
    });
    assert(deliveryUpdate.status === 200 && deliveryUpdate.json.stage_name === 'Shipping', deliveryUpdate.text);

    await insertOrder('P10-SCAN', customer.json.id, 'Large Format');
    const scan = await request({
      method: 'POST',
      path: '/api/barcode',
      token: admin.token,
      json: { scanned_value: 'P10-SCAN', location: 'Delivery' },
    });
    assert(scan.status === 201, scan.text);
    assert(scan.json.to_department === 'Delivery' && scan.json.stage_name === 'Shipping' && scan.json.stage_advanced === true, scan.text);
    const scanStored = await workOrderState(db, 'P10-SCAN');
    assert(scanStored.department === 'Delivery' && scanStored.stage_name === 'Shipping', 'a Delivery scan should advance the location stage');

    await insertOrder('P10-DELIV', customer.json.id, 'Large Format');
    const deliv = await workOrderState(db, 'P10-DELIV');
    const delivMove = await request({
      method: 'POST',
      path: `/api/workorders/${deliv.id}/move`,
      token: admin.token,
      json: { department: 'Delivery' },
    });
    assert(delivMove.status === 200 && delivMove.json.stage_name === 'Shipping' && delivMove.json.stage_advanced === true, delivMove.text);
    const delivStored = await workOrderState(db, 'P10-DELIV');
    assert(delivStored.department === 'Delivery' && delivStored.stage_name === 'Shipping', 'a manual move should use the Delivery location stage');

    const blankQuality = await request({
      method: 'PUT',
      path: `/api/barcode/locations/${qualityLocation.id}`,
      token: admin.token,
      json: {
        location: 'Quality',
        department_name: 'Quality',
        stage_name: '',
        is_active: true,
        sort_order: qualityLocation.sort_order,
      },
    });
    assert(blankQuality.status === 200 && blankQuality.json.stage_name === '' && blankQuality.json.department_name === 'Quality', blankQuality.text);
    await insertOrder('P10-BLANK', customer.json.id, 'Large Format');
    const blank = await workOrderState(db, 'P10-BLANK');
    const blankMove = await request({
      method: 'POST',
      path: `/api/workorders/${blank.id}/move`,
      token: admin.token,
      json: { department: 'Quality' },
    });
    assert(blankMove.status === 200 && blankMove.json.department === 'Quality', blankMove.text);
    assert(blankMove.json.stage_advanced === false && !blankMove.json.stage_name, blankMove.text);
    const blankStored = await workOrderState(db, 'P10-BLANK');
    assert(blankStored.department === 'Quality' && blankStored.stage_name == null, 'a blank Quality stage should not fall back to Quality Control');

    await db.run(
      `DELETE FROM barcode_locations
       WHERE lower(trim(COALESCE(department_name, ''))) = 'quality'
          OR lower(trim(location)) = 'quality'`
    );
    await insertOrder('P10-FALLBACK', customer.json.id, 'Large Format');
    const fallback = await workOrderState(db, 'P10-FALLBACK');
    const fallbackMove = await request({
      method: 'POST',
      path: `/api/workorders/${fallback.id}/move`,
      token: admin.token,
      json: { department: 'Quality' },
    });
    assert(fallbackMove.status === 200 && fallbackMove.json.stage_name === 'Quality Control' && fallbackMove.json.stage_advanced === true, fallbackMove.text);

    const mgrOrder = await workOrderState(db, 'P10-MGR');
    const mgrMove = await request({
      method: 'POST',
      path: `/api/workorders/${mgrOrder.id}/move`,
      token: manager.token,
      json: { department: 'Small Format', note: 'send to print' },
    });
    assert(mgrMove.status === 200 && mgrMove.json.department === 'Small Format', mgrMove.text);
    const mgrAgain = await request({
      method: 'POST',
      path: `/api/workorders/${mgrOrder.id}/move`,
      token: manager.token,
      json: { department: 'Planroom' },
    });
    assert(mgrAgain.status === 200 && mgrAgain.json.department === 'Planroom', 'a manager can move a work order again after it changes department');
    const floaterMove = await request({
      method: 'POST',
      path: `/api/workorders/${other.id}/move`,
      token: floaterLogin.token,
      json: { department: 'Large Format' },
    });
    assert(floaterMove.status === 200 && floaterMove.json.department === 'Large Format', floaterMove.text);
    const adminOrder = await workOrderState(db, 'P10-ADMIN');
    const adminMove = await request({
      method: 'POST',
      path: `/api/workorders/${adminOrder.id}/move`,
      token: qualityAdmin.token,
      json: { department: 'Planroom', note: 'admin override' },
    });
    assert(adminMove.status === 200 && adminMove.json.department === 'Planroom', 'an admin with a department can move any work order');

    const staffDetail = await request({ method: 'GET', path: `/api/workorders/${qual.id}`, token: manager.token });
    assert(staffDetail.status === 200, staffDetail.text);
    const staffHistory = (staffDetail.json.production_history || []).find((row) => row.manual);
    assert(staffHistory && /hold for proof/.test(staffHistory.notes), 'staff history should mark the manual move and keep the note');
    const staffActivity = (staffDetail.json.activity || []).find((row) => row.manual);
    assert(staffActivity && staffActivity.note === 'hold for proof' && /Manual/.test(staffActivity.summary), JSON.stringify(staffDetail.json.activity));

    const ownList = await request({ method: 'GET', path: '/api/workorders', token: customerLogin.token });
    const ownIds = (ownList.json || []).map((row) => row.external_id);
    assert(ownIds.includes('P10-QUAL'), 'a customer should see their own work order');
    assert(!ownIds.includes('P10-OTHER') && !ownIds.includes('P10-ADMIN'), 'a customer should not see another customer work order');
    const ownDetail = await request({ method: 'GET', path: `/api/workorders/${qual.id}`, token: customerLogin.token });
    assert(ownDetail.status === 200, ownDetail.text);
    assert(!/hold for proof/.test(ownDetail.text), 'a customer should not see the manual note');
    assert(!(ownDetail.json.production_history || []).some((row) => row.notes || row.scanned_by || row.manual), 'customer history should omit staff fields');
    assert(!ownDetail.json.activity || ownDetail.json.activity.length === 0, 'customer detail should omit activity');
    const hidden = await request({ method: 'GET', path: `/api/workorders/${other.id}`, token: customerLogin.token });
    assert(hidden.status === 404, 'a customer should not open another customer work order');
    const customerBoard = await request({ method: 'GET', path: '/api/admin-board', token: customerLogin.token });
    assert(customerBoard.status === 403, 'a customer should not open the admin board');

    const boardActivity = await request({ method: 'GET', path: '/api/admin-board/activity?limit=50', token: admin.token });
    const manualRow = (boardActivity.json.activity || []).find((row) => row.external_id === 'P10-QUAL' && row.manual);
    assert(manualRow && manualRow.note === 'hold for proof' && /Manual/.test(manualRow.summary), JSON.stringify(boardActivity.json.activity));
  } finally {
    await db.close();
    await server.stop();
  }

  console.log('Phase 10 checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
