/**
 * Phase 17 checks: staff send a proof, the owning customer approves or
 * requests changes, and approval releases an open job once.
 * Usage (from backend/): node scripts/verify-phase17.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase17-'));
const dbFile = path.join(tmp, 'phase17.db');
const uploadDir = path.join(tmp, 'uploads');
const port = 3137;
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

function baseEnv() {
  return {
    DATABASE_FILE: dbFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    DELIVERY_TIMEZONE: 'America/New_York',
    DUE_SOON_HOURS: '1',
    DELIVERY_WINDOW_START: '09:00',
    DELIVERY_WINDOW_END: '16:00',
    DELIVERY_SLOT_MINUTES: '15',
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: uploadDir,
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '2525',
    SMTP_USER: 'proofs',
    SMTP_PASS: 'secret',
    SMTP_FROM: 'proofs@accent.example',
    SMTP_SECURE: 'false',
    PUBLIC_APP_URL: appUrl,
    MAIL_TRANSPORT: 'json',
  };
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

function weekdayAhead() {
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  for (let add = 1; add < 12; add += 1) {
    const date = new Date(Date.now() + add * 24 * 60 * 60 * 1000);
    const weekday = dayFmt.format(date);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    return dateFmt.format(date);
  }
  throw new Error('no weekday found');
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

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...baseEnv() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let stopped = false;
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
        // server still starting
      }
      setTimeout(poll, 200);
    };
    poll();
  });
  return {
    ready,
    logs: () => logs,
    stop() {
      stopped = true;
      child.kill('SIGTERM');
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

function orderBody(byName, overrides) {
  return fillOrderLines({
    company: 'Phase Seventeen Co',
    contact_name: 'Pat Seventeen',
    phone: '919-555-1717',
    email: 'pat@phase17.example',
    project_name: 'Proof cycle',
    notes: 'Hold this for a proof.',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '17 Proof Lane',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Will Call',
    due_date: weekdayAhead(),
    due_time: '10:00',
    service_ids: [byName['Large Format'].id, byName['Small Format'].id],
    line_items: [
      { description: 'Banner', quantity: '1', service_id: byName['Large Format'].id },
      { description: 'Card', quantity: '1', service_id: byName['Small Format'].id },
    ],
    ...overrides,
  });
}

async function placeOrder(token, byName, overrides) {
  const response = await request({
    method: 'POST',
    path: '/api/orders',
    token,
    json: orderBody(byName, overrides),
  });
  assert(response.status === 201, `order create failed: ${response.status} ${response.text}`);
  const workA = response.json.work_orders.find((row) => String(row.external_id).endsWith('-A'));
  const workB = response.json.work_orders.find((row) => String(row.external_id).endsWith('-B'));
  assert(workA && workB, 'the order should create two work orders');
  return { order: response.json.order, workA, workB };
}

function sendProof(token, orderId, fields, files) {
  const form = multipart({ files, fields });
  return request({
    method: 'POST',
    path: `/api/orders/${orderId}/proofs`,
    token,
    raw: form.raw,
    contentType: form.contentType,
  });
}

async function historyCount(db, workOrderId, notes) {
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM production_history WHERE work_order_id = ? AND notes = ?`,
    [workOrderId, notes]
  );
  return row.count;
}

async function releaseCount(db, workOrderId) {
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM activity_log
     WHERE entity_type = 'work_order' AND entity_id = ? AND action = 'work_order.proof_released'`,
    [workOrderId]
  );
  return row.count;
}

async function main() {
  fs.mkdirSync(uploadDir, { recursive: true });
  const env = baseEnv();
  const init = await spawnNode(path.join(backendDir, 'init_db.js'), env);
  if (init.code !== 0) throw new Error(`init_db failed (${init.code})\n${init.out}\n${init.err}`);

  const seeded = openDb(dbFile);
  await seeded.run(`UPDATE system_settings SET value = '0' WHERE key = 'email_customers_on_proof'`);
  await seeded.run(`DELETE FROM notification_settings WHERE event_key = 'proof_ready'`);
  const columnBefore = await seeded.all(`PRAGMA table_info(work_orders)`);
  assert(columnBefore.some((column) => column.name === 'proof_status'), 'proof_status should exist after init');
  await seeded.close();

  const again = await spawnNode(path.join(backendDir, 'init_db.js'), env);
  if (again.code !== 0) throw new Error(`second init_db failed (${again.code})\n${again.out}\n${again.err}`);
  const restored = openDb(dbFile);
  const flag = await restored.get(`SELECT value FROM system_settings WHERE key = 'email_customers_on_proof'`);
  assert(flag && flag.value === '0', 'a saved proof email switch should survive init');
  const ready = await restored.get(`SELECT COUNT(*) AS count FROM notification_settings WHERE event_key = 'proof_ready' AND channel = 'in_app'`);
  const decisionEvent = await restored.get(`SELECT COUNT(*) AS count FROM notification_settings WHERE event_key = 'proof_decision' AND enabled = 1`);
  assert(ready.count === 1, 'a missing proof_ready event should be inserted once');
  assert(decisionEvent.count === 1, 'proof_decision should stay enabled');
  await restored.run(`UPDATE system_settings SET value = '1' WHERE key = 'email_customers_on_proof'`);
  await restored.close();

  const server = startServer();
  const db = openDb(dbFile);
  try {
    await server.ready;
    assert(/MAIL_TRANSPORT=json is set with SMTP_HOST/.test(server.logs()), 'startup should warn when json transport is set with SMTP_HOST');
    const admin = await login('admin', adminPassword);
    await db.run(`UPDATE users SET email = 'admin@phase17.example' WHERE username = 'admin'`);
    const operatorUser = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'phase17op',
        display_name: 'Phase Seventeen Operator',
        role: 'operator',
        password: 'OperatorPass123',
        email: 'op@phase17.example',
        department: 'Large Format',
      },
    });
    assert(operatorUser.status === 201, `operator create failed: ${operatorUser.status} ${operatorUser.text}`);
    const managerUser = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'phase17mgr',
        display_name: 'Phase Seventeen Manager',
        role: 'manager',
        password: 'ManagerPass123',
        email: 'mgr@phase17.example',
      },
    });
    assert(managerUser.status === 201, `manager create failed: ${managerUser.status} ${managerUser.text}`);
    const created = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Phase Seventeen Customer',
        username: 'phase17',
        password: 'CustomerPass1',
        company: 'Phase Seventeen Co',
        contact_name: 'Pat Seventeen',
        phone: '919-555-1717',
        email: 'pat@phase17.example',
      },
    });
    assert(created.status === 201 && created.json.id, `customer create failed: ${created.status} ${created.text}`);
    const otherCustomer = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Other Customer',
        username: 'phase17other',
        password: 'CustomerPass1',
        company: 'Other Co',
        contact_name: 'Other Person',
        phone: '919-555-1700',
        email: 'other@phase17.example',
      },
    });
    assert(otherCustomer.status === 201, otherCustomer.text);

    const customer = await login('phase17', 'CustomerPass1');
    const other = await login('phase17other', 'CustomerPass1');
    const operator = await login('phase17op', 'OperatorPass123');
    const manager = await login('phase17mgr', 'ManagerPass123');
    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    assert(options.status === 200, options.text);
    const byName = Object.fromEntries(options.json.services.map((service) => [service.name, service]));
    setServiceNames(byName);

    const unauth = await request({ method: 'GET', path: '/api/orders/1/proofs' });
    assert(unauth.status === 401, `unsigned list should be 401, got ${unauth.status}`);
    const badId = await request({ method: 'GET', path: '/api/orders/0/proofs', token: admin.token });
    assert(badId.status === 400, `id 0 should be 400, got ${badId.status}`);

    const first = await placeOrder(customer.token, byName);
    const customerSend = await sendProof(customer.token, first.order.id, { message: 'Please review' }, [pdfFile('customer.pdf', 'nope')]);
    assert(customerSend.status === 403, `a customer should not send a proof, got ${customerSend.status}`);

    const noFiles = await sendProof(operator.token, first.order.id, { message: 'Look at this' }, []);
    assert(noFiles.status === 400, `a proof needs a file, got ${noFiles.status} ${noFiles.text}`);
    const noMessage = await sendProof(operator.token, first.order.id, {}, [pdfFile('blank.pdf', 'blank')]);
    assert(noMessage.status === 400, `a proof needs a message, got ${noMessage.status}`);
    const badType = await sendProof(operator.token, first.order.id, { message: 'No' }, [{ name: 'virus.exe', type: 'application/octet-stream', data: Buffer.from('MZ') }]);
    assert(badType.status === 400, `exe should be rejected, got ${badType.status} ${badType.text}`);
    const wrongJob = await sendProof(operator.token, first.order.id, { message: 'Wrong job', work_order_id: '999999' }, [pdfFile('wrong.pdf', 'wrong')]);
    assert(wrongJob.status === 400, `a work order from another order should be rejected, got ${wrongJob.status}`);

    const sent = await sendProof(operator.token, first.order.id, {
      message: 'Please review <script>alert(1)</script>',
      work_order_id: String(first.workA.id),
      send_email: 'true',
      email_to: 'pat@phase17.example',
    }, [pdfFile('../../proof <b>1</b>.pdf', 'proof-bytes'), pdfFile('notes.png', 'png')]);
    assert(sent.status === 201, `operator send failed: ${sent.status} ${sent.text}`);
    assert(sent.json.proof.version === 1 && sent.json.proof.version_label === 'v1', JSON.stringify(sent.json.proof));
    assert(sent.json.proof.status === 'awaiting' && sent.json.proof.status_label === 'Awaiting proof approval', sent.json.proof.status_label);
    assert(sent.json.proof.files.length === 2, 'both files should be stored');
    assert(!sent.json.proof.files.some((file) => /[\\/<>]/.test(file.original_name)), `names should be sanitized: ${JSON.stringify(sent.json.proof.files)}`);
    assert(sent.json.email.status === 'sent', `email should send, got ${sent.json.email && sent.json.email.status}`);
    const html = sent.json.email.preview && sent.json.email.preview.html;
    assert(html && html.includes('&lt;script&gt;'), 'the proof email should escape the message');
    assert(html.includes('/login?next=') && html.includes('%23proofs'), `the email should link to sign-in, got ${html}`);
    assert(!html.includes('/api/proof-files') && !html.includes('token='), 'the email should not offer a public download');

    const held = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [first.workA.id]);
    const sibling = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [first.workB.id]);
    assert(held.status === 'open' && held.proof_status === 'awaiting', `the proofed job should be held open, got ${JSON.stringify(held)}`);
    assert(sibling.status === 'open' && !sibling.proof_status, `the other job should not be held, got ${JSON.stringify(sibling)}`);

    const staffDetail = await request({ method: 'GET', path: `/api/workorders/${first.workA.id}`, token: operator.token });
    assert(staffDetail.status === 200 && staffDetail.json.proof_status_label === 'Awaiting proof approval', staffDetail.text);
    assert((staffDetail.json.proofs || []).some((proof) => proof.version === 1), 'the work order should list the proof');

    const heldPrint = await request({ method: 'GET', path: `/api/workorders/${first.workA.id}/print`, token: admin.token });
    assert(heldPrint.status === 200, heldPrint.text);
    assert(heldPrint.json.work_orders[0].routing.current_status === 'open', 'printing a held job should leave it open');
    assert(await historyCount(db, first.workA.id, 'Printed') === 0, 'a held print should not log Printed');
    const printedActivity = await db.get(
      `SELECT COUNT(*) AS count FROM activity_log WHERE entity_type = 'work_order' AND entity_id = ? AND action = 'work_order.printed'`,
      [first.workA.id]
    );
    assert(printedActivity.count === 0, 'a held print should not write work_order.printed');

    const siblingPrint = await request({ method: 'GET', path: `/api/workorders/${first.workB.id}/print`, token: manager.token });
    assert(siblingPrint.status === 200, siblingPrint.text);
    const siblingAfter = await db.get(`SELECT status FROM work_orders WHERE id = ?`, [first.workB.id]);
    assert(siblingAfter.status === 'in-progress', 'printing the job without a proof should move it to In Production');
    assert(await historyCount(db, first.workB.id, 'Printed') === 1, 'the unheld job should log one Printed row');

    const ownList = await request({ method: 'GET', path: `/api/orders/${first.order.id}/proofs`, token: customer.token });
    assert(ownList.status === 200 && ownList.json.proofs.length === 1, ownList.text);
    const otherList = await request({ method: 'GET', path: `/api/orders/${first.order.id}/proofs`, token: other.token });
    assert(otherList.status === 404, `another customer should not see the order proofs, got ${otherList.status}`);
    const fileId = sent.json.proof.files[0].id;
    const otherDownload = await request({ method: 'GET', path: `/api/proof-files/${fileId}/download`, token: other.token });
    assert(otherDownload.status === 404, `another customer should not download the proof, got ${otherDownload.status}`);
    const otherView = await request({ method: 'GET', path: `/api/proof-files/${fileId}/view`, token: other.token });
    assert(otherView.status === 404, `another customer should not view the proof, got ${otherView.status}`);
    const guessed = await request({ method: 'GET', path: '/api/proof-files/999999/download', token: customer.token });
    assert(guessed.status === 404, `a guessed file should be 404, got ${guessed.status}`);

    const download = await request({ method: 'GET', path: `/api/proof-files/${fileId}/download`, token: customer.token });
    assert(download.status === 200, `download failed: ${download.status} ${download.text}`);
    assert(download.headers['x-content-type-options'] === 'nosniff', 'download should set nosniff');
    assert(download.headers['cache-control'] === 'private, no-store', 'download should not be cached');
    assert(String(download.headers['content-type'] || '').includes('application/pdf'), `download content type should be pdf, got ${download.headers['content-type']}`);
    assert(/attachment/i.test(String(download.headers['content-disposition'] || '')), `download should be an attachment, got ${download.headers['content-disposition']}`);
    const view = await request({ method: 'GET', path: `/api/proof-files/${fileId}/view`, token: customer.token });
    assert(view.status === 200, `view failed: ${view.status}`);
    assert(/inline/i.test(String(view.headers['content-disposition'] || '')), `view should be inline, got ${view.headers['content-disposition']}`);
    assert(view.headers['x-content-type-options'] === 'nosniff', 'view should set nosniff');

    const pending = await request({ method: 'GET', path: '/api/proofs/pending', token: customer.token });
    assert(pending.status === 200 && pending.json.proofs.some((proof) => proof.id === sent.json.proof.id), 'the customer should see the pending proof');
    const otherPending = await request({ method: 'GET', path: '/api/proofs/pending', token: other.token });
    assert(otherPending.status === 200 && !(otherPending.json.proofs || []).some((proof) => proof.order_id === first.order.id), 'another customer should not see this pending proof');

    const notes = await request({ method: 'GET', path: '/api/notifications', token: customer.token });
    const welcome = (notes.json.notifications || []).find((row) => row.type === 'proof_ready' && row.order_id === first.order.id);
    assert(welcome && welcome.title === `New proof for order ${first.order.order_number}`, JSON.stringify(notes.json.notifications));
    const otherNotes = await request({ method: 'GET', path: '/api/notifications', token: other.token });
    assert(!(otherNotes.json.notifications || []).some((row) => row.type === 'proof_ready' && row.order_id === first.order.id), 'another customer should not see the proof notification');

    const duplicateWhileWaiting = await sendProof(operator.token, first.order.id, {
      message: 'Still waiting',
      work_order_id: String(first.workA.id),
      send_email: 'false',
    }, [pdfFile('early.pdf', 'early')]);
    assert(duplicateWhileWaiting.status === 409, `a second version should wait until this one is decided, got ${duplicateWhileWaiting.status} ${duplicateWhileWaiting.text}`);

    const staffApprove = await request({ method: 'POST', path: `/api/proofs/${sent.json.proof.id}/approve`, token: operator.token });
    assert(staffApprove.status === 403, `staff should not approve, got ${staffApprove.status}`);
    const otherApprove = await request({ method: 'POST', path: `/api/proofs/${sent.json.proof.id}/approve`, token: other.token });
    assert(otherApprove.status === 404, `another customer should not approve, got ${otherApprove.status}`);
    const emptyComment = await request({
      method: 'POST',
      path: `/api/proofs/${sent.json.proof.id}/changes`,
      token: customer.token,
      json: { comment: '   ' },
    });
    assert(emptyComment.status === 400, `changes need a comment, got ${emptyComment.status} ${emptyComment.text}`);
    const stillAwaiting = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [first.workA.id]);
    assert(stillAwaiting.status === 'open' && stillAwaiting.proof_status === 'awaiting', 'a rejected change request should leave the proof awaiting');

    const changes = await request({
      method: 'POST',
      path: `/api/proofs/${sent.json.proof.id}/changes`,
      token: customer.token,
      json: { comment: 'Please darken the logo' },
    });
    assert(changes.status === 200 && changes.json.proof.status === 'changes_requested', changes.text);
    assert(changes.json.proof.decision_comment === 'Please darken the logo', 'the comment should be stored');
    assert(changes.json.proof.decided_by_name && changes.json.proof.decided_at, 'the decision should record who and when');
    assert(changes.json.email && changes.json.email.status === 'sent', `staff should be emailed, got ${JSON.stringify(changes.json.email)}`);
    const staffHtml = changes.json.email.preview && changes.json.email.preview.html;
    assert(staffHtml && staffHtml.includes('Please darken the logo'), 'the staff email should include the comment');
    assert(staffHtml.includes('/login?next='), 'the staff email should link to sign-in');
    const staffAddresses = (changes.json.email.recipients || []).map((row) => row.address).sort();
    assert(staffAddresses.includes('admin@phase17.example') && staffAddresses.includes('op@phase17.example'), `staff emails were ${staffAddresses.join(',')}`);
    const changed = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [first.workA.id]);
    assert(changed.status === 'open' && changed.proof_status === 'changes_requested', `changes should keep the job open, got ${JSON.stringify(changed)}`);
    const againPrint = await request({ method: 'GET', path: `/api/workorders/${first.workA.id}/print`, token: admin.token });
    assert(againPrint.json.work_orders[0].routing.current_status === 'open', 'printing after changes were requested should stay open');
    assert(await historyCount(db, first.workA.id, 'Printed') === 0, 'changes requested should still block the print move');

    const staffNotes = await request({ method: 'GET', path: '/api/notifications', token: manager.token });
    const decisionNote = (staffNotes.json.notifications || []).find((row) => row.type === 'proof_decision' && row.order_id === first.order.id);
    assert(decisionNote && /Changes requested/.test(decisionNote.title), JSON.stringify(staffNotes.json.notifications));
    const customerDecisions = await request({ method: 'GET', path: '/api/notifications?limit=50', token: customer.token });
    assert(!(customerDecisions.json.notifications || []).some((row) => row.type === 'proof_decision'), 'the customer should not see the staff decision notification');
    const pendingAfter = await request({ method: 'GET', path: '/api/proofs/pending', token: customer.token });
    assert(!(pendingAfter.json.proofs || []).some((proof) => proof.id === sent.json.proof.id), 'a decided proof should leave the pending list');

    const decidedAgain = await request({ method: 'POST', path: `/api/proofs/${sent.json.proof.id}/approve`, token: customer.token });
    assert(decidedAgain.status === 409, `a decided version should stay decided, got ${decidedAgain.status}`);

    const versionTwo = await sendProof(manager.token, first.order.id, {
      message: 'Darker logo attached',
      work_order_id: String(first.workA.id),
      send_email: 'false',
    }, [pdfFile('proof-v2.pdf', 'v2')]);
    assert(versionTwo.status === 201 && versionTwo.json.proof.version === 2, versionTwo.text);
    assert(versionTwo.json.proof.status === 'awaiting', 'a new version should await approval');
    assert(versionTwo.json.email.status === 'skipped', `send_email false should skip mail, got ${versionTwo.json.email.status}`);
    const reset = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [first.workA.id]);
    assert(reset.proof_status === 'awaiting' && reset.status === 'open', `v2 should hold the job again, got ${JSON.stringify(reset)}`);
    const pendingV2 = await request({ method: 'GET', path: '/api/proofs/pending', token: customer.token });
    assert(pendingV2.json.proofs.some((proof) => proof.id === versionTwo.json.proof.id), 'v2 should be pending');

    const detailComments = await request({ method: 'GET', path: `/api/workorders/${first.workA.id}`, token: admin.token });
    const older = (detailComments.json.proofs || []).find((proof) => proof.version === 1);
    assert(older && older.decision_comment === 'Please darken the logo', 'staff should see the customer comment on the work order');

    const raced = await Promise.all([0, 1].map(() => request({
      method: 'POST',
      path: `/api/proofs/${versionTwo.json.proof.id}/approve`,
      token: customer.token,
    })));
    const statuses = raced.map((response) => response.status).sort();
    assert(statuses[0] === 200 && statuses[1] === 409, `double approve should be one success and one conflict, got ${statuses.join(',')}`);
    const released = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [first.workA.id]);
    assert(released.status === 'in-progress' && released.proof_status === 'approved', `approval should release the job, got ${JSON.stringify(released)}`);
    assert(await historyCount(db, first.workA.id, 'Proof approved') === 1, 'double approve should write one production history row');
    assert(await releaseCount(db, first.workA.id) === 1, 'double approve should write one activity row');
    assert(await releaseCount(db, first.workB.id) === 0, 'approving one work order should not release its sibling');
    const third = await request({ method: 'POST', path: `/api/proofs/${versionTwo.json.proof.id}/approve`, token: customer.token });
    assert(third.status === 409, `the approved version should stay final, got ${third.status}`);
    assert(await historyCount(db, first.workA.id, 'Proof approved') === 1, 'a later approve should not add another transition');

    const afterRelease = await request({ method: 'GET', path: `/api/workorders/${first.workA.id}/print`, token: admin.token });
    assert(afterRelease.status === 200, afterRelease.text);
    assert(await historyCount(db, first.workA.id, 'Printed') === 0, 'a job already released by approval should not also log Printed');
    assert(await releaseCount(db, first.workA.id) === 1, 'reprinting should not add another release');
    const approvedDetail = await request({ method: 'GET', path: `/api/workorders/${first.workA.id}`, token: operator.token });
    assert(approvedDetail.json.proof_status_label === 'Approved', approvedDetail.json.proof_status_label);

    const whole = await placeOrder(customer.token, byName, { project_name: 'Whole order proof' });
    const orderProof = await sendProof(admin.token, whole.order.id, {
      message: 'Proof for both jobs',
      send_email: 'false',
    }, [pdfFile('both.pdf', 'both')]);
    assert(orderProof.status === 201 && orderProof.json.proof.work_order_id == null, orderProof.text);
    const bothHeld = await db.all(
      `SELECT id, status, proof_status FROM work_orders WHERE order_id = ? ORDER BY id`,
      [whole.order.id]
    );
    assert(bothHeld.every((row) => row.status === 'open' && row.proof_status === 'awaiting'), `an order proof should hold every job, got ${JSON.stringify(bothHeld)}`);
    const orderPrint = await request({ method: 'GET', path: `/api/orders/${whole.order.id}/print`, token: admin.token });
    assert(orderPrint.status === 200, orderPrint.text);
    const stillHeld = await db.all(`SELECT status FROM work_orders WHERE order_id = ?`, [whole.order.id]);
    assert(stillHeld.every((row) => row.status === 'open'), 'printing the order should not release jobs that are awaiting a proof');

    const approvedOrder = await request({
      method: 'POST',
      path: `/api/proofs/${orderProof.json.proof.id}/approve`,
      token: customer.token,
    });
    assert(approvedOrder.status === 200, approvedOrder.text);
    assert((approvedOrder.json.released_work_order_ids || []).length === 2, `both jobs should be released, got ${JSON.stringify(approvedOrder.json.released_work_order_ids)}`);
    const bothLive = await db.all(`SELECT status, proof_status FROM work_orders WHERE order_id = ?`, [whole.order.id]);
    assert(bothLive.every((row) => row.status === 'in-progress' && row.proof_status === 'approved'), JSON.stringify(bothLive));
    assert(await historyCount(db, whole.workA.id, 'Proof approved') === 1, 'each job should log one release');
    assert(await historyCount(db, whole.workB.id, 'Proof approved') === 1, 'the second job should log one release');

    const laterOnLive = await sendProof(operator.token, whole.order.id, {
      message: 'One more look after production started',
      work_order_id: String(whole.workA.id),
      send_email: 'false',
    }, [pdfFile('already-live.pdf', 'later')]);
    assert(laterOnLive.status === 201, laterOnLive.text);
    const stillLive = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [whole.workA.id]);
    assert(stillLive.status === 'in-progress' && stillLive.proof_status === 'awaiting', `a new proof on a live job should wait without leaving In Production, got ${JSON.stringify(stillLive)}`);
    assert(await releaseCount(db, whole.workA.id) === 1, 'sending a later proof should not release the job again');

    const jobFirst = await placeOrder(customer.token, byName, { project_name: 'Job proof then order proof' });
    const jobProof = await sendProof(admin.token, jobFirst.order.id, {
      message: 'Job proof first',
      work_order_id: String(jobFirst.workA.id),
      send_email: 'false',
    }, [pdfFile('job-first.pdf', 'job')]);
    assert(jobProof.status === 201, jobProof.text);
    const orderAfterJob = await sendProof(admin.token, jobFirst.order.id, {
      message: 'Order proof second',
      send_email: 'false',
    }, [pdfFile('order-second.pdf', 'order')]);
    assert(orderAfterJob.status === 201, orderAfterJob.text);
    const covered = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [jobFirst.workA.id]);
    assert(covered.status === 'open' && covered.proof_status === 'awaiting', `both proofs should hold the job, got ${JSON.stringify(covered)}`);
    const approveOrderFirst = await request({
      method: 'POST',
      path: `/api/proofs/${orderAfterJob.json.proof.id}/approve`,
      token: customer.token,
    });
    assert(approveOrderFirst.status === 200, approveOrderFirst.text);
    const stillJob = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [jobFirst.workA.id]);
    assert(stillJob.status === 'open' && stillJob.proof_status === 'awaiting', `approving the order proof should leave the awaiting job proof holding the job, got ${JSON.stringify(stillJob)}`);
    assert(!(approveOrderFirst.json.released_work_order_ids || []).includes(jobFirst.workA.id), 'the job with an awaiting job proof should not be released');
    const siblingReleased = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [jobFirst.workB.id]);
    assert(siblingReleased.status === 'in-progress' && siblingReleased.proof_status === 'approved', `the sibling covered only by the order proof should enter In Production, got ${JSON.stringify(siblingReleased)}`);
    const heldPrintAfterOrder = await request({ method: 'GET', path: `/api/workorders/${jobFirst.workA.id}/print`, token: admin.token });
    assert(heldPrintAfterOrder.json.work_orders[0].routing.current_status === 'open', 'printing should not move a job that still has an awaiting job proof');
    const approveOlderJob = await request({
      method: 'POST',
      path: `/api/proofs/${jobProof.json.proof.id}/approve`,
      token: customer.token,
    });
    assert(approveOlderJob.status === 200, `the older job proof should still be approvable, got ${approveOlderJob.status} ${approveOlderJob.text}`);
    const jobReleased = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [jobFirst.workA.id]);
    assert(jobReleased.status === 'in-progress' && jobReleased.proof_status === 'approved', `approving the remaining proof should move the job to In Production, got ${JSON.stringify(jobReleased)}`);
    assert(await releaseCount(db, jobFirst.workA.id) === 1, 'the job should be released once');
    assert(await historyCount(db, jobFirst.workA.id, 'Proof approved') === 1, 'the job should log one release');

    const orderFirst = await placeOrder(customer.token, byName, { project_name: 'Order proof then job proof' });
    const orderProofFirst = await sendProof(manager.token, orderFirst.order.id, {
      message: 'Order proof first',
      send_email: 'false',
    }, [pdfFile('order-first.pdf', 'order')]);
    assert(orderProofFirst.status === 201, orderProofFirst.text);
    const jobAfterOrder = await sendProof(manager.token, orderFirst.order.id, {
      message: 'Job proof second',
      work_order_id: String(orderFirst.workA.id),
      send_email: 'false',
    }, [pdfFile('job-second.pdf', 'job')]);
    assert(jobAfterOrder.status === 201, jobAfterOrder.text);
    const bothAwaiting = await db.all(
      `SELECT id, status, proof_status FROM work_orders WHERE order_id = ? ORDER BY id`,
      [orderFirst.order.id]
    );
    assert(bothAwaiting.every((row) => row.status === 'open' && row.proof_status === 'awaiting'), `the newer job proof should not clear the order hold, got ${JSON.stringify(bothAwaiting)}`);
    const approveNewerJob = await request({
      method: 'POST',
      path: `/api/proofs/${jobAfterOrder.json.proof.id}/approve`,
      token: customer.token,
    });
    assert(approveNewerJob.status === 200, approveNewerJob.text);
    const heldByOrder = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [orderFirst.workA.id]);
    assert(heldByOrder.status === 'open' && heldByOrder.proof_status === 'awaiting', `approving the job proof should leave the awaiting order proof holding the job, got ${JSON.stringify(heldByOrder)}`);
    assert((approveNewerJob.json.released_work_order_ids || []).length === 0, 'a newer job proof should not release a job the order proof still holds');
    const siblingStill = await db.get(`SELECT status, proof_status FROM work_orders WHERE id = ?`, [orderFirst.workB.id]);
    assert(siblingStill.status === 'open' && siblingStill.proof_status === 'awaiting', 'the sibling should stay held by the order proof');
    const approveOlderOrder = await request({
      method: 'POST',
      path: `/api/proofs/${orderProofFirst.json.proof.id}/approve`,
      token: customer.token,
    });
    assert(approveOlderOrder.status === 200, `the older order proof should still be approvable, got ${approveOlderOrder.status} ${approveOlderOrder.text}`);
    const bothLiveAfter = await db.all(
      `SELECT id, status, proof_status FROM work_orders WHERE order_id = ? ORDER BY id`,
      [orderFirst.order.id]
    );
    assert(bothLiveAfter.every((row) => row.status === 'in-progress' && row.proof_status === 'approved'), `both jobs should enter In Production once every covering proof is approved, got ${JSON.stringify(bothLiveAfter)}`);
    assert(await releaseCount(db, orderFirst.workA.id) === 1, 'the job proofed twice should be released once');
    assert(await releaseCount(db, orderFirst.workB.id) === 1, 'the sibling should be released once');
    assert(await historyCount(db, orderFirst.workA.id, 'Proof approved') === 1, 'the twice-proofed job should log one release');
    assert(await historyCount(db, orderFirst.workB.id, 'Proof approved') === 1, 'the sibling should log one release');

    const quiet = await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { proof_ready: false } },
    });
    assert(quiet.status === 200, quiet.text);
    const quietOrder = await placeOrder(customer.token, byName, { project_name: 'Quiet proof' });
    const beforeQuiet = await db.get(`SELECT COUNT(*) AS count FROM notifications WHERE type = 'proof_ready'`);
    const quietSend = await sendProof(operator.token, quietOrder.order.id, {
      message: 'No bell',
      work_order_id: String(quietOrder.workA.id),
      send_email: 'false',
    }, [pdfFile('quiet.pdf', 'quiet')]);
    assert(quietSend.status === 201, quietSend.text);
    const afterQuiet = await db.get(`SELECT COUNT(*) AS count FROM notifications WHERE type = 'proof_ready'`);
    assert(afterQuiet.count === beforeQuiet.count, 'a disabled proof notification should not be stored');

    console.log('PASS phase 17 proofs, hold, and one release');
  } finally {
    server.stop();
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
