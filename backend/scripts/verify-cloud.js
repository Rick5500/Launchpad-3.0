/**
 * Cloud deploy checks: production serves the built frontend, development does not,
 * and the S3 driver works against an in-memory bucket.
 * Usage (from backend/): node scripts/verify-cloud.js
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const backendDir = path.join(__dirname, '..');

if (process.argv[2] === 's3-filestore') {
  process.env.NODE_ENV = 'test';
  const s3 = require('../storage/s3');
  s3.setTestClient(s3.createMemoryClient());
  const fileStore = require('../fileStore');
  const payload = Buffer.from('%PDF-1.4 cloud');
  const written = fileStore.writeNewFile('pdf', payload);
  if (!written || !written.storedName) {
    console.error('writeNewFile did not return a stored name');
    process.exit(1);
  }
  const opened = fileStore.openStored(written.storedName, written.storageRoot);
  if (!opened || opened.size !== payload.length) {
    console.error('openStored did not read the S3 object');
    process.exit(1);
  }
  const hash = fileStore.getStorageDriver('s3').driver.hashFileSync(opened.fullPath);
  const expect = crypto.createHash('sha256').update(payload).digest('hex');
  if (hash !== expect) {
    console.error('S3 hash mismatch');
    process.exit(1);
  }
  if (fileStore.removeStored(written.storedName, written.storageRoot) !== 'removed') {
    console.error('removeStored did not delete the S3 object');
    process.exit(1);
  }
  if (fileStore.openStored(written.storedName, written.storageRoot)) {
    console.error('deleted S3 object should be gone');
    process.exit(1);
  }
  console.log('PASS s3 fileStore');
  process.exit(0);
}

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.name = 'AssertionError';
    throw error;
  }
}

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function runSql(db, method, sql, params = []) {
  return new Promise((resolve, reject) => {
    db[method](sql, params, function onResult(err, row) {
      if (err) reject(err);
      else resolve(method === 'run' ? this : (row || (method === 'all' ? [] : null)));
    });
  });
}

function request(port, options) {
  return new Promise((resolve, reject) => {
    const body = options.body == null ? null : Buffer.from(JSON.stringify(options.body));
    const headers = { ...(options.headers || {}) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: options.path,
      method: options.method || 'GET',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (err) { json = null; }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(port, child) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 90000) {
    if (child.exitCode != null) {
      throw new Error(`server exited ${child.exitCode} before /health: ${last}`);
    }
    try {
      const health = await request(port, { path: '/health' });
      if (health.status === 200 && health.json && health.json.status === 'ok') return;
      last = health.text;
    } catch (err) {
      last = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for /health: ${last}`);
}

function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  child.log = () => log;
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('close', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
    }, 5000);
  });
}

function spawnNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
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

function cookieHeader(res) {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw.join('\n') : String(raw || '');
}

async function checkConfig() {
  const runtime = require('../runtimeConfig');
  const cookies = require('../cookies');
  withEnv({
    DATABASE_PATH: '/var/data/launchpad.db',
    DATABASE_FILE: 'database/launchpad.db',
    UPLOADS_DIR: '/var/data/uploads',
    UPLOAD_DIR: '../data/uploads',
  }, () => {
    runtime.applyPathAliases();
    assert(process.env.DATABASE_FILE === '/var/data/launchpad.db', 'DATABASE_PATH should win');
    assert(process.env.UPLOAD_DIR === '/var/data/uploads', 'UPLOADS_DIR should win');
  });
  withEnv({
    NODE_ENV: 'development',
    PUBLIC_APP_URL: '',
    COOKIE_SECURE: '',
    CORS_ORIGINS: '',
    CORS_ORIGIN: '',
  }, () => {
    assert(runtime.corsOrigins().join(',') === 'http://localhost:5173,http://localhost:5174', 'local origins should stay the default');
    assert(runtime.sessionCookiesEnabled() === false, 'development should not set a session cookie');
    assert(runtime.cookieSecure({}) === false, 'development http should not mark the cookie Secure');
    assert(runtime.shouldAutoMigrate() === false, 'development should not auto-migrate');
  });
  withEnv({
    NODE_ENV: 'production',
    PUBLIC_APP_URL: 'https://launchpad.acgprinting.com',
    COOKIE_SECURE: 'true',
    CORS_ORIGINS: 'https://shop.example',
  }, () => {
    const origins = runtime.corsOrigins();
    assert(origins.includes('http://localhost:5173'), 'localhost should remain allowed');
    assert(origins.includes('https://launchpad.acgprinting.com'), 'PUBLIC_APP_URL should be allowed');
    assert(origins.includes('https://shop.example'), 'CORS_ORIGINS should be allowed');
    assert(runtime.cookieSecure({}) === true, 'COOKIE_SECURE should force the Secure flag');
    assert(runtime.sessionCookiesEnabled() === true, 'production should set a session cookie');
    assert(runtime.shouldAutoMigrate() === true, 'production should auto-migrate');
    assert(cookies.sessionMaxAgeSeconds() >= 60, 'cookie lifetime should follow the session');
  });
  console.log('PASS config aliases, CORS, cookies, migrate flag');
}

function checkS3Driver() {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const s3 = require('../storage/s3');
  const { getStorageDriver } = require('../storage/localFolder');
  delete process.env.FILE_STORAGE_DRIVER;
  process.env.S3_BUCKET = 'ignored-until-selected';
  assert(getStorageDriver().driver.id === 'local', 'S3 env vars should not switch the driver by themselves');
  delete process.env.S3_BUCKET;
  delete process.env.S3_ACCESS_KEY_ID;
  delete process.env.S3_SECRET_ACCESS_KEY;
  const missing = getStorageDriver('s3');
  assert(missing.error && /S3_BUCKET/.test(missing.error.message), `missing S3 config should name the variables, got ${missing.error && missing.error.message}`);

  const r2 = s3.readConfig({
    S3_BUCKET: 'lp',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    S3_REGION: 'auto',
  });
  assert(!r2.error, 'R2-style config should parse');
  assert(r2.forcePathStyle === true, 'an endpoint should default to path-style');
  assert(r2.region === 'auto', 'region should be kept');
  assert(r2.prefix === 'launchpad', 'prefix should default to launchpad');
  const aws = s3.readConfig({
    S3_BUCKET: 'lp',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_PREFIX: '',
    S3_FORCE_PATH_STYLE: 'false',
  });
  assert(aws.forcePathStyle === false, 'AWS without an endpoint should use virtual-hosted style');
  assert(aws.prefix === '', 'an empty prefix should stay empty');

  const memory = s3.createMemoryClient();
  const root = '/var/data/uploads';
  const driver = s3.createS3Driver({
    client: memory,
    bucket: 'lp',
    prefix: 'launchpad',
    root,
  });
  assert(driver.locationLabel() === 's3://lp/launchpad', `location should name the bucket, got ${driver.locationLabel()}`);
  const file = path.posix.join(root, `${'a'.repeat(32)}.pdf`);
  const body = Buffer.from('pdf-bytes');
  driver.writeFileSync(file, body);
  assert(driver.statSync(file).size === body.length, 'stat should report the object size');
  assert(driver.hashFileSync(file) === crypto.createHash('sha256').update(body).digest('hex'), 'hash should match the bytes');
  const copy = path.posix.join(root, `${'b'.repeat(32)}.pdf`);
  driver.copyFileSync(file, copy);
  assert(driver.existsSync(copy), 'copy should write the destination');
  const renamed = path.posix.join(root, `${'c'.repeat(32)}.pdf`);
  driver.renameSync(copy, renamed);
  assert(!driver.existsSync(copy) && driver.existsSync(renamed), 'rename should move the object');
  const id = crypto.randomBytes(16).toString('hex');
  driver.writeMarkerSync(root, id);
  assert(driver.readMarkerSync(root) === id, 'marker should round-trip');
  assert(driver.status(root, id).reachable === true, 'a matching marker should be reachable');
  assert(driver.listNamesSync(root).includes(`${'a'.repeat(32)}.pdf`), 'list should include the file name');
  let missingFile = false;
  try { driver.statSync(path.posix.join(root, `${'d'.repeat(32)}.pdf`)); } catch (err) { missingFile = err.code === 'ENOENT'; }
  assert(missingFile, 'a missing object should be ENOENT');
  const unknown = getStorageDriver('sharepoint');
  assert(unknown.error && /SharePoint/i.test(unknown.error.message) && /OneDrive/i.test(unknown.error.message), 'an unknown driver should still name OneDrive and SharePoint');
  const readme = fs.readFileSync(path.join(backendDir, 'storage', 'README.md'), 'utf8');
  assert(/OneDrive/i.test(readme) && /SharePoint/i.test(readme), 'the storage README should still mention OneDrive and SharePoint');
  if (previousNodeEnv == null) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  console.log('PASS s3 driver');
}

async function checkBackup() {
  const backup = require('../backup');
  assert(backup.backupEnabled() === false, 'backup should be off by default');
  assert(backup.start() == null, 'the scheduler should not start while backup is off');
  const expired = backup.selectExpired([
    'launchpad-20260101-010101.db',
    'launchpad-20260102-010101.db',
    'launchpad-20260103-010101.db',
    'notes.txt',
  ], 2);
  assert(expired.join(',') === 'launchpad-20260101-010101.db', `retention should drop the oldest, got ${expired.join(',')}`);
  assert(backup.backupDue(new Date('2026-06-09T12:00:00Z'), '', 2, 'UTC') === true, 'a missing backup after the hour should be due');
  assert(backup.backupDue(new Date('2026-06-09T00:30:00Z'), '', 2, 'UTC') === false, 'before the hour should wait');
  assert(backup.backupDue(new Date('2026-06-09T12:00:00Z'), '2026-06-09 03:00:00', 2, 'UTC') === false, 'one backup per shop day');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cloud-backup-'));
  const sourceFile = path.join(tmp, 'live.db');
  const copyFile = path.join(tmp, 'copy.db');
  const db = new sqlite3.Database(sourceFile);
  await runSql(db, 'run', 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  await runSql(db, 'run', 'INSERT INTO notes (body) VALUES (?)', ['kept']);
  await backup.backupDatabase(db, copyFile);
  await runSql(db, 'run', 'INSERT INTO notes (body) VALUES (?)', ['after']);
  const copy = new sqlite3.Database(copyFile);
  const copied = await runSql(copy, 'all', 'SELECT body FROM notes ORDER BY id');
  const live = await runSql(db, 'all', 'SELECT body FROM notes ORDER BY id');
  assert(copied.length === 1 && copied[0].body === 'kept', 'online backup should be a snapshot');
  assert(live.length === 2, 'the live database should stay writable during backup');
  await runSql(copy, 'run', 'CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME)');
  await new Promise((resolve) => copy.close(() => resolve()));

  const uploadRoot = path.join(tmp, 'uploads');
  fs.mkdirSync(uploadRoot);
  const localDb = new sqlite3.Database(path.join(tmp, 'local.db'));
  await runSql(localDb, 'run', 'CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME)');
  await runSql(localDb, 'run', 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  await runSql(localDb, 'run', 'INSERT INTO notes (body) VALUES (?)', ['local']);
  const localResult = await backup.runBackup({
    db: localDb,
    destination: 'dir',
    root: uploadRoot,
    now: new Date('2026-06-09T08:00:00Z'),
    timeZone: 'UTC',
    keep: 2,
  });
  assert(fs.existsSync(path.join(uploadRoot, 'backups', localResult.filename)), 'local backup file should be in uploads/backups');
  const recorded = await backup.readLastBackup(localDb);
  assert(recorded === '2026-06-09 08:00:00', `last_backup_at should be stored, got ${recorded}`);

  const s3 = require('../storage/s3');
  const memory = s3.createMemoryClient();
  const driver = s3.createS3Driver({ client: memory, bucket: 'lp', prefix: 'launchpad', root: uploadRoot });
  fs.writeFileSync(path.join(uploadRoot, 'backups', 'launchpad-20260101-010101.db'), 'old');
  driver.writeFileSync(path.join(uploadRoot, 'backups', 'launchpad-20260101-010101.db'), Buffer.from('old'));
  driver.writeFileSync(path.join(uploadRoot, 'backups', 'launchpad-20260102-010101.db'), Buffer.from('older'));
  const s3Db = new sqlite3.Database(path.join(tmp, 's3.db'));
  await runSql(s3Db, 'run', 'CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME)');
  await runSql(s3Db, 'run', 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  await runSql(s3Db, 'run', 'INSERT INTO notes (body) VALUES (?)', ['remote']);
  const remote = await backup.runBackup({
    db: s3Db,
    destination: 's3',
    driver,
    root: uploadRoot,
    now: new Date('2026-06-10T08:00:00Z'),
    timeZone: 'UTC',
    keep: 2,
  });
  const names = driver.listNamesSync(path.join(uploadRoot, 'backups'));
  assert(names.includes(remote.filename), `S3 backup should be listed, got ${names.join(',')}`);
  assert(!names.includes('launchpad-20260101-010101.db'), 'S3 retention should delete the oldest backup');
  assert(names.includes('launchpad-20260102-010101.db'), 'S3 retention should keep the newer existing backup');
  await new Promise((resolve) => db.close(() => resolve()));
  await new Promise((resolve) => localDb.close(() => resolve()));
  await new Promise((resolve) => s3Db.close(() => resolve()));
  console.log('PASS sqlite backup and retention');
}

async function checkRelocate() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cloud-relocate-'));
  const dbFile = path.join(tmp, 'launchpad.db');
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads);
  const stored = `${crypto.randomBytes(16).toString('hex')}.pdf`;
  fs.writeFileSync(path.join(uploads, stored), 'file');
  const db = new sqlite3.Database(dbFile);
  await runSql(db, 'run', 'CREATE TABLE order_files (id INTEGER PRIMARY KEY, stored_name TEXT, storage_root TEXT)');
  await runSql(db, 'run', 'CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME)');
  await runSql(db, 'run', 'CREATE TABLE file_storage_roots (path TEXT PRIMARY KEY, created_at DATETIME)');
  await runSql(db, 'run', 'INSERT INTO order_files (stored_name, storage_root) VALUES (?, ?)', [stored, 'C:\\ACG\\uploads']);
  await new Promise((resolve) => db.close(() => resolve()));

  const env = {
    DATABASE_PATH: dbFile,
    UPLOADS_DIR: uploads,
    NODE_ENV: 'test',
    FILE_STORAGE_DRIVER: '',
  };
  const dry = await spawnNode(['scripts/relocate-storage.js'], env);
  assert(dry.code === 0, `relocate dry-run failed: ${dry.err || dry.out}`);
  assert(/"updated": 1/.test(dry.out), `dry-run should count the Windows path, got ${dry.out}`);
  const before = new sqlite3.Database(dbFile);
  const still = await runSql(before, 'get', 'SELECT storage_root FROM order_files');
  await new Promise((resolve) => before.close(() => resolve()));
  assert(still.storage_root === 'C:\\ACG\\uploads', 'dry-run should not rewrite the row');

  const applied = await spawnNode(['scripts/relocate-storage.js', '--apply'], env);
  assert(applied.code === 0, `relocate --apply failed: ${applied.err || applied.out}`);
  const afterDb = new sqlite3.Database(dbFile);
  const after = await runSql(afterDb, 'get', 'SELECT storage_root FROM order_files');
  const setting = await runSql(afterDb, 'get', `SELECT value FROM system_settings WHERE key = 'file_storage_dir'`);
  await new Promise((resolve) => afterDb.close(() => resolve()));
  assert(after.storage_root === uploads, `storage root should be the new folder, got ${after.storage_root}`);
  assert(setting.value === uploads, 'file storage setting should follow UPLOADS_DIR');
  assert(fs.existsSync(path.join(uploads, '.launchpad-storage')), 'apply should write the storage marker');
  console.log('PASS storage relocate');
}

async function checkServers() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cloud-http-'));
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  const marker = 'LAUNCHPAD_SPA_MARKER';
  fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><html><body>${marker}</body></html>`);
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'ASSET_OK');
  const prodDb = path.join(tmp, 'disk', 'nested', 'launchpad.db');
  const prodUploads = path.join(tmp, 'disk', 'uploads');
  const prodPort = 3195;
  const child = startServer({
    NODE_ENV: 'production',
    PORT: String(prodPort),
    DATABASE_PATH: prodDb,
    DATABASE_FILE: '',
    UPLOADS_DIR: prodUploads,
    UPLOAD_DIR: '',
    PUBLIC_APP_URL: 'https://launchpad.acgprinting.com',
    TRUST_PROXY: '1',
    COOKIE_SECURE: 'true',
    FRONTEND_DIST: dist,
    INIT_ADMIN_PASSWORD: 'AdminPass123',
    DELIVERY_TIMEZONE: 'UTC',
    FILE_STORAGE_DRIVER: '',
    BACKUP_ENABLED: '',
    M365_TENANT_ID: '',
    M365_CLIENT_ID: '',
    M365_CLIENT_SECRET: '',
    M365_MAILBOX: '',
  });
  try {
    await waitFor(prodPort, child);
    assert(fs.existsSync(prodDb), 'production startup should create the database from DATABASE_PATH');
    assert(fs.existsSync(prodUploads), 'production startup should create UPLOADS_DIR');
    const home = await request(prodPort, { path: '/' });
    assert(home.status === 200 && home.text.includes(marker), 'production / should serve the frontend');
    const spa = await request(prodPort, { path: '/orders/5' });
    assert(spa.status === 200 && spa.text.includes(marker), 'production client routes should fall back to index.html');
    const asset = await request(prodPort, { path: '/assets/app.js' });
    assert(asset.status === 200 && asset.text.includes('ASSET_OK'), 'production should serve built assets');
    const missingAsset = await request(prodPort, { path: '/assets/missing.js' });
    assert(missingAsset.status === 404 && !missingAsset.text.includes(marker), 'a missing asset should not return the SPA');
    const health = await request(prodPort, { path: '/api/health' });
    assert(health.status === 200 && health.json.status === 'ok', 'API health should stay JSON');
    const unknown = await request(prodPort, { path: '/api/does-not-exist' });
    assert(unknown.status === 404 && unknown.json && unknown.json.error === 'Not found', `unknown API should be JSON 404, got ${unknown.status} ${unknown.text}`);
    const allowed = await request(prodPort, {
      path: '/api/health',
      headers: { Origin: 'https://launchpad.acgprinting.com' },
    });
    assert(allowed.headers['access-control-allow-origin'] === 'https://launchpad.acgprinting.com', 'PUBLIC_APP_URL should be a CORS origin');
    const localOrigin = await request(prodPort, {
      path: '/api/health',
      headers: { Origin: 'http://localhost:5173' },
    });
    assert(localOrigin.headers['access-control-allow-origin'] === 'http://localhost:5173', 'the Vite origin should stay allowed');
    const blocked = await request(prodPort, {
      path: '/api/health',
      headers: { Origin: 'https://evil.example' },
    });
    assert(blocked.headers['access-control-allow-origin'] !== 'https://evil.example', 'an unknown origin should not be reflected');

    const login = await request(prodPort, {
      method: 'POST',
      path: '/api/auth/login',
      body: { username: 'admin', password: 'AdminPass123' },
    });
    assert(login.status === 200 && login.json && login.json.token, `admin login failed: ${login.status} ${login.text}`);
    const setCookie = cookieHeader(login);
    assert(/lp_session=/.test(setCookie), `login should set a session cookie, got ${setCookie}`);
    assert(/HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), `cookie should be HttpOnly, Secure, and SameSite=Lax, got ${setCookie}`);
    const token = /lp_session=([^;]+)/.exec(setCookie)[1];
    const me = await request(prodPort, {
      path: '/api/auth/me',
      headers: { Cookie: `lp_session=${token}` },
    });
    assert(me.status === 200 && me.json && me.json.user && me.json.user.username === 'admin', `cookie should authenticate, got ${me.status} ${me.text}`);
    const logout = await request(prodPort, {
      method: 'POST',
      path: '/api/auth/logout',
      headers: { Cookie: `lp_session=${token}` },
    });
    assert(/Max-Age=0/.test(cookieHeader(logout)), 'logout should clear the cookie');
    const after = await request(prodPort, {
      path: '/api/auth/me',
      headers: { Cookie: `lp_session=${token}` },
    });
    assert(after.status === 401, 'the cleared session should not authenticate');
    console.log('PASS production server');
  } catch (err) {
    err.message += `\n--- server log ---\n${child.log()}`;
    throw err;
  } finally {
    await stopServer(child);
  }

  const devDb = path.join(tmp, 'dev.db');
  const devUploads = path.join(tmp, 'dev-uploads');
  fs.mkdirSync(devUploads);
  const devPort = 3196;
  const dev = startServer({
    NODE_ENV: 'test',
    PORT: String(devPort),
    DATABASE_FILE: devDb,
    DATABASE_PATH: '',
    UPLOAD_DIR: devUploads,
    UPLOADS_DIR: '',
    FRONTEND_DIST: dist,
    PUBLIC_APP_URL: '',
    COOKIE_SECURE: '',
    FILE_STORAGE_DRIVER: '',
    BACKUP_ENABLED: '',
    AUTO_MIGRATE: '',
    M365_TENANT_ID: '',
    M365_CLIENT_ID: '',
    M365_CLIENT_SECRET: '',
    M365_MAILBOX: '',
  });
  try {
    await waitFor(devPort, dev);
    const home = await request(devPort, { path: '/' });
    assert(home.status === 404 && !home.text.includes(marker), 'development should not serve the frontend');
    const health = await request(devPort, { path: '/api/health' });
    assert(health.status === 200 && health.json.status === 'ok', 'development API should still answer');
    const probe = new sqlite3.Database(devDb);
    const tables = await runSql(probe, 'all', `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`);
    await new Promise((resolve) => probe.close(() => resolve()));
    assert(tables.length === 0, 'development startup should not run init_db');
    console.log('PASS development server unchanged');
  } catch (err) {
    err.message += `\n--- server log ---\n${dev.log()}`;
    throw err;
  } finally {
    await stopServer(dev);
  }
}

async function main() {
  await checkConfig();
  checkS3Driver();
  const remote = require('../storage/s3Remote');
  const ping = remote.syncCall('ping', {}, {});
  assert(ping.meta && ping.meta.pong === true, 'S3 worker bridge should answer a ping');
  remote.closeRemote();
  console.log('PASS s3 worker bridge');
  await checkBackup();
  await checkRelocate();
  const integrated = await spawnNode([path.join('scripts', 'verify-cloud.js'), 's3-filestore'], {
    NODE_ENV: 'test',
    FILE_STORAGE_DRIVER: 's3',
    UPLOAD_DIR: path.join(os.tmpdir(), 'lp-cloud-s3-uploads'),
    S3_BUCKET: 'launchpad-test',
    S3_ACCESS_KEY_ID: 'AKIATEST',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    S3_REGION: 'auto',
    DATABASE_FILE: path.join(os.tmpdir(), 'lp-cloud-s3-unused.db'),
  });
  assert(integrated.code === 0, `s3 fileStore child failed: ${integrated.err || integrated.out}`);
  console.log(integrated.out.trim());
  await checkServers();
  console.log('Cloud deploy checks passed.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
