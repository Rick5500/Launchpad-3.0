/**
 * Phase 19 checks: an admin chooses the folder where files are stored.
 * The folder can be a local path, a mapped drive, or a network share.
 * Old files keep their original folder. Move copies, checks size, then deletes.
 * Usage (from backend/): node scripts/verify-phase19.js
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase19-'));
const dbFile = path.join(tmp, 'phase19.db');
const uploadDir = path.join(tmp, 'uploads');
const port = 3169;
const adminPassword = 'AdminPass123';
const operatorPassword = 'OperatorPass1';

process.env.DATABASE_FILE = dbFile;
process.env.UPLOAD_DIR = uploadDir;
delete process.env.FILE_STORAGE_DRIVER;

const fileStore = require('../fileStore');

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

function storedName(ext = 'pdf') {
  return `${crypto.randomBytes(16).toString('hex')}.${ext}`;
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

function baseEnv(extra = {}) {
  return {
    DATABASE_FILE: dbFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    DELIVERY_TIMEZONE: 'UTC',
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: uploadDir,
    UPLOAD_ORPHAN_HOURS: '24',
    UPLOAD_SWEEP_INTERVAL_SECONDS: '3600',
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
    ...extra,
  };
}

function request({ method, path: requestPath, token, json, raw, contentType, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const body = raw || (json != null ? Buffer.from(JSON.stringify(json)) : null);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) {
      headers['Content-Type'] = contentType || 'application/json';
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
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
        resolve({ status: res.statusCode, json: parsed, text, buffer, headers: res.headers });
      });
    });
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`request timed out after ${timeoutMs}ms: ${method} ${requestPath}`));
      });
    }
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function multipart(files) {
  const boundary = `----Launchpad${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
    ));
    chunks.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    raw: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...baseEnv() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const closed = new Promise((resolve) => {
    child.on('close', () => resolve());
  });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not become ready\n${logs}`));
    }, 15000);
    const poll = async () => {
      try {
        const health = await request({ method: 'GET', path: '/api/health' });
        if (health.status === 200 && health.json && health.json.status === 'ok') {
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
    closed,
    stop() {
      child.kill('SIGTERM');
    },
  };
}

async function initDatabase() {
  const result = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  if (result.code !== 0) throw new Error(`init_db failed (${result.code})\n${result.out}\n${result.err}`);
}

async function login(username, password) {
  const response = await request({
    method: 'POST',
    path: '/api/auth/login',
    json: { username, password },
  });
  assert(response.status === 200 && response.json && response.json.token, `login failed for ${username}: ${response.text}`);
  return response.json.token;
}

function checkPathRules() {
  for (const value of ['uploads', 'data/uploads', '../data/uploads', './uploads', 'Z:launchpad']) {
    const parsed = fileStore.parseStoragePath(value);
    assert(parsed.error && /absolute path/i.test(parsed.error), `relative path should be rejected: ${value} (${parsed.error})`);
  }
  const unc = fileStore.parseStoragePath('\\\\server\\share\\launchpad');
  assert(unc.path === '\\\\server\\share\\launchpad', `UNC path should stay absolute, got ${unc.path || unc.error}`);
  const drive = fileStore.parseStoragePath('Z:\\launchpad');
  assert(drive.path === 'Z:\\launchpad', `mapped drive should stay absolute, got ${drive.path || drive.error}`);
  const slashDrive = fileStore.parseStoragePath('z:/launchpad');
  assert(slashDrive.path === 'Z:\\launchpad', `drive slash form should normalize, got ${slashDrive.path || slashDrive.error}`);
  const forwardUnc = fileStore.parseStoragePath('//server/share/launchpad');
  assert(forwardUnc.path === '\\\\server\\share\\launchpad', `forward UNC should normalize, got ${forwardUnc.path || forwardUnc.error}`);
  const bare = fileStore.parseStoragePath('\\\\server');
  assert(bare.error && /server and the share/i.test(bare.error), 'a share without a folder name should say what is missing');

  const traversal = fileStore.safeStoredPath(`../${'a'.repeat(32)}.pdf`);
  assert(traversal == null, 'a stored name must not escape the folder');
  const absoluteName = fileStore.safeStoredPath(`/tmp/${'b'.repeat(32)}.pdf`);
  assert(absoluteName == null, 'a stored name must not be a path');
  const driver = fileStore.getStorageDriver('sharepoint');
  assert(driver.error && /SharePoint/i.test(driver.error.message) && /OneDrive/i.test(driver.error.message), 'an unknown driver should name the cloud drivers that are not built');
  assert(fileStore.getStorageDriver('local').driver.id === 'local', 'the local folder driver should be available');
  const readme = fs.readFileSync(path.join(backendDir, 'storage', 'README.md'), 'utf8');
  assert(/OneDrive/i.test(readme) && /SharePoint/i.test(readme), 'the storage README should say a cloud driver can be added later');
  console.log('PASS path rules and storage driver');
}

async function main() {
  checkPathRules();
  await initDatabase();
  const db = openDb(dbFile);
  for (const table of ['order_files', 'shared_files', 'proof_files', 'inbound_email_attachments']) {
    const columns = new Set((await db.all(`PRAGMA table_info(${table})`)).map((row) => row.name));
    assert(columns.has('storage_root'), `${table}.storage_root should exist`);
    assert(columns.has('storage_previous'), `${table}.storage_previous should exist`);
  }
  await db.close();
  console.log('PASS storage columns');

  fs.mkdirSync(uploadDir, { recursive: true });
  const server = startServer();
  try {
    await server.ready;
    const admin = await login('admin', adminPassword);
    const createdOperator = await request({
      method: 'POST',
      path: '/api/users',
      token: admin,
      json: { username: 'phase19op', display_name: 'Phase 19 Op', role: 'operator', password: operatorPassword },
    });
    assert(createdOperator.status === 201, `operator create failed: ${createdOperator.text}`);
    const operator = await login('phase19op', operatorPassword);

    const anon = await request({ method: 'GET', path: '/api/settings' });
    assert(anon.status === 401, 'settings should require a sign-in');
    const opGet = await request({ method: 'GET', path: '/api/settings', token: operator });
    assert(opGet.status === 403, 'an operator should not open system settings');
    const opPut = await request({
      method: 'PUT',
      path: '/api/settings/file-storage',
      token: operator,
      json: { path: uploadDir },
    });
    assert(opPut.status === 403, 'an operator should not change the storage folder');

    const initial = await request({ method: 'GET', path: '/api/settings', token: admin });
    assert(initial.status === 200, `settings failed: ${initial.text}`);
    assert(initial.json.file_storage, 'settings should include file storage');
    assert(initial.json.file_storage.source === 'environment', `storage should follow UPLOAD_DIR first, got ${initial.json.file_storage.source}`);
    assert(path.resolve(initial.json.file_storage.path) === path.resolve(uploadDir), `storage path should be the upload dir, got ${initial.json.file_storage.path}`);
    assert(initial.json.file_storage.reachable === true, 'the upload dir should be reachable');
    assert(Number.isFinite(initial.json.file_storage.free_bytes) && initial.json.file_storage.free_bytes >= 0, 'free space should be reported');
    assert(initial.json.file_storage.free_label, 'free space should have a label');
    assert(!initial.json.file_storage.warning, 'a reachable folder should not warn');
    const storedKey = await openDb(dbFile);
    const beforeKey = await storedKey.get(`SELECT value FROM system_settings WHERE key = 'file_storage_dir'`);
    assert(!beforeKey, 'the database should not override UPLOAD_DIR until an admin saves a folder');
    await storedKey.close();

    const codeDir = path.join(backendDir, 'phase19-hidden');
    const sneaky = `${path.dirname(backendDir)}/backend/../backend/phase19-sneaky`;
    const frontendDir = path.join(backendDir, '..', 'frontend', 'phase19-hidden');
    const linkDir = path.join(tmp, 'link-to-backend');
    fs.symlinkSync(backendDir, linkDir);
    const rejected = [
      ['uploads', /absolute path/i],
      ['../data/uploads', /absolute path/i],
      [codeDir, /application code/i],
      [sneaky, /application code/i],
      [frontendDir, /application code/i],
      [path.join(linkDir, 'uploads'), /application code/i],
      ['\\\\server\\share\\launchpad', /not reachable or is not writable/i],
      ['Z:\\launchpad', /not reachable or is not writable/i],
      ['//files/share/launchpad', /not reachable or is not writable/i],
    ];
    for (const [folder, pattern] of rejected) {
      const response = await request({
        method: 'PUT',
        path: '/api/settings/file-storage',
        token: admin,
        json: { path: folder },
      });
      assert(response.status === 400, `expected 400 for ${folder}, got ${response.status} ${response.text}`);
      assert(response.json && pattern.test(response.json.error || ''), `unclear error for ${folder}: ${response.text}`);
    }
    assert(!fs.existsSync(codeDir), 'a rejected code path must not be created');
    assert(!fs.existsSync(path.join(backendDir, 'phase19-sneaky')), 'a rejected sneaky path must not be created');
    assert(!fs.existsSync(frontendDir), 'a rejected frontend path must not be created');
    const health = await request({ method: 'GET', path: '/api/health' });
    assert(health.status === 200 && health.json.status === 'ok', 'a rejected folder must not stop the server');

    const createdDir = path.join(tmp, 'created-store');
    assert(!fs.existsSync(createdDir), 'the new folder should start missing');
    const saved = await request({
      method: 'PUT',
      path: '/api/settings/file-storage',
      token: admin,
      json: { path: `${createdDir}/` },
    });
    assert(saved.status === 200, `save failed: ${saved.text}`);
    assert(saved.json.file_storage.source === 'settings', 'a saved folder should outrank UPLOAD_DIR');
    assert(saved.json.file_storage.path === createdDir, `saved path should be absolute with no trailing slash, got ${saved.json.file_storage.path}`);
    assert(saved.json.file_storage.reachable === true, 'the new folder should be reachable');
    assert(fs.statSync(createdDir).isDirectory(), 'the new folder should be created');
    const probeLeft = fs.readdirSync(createdDir).filter((name) => name.includes('launchpad-write-test'));
    assert(probeLeft.length === 0, 'the write test file should be deleted');
    const keyDb = openDb(dbFile);
    const keyRow = await keyDb.get(`SELECT value FROM system_settings WHERE key = 'file_storage_dir'`);
    assert(keyRow && keyRow.value === createdDir, 'the folder should be stored in system_settings');
    const activity = await keyDb.get(
      `SELECT action, detail FROM activity_log WHERE action = 'settings.updated' AND detail LIKE '%file_storage_dir%' ORDER BY id DESC LIMIT 1`
    );
    assert(activity, 'saving the folder should write an activity row');
    await keyDb.close();

    const legacyName = storedName();
    const legacyBytes = Buffer.from('%PDF-1.4 legacy-bytes');
    fs.writeFileSync(path.join(uploadDir, legacyName), legacyBytes);
    const seed = openDb(dbFile);
    const legacyInsert = await seed.run(
      `INSERT INTO order_files (original_name, stored_name, size_bytes, storage_root)
       VALUES ('legacy.pdf', ?, ?, NULL)`,
      [legacyName, legacyBytes.length]
    );
    await seed.close();
    const legacyDownload = await request({
      method: 'GET',
      path: `/api/uploads/${legacyInsert.lastID}/download`,
      token: admin,
    });
    assert(legacyDownload.status === 200, `old file should download after the folder change: ${legacyDownload.text}`);
    assert(legacyDownload.buffer.equals(legacyBytes), 'the old file should still be the original bytes');
    assert(!legacyDownload.text.includes(uploadDir), 'a download should not print the storage folder');

    const uploadBody = multipart([{ name: '../../etc/passwd.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 new-folder') }]);
    const uploaded = await request({
      method: 'POST',
      path: '/api/uploads',
      token: admin,
      raw: uploadBody.raw,
      contentType: uploadBody.contentType,
    });
    assert(uploaded.status === 201, `upload failed: ${uploaded.text}`);
    assert(!uploaded.text.includes(createdDir), 'an upload response should not reveal the storage folder');
    const uploadDb = openDb(dbFile);
    const uploadRow = await uploadDb.get('SELECT stored_name, storage_root FROM order_files WHERE id = ?', [uploaded.json.files[0].id]);
    await uploadDb.close();
    assert(uploadRow.storage_root === createdDir, 'a new file should record the folder it was written to');
    assert(fs.existsSync(path.join(createdDir, uploadRow.stored_name)), 'the new file should be in the saved folder');
    assert(!fs.existsSync(path.join(uploadDir, uploadRow.stored_name)), 'the new file should not be written to the old folder');
    assert(!uploadRow.stored_name.includes('passwd'), 'the stored name should not keep a path');

    const cleared = await request({
      method: 'PUT',
      path: '/api/settings/file-storage',
      token: admin,
      json: { path: '' },
    });
    assert(cleared.status === 200, `clear failed: ${cleared.text}`);
    assert(cleared.json.file_storage.source === 'environment', 'clearing the setting should follow UPLOAD_DIR again');
    assert(path.resolve(cleared.json.file_storage.path) === path.resolve(uploadDir), 'the current folder should be UPLOAD_DIR again');
    const clearedDb = openDb(dbFile);
    const clearedKey = await clearedDb.get(`SELECT value FROM system_settings WHERE key = 'file_storage_dir'`);
    await clearedDb.close();
    assert(!clearedKey, 'clearing the folder should remove the database setting');
    const stillThere = await request({
      method: 'GET',
      path: `/api/uploads/${legacyInsert.lastID}/download`,
      token: admin,
    });
    assert(stillThere.status === 200 && stillThere.buffer.equals(legacyBytes), 'clearing the setting should keep the original file readable');
    const stillNew = await request({
      method: 'GET',
      path: `/api/uploads/${uploaded.json.files[0].id}/download`,
      token: admin,
    });
    assert(stillNew.status === 200, 'a file saved in the other folder should still download');

    const moveDir = path.join(tmp, 'moved-store');
    const movedSetting = await request({
      method: 'PUT',
      path: '/api/settings/file-storage',
      token: admin,
      json: { path: moveDir },
    });
    assert(movedSetting.status === 200 && movedSetting.json.file_storage.path === moveDir, `move folder save failed: ${movedSetting.text}`);

    const alpha = Buffer.from('alpha-file');
    const bravo = Buffer.from('bravo-file-ok');
    const charlie = Buffer.from('charlie-shared');
    const delta = Buffer.from('delta-proof');
    const echo = Buffer.from('echo-mail');
    const mismatch = Buffer.from('bad');
    const names = {
      alpha: storedName(),
      bravo: storedName(),
      charlie: storedName(),
      delta: storedName(),
      echo: storedName(),
      mismatch: storedName(),
      missing: storedName(),
    };
    fs.writeFileSync(path.join(uploadDir, names.alpha), alpha);
    fs.copyFileSync(path.join(uploadDir, names.alpha), path.join(moveDir, names.alpha));
    fs.writeFileSync(path.join(uploadDir, names.bravo), bravo);
    fs.copyFileSync(path.join(uploadDir, names.bravo), path.join(moveDir, names.bravo));
    fs.writeFileSync(path.join(uploadDir, names.charlie), charlie);
    fs.writeFileSync(path.join(uploadDir, names.delta), delta);
    fs.writeFileSync(path.join(uploadDir, names.echo), echo);
    fs.writeFileSync(path.join(uploadDir, names.mismatch), mismatch);

    const rows = openDb(dbFile);
    const alphaRow = await rows.run(
      `INSERT INTO order_files (original_name, stored_name, size_bytes) VALUES ('alpha.pdf', ?, ?)`,
      [names.alpha, alpha.length]
    );
    const bravoRow = await rows.run(
      `INSERT INTO order_files (original_name, stored_name, size_bytes, storage_root, storage_previous)
       VALUES ('bravo.pdf', ?, ?, ?, ?)`,
      [names.bravo, bravo.length, moveDir, uploadDir]
    );
    const sharedRow = await rows.run(
      `INSERT INTO shared_files (original_name, stored_name, size_bytes) VALUES ('shared.pdf', ?, ?)`,
      [names.charlie, charlie.length]
    );
    const proofRow = await rows.run(
      `INSERT INTO proof_files (proof_id, original_name, stored_name, size_bytes) VALUES (1, 'proof.pdf', ?, ?)`,
      [names.delta, delta.length]
    );
    const mailRow = await rows.run(
      `INSERT INTO inbound_email_attachments (inbound_email_id, original_name, stored_name, size_bytes)
       VALUES (1, 'mail.pdf', ?, ?)`,
      [names.echo, echo.length]
    );
    const mismatchRow = await rows.run(
      `INSERT INTO order_files (original_name, stored_name, size_bytes) VALUES ('mismatch.pdf', ?, 99)`,
      [names.mismatch]
    );
    await rows.run(
      `INSERT INTO order_files (original_name, stored_name, size_bytes) VALUES ('missing.pdf', ?, 4)`,
      [names.missing]
    );
    await rows.close();

    const firstMove = await request({ method: 'POST', path: '/api/settings/file-storage/move', token: admin });
    assert(firstMove.status === 200, `move failed: ${firstMove.text}`);
    assert(firstMove.json.moved >= 4, `expected the prepared files to move, got ${firstMove.text}`);
    assert(firstMove.json.missing >= 1, `a missing file should be reported, got ${firstMove.text}`);
    assert(firstMove.json.failed >= 1, `a size mismatch should fail, got ${firstMove.text}`);
    assert(!fs.existsSync(path.join(uploadDir, names.alpha)), 'a file copied before the record update should not leave the original');
    assert(fs.readFileSync(path.join(moveDir, names.alpha)).equals(alpha), 'the resumed copy should match');
    assert(!fs.existsSync(path.join(uploadDir, names.bravo)), 'an interrupted delete should be finished');
    assert(fs.readFileSync(path.join(moveDir, names.bravo)).equals(bravo), 'the interrupted file should stay in the new folder');
    assert(!fs.existsSync(path.join(uploadDir, names.charlie)), 'the shared file original should be removed only after the move');
    assert(fs.readFileSync(path.join(moveDir, names.charlie)).equals(charlie), 'the shared file should match');
    assert(fs.readFileSync(path.join(moveDir, names.delta)).equals(delta), 'the proof file should match');
    assert(fs.readFileSync(path.join(moveDir, names.echo)).equals(echo), 'the email attachment should match');
    assert(fs.existsSync(path.join(uploadDir, names.mismatch)), 'a size mismatch must keep the original');
    assert(!fs.existsSync(path.join(moveDir, names.mismatch)), 'a size mismatch must not replace the new folder');

    const afterMove = openDb(dbFile);
    const alphaSaved = await afterMove.get('SELECT storage_root, storage_previous FROM order_files WHERE id = ?', [alphaRow.lastID]);
    const bravoSaved = await afterMove.get('SELECT storage_root, storage_previous FROM order_files WHERE id = ?', [bravoRow.lastID]);
    const sharedSaved = await afterMove.get('SELECT storage_root, storage_previous FROM shared_files WHERE id = ?', [sharedRow.lastID]);
    const proofSaved = await afterMove.get('SELECT storage_root, storage_previous FROM proof_files WHERE id = ?', [proofRow.lastID]);
    const mailSaved = await afterMove.get('SELECT storage_root, storage_previous FROM inbound_email_attachments WHERE id = ?', [mailRow.lastID]);
    const mismatchSaved = await afterMove.get('SELECT storage_root FROM order_files WHERE id = ?', [mismatchRow.lastID]);
    const moveActivity = await afterMove.get(`SELECT id FROM activity_log WHERE action = 'settings.file_storage_moved' ORDER BY id DESC LIMIT 1`);
    await afterMove.close();
    for (const savedRow of [alphaSaved, bravoSaved, sharedSaved, proofSaved, mailSaved]) {
      assert(savedRow.storage_root === moveDir, `moved row should record ${moveDir}, got ${savedRow.storage_root}`);
      assert(savedRow.storage_previous == null, 'storage_previous should be cleared after the original is deleted');
    }
    assert(mismatchSaved.storage_root == null, 'a failed file should keep its original folder');
    assert(moveActivity, 'the move should be recorded');

    const alphaDownload = await request({
      method: 'GET',
      path: `/api/uploads/${alphaRow.lastID}/download`,
      token: admin,
    });
    assert(alphaDownload.status === 200 && alphaDownload.buffer.equals(alpha), 'a moved file should download from the new folder');

    const secondMove = await request({ method: 'POST', path: '/api/settings/file-storage/move', token: admin });
    assert(secondMove.status === 200, `second move failed: ${secondMove.text}`);
    assert(secondMove.json.moved === 0, `a second move should not copy again, got ${secondMove.text}`);
    assert(fs.readFileSync(path.join(moveDir, names.charlie)).equals(charlie), 'a second move should leave the copied file in place');
    assert(fs.existsSync(path.join(uploadDir, names.mismatch)), 'a second move should still keep the mismatched original');

    fs.rmSync(moveDir, { recursive: true, force: true });
    fs.writeFileSync(moveDir, 'not a directory');
    const blocked = await request({
      method: 'POST',
      path: '/api/uploads',
      token: admin,
      raw: uploadBody.raw,
      contentType: uploadBody.contentType,
    });
    assert(blocked.status === 503, `an unreachable folder should reject uploads with 503, got ${blocked.status} ${blocked.text}`);
    assert(blocked.json && /cannot be reached/i.test(blocked.json.error || ''), `503 should explain the folder, got ${blocked.text}`);
    const warned = await request({ method: 'GET', path: '/api/settings', token: admin });
    assert(warned.status === 200, `settings should still load, got ${warned.status} ${server.logs()}`);
    assert(warned.json.file_storage.reachable === false, 'admins should see that the folder is unreachable');
    assert(warned.json.file_storage.warning && /cannot be reached|not a directory/i.test(warned.json.file_storage.warning), `the warning should be clear, got ${warned.json.file_storage.warning}`);
    const moveBlocked = await request({ method: 'POST', path: '/api/settings/file-storage/move', token: admin });
    assert(moveBlocked.status === 503, 'move should fail clearly when the folder is unreachable');
    const stillUp = await request({ method: 'GET', path: '/api/health' });
    assert(stillUp.status === 200 && stillUp.json.status === 'ok', 'the server should keep running when storage is down');
    const legacyStill = await request({
      method: 'GET',
      path: `/api/uploads/${mismatchRow.lastID}/download`,
      token: admin,
    });
    assert(legacyStill.status === 200 && legacyStill.buffer.equals(mismatch), 'a file in the original folder should still download');

    console.log('PASS file storage setting, move, and unreachable folder');
  } catch (err) {
    console.error(server.logs());
    throw err;
  } finally {
    server.stop();
    await server.closed;
  }
}

main()
  .then(() => {
    console.log('phase 19 ok');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
