/**
 * Phase 11 checks: customer self sign-up, an upgrade-safe setting seed,
 * and customer isolation after registration.
 * Usage (from backend/): node scripts/verify-phase11.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase11-'));
const freshDb = path.join(tmp, 'fresh.db');
const upgradeDb = path.join(tmp, 'upgrade.db');
const rateDb = path.join(tmp, 'rate.db');
const port = 3123;
const ratePort = 3124;
const adminPassword = 'AdminPass123';

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.name = 'AssertionError';
    throw error;
  }
}

function openDb(file) {
  const sqlite3 = require('sqlite3').verbose();
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
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  return { run, get, close };
}

function baseEnv(databaseFile, extra = {}) {
  return {
    DATABASE_FILE: databaseFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    DELIVERY_TIMEZONE: 'UTC',
    PORT: String(extra.PORT || port),
    NODE_ENV: 'test',
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
    REGISTER_RATE_IP_MAX: '40',
    REGISTER_RATE_IP_ATTEMPT_MAX: '80',
    REGISTER_RATE_GLOBAL_MAX: '80',
    ...extra,
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

function request({ method, path: requestPath, token, json, port: requestPort = port }) {
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
      port: requestPort,
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

function startServer(databaseFile, listenPort, extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...baseEnv(databaseFile, { PORT: String(listenPort), ...extraEnv }) },
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
        const health = await request({ method: 'GET', path: '/api/health', port: listenPort });
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

function accountBody(overrides = {}) {
  return {
    company: 'Northwind Signs',
    contact_name: 'Ada North',
    email: 'Ada@Northwind.example',
    phone: '919-555-0142',
    password: 'Northwind1',
    password_confirm: 'Northwind1',
    website: '',
    ...overrides,
  };
}

async function login(username, password, listenPort = port) {
  const response = await request({
    method: 'POST',
    path: '/api/auth/login',
    json: { username, password },
    port: listenPort,
  });
  assert(response.status === 200 && response.json && response.json.token, `login failed for ${username}: ${response.status} ${response.text}`);
  return response.json;
}

async function indexRow(db, name) {
  return db.get(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?`, [name]);
}

async function checkUpgrade() {
  const first = await initDatabase(upgradeDb);
  assert(first.code === 0, 'first init should succeed');
  const seeded = openDb(upgradeDb);
  const flag = await seeded.get(`SELECT value FROM system_settings WHERE key = 'customer_self_signup_enabled'`);
  const letterhead = await seeded.get(`SELECT value FROM system_settings WHERE key = 'company_name'`);
  const note = await seeded.get(`SELECT enabled, channel FROM notification_settings WHERE event_key = 'customer_registered'`);
  const usernameIndex = await indexRow(seeded, 'idx_users_username_nocase');
  const emailIndex = await indexRow(seeded, 'idx_users_email_nocase');
  assert(flag && flag.value === '1', 'a new database should seed customer self sign-up on');
  assert(letterhead && letterhead.value === 'Accent Imaging, Inc.', 'letterhead seed should stay in place');
  assert(note && note.enabled === 1 && note.channel === 'in_app', 'new-customer notifications should start enabled');
  assert(usernameIndex, 'username case-insensitive index should be created');
  assert(!emailIndex, 'email should not get a unique index');

  await seeded.run(`DELETE FROM system_settings WHERE key = 'customer_self_signup_enabled'`);
  await seeded.run(`DELETE FROM notification_settings WHERE event_key = 'customer_registered'`);
  await seeded.run('DROP INDEX IF EXISTS idx_users_username_nocase');
  await seeded.run('DROP INDEX IF EXISTS idx_users_email_nocase');
  await seeded.close();

  const upgraded = await initDatabase(upgradeDb);
  assert(upgraded.code === 0, `upgrade init should succeed\n${upgraded.err}`);
  const after = openDb(upgradeDb);
  const restored = await after.get(`SELECT value, COUNT(*) AS count FROM system_settings WHERE key = 'customer_self_signup_enabled'`);
  const names = await after.get(`SELECT COUNT(*) AS count FROM system_settings WHERE key = 'company_name'`);
  const noteAgain = await after.get(`SELECT enabled FROM notification_settings WHERE event_key = 'customer_registered'`);
  const usernameAgain = await indexRow(after, 'idx_users_username_nocase');
  const emailAgain = await indexRow(after, 'idx_users_email_nocase');
  assert(restored && restored.value === '1', 'an upgraded database should gain the sign-up setting turned on');
  assert(names.count === 1, 'upgrade should not duplicate company_name');
  assert(noteAgain && noteAgain.enabled === 1, 'upgrade should add the notification event once');
  assert(usernameAgain, 'upgrade should add the username index');
  assert(!emailAgain, 'upgrade should not add an email index');

  await after.run(`UPDATE system_settings SET value = '0' WHERE key = 'customer_self_signup_enabled'`);
  await after.run(`UPDATE notification_settings SET enabled = 0 WHERE event_key = 'customer_registered'`);
  await after.close();

  const kept = await initDatabase(upgradeDb);
  assert(kept.code === 0, 'a second upgrade should succeed');
  const check = openDb(upgradeDb);
  const saved = await check.get(`SELECT value FROM system_settings WHERE key = 'customer_self_signup_enabled'`);
  const savedCount = await check.get(`SELECT COUNT(*) AS count FROM system_settings WHERE key = 'customer_self_signup_enabled'`);
  const quiet = await check.get(`SELECT enabled FROM notification_settings WHERE event_key = 'customer_registered'`);
  const quietCount = await check.get(`SELECT COUNT(*) AS count FROM notification_settings WHERE event_key = 'customer_registered'`);
  assert(saved && saved.value === '0' && savedCount.count === 1, 'init must not turn customer self sign-up back on');
  assert(quiet && quiet.enabled === 0 && quietCount.count === 1, 'init must not re-enable a notification an admin turned off');

  await check.run('CREATE UNIQUE INDEX idx_users_email_nocase ON users(email COLLATE NOCASE)');
  await check.close();
  const repaired = await initDatabase(upgradeDb);
  assert(repaired.code === 0, `init should drop a leftover email index\n${repaired.err}`);
  const repairedDb = openDb(upgradeDb);
  const droppedIndex = await indexRow(repairedDb, 'idx_users_email_nocase');
  const usernameKept = await indexRow(repairedDb, 'idx_users_username_nocase');
  assert(!droppedIndex, 'init should drop idx_users_email_nocase');
  assert(usernameKept, 'dropping the email index should leave the username index');
  await repairedDb.run(
    `INSERT INTO users (username, password_hash, role, display_name, email, is_active)
     VALUES ('dup-a', 'x', 'customer', 'Dup A', 'Dup@Example.com', 1)`
  );
  await repairedDb.run(
    `INSERT INTO users (username, password_hash, role, display_name, email, is_active)
     VALUES ('dup-b', 'x', 'customer', 'Dup B', 'dup@example.com', 1)`
  );
  await repairedDb.close();

  const warned = await initDatabase(upgradeDb);
  assert(warned.code === 0, `init should continue when duplicate emails already exist\n${warned.err}`);
  const left = openDb(upgradeDb);
  const skipped = await indexRow(left, 'idx_users_email_nocase');
  const stillOff = await left.get(`SELECT value FROM system_settings WHERE key = 'customer_self_signup_enabled'`);
  const both = await left.get(`SELECT COUNT(*) AS count FROM users WHERE lower(trim(email)) = 'dup@example.com'`);
  await left.close();
  assert(!skipped, 'init should not create an email index when duplicate emails already exist');
  assert(stillOff && stillOff.value === '0', 'the duplicate-email path should keep the saved switch');
  assert(both.count === 2, 'existing duplicate emails should remain');
  console.log('PASS upgrade');
}

async function checkRateLimit(extraEnv, label) {
  const server = startServer(rateDb, ratePort, extraEnv);
  await server.ready;
  try {
    for (let index = 1; index <= 2; index += 1) {
      const created = await request({
        method: 'POST',
        path: '/api/auth/register',
        port: ratePort,
        json: accountBody({
          company: `${label} ${index}`,
          email: `${label}${index}@rate.example`,
        }),
      });
      assert(created.status === 201 && created.json && created.json.token, `${label} registration ${index} should succeed: ${created.status} ${created.text}`);
    }
    const blocked = await request({
      method: 'POST',
      path: '/api/auth/register',
      port: ratePort,
      json: accountBody({
        company: `${label} blocked`,
        email: `${label}-blocked@rate.example`,
      }),
    });
    assert(blocked.status === 429, `${label} should return 429, got ${blocked.status} ${blocked.text}`);
    assert(blocked.headers['retry-after'], `${label} should set Retry-After`);
    const db = openDb(rateDb);
    const row = await db.get(`SELECT id FROM users WHERE lower(email) = ?`, [`${label}-blocked@rate.example`]);
    await db.close();
    assert(!row, `${label} must not create the blocked account`);
    console.log(`PASS rate limit ${label}`);
  } finally {
    await server.stop();
  }
}

async function renameUserCase(token, currentName, nextName) {
  const listed = await request({
    method: 'GET',
    path: `/api/users?limit=100&q=${encodeURIComponent(currentName)}`,
    token,
  });
  assert(listed.status === 200, listed.text);
  const row = (listed.json.users || []).find((user) => String(user.username).toLowerCase() === currentName.toLowerCase());
  assert(row && row.id, `missing user ${currentName}`);
  const updated = await request({
    method: 'PUT',
    path: `/api/users/${row.id}`,
    token,
    json: {
      username: nextName,
      display_name: row.display_name,
      role: row.role,
      is_active: row.is_active,
      company: row.company,
      contact_name: row.contact_name,
      phone: row.phone,
      email: row.email,
    },
  });
  assert(updated.status === 200 && updated.json.username === nextName, `rename ${currentName} failed: ${updated.status} ${updated.text}`);
}

async function checkInitAfterCaseRename() {
  const again = await initDatabase(freshDb);
  assert(again.code === 0, `init after a case-only rename should succeed\n${again.out}\n${again.err}`);
  const db = openDb(freshDb);
  const whitebox = await db.get(`SELECT username, COUNT(*) AS count FROM users WHERE lower(username) = 'whitebox'`);
  const admin = await db.get(`SELECT username, COUNT(*) AS count FROM users WHERE lower(username) = 'admin'`);
  await db.close();
  assert(whitebox && whitebox.count === 1 && whitebox.username === 'Whitebox', `whitebox should stay a single renamed row: ${JSON.stringify(whitebox)}`);
  assert(admin && admin.count === 1 && admin.username === 'Admin', `admin should stay a single renamed row: ${JSON.stringify(admin)}`);
  console.log('PASS init after case rename');
}

async function checkValidationRateLimit() {
  const server = startServer(rateDb, ratePort, {
    REGISTER_RATE_IP_MAX: '2',
    REGISTER_RATE_IP_ATTEMPT_MAX: '30',
    REGISTER_RATE_GLOBAL_MAX: '200',
  });
  await server.ready;
  try {
    for (let index = 1; index <= 6; index += 1) {
      const invalid = await request({
        method: 'POST',
        path: '/api/auth/register',
        port: ratePort,
        json: accountBody({ company: '  ', email: `typo${index}@rate.example` }),
      });
      assert(invalid.status === 400, `validation failure ${index} should stay 400, got ${invalid.status} ${invalid.text}`);
    }
    const created = await request({
      method: 'POST',
      path: '/api/auth/register',
      port: ratePort,
      json: accountBody({ company: 'Typo Fixed', email: 'typo-fixed@rate.example' }),
    });
    assert(created.status === 201 && created.json && created.json.token, `validation failures should not use the success limit: ${created.status} ${created.text}`);
    console.log('PASS rate limit validation');
  } finally {
    await server.stop();
  }
}

async function runApiChecks() {
  const server = startServer(freshDb, port);
  await server.ready;
  const db = openDb(freshDb);
  try {
    const config = await request({ method: 'GET', path: '/api/auth/config' });
    assert(config.status === 200 && config.json.customer_self_signup_enabled === true, `public config should default on: ${config.text}`);

    const missingCompany = await request({ method: 'POST', path: '/api/auth/register', json: accountBody({ company: '  ' }) });
    assert(missingCompany.status === 400 && /company is required/.test(missingCompany.json.error), missingCompany.text);
    const badEmail = await request({ method: 'POST', path: '/api/auth/register', json: accountBody({ email: 'not-an-email' }) });
    assert(badEmail.status === 400 && /email is invalid/.test(badEmail.json.error), badEmail.text);
    const shortPassword = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({ password: 'short', password_confirm: 'short' }),
    });
    assert(shortPassword.status === 400 && /at least 8/.test(shortPassword.json.error), shortPassword.text);
    const longPassword = 'a'.repeat(73);
    const tooLong = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({ password: longPassword, password_confirm: longPassword }),
    });
    assert(tooLong.status === 400 && /72 bytes/.test(tooLong.json.error), tooLong.text);
    const mismatch = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({ password_confirm: 'Northwind2' }),
    });
    assert(mismatch.status === 400 && /confirmation does not match/.test(mismatch.json.error), mismatch.text);
    const badPhone = await request({ method: 'POST', path: '/api/auth/register', json: accountBody({ phone: 'call me' }) });
    assert(badPhone.status === 400 && /phone is invalid/.test(badPhone.json.error), badPhone.text);

    const beforeBot = await db.get(`SELECT COUNT(*) AS count FROM users`);
    const bot = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({ email: 'bot@northwind.example', website: 'https://spam.example' }),
    });
    assert(bot.status === 400 && bot.json.error === 'Unable to create an account', bot.text);
    assert(!/honeypot|website/i.test(bot.json.error), 'the honeypot rejection should stay generic');
    const botRow = await db.get(`SELECT id FROM users WHERE lower(email) = 'bot@northwind.example'`);
    const afterBot = await db.get(`SELECT COUNT(*) AS count FROM users`);
    assert(!botRow && afterBot.count === beforeBot.count, 'a honeypot submission must not create a user');

    const created = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({
        role: 'admin',
        department: 'Quality',
        is_active: false,
        username: 'admin',
      }),
    });
    assert(created.status === 201 && created.json && created.json.token, `register should sign the customer in: ${created.status} ${created.text}`);
    assert(created.json.user.role === 'customer', `role injection should be ignored: ${created.text}`);
    assert(created.json.user.department == null, `department injection should be ignored: ${created.text}`);
    assert(created.json.user.username === 'Ada@Northwind.example', 'the email should be the sign-in name');
    assert(created.json.user.company === 'Northwind Signs', 'company should be stored for the order form');
    assert(created.json.user.contact_name === 'Ada North', 'contact name should be stored');
    assert(created.json.user.email === 'Ada@Northwind.example', 'email should be stored');
    const stored = await db.get(
      `SELECT role, department, is_active, username, password_hash, company, contact_name
       FROM users WHERE lower(email) = 'ada@northwind.example'`
    );
    assert(stored && stored.role === 'customer' && stored.department == null && stored.is_active === 1, JSON.stringify(stored));
    assert(stored.username === 'Ada@Northwind.example' && stored.company === 'Northwind Signs' && stored.contact_name === 'Ada North', JSON.stringify(stored));
    assert(/^\$2[aby]\$/.test(stored.password_hash), 'the password should be stored with bcrypt');

    const me = await request({ method: 'GET', path: '/api/auth/me', token: created.json.token });
    assert(me.status === 200 && me.json.user.role === 'customer' && me.json.user.company === 'Northwind Signs', me.text);
    const again = await login('ada@northwind.example', 'Northwind1');
    assert(again.user.role === 'customer' && again.token, 'a later sign-in with a different email case should work');

    const duplicate = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({ email: 'ada@northwind.example', contact_name: 'Someone Else' }),
    });
    assert(duplicate.status === 409 && duplicate.json.error === 'An account with that email already exists', duplicate.text);

    const admin = await login('admin', adminPassword);
    const takenName = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'taken@shop.example',
        display_name: 'Taken Name',
        role: 'operator',
        email: 'person@shop.example',
        password: 'OperatorPass1',
        is_active: true,
      },
    });
    assert(takenName.status === 201, `staff create failed: ${takenName.status} ${takenName.text}`);
    const usernameClash = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({ email: 'Taken@Shop.example', company: 'Clash Co' }),
    });
    assert(usernameClash.status === 409 && /already exists/.test(usernameClash.json.error), usernameClash.text);
    const emailClash = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({ email: 'Person@Shop.example', company: 'Email Clash' }),
    });
    assert(emailClash.status === 409 && /already exists/.test(emailClash.json.error), emailClash.text);

    const coOne = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: { display_name: 'Co One', email: 'buyer@big.com', password: 'CoOnePass1' },
    });
    assert(coOne.status === 201, `first shared email should be saved: ${coOne.status} ${coOne.text}`);
    const coTwo = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: { display_name: 'Co Two', email: 'buyer@big.com', password: 'CoTwoPass1' },
    });
    assert(coTwo.status === 201, `admin create with a duplicate email should be 201, got ${coTwo.status} ${coTwo.text}`);
    const acmeUpper = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: { display_name: 'Acme Upper', username: 'ACME', password: 'AcmeUpper1' },
    });
    assert(acmeUpper.status === 409 && /already in use/i.test(acmeUpper.json && acmeUpper.json.error), `case-variant username should be 409, got ${acmeUpper.status} ${acmeUpper.text}`);
    const acmeGenerated = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: { display_name: 'Acme', password: 'AcmeGenPass1' },
    });
    assert(acmeGenerated.status === 201 && String(acmeGenerated.json.username).toLowerCase() === 'acme-1', `generated username should be suffixed, got ${acmeGenerated.status} ${acmeGenerated.text}`);
    const sharedStaff = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'buyerdesk',
        display_name: 'Buyer Desk',
        role: 'customer',
        email: 'buyer@big.com',
        password: 'BuyerDesk1',
        is_active: true,
      },
    });
    assert(sharedStaff.status === 201, `admin user create with a duplicate email should be 201, got ${sharedStaff.status} ${sharedStaff.text}`);
    const staffCase = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'BuyerDesk',
        display_name: 'Buyer Desk Two',
        role: 'customer',
        email: 'desk@big.com',
        password: 'BuyerDesk2',
        is_active: true,
      },
    });
    assert(staffCase.status === 409 && /already in use/i.test(staffCase.json && staffCase.json.error), `user admin case-variant username should be 409, got ${staffCase.status} ${staffCase.text}`);
    const sharedEdit = await request({
      method: 'PUT',
      path: `/api/users/${sharedStaff.json.id}`,
      token: admin.token,
      json: {
        username: 'buyerdesk',
        display_name: 'Buyer Desk',
        role: 'customer',
        email: 'ada@northwind.example',
        is_active: true,
      },
    });
    assert(sharedEdit.status === 200 && sharedEdit.json.email === 'ada@northwind.example', `admin email edit should keep a shared email, got ${sharedEdit.status} ${sharedEdit.text}`);

    await db.run(`UPDATE users SET email = ? WHERE id = ?`, ['  spaced@trim.example  ', coOne.json.id]);
    const trimmedClash = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({ company: 'Trim Co', contact_name: 'Trim Person', email: 'Spaced@Trim.example' }),
    });
    assert(trimmedClash.status === 409 && /already exists/.test(trimmedClash.json.error), `trimmed email should collide, got ${trimmedClash.status} ${trimmedClash.text}`);

    const activity = await db.get(
      `SELECT action, actor_id, entity_id, detail FROM activity_log WHERE action = 'customer.self_registered'`
    );
    assert(activity && activity.actor_id === activity.entity_id, 'self registration should record the new customer as the actor');
    const detail = JSON.parse(activity.detail);
    assert(detail.role === 'customer' && detail.message === 'New customer account: Northwind Signs', activity.detail);

    const apostrophe = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({
        company: "O'Neil Signs",
        contact_name: "Pat O'Neil",
        email: "o'neil@oneil.example",
      }),
    });
    assert(apostrophe.status === 201 && apostrophe.json.user.username === "o'neil@oneil.example", `apostrophe email should register, got ${apostrophe.status} ${apostrophe.text}`);

    const staffNotes = await request({ method: 'GET', path: '/api/notifications', token: admin.token });
    assert(staffNotes.status === 200, staffNotes.text);
    const welcome = (staffNotes.json.notifications || []).find((row) => row.title === 'New customer account: Northwind Signs');
    assert(welcome && welcome.type === 'customer_registered' && welcome.customer_id == null, JSON.stringify(staffNotes.json.notifications));
    const ownNotes = await request({ method: 'GET', path: '/api/notifications', token: created.json.token });
    assert(ownNotes.status === 200, ownNotes.text);
    assert(!(ownNotes.json.notifications || []).some((row) => row.type === 'customer_registered'), 'the new customer should not see the staff notification');

    const other = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({
        company: 'Other Workshop',
        contact_name: 'Bea Other',
        email: 'bea@otherworkshop.example',
        phone: '919-555-0199',
      }),
    });
    assert(other.status === 201 && other.json.user.role === 'customer', other.text);

    const options = await request({ method: 'GET', path: '/api/orders/options', token: created.json.token });
    assert(options.status === 200, options.text);
    const archive = (options.json.services || []).find((service) => service.name === 'Archive File Request');
    assert(archive && archive.id, 'archive service should be available');
    const order = await request({
      method: 'POST',
      path: '/api/orders',
      token: created.json.token,
      json: {
        company: 'Northwind Signs',
        contact_name: 'Ada North',
        phone: '919-555-0142',
        email: 'Ada@Northwind.example',
        project_name: 'Lobby drawings',
        originals_source: 'Archived files at Accent Imaging',
        address_line1: '10 Dock Street',
        city: 'Raleigh',
        state: 'NC',
        zip: '27601',
        delivery_method: 'Will Call',
        due_date: weekdayIso(),
        due_time: '10:00',
        payment_method: 'Cash',
        notes: 'Pull the lobby drawings from the archive.',
        service_ids: [archive.id],
      },
    });
    assert(order.status === 201 && order.json.order && order.json.order.id, `new customer should place an order: ${order.status} ${order.text}`);
    const ownOrders = await request({ method: 'GET', path: '/api/orders', token: created.json.token });
    assert(ownOrders.status === 200 && ownOrders.json.total === 1, ownOrders.text);
    assert(ownOrders.json.orders[0].id === order.json.order.id, 'the customer should see their own order');
    const hiddenOrders = await request({ method: 'GET', path: '/api/orders', token: other.json.token });
    assert(hiddenOrders.status === 200 && hiddenOrders.json.total === 0, `another customer should not see the order: ${hiddenOrders.text}`);
    const hiddenDetail = await request({
      method: 'GET',
      path: `/api/orders/${order.json.order.id}`,
      token: other.json.token,
    });
    assert(hiddenDetail.status === 404, 'another customer should not open the order');
    const externalId = order.json.work_orders && order.json.work_orders[0] && order.json.work_orders[0].external_id;
    assert(externalId, 'the order should open a work order');
    const ownWork = await request({ method: 'GET', path: '/api/workorders', token: created.json.token });
    const ownIds = (ownWork.json || []).map((row) => row.external_id);
    assert(ownIds.includes(externalId) && ownIds.length === 1, `customer work order list was ${ownIds.join(', ')}`);
    const hiddenWork = await request({ method: 'GET', path: '/api/workorders', token: other.json.token });
    const hiddenIds = (hiddenWork.json || []).map((row) => row.external_id);
    assert(!hiddenIds.includes(externalId), 'another customer should not see the work order');
    const staffOnly = await request({ method: 'GET', path: '/api/users', token: created.json.token });
    assert(staffOnly.status === 403, 'a self-registered customer should not open user admin');

    const quietToggle = await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { customer_registered: false } },
    });
    assert(quietToggle.status === 200, quietToggle.text);
    const quietCustomer = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({
        company: 'Quiet Press',
        contact_name: 'Quin Quiet',
        email: 'quin@quietpress.example',
      }),
    });
    assert(quietCustomer.status === 201, quietCustomer.text);
    const quietRow = await db.get(
      `SELECT id FROM notifications WHERE type = 'customer_registered' AND title = 'New customer account: Quiet Press'`
    );
    assert(!quietRow, 'a disabled notification event should not write a row');

    await db.run(`DELETE FROM system_settings WHERE key = 'customer_self_signup_enabled'`);
    const missing = await request({ method: 'GET', path: '/api/auth/config' });
    assert(missing.status === 200 && missing.json.customer_self_signup_enabled === true, 'a missing setting should stay on');

    const turnedOff = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: { customer_self_signup_enabled: false },
    });
    assert(turnedOff.status === 200 && turnedOff.json.customer_self_signup_enabled === false, turnedOff.text);
    assert(turnedOff.json.letterhead.company_name === 'Accent Imaging, Inc.', 'the switch should not clear the letterhead');
    const hiddenConfig = await request({ method: 'GET', path: '/api/auth/config' });
    assert(hiddenConfig.status === 200 && hiddenConfig.json.customer_self_signup_enabled === false, 'public config should hide the sign-up link');
    const refused = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: accountBody({ company: 'Closed Co', email: 'closed@closed.example' }),
    });
    assert(refused.status === 403 && /turned off/.test(refused.json.error), refused.text);
    const stillIn = await login('ada@northwind.example', 'Northwind1');
    assert(stillIn.user.role === 'customer', 'turning sign-up off should leave existing customers able to sign in');

    await renameUserCase(admin.token, 'whitebox', 'Whitebox');
    await renameUserCase(admin.token, 'admin', 'Admin');
    console.log('PASS registration');
  } finally {
    await db.close();
    await server.stop();
  }
}

async function main() {
  await checkUpgrade();
  await initDatabase(freshDb);
  await initDatabase(rateDb);
  await runApiChecks();
  await checkInitAfterCaseRename();
  await checkRateLimit({ REGISTER_RATE_IP_MAX: '2', REGISTER_RATE_GLOBAL_MAX: '50' }, 'ip');
  await checkRateLimit({ REGISTER_RATE_IP_MAX: '20', REGISTER_RATE_GLOBAL_MAX: '2' }, 'global');
  await checkValidationRateLimit();
  console.log('Phase 11 checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
