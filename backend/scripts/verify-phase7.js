/**
 * Phase 7 checks: scan locations follow department names on a fresh database
 * and on a database that still has the old stage-only seed.
 * Usage (from backend/): node scripts/verify-phase7.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase7-'));
const freshDb = path.join(tmp, 'fresh.db');
const legacyDb = path.join(tmp, 'legacy.db');
const aliasDb = path.join(tmp, 'alias.db');
const port = 3118;
const adminPassword = 'AdminPass123';
const CUSTOM_STAMP = '2020-01-01 00:00:00';

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
    BARCODE_LOCATION_STAGES: 'Quality=Quality Control;Dispatch=Shipping',
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
        child.once('exit', () => {
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

async function locationSnapshot(db) {
  const rows = await db.all(
    `SELECT location, department_name, stage_name, sort_order, is_active, updated_at
     FROM barcode_locations
     ORDER BY lower(location), id`
  );
  return JSON.stringify(rows);
}

async function locationRow(db, location) {
  return db.get(
    `SELECT location, department_name, stage_name, sort_order, is_active, updated_at
     FROM barcode_locations WHERE lower(location) = lower(?)`,
    [location]
  );
}

function assertFields(row, expected, label) {
  assert(row, `${label} should exist`);
  for (const [key, value] of Object.entries(expected)) {
    assert(row[key] === value, `${label} ${key} expected ${JSON.stringify(value)} got ${JSON.stringify(row[key])}`);
  }
}

async function departmentSeeds(db, skipNames = []) {
  const skip = new Set(skipNames.map((name) => name.toLowerCase()));
  const departments = await db.all(
    `SELECT name, sort_order FROM departments WHERE is_active = 1 ORDER BY sort_order, name`
  );
  return departments
    .filter((department) => !skip.has(department.name.toLowerCase()))
    .map((department) => ({
      location: department.name,
      department_name: department.name,
      stage_name: null,
      sort_order: department.sort_order || 0,
      is_active: 1,
      updated_at: CUSTOM_STAMP,
    }));
}

async function replaceLocations(db, rows) {
  await db.run(`DELETE FROM system_settings WHERE key = 'barcode_locations_legacy_departments'`);
  await db.run(`DELETE FROM barcode_locations`);
  for (const row of rows) {
    await db.run(
      `INSERT INTO barcode_locations (location, department_name, stage_name, sort_order, is_active, updated_at)
       VALUES (?,?,?,?,?,?)`,
      [row.location, row.department_name, row.stage_name, row.sort_order, row.is_active, row.updated_at]
    );
  }
  await db.run(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ('barcode_locations_seeded', '1', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = '1'`
  );
}

async function insertWorkOrder(db, externalId, department) {
  await db.run(
    `INSERT INTO work_orders (external_id, description, quantity, status, department)
     VALUES (?, 'Scan location check', 1, 'open', ?)`,
    [externalId, department]
  );
}

async function assertFresh(file) {
  const db = openDb(file);
  const departments = await db.all(`SELECT name FROM departments WHERE is_active = 1 ORDER BY name`);
  const locations = await db.all(
    `SELECT location, department_name, stage_name, is_active FROM barcode_locations ORDER BY lower(location)`
  );
  assert(locations.length === departments.length, `fresh database should seed one location per department, found ${locations.length}`);
  for (const department of departments) {
    const row = locations.find((item) => item.location === department.name);
    assert(row && row.department_name === department.name && row.is_active === 1, `${department.name} should be an active scan location for that department`);
  }
  const quality = locations.find((item) => item.location === 'Quality');
  const dispatch = locations.find((item) => item.location === 'Dispatch');
  assert(quality && quality.stage_name === 'Quality Control', 'Quality should keep the Quality Control stage');
  assert(dispatch && dispatch.stage_name === 'Shipping', 'Dispatch should keep the Shipping stage');
  for (const legacyName of ['Quality Control', 'Shipping', 'Finishing']) {
    assert(!locations.some((item) => item.location.toLowerCase() === legacyName.toLowerCase() && item.is_active === 1), `${legacyName} should not be a selectable location on a fresh database`);
  }
  const flag = await db.get(`SELECT value FROM system_settings WHERE key = 'barcode_locations_legacy_departments'`);
  assert(flag && flag.value === '1', 'legacy location migration should be recorded');
  await db.close();
}

async function assertLegacy(file) {
  const db = openDb(file);
  assertFields(await locationRow(db, 'Quality'), {
    department_name: 'Quality',
    stage_name: 'Quality Control',
    is_active: 1,
  }, 'Quality');
  assertFields(await locationRow(db, 'Quality Control'), {
    department_name: 'Quality',
    stage_name: 'Quality Control',
    is_active: 0,
  }, 'legacy Quality Control');
  assertFields(await locationRow(db, 'Dispatch'), {
    department_name: 'Dispatch',
    stage_name: 'Shipping',
    is_active: 1,
  }, 'Dispatch');
  assertFields(await locationRow(db, 'Shipping'), {
    department_name: 'Dispatch',
    stage_name: 'Shipping',
    is_active: 0,
  }, 'legacy Shipping');
  assertFields(await locationRow(db, 'Finishing'), {
    department_name: null,
    stage_name: 'Finishing',
    is_active: 0,
  }, 'legacy Finishing');
  assertFields(await locationRow(db, 'Receiving Dock'), {
    department_name: 'Small Format',
    stage_name: 'Prepress',
    sort_order: 40,
    is_active: 1,
    updated_at: CUSTOM_STAMP,
  }, 'admin location Receiving Dock');
  assertFields(await locationRow(db, 'Laminating'), {
    department_name: null,
    stage_name: 'Finishing',
    sort_order: 41,
    is_active: 1,
    updated_at: CUSTOM_STAMP,
  }, 'admin stage-only Laminating');
  await db.close();
}

async function assertAlias(file) {
  const db = openDb(file);
  const quality = await locationRow(db, 'Quality');
  assert(!quality, 'migration should not recreate a Quality location an admin removed');
  assertFields(await locationRow(db, 'Quality Control'), {
    department_name: 'Quality',
    stage_name: 'Quality Control',
    is_active: 1,
  }, 'Quality Control without a Quality row');
  assertFields(await locationRow(db, 'Shipping'), {
    department_name: 'Delivery',
    stage_name: 'Shipping',
    is_active: 1,
    updated_at: CUSTOM_STAMP,
  }, 'customised Shipping');
  assertFields(await locationRow(db, 'Hold Shelf'), {
    department_name: 'Admin',
    stage_name: null,
    sort_order: 42,
    is_active: 1,
    updated_at: CUSTOM_STAMP,
  }, 'admin location Hold Shelf');
  const dispatch = await locationRow(db, 'Dispatch');
  assert(dispatch && dispatch.department_name === 'Dispatch' && dispatch.stage_name == null, 'customised Shipping should not copy its stage onto Dispatch');
  await db.close();
}

async function scan(token, scannedValue, location) {
  const response = await request({
    method: 'POST',
    path: '/api/barcode',
    token,
    json: { scanned_value: scannedValue, location },
  });
  assert(response.status === 201, `scan ${scannedValue} at ${location} failed: ${response.status} ${response.text}`);
  return response.json;
}

async function main() {
  await initDatabase(freshDb);
  await initDatabase(freshDb);
  await assertFresh(freshDb);
  const fresh = openDb(freshDb);
  const freshOnce = await locationSnapshot(fresh);
  await fresh.close();
  await initDatabase(freshDb);
  const freshAgain = openDb(freshDb);
  const freshTwice = await locationSnapshot(freshAgain);
  await freshAgain.close();
  assert(freshOnce === freshTwice, 'initialising a fresh database twice should leave scan locations unchanged');

  await initDatabase(legacyDb);
  const legacy = openDb(legacyDb);
  const legacyRows = await departmentSeeds(legacy);
  legacyRows.push(
    { location: 'Quality Control', department_name: null, stage_name: 'Quality Control', sort_order: 20, is_active: 1, updated_at: CUSTOM_STAMP },
    { location: 'Shipping', department_name: null, stage_name: 'Shipping', sort_order: 21, is_active: 1, updated_at: CUSTOM_STAMP },
    { location: 'Finishing', department_name: null, stage_name: 'Finishing', sort_order: 22, is_active: 1, updated_at: CUSTOM_STAMP },
    { location: 'Receiving Dock', department_name: 'Small Format', stage_name: 'Prepress', sort_order: 40, is_active: 1, updated_at: CUSTOM_STAMP },
    { location: 'Laminating', department_name: null, stage_name: 'Finishing', sort_order: 41, is_active: 1, updated_at: CUSTOM_STAMP }
  );
  await replaceLocations(legacy, legacyRows);
  await legacy.close();
  await initDatabase(legacyDb);
  await assertLegacy(legacyDb);
  const migrated = openDb(legacyDb);
  const legacyOnce = await locationSnapshot(migrated);
  await migrated.close();
  await initDatabase(legacyDb);
  const migratedAgain = openDb(legacyDb);
  const legacyTwice = await locationSnapshot(migratedAgain);
  assert(legacyOnce === legacyTwice, 'initialising an upgraded database twice should leave scan locations unchanged');
  await migratedAgain.run(`DELETE FROM system_settings WHERE key = 'barcode_locations_legacy_departments'`);
  await migratedAgain.close();
  await initDatabase(legacyDb);
  const migratedThird = openDb(legacyDb);
  const legacyThrice = await locationSnapshot(migratedThird);
  await migratedThird.close();
  assert(legacyOnce === legacyThrice, 'the legacy location migration should be safe to run again');

  await initDatabase(aliasDb);
  const alias = openDb(aliasDb);
  const aliasRows = await departmentSeeds(alias, ['Quality']);
  aliasRows.push(
    { location: 'Quality Control', department_name: null, stage_name: 'Quality Control', sort_order: 20, is_active: 1, updated_at: CUSTOM_STAMP },
    { location: 'Shipping', department_name: 'Delivery', stage_name: 'Shipping', sort_order: 21, is_active: 1, updated_at: CUSTOM_STAMP },
    { location: 'Hold Shelf', department_name: 'Admin', stage_name: null, sort_order: 42, is_active: 1, updated_at: CUSTOM_STAMP }
  );
  await replaceLocations(alias, aliasRows);
  await alias.close();
  await initDatabase(aliasDb);
  await initDatabase(aliasDb);
  await assertAlias(aliasDb);

  const legacyServer = startServer(legacyDb);
  await legacyServer.ready;
  const legacyOrders = openDb(legacyDb);
  try {
    await insertWorkOrder(legacyOrders, '20261016-001-A', 'Small Format');
    await insertWorkOrder(legacyOrders, '20261016-001-B', 'Small Format');
    await insertWorkOrder(legacyOrders, '20261016-001-C', 'Small Format');
    await insertWorkOrder(legacyOrders, '20261016-001-D', 'Small Format');
    const admin = await login('admin', adminPassword);
    const config = await request({ method: 'GET', path: '/api/barcode/config', token: admin.token });
    assert(config.status === 200, 'scan config should load');
    const names = (config.json.locations || []).map((row) => row.location);
    assert(names.includes('Quality'), 'the scan list should offer Quality');
    assert(!names.some((name) => name.toLowerCase() === 'quality control'), 'the scan list should not also offer Quality Control');
    assert(!names.some((name) => name.toLowerCase() === 'shipping'), 'the scan list should not also offer Shipping');
    assert(!names.some((name) => name.toLowerCase() === 'finishing'), 'the scan list should not offer Finishing');
    const qualityOption = config.json.locations.find((row) => row.location === 'Quality');
    assert(qualityOption && qualityOption.department_name === 'Quality', 'Quality should show the Quality department');

    const moved = await scan(admin.token, '20261016-001-A', 'Quality');
    assert(moved.department_moved === true && moved.to_department === 'Quality' && moved.from_department === 'Small Format', 'scanning Quality should move the work order to Quality');
    assert(moved.department_move_reason === 'moved', 'a department move should say the department moved');
    assert(moved.stage_name === 'Quality Control', 'Quality should still advance the Quality Control stage');
    const stored = await legacyOrders.get(`SELECT department, next_department FROM work_orders WHERE external_id = ?`, ['20261016-001-A']);
    assert(stored.department === 'Quality' && stored.next_department === 'Dispatch', 'the stored work order should sit in Quality');

    const qualityList = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?department=Quality&q=20261016-001-A',
      token: admin.token,
    });
    assert(qualityList.status === 200, qualityList.text);
    assert(/no-store/.test(String(qualityList.headers['cache-control'] || '')), 'the active work order list should not be cached');
    assert(qualityList.json.work_orders.some((row) => row.external_id === '20261016-001-A' && row.department === 'Quality'), 'the Admin Board Quality list should include the scanned order');
    const smallList = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?department=Small%20Format&q=20261016-001-A',
      token: admin.token,
    });
    assert(!smallList.json.work_orders.some((row) => row.external_id === '20261016-001-A'), 'the scanned order should leave Small Format');
    const board = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    assert(/no-store/.test(String(board.headers['cache-control'] || '')), 'the admin board should not be cached');
    const activity = (board.json.scans || []).find((row) => row.external_id === '20261016-001-A');
    assert(activity && activity.to_department === 'Quality', 'Scan Activity should show Quality in the To column');

    const aliasScan = await scan(admin.token, '20261016-001-B', 'Quality Control');
    assert(aliasScan.department_moved === true && aliasScan.to_department === 'Quality', 'an inactive Quality Control alias should still move the work order to Quality');
    const aliasStored = await legacyOrders.get(`SELECT department FROM work_orders WHERE external_id = ?`, ['20261016-001-B']);
    assert(aliasStored.department === 'Quality', 'the Quality Control scan should store Quality');

    const unknown = await scan(admin.token, '20261016-001-C', 'Not A Station');
    assert(unknown.department_moved === false && unknown.department_move_reason === 'unknown_location', 'an unknown location should warn that the department stayed');
    const unknownStored = await legacyOrders.get(`SELECT department FROM work_orders WHERE external_id = ?`, ['20261016-001-C']);
    assert(unknownStored.department === 'Small Format', 'an unknown location should leave the department in place');

    const stageOnly = await scan(admin.token, '20261016-001-D', 'Laminating');
    assert(stageOnly.department_moved === false && stageOnly.department_move_reason === 'stage_only', 'a stage-only location should warn that the department stayed');
    assert(stageOnly.stage_advanced === true && stageOnly.stage_name === 'Finishing', 'a stage-only location should still advance its stage');
    const stageStored = await legacyOrders.get(`SELECT department FROM work_orders WHERE external_id = ?`, ['20261016-001-D']);
    assert(stageStored.department === 'Small Format', 'a stage-only location should leave the department in place');

    const same = await scan(admin.token, '20261016-001-A', 'Quality');
    assert(same.department_moved === false && same.department_move_reason === 'same_department' && same.to_department === 'Quality', 'scanning the current department should say it stayed there');
  } finally {
    await legacyOrders.close();
    await legacyServer.stop();
  }

  const aliasServer = startServer(aliasDb);
  await aliasServer.ready;
  const aliasOrders = openDb(aliasDb);
  try {
    await insertWorkOrder(aliasOrders, '20261016-002-A', 'Small Format');
    await insertWorkOrder(aliasOrders, '20261016-002-B', 'Small Format');
    const admin = await login('admin', adminPassword);
    const moved = await scan(admin.token, '20261016-002-A', 'Quality Control');
    assert(moved.department_moved === true && moved.to_department === 'Quality' && moved.from_department === 'Small Format', 'a remaining Quality Control location should move the work order to Quality');
    const stored = await aliasOrders.get(`SELECT department FROM work_orders WHERE external_id = ?`, ['20261016-002-A']);
    assert(stored.department === 'Quality', 'Quality Control should store the Quality department');
    const qualityList = await request({
      method: 'GET',
      path: '/api/admin-board/work-orders?department=Quality&q=20261016-002-A',
      token: admin.token,
    });
    assert(qualityList.json.work_orders.some((row) => row.external_id === '20261016-002-A' && row.department === 'Quality'), 'the Admin Board should show the Quality Control scan in Quality');
    const custom = await scan(admin.token, '20261016-002-B', 'Shipping');
    assert(custom.to_department === 'Delivery' && custom.department_moved === true, 'a customised Shipping location should keep the department an admin saved');
    const customStored = await aliasOrders.get(`SELECT department FROM work_orders WHERE external_id = ?`, ['20261016-002-B']);
    assert(customStored.department === 'Delivery', 'customised Shipping should not be rewritten to Dispatch');
  } finally {
    await aliasOrders.close();
    await aliasServer.stop();
  }

  console.log('Phase 7 checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
