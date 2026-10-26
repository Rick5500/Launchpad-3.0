/**
 * Phase 15 checks: staff send files to a customer with no order.
 * Migration, permissions, customer isolation, download tracking, and email.
 * Usage (from backend/): node scripts/verify-phase15.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase15-'));
const dbFile = path.join(tmp, 'phase15.db');
const legacyDb = path.join(tmp, 'legacy.db');
fs.mkdirSync(path.resolve(backendDir, '..', 'data'), { recursive: true });
const port = 3127;
const adminPassword = 'AdminPass123';
const appUrl = 'https://launchpad.example';

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

function baseEnv(extra = {}) {
  return {
    DATABASE_FILE: dbFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    DELIVERY_TIMEZONE: 'America/New_York',
    DELIVERY_WINDOW_START: '09:00',
    DELIVERY_WINDOW_END: '16:00',
    DELIVERY_SLOT_MINUTES: '15',
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: '',
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
    EMAIL_RATE_LIMIT_MAX: '1',
    EMAIL_RATE_LIMIT_WINDOW_MS: '900000',
    ...extra,
  };
}

function mailEnv() {
  return baseEnv({
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '2525',
    SMTP_USER: 'files',
    SMTP_PASS: 'super-secret-pass',
    SMTP_FROM: 'files@accent.example',
    SMTP_SECURE: 'false',
    PUBLIC_APP_URL: appUrl,
    MAIL_TRANSPORT: 'json',
  });
}

function request({ method, path: requestPath, token, json, raw, contentType }) {
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
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
        resolve({ status: res.statusCode, json: parsed, text, headers: res.headers });
      });
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`request timed out ${method} ${requestPath}`));
    }, 25000);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (body) req.end(body);
    else req.end();
  });
}

function weekdayAhead() {
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  for (let add = 1; add < 10; add += 1) {
    const date = new Date(Date.now() + add * 24 * 60 * 60 * 1000);
    const weekday = dayFmt.format(date);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    return dateFmt.format(date);
  }
  throw new Error('no weekday found');
}

function orderBody(overrides = {}) {
  return fillOrderLines({
    company: 'Acme Construction',
    contact_name: 'John Smith',
    phone: '919-555-1234',
    email: 'jsmith@acmeconstruction.com',
    project_name: 'New City Center',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '1234 Builder Way',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Accent Truck',
    due_date: weekdayAhead(),
    due_time: '09:15',
    service_ids: [],
    line_items: [{ description: 'Default line', quantity: '1' }],
    ...overrides,
  });
}

function multipart({ files = [], fields = {} }) {
  const boundary = `----Launchpad${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value == null) continue;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  }
  for (const file of files) {
    const filename = String(file.name).replace(/"/g, '');
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
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

function pdfFile(name, text) {
  return { name, type: 'application/pdf', data: Buffer.from(`%PDF-1.4 ${text || name}`) };
}

function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let stopped = false;
  const closed = new Promise((resolve) => {
    child.on('close', () => resolve());
  });
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
      stopped = true;
      child.kill('SIGTERM');
    },
  };
}

async function initDatabase(file) {
  const result = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv({ DATABASE_FILE: file }));
  if (result.code !== 0) throw new Error(`init_db failed (${result.code})\n${result.out}\n${result.err}`);
  return result;
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

function emailHtml(body) {
  const preview = body && body.email && body.email.preview;
  if (!preview) return '';
  if (preview.html) return String(preview.html);
  if (preview.raw) return String(preview.raw);
  return '';
}

function safeAppPath(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > 300) return '';
  if (!text.startsWith('/') || text.startsWith('//')) return '';
  if (/[\u0000-\u001F\\]/.test(text)) return '';
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch (err) {
    return '';
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return '';
  if (decoded.includes('://') || decoded.includes('\\')) return '';
  if (decoded.startsWith('/login')) return '';
  return text;
}

function loginNext(html) {
  const match = String(html || '').match(/\/login\?next=([^"'\s<]+)/);
  if (!match) return '';
  return decodeURIComponent(match[1]);
}

async function checkMigration() {
  const db = openDb(legacyDb);
  await db.run(`CREATE TABLE shared_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    work_order_id INTEGER,
    customer_id INTEGER,
    uploaded_by INTEGER,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL,
    message TEXT,
    batch_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    customer_downloaded_at DATETIME
  )`);
  await db.run(
    `INSERT INTO shared_files (
      order_id, customer_id, original_name, stored_name, size_bytes, message, batch_id, created_at
    ) VALUES (42, 7, 'legacy-proof.pdf', 'aabbccddeeff00112233445566778899.pdf', 12, 'Keep me', 'batchlegacy', '2026-01-02 03:04:05')`
  );
  await db.close();
  await initDatabase(legacyDb);
  await initDatabase(legacyDb);
  const check = openDb(legacyDb);
  const table = await check.get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shared_files'`);
  assert(table && table.sql, 'shared_files should exist');
  assert(!/order_id\s+INTEGER\s+NOT\s+NULL/i.test(table.sql), 'order_id should allow a send with no order');
  const columns = new Set((await check.all('PRAGMA table_info(shared_files)')).map((row) => row.name));
  assert(columns.has('transfer_id'), 'shared_files.transfer_id should exist');
  assert(columns.has('customer_downloaded_at'), 'download tracking column should remain');
  const legacy = await check.get(`SELECT order_id, original_name, message, transfer_id, customer_id FROM shared_files WHERE original_name = 'legacy-proof.pdf'`);
  assert(legacy && legacy.order_id === 42 && legacy.message === 'Keep me', 'an existing order share should stay unchanged');
  assert(legacy.transfer_id, 'an existing order share should be grouped into a transfer');
  const transfer = await check.get('SELECT customer_id, order_id, message FROM file_transfers WHERE id = ?', [legacy.transfer_id]);
  assert(transfer && transfer.customer_id === 7 && transfer.order_id === 42 && transfer.message === 'Keep me', 'the backfilled transfer should keep the order');
  const count = await check.get('SELECT COUNT(*) AS count FROM file_transfers WHERE order_id = 42');
  assert(count.count === 1, 'a second init should not duplicate the transfer');
  const notes = new Set((await check.all('PRAGMA table_info(notifications)')).map((row) => row.name));
  assert(notes.has('transfer_id'), 'notifications.transfer_id should exist');
  await check.close();
  console.log('PASS migration keeps order shares and allows a null order');
}

async function sendDirect(token, fields, files) {
  return request({
    method: 'POST',
    path: '/api/file-transfers',
    token,
    ...multipart({ files, fields }),
  });
}

async function runApiChecks() {
  await initDatabase(dbFile);
  const server = startServer(mailEnv());
  await server.ready;
  const db = openDb(dbFile);
  try {
    const unauth = await request({ method: 'GET', path: '/api/file-transfers' });
    assert(unauth.status === 401, `unsigned list should be 401, got ${unauth.status}`);

    const admin = await login('admin', adminPassword);
    const customerResponse = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Acme Construction',
        username: 'jsmith',
        password: 'CustomerPass1',
        company: 'Acme Construction',
        contact_name: 'John Smith',
        phone: '919-555-1234',
        email: 'jsmith@acmeconstruction.com',
      },
    });
    assert(customerResponse.status === 201, `customer create failed: ${customerResponse.text}`);
    const acmeId = customerResponse.json.id || customerResponse.json.user?.id;
    assert(acmeId, `customer id missing: ${customerResponse.text}`);
    const otherResponse = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Other Co',
        username: 'otherco',
        password: 'OtherPass123',
        company: 'Other Co',
        contact_name: 'Other Person',
        email: 'other@example.com',
      },
    });
    assert(otherResponse.status === 201, `second customer failed: ${otherResponse.text}`);
    const otherId = otherResponse.json.id || otherResponse.json.user?.id;
    const quietResponse = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Quiet Co',
        username: 'quietco',
        password: 'QuietPass123',
        company: 'Quiet Co',
        contact_name: 'Quiet Person',
        email: 'quiet@example.com',
      },
    });
    assert(quietResponse.status === 201, `third customer failed: ${quietResponse.text}`);
    const quietId = quietResponse.json.id || quietResponse.json.user?.id;
    await db.run('UPDATE users SET is_active = 0 WHERE id = ?', [quietId]);

    const operatorHash = await bcrypt.hash('OperatorPass1', 10);
    const managerHash = await bcrypt.hash('ManagerPass1', 10);
    await db.run(
      `INSERT INTO users (username, password_hash, role, display_name, is_active) VALUES ('op1', ?, 'operator', 'Operator One', 1)`,
      [operatorHash]
    );
    await db.run(
      `INSERT INTO users (username, password_hash, role, display_name, is_active) VALUES ('mgr1', ?, 'manager', 'Manager One', 1)`,
      [managerHash]
    );

    const customer = await login('jsmith', 'CustomerPass1');
    const other = await login('otherco', 'OtherPass123');
    const operator = await login('op1', 'OperatorPass1');
    const manager = await login('mgr1', 'ManagerPass1');

    const customerPost = await sendDirect(customer.token, { customer_id: String(acmeId) }, [pdfFile('nope.pdf')]);
    assert(customerPost.status === 403, `customer create should be 403, got ${customerPost.status}`);

    const missingCustomer = await sendDirect(admin.token, {}, [pdfFile('no-customer.pdf')]);
    assert(missingCustomer.status === 400, `missing customer should be 400, got ${missingCustomer.status} ${missingCustomer.text}`);
    const inactive = await sendDirect(admin.token, { customer_id: String(quietId) }, [pdfFile('inactive.pdf')]);
    assert(inactive.status === 400 && /active customer/i.test(inactive.json.error || ''), `inactive customer should be rejected: ${inactive.text}`);
    const staffTarget = await sendDirect(admin.token, { customer_id: String(admin.user.userId || admin.user.id) }, [pdfFile('staff.pdf')]);
    assert(staffTarget.status === 400, `a staff account is not a customer: ${staffTarget.text}`);

    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    assert(options.status === 200, 'order options should load');
    const byName = Object.fromEntries(options.json.services.map((service) => [service.name, service]));
    setServiceNames(byName);
    const created = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody({
        service_ids: [byName['Large Format'].id],
        line_items: [{ description: 'Civil Plans', quantity: '1', service_id: byName['Large Format'].id }],
      }),
    });
    assert(created.status === 201, `order create failed: ${created.status} ${created.text}`);
    const orderId = created.json.order.id;
    const orderNumber = created.json.order.order_number;
    const orderShare = await request({
      method: 'POST',
      path: `/api/orders/${orderId}/shared-files`,
      token: operator.token,
      ...multipart({
        files: [pdfFile('order-proof.pdf', 'order')],
        fields: { send_email: 'false', message: 'On the order' },
      }),
    });
    assert(orderShare.status === 201, `order share should still work: ${orderShare.status} ${orderShare.text}`);
    const orderRow = await db.get('SELECT order_id, transfer_id FROM shared_files WHERE original_name = ?', ['order-proof.pdf']);
    assert(orderRow && orderRow.order_id === orderId && orderRow.transfer_id, 'an order share keeps its order and gets a transfer');

    const subject = 'Proofs for <Acme>';
    const message = 'Please review the line "A & B".';
    const managerSend = await sendDirect(manager.token, {
      customer_id: String(otherId),
      subject: 'Manager packet',
      send_email: 'false',
    }, [pdfFile('manager-note.pdf', 'manager')]);
    assert(managerSend.status === 201 && managerSend.json.transfer.order_id == null, `manager should send without an order: ${managerSend.status} ${managerSend.text}`);

    const sent = await sendDirect(admin.token, {
      customer_id: String(acmeId),
      subject,
      message,
      email_cc: 'boss@acmeconstruction.com',
    }, [pdfFile('direct-proof.pdf', 'direct'), pdfFile('direct-extra.pdf', 'extra')]);
    assert(sent.status === 201, `standalone send failed: ${sent.status} ${sent.text}`);
    assert(sent.json.transfer && sent.json.transfer.order_id == null, 'a standalone transfer has no order');
    assert(sent.json.transfer.subject === subject, 'subject should be stored');
    assert(sent.json.transfer.files.length === 2, 'both files should be stored');
    assert(sent.json.transfer.downloaded_by_customer === false, 'a new transfer is not downloaded yet');
    assert(sent.json.email && sent.json.email.status === 'sent', `email should send: ${JSON.stringify(sent.json.email)}`);
    const transferId = sent.json.transfer.id;
    const stored = await db.get('SELECT order_id, customer_id, transfer_id FROM shared_files WHERE original_name = ?', ['direct-proof.pdf']);
    assert(stored && stored.order_id == null && stored.customer_id === acmeId && stored.transfer_id === transferId, 'the file should belong to the customer without an order');

    const html = emailHtml(sent.json);
    const next = loginNext(html);
    assert(next === `/files/${transferId}`, `email should open the transfer, got ${next}`);
    assert(safeAppPath(next) === next, 'the email next path should pass safePath');
    const safeSource = fs.readFileSync(path.join(backendDir, '..', 'frontend', 'src', 'safePath.js'), 'utf8');
    assert(safeSource.includes("decoded.startsWith('/login')"), 'frontend safePath should reject a login loop');
    assert(!html.includes('/api/shared-files') && !html.includes('token='), 'email should not offer a public download');
    assert(html.includes(`${appUrl}/brand/logo.png`), 'the transfer email should keep the Launchpad logo');
    assert(html.includes(`${appUrl}/brand/acg-logo.png`), 'the transfer email footer should include the ACG logo');
    assert(html.includes(`${appUrl}/brand/accent-imaging-logo.png`), 'the transfer email footer should include the Accent Imaging logo');
    assert(html.includes('A service of Accent Imaging and Accent Corporate Graphics'), 'the transfer email should credit both companies');
    assert(html.includes('&lt;Acme&gt;') && html.includes('A &amp; B'), 'email should escape the subject and message');
    assert(!html.includes('super-secret-pass'), 'email should not include the SMTP password');

    const notes = await request({ method: 'GET', path: '/api/notifications?limit=50', token: customer.token });
    const welcome = (notes.json.notifications || []).find((row) => row.type === 'files_shared' && row.transfer_id === transferId);
    assert(welcome && welcome.title === subject, `customer should be notified: ${JSON.stringify(notes.json.notifications)}`);
    const otherNotes = await request({ method: 'GET', path: '/api/notifications?limit=50', token: other.token });
    assert(!(otherNotes.json.notifications || []).some((row) => row.transfer_id === transferId), 'another customer should not see the notification');

    const ownList = await request({ method: 'GET', path: '/api/file-transfers', token: customer.token });
    assert(ownList.status === 200, `customer list failed: ${ownList.text}`);
    const ownIds = (ownList.json.transfers || []).map((row) => row.id);
    assert(ownIds.includes(transferId), 'the customer should see the standalone transfer');
    const orderTransfer = (ownList.json.transfers || []).find((row) => row.order_id === orderId);
    assert(orderTransfer && orderTransfer.order_number === orderNumber, 'order shares should appear with the order number');
    const otherList = await request({ method: 'GET', path: '/api/file-transfers', token: other.token });
    assert(!(otherList.json.transfers || []).some((row) => row.id === transferId || row.order_id === orderId), 'another customer should not see the transfers');
    const guessed = await request({ method: 'GET', path: '/api/file-transfers/999999', token: customer.token });
    assert(guessed.status === 404, `a guessed transfer should be 404, got ${guessed.status}`);
    const otherGet = await request({ method: 'GET', path: `/api/file-transfers/${transferId}`, token: other.token });
    assert(otherGet.status === 404, `another customer's transfer should be 404, got ${otherGet.status}`);
    const fileId = sent.json.transfer.files[0].id;
    const otherDownload = await request({ method: 'GET', path: `/api/shared-files/${fileId}/download`, token: other.token });
    assert(otherDownload.status === 404, `another customer should not download the file, got ${otherDownload.status}`);

    const beforeDownload = await request({ method: 'GET', path: `/api/file-transfers?customer_id=${acmeId}`, token: admin.token });
    const pending = (beforeDownload.json.transfers || []).find((row) => row.id === transferId);
    assert(pending && pending.downloaded_by_customer === false && pending.customer_downloaded_at == null, 'staff should see Not yet before a download');

    const customerDownload = await request({ method: 'GET', path: `/api/shared-files/${fileId}/download`, token: customer.token });
    assert(customerDownload.status === 200, `customer download failed: ${customerDownload.status} ${customerDownload.text}`);
    assert(String(customerDownload.headers['x-content-type-options']).toLowerCase() === 'nosniff', 'download should send nosniff');
    assert(/application\/pdf/i.test(String(customerDownload.headers['content-type'] || '')), 'download should keep the file content type');
    assert(/attachment/i.test(String(customerDownload.headers['content-disposition'] || '')), 'download should be an attachment');
    const afterCustomer = await request({ method: 'GET', path: `/api/file-transfers/${transferId}`, token: customer.token });
    assert(afterCustomer.json.transfer.downloaded_by_customer === true, 'the first download should be recorded');
    const stamp = afterCustomer.json.transfer.customer_downloaded_at;
    assert(stamp, 'the download time should be stored');
    const again = await request({ method: 'GET', path: `/api/shared-files/${fileId}/download`, token: customer.token });
    assert(again.status === 200, 'a second download should still succeed');
    const afterAgain = await request({ method: 'GET', path: `/api/file-transfers/${transferId}`, token: admin.token });
    assert(afterAgain.json.transfer.customer_downloaded_at === stamp, 'a later download should keep the first time');
    const fileState = (afterAgain.json.transfer.files || []).find((file) => file.id === fileId);
    assert(fileState && fileState.customer_downloaded_at === stamp, 'the file should keep the first download time');

    const filtered = await request({ method: 'GET', path: `/api/file-transfers?customer_id=${otherId}`, token: operator.token });
    assert(filtered.status === 200 && (filtered.json.transfers || []).length > 0 && (filtered.json.transfers || []).every((row) => row.customer_id === otherId), 'staff can filter by customer');
    assert(!(filtered.json.transfers || []).some((row) => row.id === transferId), 'the filter should hide another customer');
    const acmeFiltered = await request({ method: 'GET', path: `/api/file-transfers?customer_id=${acmeId}`, token: admin.token });
    assert((acmeFiltered.json.transfers || []).some((row) => row.id === transferId), 'the customer filter should include that customer');

    const removed = await request({ method: 'DELETE', path: `/api/shared-files/${sent.json.transfer.files[1].id}`, token: operator.token });
    assert(removed.status === 200, `delete failed: ${removed.text}`);
    const customerDelete = await request({ method: 'DELETE', path: `/api/shared-files/${fileId}`, token: customer.token });
    assert(customerDelete.status === 403, `customer delete should be 403, got ${customerDelete.status}`);
    const replaced = await request({
      method: 'POST',
      path: `/api/shared-files/${fileId}/replace`,
      token: manager.token,
      ...multipart({ files: [pdfFile('direct-proof-v2.pdf', 'v2')] }),
    });
    assert(replaced.status === 200, `replace failed: ${replaced.status} ${replaced.text}`);
    const seen = await request({ method: 'GET', path: `/api/file-transfers/${transferId}`, token: customer.token });
    const names = (seen.json.transfer.files || []).map((file) => file.original_name);
    assert(names.includes('direct-proof-v2.pdf') && !names.includes('direct-extra.pdf'), `replace and delete should update the transfer: ${names.join(', ')}`);
    const replacedRow = await db.get('SELECT order_id, transfer_id, customer_downloaded_at FROM shared_files WHERE original_name = ?', ['direct-proof-v2.pdf']);
    assert(replacedRow && replacedRow.order_id == null && replacedRow.transfer_id === transferId, 'the replacement stays on the same transfer');
    assert(replacedRow.customer_downloaded_at == null, 'a replacement starts without a download');

    const limited = await sendDirect(admin.token, { customer_id: String(acmeId), subject: 'Second packet' }, [pdfFile('limited.pdf')]);
    assert(limited.status === 201 && limited.json.email && limited.json.email.status === 'rate_limited', `rate limit should still store the transfer: ${limited.status} ${limited.text}`);
    const limitedRow = await db.get('SELECT id FROM file_transfers WHERE subject = ?', ['Second packet']);
    assert(limitedRow, 'a rate-limited send should still be stored');

    const badType = await sendDirect(admin.token, { customer_id: String(acmeId), send_email: 'false' }, [{ name: 'notes.html', type: 'text/html', data: Buffer.from('<html></html>') }]);
    assert(badType.status === 400, `a disallowed file type should be rejected, got ${badType.status}`);

    console.log('PASS standalone send, isolation, tracking, and email');
  } finally {
    await db.close();
    server.stop();
    await server.closed;
  }
}

async function runUnconfigured() {
  const server = startServer(baseEnv({
    SMTP_HOST: '',
    SMTP_FROM: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    MAIL_TRANSPORT: '',
    PUBLIC_APP_URL: '',
  }));
  await server.ready;
  const db = openDb(dbFile);
  try {
    const admin = await login('admin', adminPassword);
    const customer = await db.get(`SELECT id FROM users WHERE username = 'jsmith'`);
    const before = await db.get('SELECT COUNT(*) AS count FROM file_transfers WHERE order_id IS NULL');
    const sent = await sendDirect(admin.token, {
      customer_id: String(customer.id),
      subject: 'Offline packet',
      send_email: 'true',
    }, [pdfFile('offline.pdf', 'offline')]);
    assert(sent.status === 201, `unconfigured send should still store files: ${sent.status} ${sent.text}`);
    assert(sent.json.email && sent.json.email.status === 'not_configured', `expected not_configured, got ${JSON.stringify(sent.json.email)}`);
    const after = await db.get('SELECT COUNT(*) AS count FROM file_transfers WHERE order_id IS NULL');
    assert(after.count === before.count + 1, 'the transfer should be stored when email is not set up');
    const visible = await request({ method: 'GET', path: `/api/file-transfers/${sent.json.transfer.id}`, token: (await login('jsmith', 'CustomerPass1')).token });
    assert(visible.status === 200 && visible.json.transfer.subject === 'Offline packet', 'the customer should see the transfer without email');
    console.log('PASS files sent when SMTP is not configured');
  } finally {
    await db.close();
    server.stop();
    await server.closed;
  }
}

async function main() {
  await checkMigration();
  await runApiChecks();
  await runUnconfigured();
  console.log('phase 15 ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
