/**
 * Phase 13 checks: staff share files with a customer.
 * Permissions, customer isolation, download tracking, and email
 * through a nodemailer json transport, including SMTP not configured.
 * Usage (from backend/): node scripts/verify-phase13.js
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase13-'));
const dbFile = path.join(tmp, 'phase13.db');
const migrateDb = path.join(tmp, 'migrate.db');
const uploadDir = path.resolve(backendDir, '..', 'data', 'uploads');
fs.mkdirSync(path.dirname(uploadDir), { recursive: true });
const port = 3125;
const adminPassword = 'AdminPass123';
const smtpPass = 'super-secret-pass';
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
    EMAIL_RATE_LIMIT_MAX: '3',
    EMAIL_RATE_LIMIT_WINDOW_MS: '900000',
    ...extra,
  };
}

function mailEnv() {
  return baseEnv({
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '2525',
    SMTP_USER: 'files',
    SMTP_PASS: smtpPass,
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

async function initDatabase(file, extra = {}) {
  const result = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv({ DATABASE_FILE: file, ...extra }));
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

async function columnNames(db, table) {
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

async function checkMigration() {
  await initDatabase(migrateDb);
  await initDatabase(migrateDb);
  const db = openDb(migrateDb);
  const table = await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shared_files'`);
  assert(table, 'shared_files should exist after init');
  const columns = await columnNames(db, 'shared_files');
  for (const name of ['order_id', 'work_order_id', 'stored_name', 'message', 'deleted_at', 'replaced_by_id', 'replaces_id', 'customer_downloaded_at']) {
    assert(columns.has(name), `shared_files.${name} should exist`);
  }
  const notes = await columnNames(db, 'notifications');
  assert(notes.has('order_id'), 'notifications.order_id should exist');
  const flag = await db.get(`SELECT value FROM system_settings WHERE key = 'email_customers_on_file_share'`);
  assert(flag && flag.value === '1', 'file-share email should default on');
  const flagCount = await db.get(`SELECT COUNT(*) AS count FROM system_settings WHERE key = 'email_customers_on_file_share'`);
  assert(flagCount.count === 1, 'file-share email setting should not duplicate');
  const event = await db.get(`SELECT enabled, channel FROM notification_settings WHERE event_key = 'files_shared'`);
  assert(event && event.enabled === 1 && event.channel === 'in_app', 'files_shared notification should start on');
  await db.run(`UPDATE system_settings SET value = '0' WHERE key = 'email_customers_on_file_share'`);
  await db.run(`UPDATE notification_settings SET enabled = 0 WHERE event_key = 'files_shared'`);
  await db.close();
  await initDatabase(migrateDb);
  const again = openDb(migrateDb);
  const kept = await again.get(`SELECT value FROM system_settings WHERE key = 'email_customers_on_file_share'`);
  assert(kept && kept.value === '0', 'a later init should keep the email switch off');
  const keptEvent = await again.get(`SELECT enabled FROM notification_settings WHERE event_key = 'files_shared'`);
  assert(keptEvent && keptEvent.enabled === 0, 'a later init should keep the notification switch off');
  await again.run(`DELETE FROM system_settings WHERE key = 'email_customers_on_file_share'`);
  await again.run(`DELETE FROM notification_settings WHERE event_key = 'files_shared'`);
  await again.close();
  await initDatabase(migrateDb);
  const restored = openDb(migrateDb);
  const back = await restored.get(`SELECT value, COUNT(*) AS count FROM system_settings WHERE key = 'email_customers_on_file_share'`);
  assert(back && back.value === '1' && back.count === 1, 'a missing email switch should be inserted once');
  const eventBack = await restored.get(`SELECT COUNT(*) AS count FROM notification_settings WHERE event_key = 'files_shared'`);
  assert(eventBack.count === 1, 'a missing files_shared event should be inserted once');
  await restored.close();
  console.log('PASS migration keeps the file-share switches');
}

async function share(token, orderId, { files, fields }) {
  return request({
    method: 'POST',
    path: `/api/orders/${orderId}/shared-files`,
    token,
    ...multipart({ files, fields }),
  });
}

async function runApiChecks() {
  await initDatabase(dbFile);
  const server = startServer(mailEnv());
  await server.ready;
  console.log('PASS backend startup with mock mail');
  const db = openDb(dbFile);
  try {
    const unauth = await request({ method: 'GET', path: '/api/orders/1/shared-files' });
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

    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    assert(options.status === 200, 'order options should load');
    const byName = Object.fromEntries(options.json.services.map((service) => [service.name, service]));
    setServiceNames(byName);
    const created = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody({
        service_ids: [byName['Large Format'].id, byName['Small Format'].id],
        line_items: [
          { description: 'Civil Plans', quantity: '1', service_id: byName['Large Format'].id },
          { description: 'Specs', quantity: '1', service_id: byName['Small Format'].id },
        ],
      }),
    });
    assert(created.status === 201, `order create failed: ${created.status} ${created.text}`);
    const orderId = created.json.order.id;
    const orderNumber = created.json.order.order_number;
    const workOrders = created.json.work_orders;
    assert(workOrders.length === 2, 'two services should create two work orders');
    const otherOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: other.token,
      json: orderBody({
        company: 'Other Co',
        contact_name: 'Other Person',
        email: 'other@example.com',
        project_name: 'Other Job',
        service_ids: [byName['Large Format'].id],
        line_items: [{ description: 'Other line', quantity: '1', service_id: byName['Large Format'].id }],
      }),
    });
    assert(otherOrder.status === 201, `other order failed: ${otherOrder.text}`);

    const customerPost = await share(customer.token, orderId, { files: [pdfFile('nope.pdf')], fields: { send_email: 'false' } });
    assert(customerPost.status === 403, `customer upload should be 403, got ${customerPost.status}`);
    const badId = await request({ method: 'GET', path: '/api/orders/0/shared-files', token: admin.token });
    assert(badId.status === 400, `invalid order id should be 400, got ${badId.status}`);

    const letterhead = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: {
        company_name: 'Accent File Shop',
        company_address: '100 Test Lane\nRaleigh, NC 27601',
        company_phone: '919-555-0144',
      },
    });
    assert(letterhead.status === 200 && letterhead.json.email_customers_on_file_share === true, `settings should default email on: ${letterhead.text}`);
    assert(letterhead.json.mail && letterhead.json.mail.configured === true, 'settings should report mail configured');

    const message = 'Proof ready <script>alert("x")</script> & co';
    const sent = await share(admin.token, orderId, {
      files: [pdfFile('proof <b>1</b>.pdf', 'proof-bytes'), { name: 'site.png', type: 'image/png', data: Buffer.from('png-bytes') }],
      fields: {
        message,
        email_cc: 'boss@acmeconstruction.com, boss@acmeconstruction.com',
      },
    });
    assert(sent.status === 201, `share failed: ${sent.status} ${sent.text}`);
    assert(sent.json.files.length === 2, 'two files should be stored');
    assert(sent.json.email && sent.json.email.status === 'sent', `email should send: ${JSON.stringify(sent.json.email)}`);
    const recipients = sent.json.email.recipients || [];
    assert(recipients.length === 2, `expected to and cc, got ${JSON.stringify(recipients)}`);
    assert(recipients.every((row) => row.status === 'sent'), 'each recipient should be sent');
    const html = emailHtml(sent.json);
    const text = (sent.json.email.preview && sent.json.email.preview.text) || '';
    assert(html.includes('&lt;script&gt;'), `html should escape the message: ${html.slice(0, 400)}`);
    assert(!html.includes('<script'), 'html should not contain a script tag');
    assert(html.includes('&amp;'), 'html should escape ampersands');
    assert(html.includes('Accent File Shop'), 'html should use the letterhead name');
    assert(html.includes('100 Test Lane'), 'html should use the letterhead address');
    assert(html.includes('919-555-0144'), 'html should use the letterhead phone');
    assert(html.includes(`${appUrl}/brand/logo.png`), 'the file email should keep the Launchpad logo');
    assert(html.includes(`${appUrl}/brand/acg-logo.png`), 'the file email footer should include the ACG logo');
    assert(html.includes(`${appUrl}/brand/accent-imaging-logo.png`), 'the file email footer should include the Accent Imaging logo');
    assert(html.includes('A service of Accent Imaging and Accent Corporate Graphics'), 'the file email should credit both companies');
    assert(text.includes('A service of Accent Imaging and Accent Corporate Graphics'), 'plain text should credit both companies');
    assert(!html.includes('Brought to you by'), 'the file email should not use the old division caption');
    assert(!html.includes('info@accent'), 'html should not invent a contact email');
    assert(!html.includes(smtpPass) && !text.includes(smtpPass), 'email should not contain the SMTP password');
    assert(html.includes(`${appUrl}/login?next=`), `email should link to sign-in: ${html}`);
    assert(html.includes('files-from-accent'), 'email link should open the files section');
    assert(!html.includes('/api/shared-files') && !html.includes('token='), 'email should not offer a public download');
    assert(text.includes(message), 'plain text should include the message');
    assert(text.includes(`${appUrl}/login?next=`), 'plain text should include the sign-in link');
    assert(JSON.stringify(sent.json).includes(orderNumber), 'the share should name the order');
    const dumped = JSON.stringify(sent.json);
    assert(!dumped.includes('stored_name'), 'the response should not include stored filenames');
    const fileId = sent.json.files[0].id;

    const ownList = await request({ method: 'GET', path: `/api/orders/${orderId}/shared-files`, token: customer.token });
    assert(ownList.status === 200 && ownList.json.files.length === 2, `customer should see both files: ${ownList.text}`);
    assert(ownList.json.timezone === 'America/New_York', 'list should name the shop timezone');
    assert(!ownList.json.mail, 'customers should not receive mail settings');
    assert(ownList.json.files.every((file) => !file.customer_downloaded_at), 'files should start undownloaded');
    const otherList = await request({ method: 'GET', path: `/api/orders/${orderId}/shared-files`, token: other.token });
    assert(otherList.status === 404, `other customer list should be 404, got ${otherList.status}`);
    const guessed = await request({ method: 'GET', path: '/api/shared-files/999999/download', token: customer.token });
    assert(guessed.status === 404, `guessed file should be 404, got ${guessed.status}`);
    const otherDownload = await request({ method: 'GET', path: `/api/shared-files/${fileId}/download`, token: other.token });
    assert(otherDownload.status === 404, `other customer download should be 404, got ${otherDownload.status}`);
    const customerDelete = await request({ method: 'DELETE', path: `/api/shared-files/${fileId}`, token: customer.token });
    assert(customerDelete.status === 403, `customer delete should be 403, got ${customerDelete.status}`);

    const staffDownload = await request({ method: 'GET', path: `/api/shared-files/${fileId}/download`, token: operator.token });
    assert(staffDownload.status === 200 && staffDownload.text.includes('%PDF'), 'staff should download the pdf');
    const afterStaff = await request({ method: 'GET', path: `/api/orders/${orderId}/shared-files`, token: admin.token });
    const staffRow = afterStaff.json.files.find((file) => file.id === fileId);
    assert(staffRow && !staffRow.customer_downloaded_at, 'a staff download should not count as the customer');

    const customerDownload = await request({ method: 'GET', path: `/api/shared-files/${fileId}/download`, token: customer.token });
    assert(customerDownload.status === 200 && customerDownload.text.includes('%PDF'), 'customer should download their file');
    const afterCustomer = await request({ method: 'GET', path: `/api/orders/${orderId}/shared-files`, token: customer.token });
    const downloaded = afterCustomer.json.files.find((file) => file.id === fileId);
    assert(downloaded && downloaded.downloaded_by_customer, 'customer download should be tracked');
    assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(downloaded.customer_downloaded_at), `download time should be a timestamp, got ${downloaded.customer_downloaded_at}`);
    const again = await request({ method: 'GET', path: `/api/shared-files/${fileId}/download`, token: customer.token });
    assert(again.status === 200, 'a second download should still succeed');
    const afterAgain = await request({ method: 'GET', path: `/api/orders/${orderId}/shared-files`, token: customer.token });
    const same = afterAgain.json.files.find((file) => file.id === fileId);
    assert(same.customer_downloaded_at === downloaded.customer_downloaded_at, 'the first download time should stay');

    const missingId = sent.json.files[1].id;
    const missingRow = await db.get(`SELECT stored_name, customer_downloaded_at FROM shared_files WHERE id = ?`, [missingId]);
    assert(missingRow && !missingRow.customer_downloaded_at, 'the second file should still be undownloaded');
    fs.unlinkSync(path.join(uploadDir, missingRow.stored_name));
    const missingDownload = await request({ method: 'GET', path: `/api/shared-files/${missingId}/download`, token: customer.token });
    assert(missingDownload.status === 404, `a file missing from disk should be 404, got ${missingDownload.status}`);
    const afterMissing = await db.get(`SELECT customer_downloaded_at FROM shared_files WHERE id = ?`, [missingId]);
    assert(!afterMissing.customer_downloaded_at, 'a missing file should not record the first customer download');
    const missingLog = await db.get(
      `SELECT id FROM activity_log WHERE action = 'shared_file.downloaded' AND detail LIKE ?`,
      [`%"file_id":${missingId},%`]
    );
    assert(!missingLog, 'a missing file should not write a download activity row');

    const notes = await request({ method: 'GET', path: '/api/notifications?limit=50', token: customer.token });
    const welcome = (notes.json.notifications || []).find((row) => row.type === 'files_shared' && row.title === `New files for order ${orderNumber}`);
    assert(welcome, `customer should be notified: ${JSON.stringify(notes.json.notifications)}`);
    assert(welcome.order_id === orderId, 'the notification should point at the order');
    const otherNotes = await request({ method: 'GET', path: '/api/notifications?limit=50', token: other.token });
    assert(!(otherNotes.json.notifications || []).some((row) => row.type === 'files_shared'), 'another customer should not see the notification');

    const emailRows = await db.all(`SELECT action, detail FROM activity_log WHERE action LIKE 'shared_file.email_%' ORDER BY id`);
    assert(emailRows.length === 2, `expected one activity row per recipient, got ${emailRows.length}`);
    assert(emailRows.every((row) => row.action === 'shared_file.email_sent'), 'both recipients should be logged as sent');
    assert(emailRows.some((row) => row.detail.includes('jsmith@acmeconstruction.com')), 'the order contact should be logged');
    assert(emailRows.some((row) => row.detail.includes('boss@acmeconstruction.com')), 'the cc address should be logged');
    assert(!emailRows.some((row) => row.detail.includes(smtpPass)), 'activity should not store the SMTP password');
    const downloadLog = await db.get(`SELECT id FROM activity_log WHERE action = 'shared_file.downloaded' AND detail LIKE ?`, [`%${fileId}%`]);
    assert(downloadLog, 'a customer download should be in the activity log');

    const [workA, workB] = workOrders;
    const onA = await share(operator.token, orderId, {
      files: [pdfFile('wide.pdf', 'wide')],
      fields: { send_email: 'false', work_order_id: String(workA.id) },
    });
    assert(onA.status === 201 && onA.json.email.status === 'skipped', `operator share failed: ${onA.status} ${onA.text}`);
    const onB = await share(manager.token, orderId, {
      files: [pdfFile('small.pdf', 'small')],
      fields: { send_email: 'false', work_order_id: String(workB.id) },
    });
    assert(onB.status === 201, `manager share failed: ${onB.text}`);
    const whole = await share(admin.token, orderId, {
      files: [pdfFile('order-wide.pdf', 'wide-order')],
      fields: { send_email: 'false' },
    });
    assert(whole.status === 201, `order-wide share failed: ${whole.text}`);
    const listA = await request({ method: 'GET', path: `/api/orders/${orderId}/shared-files?work_order_id=${workA.id}`, token: customer.token });
    const namesA = listA.json.files.map((file) => file.original_name);
    assert(namesA.includes('wide.pdf') && namesA.includes('order-wide.pdf') && !namesA.includes('small.pdf'), `work order A files were ${namesA.join(', ')}`);
    const listB = await request({ method: 'GET', path: `/api/orders/${orderId}/shared-files?work_order_id=${workB.id}`, token: operator.token });
    const namesB = listB.json.files.map((file) => file.original_name);
    assert(namesB.includes('small.pdf') && namesB.includes('order-wide.pdf') && !namesB.includes('wide.pdf'), `work order B files were ${namesB.join(', ')}`);
    const foreignWo = otherOrder.json.work_orders[0].id;
    const wrongWo = await share(admin.token, orderId, {
      files: [pdfFile('nope.pdf')],
      fields: { send_email: 'false', work_order_id: String(foreignWo) },
    });
    assert(wrongWo.status === 400, `a work order from another order should be 400, got ${wrongWo.status}`);

    const traversal = await share(admin.token, orderId, {
      files: [{ name: '../../secret.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 secret') }],
      fields: { send_email: 'false' },
    });
    assert(traversal.status === 201, `sanitized upload should succeed: ${traversal.status} ${traversal.text}`);
    const stored = await db.get('SELECT original_name, stored_name FROM shared_files WHERE id = ?', [traversal.json.files[0].id]);
    assert(stored.original_name === 'secret.pdf', `original name should be sanitized, got ${stored.original_name}`);
    assert(/^[a-f0-9]{32}\.pdf$/.test(stored.stored_name), `stored name should be random, got ${stored.stored_name}`);
    assert(fs.existsSync(path.join(uploadDir, stored.stored_name)), 'the file should live in the upload directory');
    assert(!fs.existsSync(path.join(uploadDir, '..', 'secret.pdf')), 'the upload should not leave the upload directory');

    const exe = await share(admin.token, orderId, {
      files: [{ name: 'run.exe', type: 'application/octet-stream', data: Buffer.from('MZ') }],
      fields: { send_email: 'false' },
    });
    assert(exe.status === 400, `exe should be rejected, got ${exe.status} ${exe.text}`);
    const empty = await share(admin.token, orderId, {
      files: [{ name: 'empty.pdf', type: 'application/pdf', data: Buffer.alloc(0) }],
      fields: { send_email: 'false' },
    });
    assert(empty.status === 400, `empty file should be rejected, got ${empty.status}`);
    const badAddress = await share(admin.token, orderId, {
      files: [pdfFile('mail.pdf')],
      fields: { send_email: 'true', email_to: 'not-an-email' },
    });
    assert(badAddress.status === 400, `invalid email should be 400, got ${badAddress.status} ${badAddress.text}`);
    const injected = await share(admin.token, orderId, {
      files: [pdfFile('mail.pdf')],
      fields: { send_email: 'true', email_to: 'a@b.co\nBcc: evil@x.com' },
    });
    assert(injected.status === 400, `header injection should be 400, got ${injected.status}`);
    const tooMany = await share(admin.token, orderId, {
      files: [pdfFile('mail.pdf')],
      fields: { send_email: 'true', email_cc: 'a@b.co,b@b.co,c@b.co,d@b.co,e@b.co,f@b.co' },
    });
    assert(tooMany.status === 400, `too many cc addresses should be 400, got ${tooMany.status}`);

    const removed = await request({ method: 'DELETE', path: `/api/shared-files/${onA.json.files[0].id}`, token: operator.token });
    assert(removed.status === 200, `delete failed: ${removed.text}`);
    const afterDelete = await request({ method: 'GET', path: `/api/orders/${orderId}/shared-files`, token: customer.token });
    assert(!afterDelete.json.files.some((file) => file.id === onA.json.files[0].id), 'a removed file should leave the list');
    const deletedDownload = await request({ method: 'GET', path: `/api/shared-files/${onA.json.files[0].id}/download`, token: customer.token });
    assert(deletedDownload.status === 404, 'a removed file should not download');
    const deletedRow = await db.get('SELECT deleted_at, deleted_by FROM shared_files WHERE id = ?', [onA.json.files[0].id]);
    assert(deletedRow && deletedRow.deleted_at, 'delete should keep the row');
    const deleteLog = await db.get(`SELECT id FROM activity_log WHERE action = 'shared_file.deleted'`);
    assert(deleteLog, 'delete should be logged');

    const replaced = await request({
      method: 'POST',
      path: `/api/shared-files/${onB.json.files[0].id}/replace`,
      token: manager.token,
      ...multipart({ files: [pdfFile('small-final.pdf', 'final')] }),
    });
    assert(replaced.status === 200 && replaced.json.file.original_name === 'small-final.pdf', `replace failed: ${replaced.status} ${replaced.text}`);
    assert(replaced.json.file.replaces_id === onB.json.files[0].id, 'the new file should point at the one it replaced');
    const oldRow = await db.get('SELECT deleted_at, replaced_by_id FROM shared_files WHERE id = ?', [onB.json.files[0].id]);
    assert(oldRow.deleted_at && oldRow.replaced_by_id === replaced.json.file.id, 'replace should soft-delete the previous file');
    const replaceLog = await db.get(`SELECT id FROM activity_log WHERE action = 'shared_file.replaced'`);
    assert(replaceLog, 'replace should be logged');
    const seen = await request({ method: 'GET', path: `/api/orders/${orderId}/shared-files`, token: customer.token });
    assert(seen.json.files.some((file) => file.original_name === 'small-final.pdf'), 'the customer should see the replacement');
    assert(!seen.json.files.some((file) => file.id === onB.json.files[0].id), 'the customer should not see the replaced file');

    const off = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: { email_customers_on_file_share: false },
    });
    assert(off.status === 200 && off.json.email_customers_on_file_share === false, 'the email default should turn off');
    const skipped = await share(admin.token, orderId, { files: [pdfFile('quiet.pdf', 'quiet')] });
    assert(skipped.status === 201 && skipped.json.email.status === 'skipped', `default off should skip email: ${JSON.stringify(skipped.json.email)}`);
    const on = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: { email_customers_on_file_share: true },
    });
    assert(on.status === 200 && on.json.email_customers_on_file_share === true, 'the email default should turn back on');

    const quietNotes = await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { files_shared: false } },
    });
    assert(quietNotes.status === 200, `notification setting failed: ${quietNotes.text}`);
    const beforeQuiet = await db.get(`SELECT COUNT(*) AS count FROM notifications WHERE type = 'files_shared'`);
    const quietShare = await share(operator.token, orderId, {
      files: [pdfFile('silent.pdf', 'silent')],
      fields: { send_email: 'false' },
    });
    assert(quietShare.status === 201, `share with notifications off failed: ${quietShare.text}`);
    const afterQuiet = await db.get(`SELECT COUNT(*) AS count FROM notifications WHERE type = 'files_shared'`);
    assert(afterQuiet.count === beforeQuiet.count, 'a disabled event should not add a notification');
    await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { files_shared: true } },
    });

    const testDenied = await request({
      method: 'POST',
      path: '/api/settings/test-email',
      token: operator.token,
      json: { to: 'ops@accent.example' },
    });
    assert(testDenied.status === 403, `operator test email should be 403, got ${testDenied.status}`);
    const managerDenied = await request({
      method: 'POST',
      path: '/api/settings/test-email',
      token: manager.token,
      json: { to: 'ops@accent.example' },
    });
    assert(managerDenied.status === 403, `manager test email should be 403, got ${managerDenied.status}`);
    const testMail = await request({
      method: 'POST',
      path: '/api/settings/test-email',
      token: admin.token,
      json: { to: 'ops@accent.example' },
    });
    assert(testMail.status === 200 && testMail.json.status === 'sent', `test email failed: ${testMail.status} ${testMail.text}`);
    assert(testMail.json.preview && String(testMail.json.preview.html).includes('Accent File Shop'), 'the test email should use the letterhead');
    assert(!String(testMail.json.preview.html).includes('/brand/acg-logo.png'), 'the test email should not include the ACG logo');
    assert(!String(testMail.json.preview.html).includes('/brand/accent-imaging-logo.png'), 'the test email should not include the Accent Imaging logo');
    assert(!String(testMail.json.preview.html).includes('A service of Accent Imaging'), 'the test email should not include the customer credit');
    const testLog = await db.get(`SELECT detail FROM activity_log WHERE action = 'settings.test_email_sent'`);
    assert(testLog && testLog.detail.includes('ops@accent.example'), 'the test email should be logged');

    const third = await share(admin.token, orderId, {
      files: [pdfFile('third.pdf', 'third')],
      fields: { send_email: 'true', email_to: 'extra@acmeconstruction.com' },
    });
    assert(third.status === 201 && third.json.email.status === 'sent', `third email should send: ${third.status} ${third.text}`);
    const beforeLimit = await db.get('SELECT COUNT(*) AS count FROM shared_files');
    const limited = await share(admin.token, orderId, {
      files: [pdfFile('limited.pdf', 'limited')],
      fields: { send_email: 'true', email_to: 'extra@acmeconstruction.com' },
    });
    assert(limited.status === 201 && limited.json.email && limited.json.email.status === 'rate_limited', `email rate limit should still share the file, got ${limited.status} ${limited.text}`);
    const afterLimit = await db.get('SELECT COUNT(*) AS count FROM shared_files');
    assert(afterLimit.count === beforeLimit.count + 1, 'a rate-limited send should still store the file');
    assert(
      /MAIL_TRANSPORT=json is set with SMTP_HOST/.test(server.logs()),
      'startup should warn when json transport is set with SMTP_HOST'
    );

    console.log('PASS permissions, isolation, tracking, and mock email');
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
    const customer = await login('jsmith', 'CustomerPass1');
    const order = await db.get(`SELECT id FROM orders WHERE email = 'jsmith@acmeconstruction.com' ORDER BY id LIMIT 1`);
    const before = await db.get('SELECT COUNT(*) AS count FROM shared_files WHERE deleted_at IS NULL');
    const sent = await share(admin.token, order.id, {
      files: [pdfFile('offline.pdf', 'offline')],
      fields: { send_email: 'true' },
    });
    assert(sent.status === 201, `unconfigured share should still store files: ${sent.status} ${sent.text}`);
    assert(sent.json.email && sent.json.email.status === 'not_configured', `expected not_configured, got ${JSON.stringify(sent.json.email)}`);
    const after = await db.get('SELECT COUNT(*) AS count FROM shared_files WHERE deleted_at IS NULL');
    assert(after.count === before.count + 1, 'the file should be stored when email is not set up');
    const visible = await request({ method: 'GET', path: `/api/orders/${order.id}/shared-files`, token: customer.token });
    assert(visible.json.files.some((file) => file.original_name === 'offline.pdf'), 'the customer should see the file without email');
    const testMail = await request({
      method: 'POST',
      path: '/api/settings/test-email',
      token: admin.token,
      json: { to: 'ops@accent.example' },
    });
    assert(testMail.status === 400 && /isn't set up/.test(testMail.json.error || ''), `test email should explain that mail is not set up: ${testMail.text}`);
    const logs = server.logs();
    assert(!/TypeError|Unhandled/.test(logs), `unconfigured mail should not crash\n${logs}`);
    console.log('PASS files shared when SMTP is not configured');
  } finally {
    await db.close();
    server.stop();
    await server.closed;
  }
}

async function runUnreachableSmtp() {
  const timeoutMs = 2500;
  const server = startServer(baseEnv({
    SMTP_HOST: '10.255.255.1',
    SMTP_PORT: '2525',
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_FROM: 'files@accent.example',
    SMTP_SECURE: 'false',
    PUBLIC_APP_URL: appUrl,
    MAIL_TRANSPORT: '',
    SMTP_TIMEOUT_MS: String(timeoutMs),
  }));
  await server.ready;
  const db = openDb(dbFile);
  try {
    const admin = await login('admin', adminPassword);
    const order = await db.get(`SELECT id FROM orders WHERE email = 'jsmith@acmeconstruction.com' ORDER BY id LIMIT 1`);
    const before = await db.get('SELECT COUNT(*) AS count FROM shared_files WHERE deleted_at IS NULL');
    const started = Date.now();
    const sent = await share(admin.token, order.id, {
      files: [pdfFile('blackhole.pdf', 'blackhole')],
      fields: { send_email: 'true', email_to: 'jsmith@acmeconstruction.com' },
    });
    const elapsed = Date.now() - started;
    assert(sent.status === 201, `unreachable SMTP should still share files: ${sent.status} ${sent.text}`);
    assert(sent.json.email && sent.json.email.status === 'failed', `expected failed email, got ${JSON.stringify(sent.json.email)}`);
    assert(elapsed < timeoutMs + 8000, `share should fail within the SMTP timeout, took ${elapsed}ms`);
    const after = await db.get('SELECT COUNT(*) AS count FROM shared_files WHERE deleted_at IS NULL');
    assert(after.count === before.count + 1, 'the file should be stored when SMTP is unreachable');
    const testStarted = Date.now();
    const testMail = await request({
      method: 'POST',
      path: '/api/settings/test-email',
      token: admin.token,
      json: { to: 'ops@accent.example' },
    });
    const testElapsed = Date.now() - testStarted;
    assert(testMail.status === 502, `unreachable test email should fail, got ${testMail.status} ${testMail.text}`);
    assert(testElapsed < timeoutMs + 8000, `test email should fail within the SMTP timeout, took ${testElapsed}ms`);
    const logs = server.logs();
    assert(!/TypeError|Unhandled/.test(logs), `unreachable SMTP should not crash\n${logs}`);
    console.log(`PASS unreachable SMTP fails within the timeout (${elapsed}ms share, ${testElapsed}ms test)`);
  } finally {
    await db.close();
    server.stop();
    await server.closed;
  }
}

function runEmailBranding() {
  const mailer = require('../mailer');
  const letterhead = {
    name: 'Accent File Shop',
    address_lines: ['100 Test Lane', 'Raleigh, NC 27601'],
    phone: '919-555-0144',
  };
  const previous = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = appUrl;
  const credit = 'A service of Accent Imaging and Accent Corporate Graphics';
  const link = `${appUrl}/login?next=%2Forders%2F1`;
  const customerMail = [
    mailer.renderShareEmail({ letterhead, orderNumber: 'LP-1', message: 'Ready', fileNames: ['a.pdf'], link }),
    mailer.renderTransferEmail({ letterhead, subject: 'Files', message: 'Ready', fileNames: ['a.pdf'], link: `${appUrl}/login?next=%2Ffiles%2F1` }),
    mailer.renderQuoteEmail({ letterhead, projectName: 'Banner', price: '$10.00', notes: 'Net 15', validUntil: '2026-12-01', lineItems: [], link: `${appUrl}/login?next=%2Fquotes%2F1` }),
    mailer.renderProofEmail({ letterhead, orderNumber: 'LP-1', version: 1, message: 'Look', fileNames: ['a.pdf'], link: `${appUrl}/login?next=%2Forders%2F1%23proofs`, workOrderNumber: 'LP-1-A' }),
    mailer.renderPickupReadyEmail({ letterhead, orderNumber: 'LP-1', locationName: 'Raleigh', locationAddress: '8121 Brownleigh Drive\nRaleigh, NC 27617', locationPhone: '919-782-3332', link }),
  ];
  const staffMail = [
    mailer.renderProofChangesEmail({ letterhead, orderNumber: 'LP-1', version: 1, comment: 'Darker', customerName: 'Pat', link, workOrderNumber: 'LP-1-A' }),
    mailer.renderQuoteRequestEmail({ letterhead, customerName: 'Pat', projectName: 'Banner', neededBy: '2026-12-01', link: `${appUrl}/login?next=%2Fquote-requests%2F1` }),
    mailer.renderTestEmail({ letterhead }),
  ];
  for (const rendered of customerMail) {
    assert(rendered.html.includes(`${appUrl}/brand/logo.png`), `Launchpad logo missing from ${rendered.subject}`);
    assert(rendered.html.includes(`${appUrl}/brand/acg-logo.png`), `ACG logo missing from ${rendered.subject}`);
    assert(rendered.html.includes(`${appUrl}/brand/accent-imaging-logo.png`), `Accent Imaging logo missing from ${rendered.subject}`);
    assert(rendered.html.includes('alt="Accent Corporate Graphics"'), `ACG image should be named in ${rendered.subject}`);
    assert(rendered.html.includes('alt="Accent Imaging"'), `Accent Imaging image should be named in ${rendered.subject}`);
    assert(rendered.html.includes(credit), `credit sentence missing from ${rendered.subject}`);
    assert(!rendered.html.includes('Brought to you by'), `old caption should be gone from ${rendered.subject}`);
    assert(rendered.html.includes('100 Test Lane') && rendered.html.includes('919-555-0144'), `letterhead should stay beside the credit in ${rendered.subject}`);
    assert(rendered.text.includes(credit), `plain text should credit both companies in ${rendered.subject}`);
    assert(!rendered.html.includes('acg-logo.pdf') && !rendered.html.includes('accent-imaging-logo.pdf'), 'email should use the web PNGs, not the vector originals');
  }
  for (const rendered of staffMail) {
    assert(rendered.html.includes(`${appUrl}/brand/logo.png`), `Launchpad logo missing from ${rendered.subject}`);
    assert(!rendered.html.includes('/brand/acg-logo.png'), `staff mail should omit the ACG logo in ${rendered.subject}`);
    assert(!rendered.html.includes('/brand/accent-imaging-logo.png'), `staff mail should omit the Accent Imaging logo in ${rendered.subject}`);
    assert(!rendered.html.includes(credit) && !rendered.text.includes(credit), `staff mail should omit the customer credit in ${rendered.subject}`);
    assert(rendered.html.includes('100 Test Lane') && rendered.html.includes('919-555-0144'), `letterhead should remain in ${rendered.subject}`);
  }
  process.env.PUBLIC_APP_URL = '';
  const omitted = mailer.renderShareEmail({ letterhead, orderNumber: 'LP-1', message: 'Ready', fileNames: ['a.pdf'], link: '/login?next=%2Forders%2F1' });
  assert(!omitted.html.includes('acg-logo') && !omitted.html.includes('accent-imaging-logo') && !omitted.html.includes('<img'), 'hosted logos should be omitted when PUBLIC_APP_URL is unset');
  assert(omitted.html.includes('100 Test Lane') && omitted.html.includes('919-555-0144'), 'letterhead text should remain when the logo is omitted');
  assert(omitted.html.includes(credit) && omitted.text.includes(credit), 'the credit sentence should remain when the logos are omitted');
  if (previous == null) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = previous;
  console.log('PASS customer emails include the division credit');
}

async function main() {
  runEmailBranding();
  await checkMigration();
  await runApiChecks();
  await runUnconfigured();
  await runUnreachableSmtp();
  console.log('phase 13 ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
