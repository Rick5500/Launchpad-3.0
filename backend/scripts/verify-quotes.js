/**
 * Quote requests: customers create their own, operators receive 403,
 * managers and admins quote, and an accepted quote becomes an order
 * only through the normal order create path.
 * Usage (from backend/): node scripts/verify-quotes.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { setServiceNames, fillOrderLines } = require('./orderLineDefaults');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-quotes-'));
const dbFile = path.join(tmp, 'quotes.db');
const uploadDir = path.join(tmp, 'uploads');
const port = 3171;
const adminPassword = 'AdminPass123';
const customerPassword = 'CustomerPass1';
const otherPassword = 'OtherPass123';
const managerPassword = 'ManagerPass1';
const operatorPassword = 'OperatorPass1';

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
    DELIVERY_TIMEZONE: 'UTC',
    WILL_CALL_WINDOW_START: '08:00',
    WILL_CALL_WINDOW_END: '17:00',
    DELIVERY_WINDOW_START: '09:00',
    DELIVERY_WINDOW_END: '16:00',
    DELIVERY_SLOT_MINUTES: '15',
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: uploadDir,
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
    SMTP_HOST: '',
    SMTP_FROM: '',
    MAIL_TRANSPORT: '',
    ...extra,
  };
}

function request({ method, path: requestPath, token, json, raw, contentType, port: requestPort }) {
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
      port: requestPort || port,
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
        resolve({ status: res.statusCode, json: parsed, text });
      });
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function multipart(files) {
  const boundary = `----LaunchpadQuotes${Date.now().toString(16)}`;
  const chunks = [];
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/pdf'}\r\n\r\n`
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

function weekdayAhead() {
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
  for (let add = 1; add < 12; add += 1) {
    const date = new Date(Date.now() + add * 24 * 60 * 60 * 1000);
    const weekday = dayFmt.format(date);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    return dateFmt.format(date);
  }
  throw new Error('no weekday found');
}

function startServer(extraEnv = {}) {
  const env = { ...process.env, ...baseEnv(), ...extraEnv };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const closed = new Promise((resolve) => child.on('close', () => resolve()));
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not become ready\n${logs}`)), 15000);
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
    stop() { child.kill('SIGTERM'); },
  };
}

async function login(username, password) {
  const response = await request({ method: 'POST', path: '/api/auth/login', json: { username, password } });
  assert(response.status === 200 && response.json && response.json.token, `login failed for ${username}: ${response.status} ${response.text}`);
  return response.json;
}

function quoteBody(overrides = {}) {
  return {
    project_name: 'Lobby banner',
    description: 'Full color banner with grommets.',
    quantity: '2',
    size: '36 x 72',
    material: '13 oz scrim',
    finishing: 'Hem and grommets every 2 feet.',
    needed_by: weekdayAhead(),
    ...overrides,
  };
}

function orderBody(customerId, quoteId, serviceId, fileIds) {
  return fillOrderLines({
    customer_id: customerId,
    quote_request_id: quoteId,
    company: 'Quote Co',
    contact_name: 'Quinn Quote',
    phone: '919-555-0101',
    email: 'quinn@quote.example',
    project_name: 'Lobby banner',
    notes: 'Converted from the accepted quote.',
    originals_source: fileIds.length ? 'Files attached below' : 'Hardcopy or digital media provided',
    file_ids: fileIds,
    address_line1: '1 Quote Way',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Will Call',
    due_date: weekdayAhead(),
    due_time: '10:00',
    service_ids: [serviceId],
    line_items: [{ description: 'Banner', quantity: '2', service_id: serviceId }],
  });
}

async function main() {
  fs.mkdirSync(uploadDir, { recursive: true });
  const firstInit = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  assert(firstInit.code === 0, `init_db failed\n${firstInit.out}\n${firstInit.err}`);
  const secondInit = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  assert(secondInit.code === 0, `second init_db failed\n${secondInit.out}\n${secondInit.err}`);

  const server = startServer();
  const db = openDb(dbFile);
  try {
    await server.ready;
    const admin = await login('admin', adminPassword);
    const customerResponse = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Quinn Quote',
        username: 'quotecustomer',
        password: customerPassword,
        company: 'Quote Co',
        contact_name: 'Quinn Quote',
        phone: '919-555-0101',
        email: 'quinn@quote.example',
        address_line1: '1 Quote Way',
        city: 'Raleigh',
        state: 'NC',
        zip: '27601',
      },
    });
    assert(customerResponse.status === 201 && customerResponse.json.id, customerResponse.text);
    const otherResponse = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Other Customer',
        username: 'quoteother',
        password: otherPassword,
        company: 'Other Co',
        contact_name: 'Olivia Other',
        phone: '919-555-0102',
        email: 'olivia@quote.example',
      },
    });
    assert(otherResponse.status === 201, otherResponse.text);
    const managerResponse = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: { username: 'quotemanager', display_name: 'Quote Manager', role: 'manager', password: managerPassword, email: 'manager@quote.example' },
    });
    assert(managerResponse.status === 201, managerResponse.text);
    const operatorResponse = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: { username: 'quoteoperator', display_name: 'Quote Operator', role: 'operator', password: operatorPassword, email: 'operator@quote.example' },
    });
    assert(operatorResponse.status === 201, operatorResponse.text);

    const customer = await login('quotecustomer', customerPassword);
    const other = await login('quoteother', otherPassword);
    const manager = await login('quotemanager', managerPassword);
    const operator = await login('quoteoperator', operatorPassword);

    const anonymous = await request({ method: 'GET', path: '/api/quote-requests' });
    assert(anonymous.status === 401, `signed-out list should be 401, got ${anonymous.status}`);

    const staffCreate = await request({
      method: 'POST',
      path: '/api/quote-requests',
      token: manager.token,
      json: quoteBody(),
    });
    assert(staffCreate.status === 403, `manager create should be 403, got ${staffCreate.status} ${staffCreate.text}`);

    const upload = multipart([{ name: 'banner.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 banner') }]);
    const uploaded = await request({
      method: 'POST',
      path: '/api/uploads',
      token: customer.token,
      raw: upload.raw,
      contentType: upload.contentType,
    });
    assert(uploaded.status === 201 && uploaded.json.files && uploaded.json.files[0], uploaded.text);
    const fileId = uploaded.json.files[0].id;

    const created = await request({
      method: 'POST',
      path: '/api/quote-requests',
      token: customer.token,
      json: quoteBody({ file_ids: [fileId] }),
    });
    assert(created.status === 201 && created.json.quote && created.json.quote.status === 'New', created.text);
    const quoteId = created.json.quote.id;
    assert(created.json.quote.files.some((file) => file.id === fileId && file.original_name === 'banner.pdf'), 'the request should keep the uploaded file');

    const requestedTitle = 'New quote request from Quinn Quote: Lobby banner';
    const managerAfterCreate = await request({ method: 'GET', path: '/api/notifications?limit=20', token: manager.token });
    const adminAfterCreate = await request({ method: 'GET', path: '/api/notifications?limit=20', token: admin.token });
    const customerAfterCreate = await request({ method: 'GET', path: '/api/notifications?limit=20', token: customer.token });
    const operatorAfterCreate = await request({ method: 'GET', path: '/api/notifications?limit=50', token: operator.token });
    const requestedFor = (body, id) => (body.notifications || []).find((row) => row.type === 'quote_requested' && row.quote_request_id === id);
    assert(requestedFor(managerAfterCreate.json, quoteId) && requestedFor(managerAfterCreate.json, quoteId).title === requestedTitle, 'managers should see a new quote request notice naming the customer and project');
    assert(requestedFor(adminAfterCreate.json, quoteId), 'admins should be notified of a new quote request');
    assert(!requestedFor(customerAfterCreate.json, quoteId), 'customers should not receive the staff new-request notice');
    assert(!(operatorAfterCreate.json.notifications || []).some((row) => row.type === 'quote_requested' || row.type === 'quote_declined'), 'an operator should not receive a new quote request notice');
    const skippedEmail = await db.get(
      `SELECT id FROM activity_log WHERE action = 'quote_request.staff_emailed' AND entity_id = ?`,
      [quoteId]
    );
    assert(!skippedEmail, 'quote request email should be skipped when SMTP is not configured');

    const managerBoard = await request({ method: 'GET', path: '/api/admin-board', token: manager.token });
    assert(managerBoard.status === 200 && managerBoard.json.quote_requests, managerBoard.text);
    assert(managerBoard.json.quote_requests.new_count >= 1, 'managers should see the new quote count');
    const boardQuote = (managerBoard.json.quote_requests.quotes || []).find((row) => row.id === quoteId);
    assert(boardQuote && boardQuote.project_name === 'Lobby banner' && boardQuote.customer_name === 'Quinn Quote' && boardQuote.status === 'New' && boardQuote.needed_by, `dashboard should list the new request: ${JSON.stringify(boardQuote)}`);
    assert((managerBoard.json.alerts || []).some((alert) => alert.id === 'quote-requests' && alert.count >= 1), 'new quote requests should show in system alerts');
    assert((managerBoard.json.activity || []).some((row) => row.action === 'quote_request.created' && row.entity_id === quoteId), 'new quote requests should show in recent activity');
    const adminBoard = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    assert(adminBoard.status === 200 && (adminBoard.json.quote_requests.quotes || []).some((row) => row.id === quoteId), 'admins should see quote requests on the dashboard');
    const operatorBoard = await request({ method: 'GET', path: '/api/admin-board', token: operator.token });
    assert(operatorBoard.status === 200 && operatorBoard.json.quote_requests == null, `operators should not receive quote dashboard data: ${operatorBoard.text.slice(0, 300)}`);
    assert(!(operatorBoard.json.alerts || []).some((alert) => alert.id === 'quote-requests' || alert.id === 'quote-accepted'), 'operators should not see quote alerts');
    assert(!(operatorBoard.json.activity || []).some((row) => row.entity_type === 'quote_request'), 'operators should not see quote activity on the dashboard');
    const operatorActivity = await request({ method: 'GET', path: '/api/admin-board/activity?limit=100', token: operator.token });
    assert(operatorActivity.status === 200 && !(operatorActivity.json.activity || []).some((row) => row.entity_type === 'quote_request'), 'operators should not receive quote activity');
    const customerBoard = await request({ method: 'GET', path: '/api/admin-board', token: customer.token });
    assert(customerBoard.status === 403, 'customers should not load the staff dashboard');
    const settingsCatalog = await request({ method: 'GET', path: '/api/notifications/settings', token: admin.token });
    assert(settingsCatalog.status === 200, settingsCatalog.text);
    const settingKeys = new Set((settingsCatalog.json.in_app || []).map((event) => event.event_key));
    assert(settingKeys.has('quote_requested') && settingKeys.has('quote_declined'), 'quote request notification settings should be listed');

    const createdLog = await db.get(
      `SELECT action, detail FROM activity_log WHERE action = 'quote_request.created' AND entity_id = ?`,
      [quoteId]
    );
    assert(createdLog && createdLog.detail.includes('Lobby banner'), 'creating a request should be logged');

    const ownList = await request({ method: 'GET', path: '/api/quote-requests', token: customer.token });
    assert(ownList.status === 200 && ownList.json.quotes.some((row) => row.id === quoteId), ownList.text);
    const hidden = await request({ method: 'GET', path: '/api/quote-requests', token: other.token });
    assert(hidden.status === 200 && hidden.json.quotes.length === 0, 'another customer should not see the request');
    const hiddenDetail = await request({ method: 'GET', path: `/api/quote-requests/${quoteId}`, token: other.token });
    assert(hiddenDetail.status === 404, `another customer should get 404, got ${hiddenDetail.status}`);
    const hiddenDownload = await request({ method: 'GET', path: `/api/uploads/${fileId}/download`, token: other.token });
    assert(hiddenDownload.status === 404, 'another customer should not download the file');
    const blockedDelete = await request({ method: 'DELETE', path: `/api/uploads/${fileId}`, token: customer.token });
    assert(blockedDelete.status === 403, `a file on a quote should not be deleted, got ${blockedDelete.status}`);
    const operatorDownload = await request({ method: 'GET', path: `/api/uploads/${fileId}/download`, token: operator.token });
    assert(operatorDownload.status === 403 || operatorDownload.status === 404, `operator download of a quote file should be 403 or 404, got ${operatorDownload.status}`);
    const operatorDelete = await request({ method: 'DELETE', path: `/api/uploads/${fileId}`, token: operator.token });
    assert(operatorDelete.status === 403 || operatorDelete.status === 404, `operator delete of a quote file should be 403 or 404, got ${operatorDelete.status}`);
    const quoteFileRemains = await db.get('SELECT id, quote_request_id FROM order_files WHERE id = ?', [fileId]);
    assert(quoteFileRemains && quoteFileRemains.quote_request_id === quoteId, 'an operator must not delete a quote file');

    for (const pathName of [
      '/api/quote-requests',
      '/api/quote-requests/summary',
      `/api/quote-requests/${quoteId}`,
      `/api/quote-requests/${quoteId}/order-draft`,
    ]) {
      const blocked = await request({ method: 'GET', path: pathName, token: operator.token });
      assert(blocked.status === 403, `operator GET ${pathName} should be 403, got ${blocked.status} ${blocked.text}`);
    }
    const operatorCreate = await request({
      method: 'POST',
      path: '/api/quote-requests',
      token: operator.token,
      json: quoteBody(),
    });
    assert(operatorCreate.status === 403, 'operator create should be 403');
    const operatorQuote = await request({
      method: 'POST',
      path: `/api/quote-requests/${quoteId}/quote`,
      token: operator.token,
      json: { price: '10.00' },
    });
    assert(operatorQuote.status === 403, 'operator quote should be 403');

    const customerQuote = await request({
      method: 'POST',
      path: `/api/quote-requests/${quoteId}/quote`,
      token: customer.token,
      json: { price: '10.00' },
    });
    assert(customerQuote.status === 403, 'customer quote should be 403');

    const summary = await request({ method: 'GET', path: '/api/quote-requests/summary', token: manager.token });
    assert(summary.status === 200 && summary.json.new_count >= 1, summary.text);
    const filtered = await request({ method: 'GET', path: '/api/quote-requests?status=New', token: admin.token });
    assert(filtered.status === 200 && filtered.json.quotes.some((row) => row.id === quoteId), 'admin should see the new request');

    const earlyDraft = await request({ method: 'GET', path: `/api/quote-requests/${quoteId}/order-draft`, token: manager.token });
    assert(earlyDraft.status === 409, `draft before accept should be 409, got ${earlyDraft.status}`);

    const quoted = await request({
      method: 'POST',
      path: `/api/quote-requests/${quoteId}/quote`,
      token: manager.token,
      json: {
        price: '486.50',
        notes: 'Price includes hemming. Valid on this artwork.',
        valid_until: weekdayAhead(),
        line_items: [
          { code: 'BAN', unit: 'ea', quantity: '2', description: 'Lobby banner', price: '240.00' },
          { code: 'FIN', unit: 'lot', quantity: '1', description: 'Grommets', price: '6.50' },
        ],
      },
    });
    assert(quoted.status === 200 && quoted.json.quote.status === 'Quoted', quoted.text);
    assert(quoted.json.quote.price === '486.50', 'the stored price should keep cents');
    assert(quoted.json.quote.line_items.length === 2, 'line items should be stored');
    assert(quoted.json.email && quoted.json.email.status === 'not_configured', `email should be skipped without SMTP, got ${JSON.stringify(quoted.json.email)}`);

    const customerNotes = await request({ method: 'GET', path: '/api/notifications?limit=20', token: customer.token });
    assert(customerNotes.status === 200, customerNotes.text);
    const readyNote = (customerNotes.json.notifications || []).find((row) => row.type === 'quote_ready' && row.quote_request_id === quoteId);
    assert(readyNote, 'the customer should be notified in the app');
    const operatorNotes = await request({ method: 'GET', path: '/api/notifications?limit=50', token: operator.token });
    assert(operatorNotes.status === 200, operatorNotes.text);
    assert(!(operatorNotes.json.notifications || []).some((row) => row.type === 'quote_ready' || row.type === 'quote_accepted' || row.type === 'quote_requested' || row.type === 'quote_declined'), 'an operator should not receive quote notifications');
    const quotedBoard = await request({ method: 'GET', path: '/api/admin-board', token: manager.token });
    assert(quotedBoard.json.quote_requests && quotedBoard.json.quote_requests.new_count === 0, 'sending the only new quote should clear the new count');
    assert(!(quotedBoard.json.quote_requests.quotes || []).some((row) => row.id === quoteId), 'a quoted request should leave the open dashboard list');
    assert(!(quotedBoard.json.alerts || []).some((alert) => alert.id === 'quote-requests'), 'the new-request alert should clear when nothing is new');

    const options = await request({ method: 'GET', path: '/api/orders/options', token: manager.token });
    assert(options.status === 200, options.text);
    const byName = Object.fromEntries(options.json.services.map((service) => [service.name, service]));
    setServiceNames(byName);
    const serviceId = byName['Large Format'].id;

    const tooSoon = await request({
      method: 'POST',
      path: '/api/orders',
      token: manager.token,
      json: orderBody(customerResponse.json.id, quoteId, serviceId, [fileId]),
    });
    assert(tooSoon.status === 400, `converting before accept should be 400, got ${tooSoon.status} ${tooSoon.text}`);
    const stillQuoted = await db.get('SELECT status, converted_order_id FROM quote_requests WHERE id = ?', [quoteId]);
    assert(stillQuoted.status === 'Quoted' && !stillQuoted.converted_order_id, 'a rejected order must not convert the quote');

    const accepted = await request({ method: 'POST', path: `/api/quote-requests/${quoteId}/accept`, token: customer.token, json: {} });
    assert(accepted.status === 200 && accepted.json.quote.status === 'Accepted', accepted.text);
    const acceptAgain = await request({ method: 'POST', path: `/api/quote-requests/${quoteId}/accept`, token: customer.token, json: {} });
    assert(acceptAgain.status === 409, 'accepting twice should be 409');
    const managerNotes = await request({ method: 'GET', path: '/api/notifications?limit=20', token: manager.token });
    assert((managerNotes.json.notifications || []).some((row) => row.type === 'quote_accepted' && row.quote_request_id === quoteId), 'managers should be notified when a quote is accepted');
    const customerAfterAccept = await request({ method: 'GET', path: '/api/notifications?limit=20', token: customer.token });
    assert(!(customerAfterAccept.json.notifications || []).some((row) => row.type === 'quote_accepted'), 'the accept notice is for staff');
    const acceptedBoard = await request({ method: 'GET', path: '/api/admin-board', token: manager.token });
    assert(acceptedBoard.json.quote_requests && acceptedBoard.json.quote_requests.accepted_count >= 1, 'accepted quotes waiting to convert should be counted');
    const acceptedRow = (acceptedBoard.json.quote_requests.quotes || []).find((row) => row.id === quoteId);
    assert(acceptedRow && acceptedRow.status === 'Accepted' && acceptedRow.project_name === 'Lobby banner', 'an accepted quote should stay on the dashboard until it is converted');
    const acceptedAlert = (acceptedBoard.json.alerts || []).find((alert) => alert.id === 'quote-accepted');
    assert(acceptedAlert && acceptedAlert.count >= 1 && acceptedAlert.quote_request_id === quoteId, 'the accepted-quote alert should point at the quote ready to convert');
    assert((acceptedBoard.json.activity || []).some((row) => row.action === 'quote_request.accepted' && row.entity_id === quoteId), 'accepting a quote should show in recent activity');
    const adminAcceptedBoard = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    assert((adminAcceptedBoard.json.quote_requests.quotes || []).some((row) => row.id === quoteId && row.status === 'Accepted'), 'admins should see accepted quotes ready to convert');
    const operatorAcceptedBoard = await request({ method: 'GET', path: '/api/admin-board', token: operator.token });
    assert(operatorAcceptedBoard.json.quote_requests == null, 'operators should not receive accepted quote dashboard data');
    assert(!(operatorAcceptedBoard.json.alerts || []).some((alert) => alert.id === 'quote-accepted'), 'operators should not see the accepted-quote alert');

    const ordersBefore = await db.get('SELECT COUNT(*) AS count FROM orders');
    const badOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: manager.token,
      json: { ...orderBody(customerResponse.json.id, quoteId, serviceId, [fileId]), company: '' },
    });
    assert(badOrder.status === 400, `an incomplete order should be 400, got ${badOrder.status} ${badOrder.text}`);
    const operatorOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: operator.token,
      json: orderBody(customerResponse.json.id, quoteId, serviceId, [fileId]),
    });
    assert(operatorOrder.status === 403, `operator convert should be 403, got ${operatorOrder.status} ${operatorOrder.text}`);
    const operatorGrab = orderBody(customerResponse.json.id, quoteId, serviceId, [fileId]);
    delete operatorGrab.quote_request_id;
    const operatorSteal = await request({
      method: 'POST',
      path: '/api/orders',
      token: operator.token,
      json: operatorGrab,
    });
    assert(operatorSteal.status === 403 || operatorSteal.status === 404, `operator order with a quote file should be 403 or 404, got ${operatorSteal.status} ${operatorSteal.text}`);
    const fileUntouched = await db.get('SELECT order_id, quote_request_id FROM order_files WHERE id = ?', [fileId]);
    assert(fileUntouched && fileUntouched.order_id == null && fileUntouched.quote_request_id === quoteId, 'an operator order must not attach or change a quote file');
    const customerGrab = orderBody(customerResponse.json.id, quoteId, serviceId, [fileId]);
    delete customerGrab.quote_request_id;
    const customerSteal = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: customerGrab,
    });
    assert(customerSteal.status === 403 || customerSteal.status === 404, `a customer cannot attach a quote file to another order, got ${customerSteal.status} ${customerSteal.text}`);
    const customerOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(customerResponse.json.id, quoteId, serviceId, [fileId]),
    });
    assert(customerOrder.status === 403, `customer convert should be 403, got ${customerOrder.status} ${customerOrder.text}`);
    const ordersAfterRejects = await db.get('SELECT COUNT(*) AS count FROM orders');
    assert(ordersAfterRejects.count === ordersBefore.count, 'failed converts must not leave an order');
    const notConverted = await db.get('SELECT converted_order_id FROM quote_requests WHERE id = ?', [quoteId]);
    assert(!notConverted.converted_order_id, 'the quote stays unconverted until a valid order is saved');

    const draft = await request({ method: 'GET', path: `/api/quote-requests/${quoteId}/order-draft`, token: manager.token });
    assert(draft.status === 200 && draft.json.project_name === 'Lobby banner', draft.text);
    assert(draft.json.customer_id === customerResponse.json.id, 'the draft should name the customer');
    assert(draft.json.files.some((file) => file.id === fileId), 'the draft should include the quote file');

    const converted = await request({
      method: 'POST',
      path: '/api/orders',
      token: manager.token,
      json: orderBody(customerResponse.json.id, quoteId, serviceId, draft.json.files.map((file) => file.id)),
    });
    assert(converted.status === 201 && converted.json.order && converted.json.order.id, `convert failed: ${converted.status} ${converted.text}`);
    assert(converted.json.work_orders && converted.json.work_orders.length === 1, 'the order should open a work order through the normal flow');
    const linked = await db.get('SELECT status, converted_order_id FROM quote_requests WHERE id = ?', [quoteId]);
    assert(linked.status === 'Accepted' && linked.converted_order_id === converted.json.order.id, 'the quote should point at the new order');
    const fileLinked = await db.get('SELECT order_id, quote_request_id FROM order_files WHERE id = ?', [fileId]);
    assert(fileLinked.order_id === converted.json.order.id && fileLinked.quote_request_id === quoteId, 'the file should stay on the quote and move onto the order');
    const convertLog = await db.get(
      `SELECT id FROM activity_log WHERE action = 'quote_request.converted' AND entity_id = ?`,
      [quoteId]
    );
    assert(convertLog, 'converting should be logged');
    const again = await request({
      method: 'POST',
      path: '/api/orders',
      token: admin.token,
      json: orderBody(customerResponse.json.id, quoteId, serviceId, []),
    });
    assert(again.status === 409, `a second convert should be 409, got ${again.status} ${again.text}`);
    const convertedBoard = await request({ method: 'GET', path: '/api/admin-board', token: admin.token });
    assert(!(convertedBoard.json.quote_requests.quotes || []).some((row) => row.id === quoteId), 'a converted quote should leave the open dashboard list');
    assert(convertedBoard.json.quote_requests.accepted_count === 0, 'a converted quote should leave the accepted count');

    const declinedRequest = await request({
      method: 'POST',
      path: '/api/quote-requests',
      token: customer.token,
      json: quoteBody({ project_name: 'Window graphic', description: 'White vinyl.', quantity: '1' }),
    });
    assert(declinedRequest.status === 201, declinedRequest.text);
    const declineId = declinedRequest.json.quote.id;
    const adminQuote = await request({
      method: 'POST',
      path: `/api/quote-requests/${declineId}/quote`,
      token: admin.token,
      json: { price: '90.00', notes: 'First price', line_items: [] },
    });
    assert(adminQuote.status === 200 && adminQuote.json.quote.status === 'Quoted', adminQuote.text);
    const declined = await request({
      method: 'POST',
      path: `/api/quote-requests/${declineId}/decline`,
      token: customer.token,
      json: { reason: 'Price is over budget.' },
    });
    assert(declined.status === 200 && declined.json.quote.status === 'Declined', declined.text);
    assert(declined.json.quote.decline_reason === 'Price is over budget.', 'the decline reason should be stored');
    const declineLog = await db.get(
      `SELECT id FROM activity_log WHERE action = 'quote_request.declined' AND entity_id = ?`,
      [declineId]
    );
    assert(declineLog, 'declining should be logged');
    const declineNotes = await request({ method: 'GET', path: '/api/notifications?limit=30', token: manager.token });
    const declineNote = (declineNotes.json.notifications || []).find((row) => row.type === 'quote_declined' && row.quote_request_id === declineId);
    assert(declineNote && /Price is over budget/.test(declineNote.body || ''), `managers should see the decline reason, got ${JSON.stringify(declineNote)}`);
    const adminDeclineNotes = await request({ method: 'GET', path: '/api/notifications?limit=30', token: admin.token });
    assert((adminDeclineNotes.json.notifications || []).some((row) => row.type === 'quote_declined' && row.quote_request_id === declineId), 'admins should be notified when a quote is declined');
    const operatorDeclineNotes = await request({ method: 'GET', path: '/api/notifications?limit=50', token: operator.token });
    assert(!(operatorDeclineNotes.json.notifications || []).some((row) => row.type === 'quote_requested' || row.type === 'quote_declined' || row.type === 'quote_ready' || row.type === 'quote_accepted'), 'an operator should not receive quote notifications');
    const customerDeclineNotes = await request({ method: 'GET', path: '/api/notifications?limit=30', token: customer.token });
    assert(!(customerDeclineNotes.json.notifications || []).some((row) => row.type === 'quote_declined' || row.type === 'quote_requested'), 'customers should not receive staff quote notices');
    const readyBefore = await db.get(
      `SELECT COUNT(*) AS count FROM notifications WHERE type = 'quote_ready' AND quote_request_id = ?`,
      [declineId]
    );
    const quiet = await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { quote_ready: false } },
    });
    assert(quiet.status === 200, quiet.text);
    const revised = await request({
      method: 'POST',
      path: `/api/quote-requests/${declineId}/quote`,
      token: admin.token,
      json: {
        price: '75.00',
        notes: 'Revised price.',
        line_items: [{ code: 'WIN', unit: 'ea', quantity: '1', description: 'Window graphic', price: '75.00' }],
      },
    });
    assert(revised.status === 200 && revised.json.quote.status === 'Quoted' && revised.json.quote.price === '75.00', revised.text);
    assert(revised.json.quote.quote_version === 2, 'a resend should advance the quote version');
    assert(!revised.json.quote.decline_reason, 'a revised quote should clear the decline reason');
    const readyAfter = await db.get(
      `SELECT COUNT(*) AS count FROM notifications WHERE type = 'quote_ready' AND quote_request_id = ?`,
      [declineId]
    );
    assert(readyAfter.count === readyBefore.count, 'a disabled quote notification should not be written');

    const quietRequestedBefore = await db.get(`SELECT COUNT(*) AS count FROM notifications WHERE type = 'quote_requested'`);
    const quietDeclinedBefore = await db.get(`SELECT COUNT(*) AS count FROM notifications WHERE type = 'quote_declined'`);
    const quietSettings = await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { quote_requested: false, quote_declined: false } },
    });
    assert(quietSettings.status === 200, quietSettings.text);
    assert((quietSettings.json.in_app || []).some((event) => event.event_key === 'quote_requested' && event.enabled === false), 'the new-request setting should turn off');
    assert((quietSettings.json.in_app || []).some((event) => event.event_key === 'quote_declined' && event.enabled === false), 'the decline setting should turn off');
    const quietRequest = await request({
      method: 'POST',
      path: '/api/quote-requests',
      token: customer.token,
      json: quoteBody({ project_name: 'Quiet request', description: 'No notice.', quantity: '1' }),
    });
    assert(quietRequest.status === 201, quietRequest.text);
    const quietRequestedAfter = await db.get(`SELECT COUNT(*) AS count FROM notifications WHERE type = 'quote_requested'`);
    assert(quietRequestedAfter.count === quietRequestedBefore.count, 'turning off quote_requested should suppress the notice');
    const quietQuoted = await request({
      method: 'POST',
      path: `/api/quote-requests/${quietRequest.json.quote.id}/quote`,
      token: manager.token,
      json: { price: '12.00', line_items: [] },
    });
    assert(quietQuoted.status === 200, quietQuoted.text);
    const quietDeclined = await request({
      method: 'POST',
      path: `/api/quote-requests/${quietRequest.json.quote.id}/decline`,
      token: customer.token,
      json: { reason: 'Not now' },
    });
    assert(quietDeclined.status === 200, quietDeclined.text);
    const quietDeclinedAfter = await db.get(`SELECT COUNT(*) AS count FROM notifications WHERE type = 'quote_declined'`);
    assert(quietDeclinedAfter.count === quietDeclinedBefore.count, 'turning off quote_declined should suppress the notice');

    const openRequest = await request({
      method: 'POST',
      path: '/api/quote-requests',
      token: other.token,
      json: quoteBody({ project_name: 'Still new', description: 'Waiting.', quantity: '4' }),
    });
    assert(openRequest.status === 201, openRequest.text);
    const newOnly = await request({ method: 'GET', path: '/api/quote-requests?status=New', token: manager.token });
    assert(newOnly.json.quotes.some((row) => row.project_name === 'Still new'), 'the New filter should include the open request');
    assert(!newOnly.json.quotes.some((row) => row.id === quoteId), 'an accepted quote should leave the New filter');
    const badge = await request({ method: 'GET', path: '/api/quote-requests/summary', token: admin.token });
    assert(badge.json.new_count === newOnly.json.total, 'the badge count should match New requests');
  } catch (err) {
    console.error(server.logs());
    throw err;
  } finally {
    server.stop();
    await server.closed;
    await db.close();
  }

  const mailServer = startServer({
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '2525',
    SMTP_FROM: 'quotes@accent.example',
    SMTP_SECURE: 'false',
    PUBLIC_APP_URL: 'https://launchpad.example',
    MAIL_TRANSPORT: 'json',
  });
  try {
    await mailServer.ready;
    const admin = await login('admin', adminPassword);
    const list = await request({ method: 'GET', path: '/api/quote-requests?status=Quoted', token: admin.token });
    const windowQuote = list.json.quotes.find((row) => row.project_name === 'Window graphic');
    assert(windowQuote, 'the revised quote should still be listed');
    const mailed = await request({
      method: 'POST',
      path: `/api/quote-requests/${windowQuote.id}/quote`,
      token: admin.token,
      json: { price: '70.00', notes: 'Emailed price.', valid_until: weekdayAhead(), line_items: [] },
    });
    assert(mailed.status === 200 && mailed.json.email && mailed.json.email.status === 'sent', mailed.text);
    const html = mailed.json.email.preview && mailed.json.email.preview.html;
    assert(html && html.includes('Window graphic') && html.includes('$70.00'), 'the quote email should name the job and the price');
    assert(html.includes('quotes%2F') || html.includes('/quotes/'), 'the quote email should link back to the customer quote');

    const mailDb = openDb(dbFile);
    await mailDb.run(`UPDATE users SET email = 'admin@quote.example' WHERE username = 'admin'`);
    await mailDb.run(
      `INSERT INTO users (username, password_hash, role, display_name, email, is_active)
       VALUES ('quietmanager', 'x', 'manager', 'Quiet Manager', 'quiet@quote.example', 0)`
    );
    await mailDb.close();
    const enableRequested = await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { quote_requested: true } },
    });
    assert(enableRequested.status === 200, enableRequested.text);
    const customer = await login('quotecustomer', customerPassword);
    const suppressed = await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { quote_requested: false } },
    });
    assert(suppressed.status === 200, suppressed.text);
    const silentRequest = await request({
      method: 'POST',
      path: '/api/quote-requests',
      token: customer.token,
      json: quoteBody({ project_name: 'Silent banner', description: 'No mail.', quantity: '1' }),
    });
    assert(silentRequest.status === 201, silentRequest.text);
    const silentMail = await openDb(dbFile);
    const silentLog = await silentMail.get(
      `SELECT id FROM activity_log WHERE action = 'quote_request.staff_emailed' AND entity_id = ?`,
      [silentRequest.json.quote.id]
    );
    const silentNote = await silentMail.get(
      `SELECT id FROM notifications WHERE type = 'quote_requested' AND quote_request_id = ?`,
      [silentRequest.json.quote.id]
    );
    await silentMail.close();
    assert(!silentLog && !silentNote, 'a disabled quote request setting should suppress the notice and the email');
    const enabledAgain = await request({
      method: 'PUT',
      path: '/api/notifications/settings',
      token: admin.token,
      json: { events: { quote_requested: true } },
    });
    assert(enabledAgain.status === 200, enabledAgain.text);
    const mailedRequest = await request({
      method: 'POST',
      path: '/api/quote-requests',
      token: customer.token,
      json: quoteBody({ project_name: 'Mailed banner <b>', description: 'Please quote.', quantity: '3' }),
    });
    assert(mailedRequest.status === 201, mailedRequest.text);
    const mailedDb = openDb(dbFile);
    const mailedLog = await mailedDb.get(
      `SELECT detail FROM activity_log WHERE action = 'quote_request.staff_emailed' AND entity_id = ?`,
      [mailedRequest.json.quote.id]
    );
    const mailedNotes = await mailedDb.all(
      `SELECT id FROM notifications WHERE type = 'quote_requested' AND quote_request_id = ?`,
      [mailedRequest.json.quote.id]
    );
    await mailedDb.close();
    assert(mailedNotes.length === 1, 'the mailed request should write one in-app notice');
    assert(mailedLog, 'configured SMTP should email managers about a new quote request');
    const mailedDetail = JSON.parse(mailedLog.detail);
    const recipients = (mailedDetail.recipients || []).map((address) => String(address).toLowerCase());
    assert(recipients.includes('manager@quote.example') && recipients.includes('admin@quote.example'), `active managers and admins should be emailed, got ${recipients.join(', ')}`);
    assert(!recipients.includes('operator@quote.example') && !recipients.includes('quiet@quote.example'), 'operators and inactive managers should not be emailed');
    assert(mailedDetail.subject === 'New quote request from Quinn Quote: Mailed banner <b>', `email subject should name the request, got ${mailedDetail.subject}`);
    const mailer = require('../mailer');
    const rendered = mailer.renderQuoteRequestEmail({
      letterhead: { name: 'Accent', address_lines: [], phone: '' },
      customerName: 'Quinn <Quote>',
      projectName: 'A & B',
      neededBy: '2026-11-02',
      link: mailer.staffQuoteLink(mailedRequest.json.quote.id),
    });
    assert(rendered.html.includes('Quinn &lt;Quote&gt;') && rendered.html.includes('A &amp; B'), 'the request email should escape names');
    assert(!rendered.html.includes('Quinn <Quote>'), 'raw HTML in a customer name should not be sent');
    assert(rendered.html.includes('quote-requests'), 'the request email should link to Quote Requests');
  } catch (err) {
    console.error(mailServer.logs());
    throw err;
  } finally {
    mailServer.stop();
    await mailServer.closed;
  }

  const upgraded = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  assert(upgraded.code === 0, `init after data should succeed\n${upgraded.err}`);
  const check = openDb(dbFile);
  const kept = await check.get(`SELECT project_name, status, converted_order_id FROM quote_requests WHERE project_name = 'Lobby banner'`);
  assert(kept && kept.status === 'Accepted' && kept.converted_order_id, 'init should keep an existing quote');
  const stillOff = await check.get(`SELECT enabled, COUNT(*) AS count FROM notification_settings WHERE event_key = 'quote_ready'`);
  assert(stillOff && stillOff.enabled === 0 && stillOff.count === 1, 'init should not turn a quote notification back on or duplicate it');
  const declinedOff = await check.get(`SELECT enabled, COUNT(*) AS count FROM notification_settings WHERE event_key = 'quote_declined'`);
  assert(declinedOff && declinedOff.enabled === 0 && declinedOff.count === 1, 'init should not turn a declined-quote notification back on or duplicate it');
  await check.run(`DELETE FROM notification_settings WHERE event_key = 'quote_requested'`);
  await check.run('DROP TABLE quote_line_items');
  await check.run('DROP TABLE quote_requests');
  await check.run('DROP INDEX IF EXISTS idx_order_files_quote');
  await check.run('DROP INDEX IF EXISTS idx_notifications_quote');
  await check.run('ALTER TABLE order_files DROP COLUMN quote_request_id');
  await check.run('ALTER TABLE notifications DROP COLUMN quote_request_id');
  await check.close();

  const repaired = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  assert(repaired.code === 0, `init should restore quote tables\n${repaired.out}\n${repaired.err}`);
  const after = openDb(dbFile);
  const quoteCols = await after.all('PRAGMA table_info(quote_requests)');
  const fileCols = await after.all('PRAGMA table_info(order_files)');
  const noteCols = await after.all('PRAGMA table_info(notifications)');
  for (const name of ['project_name', 'status', 'price', 'quote_version', 'converted_order_id']) {
    assert(quoteCols.some((column) => column.name === name), `quote_requests.${name} should exist after upgrade`);
  }
  assert(fileCols.some((column) => column.name === 'quote_request_id'), 'order_files.quote_request_id should be added on upgrade');
  assert(noteCols.some((column) => column.name === 'quote_request_id'), 'notifications.quote_request_id should be added on upgrade');
  const setting = await after.get(`SELECT enabled FROM notification_settings WHERE event_key = 'quote_accepted'`);
  assert(setting && setting.enabled === 1, 'a missing quote notification setting should be seeded');
  const requestedSetting = await after.get(`SELECT enabled, channel FROM notification_settings WHERE event_key = 'quote_requested'`);
  assert(requestedSetting && requestedSetting.enabled === 1 && requestedSetting.channel === 'in_app', 'a missing quote request setting should be seeded on');
  const declinedSetting = await after.get(`SELECT enabled, COUNT(*) AS count FROM notification_settings WHERE event_key = 'quote_declined'`);
  assert(declinedSetting && declinedSetting.enabled === 0 && declinedSetting.count === 1, 'init should leave a disabled quote decline setting off');
  await after.close();
  console.log('PASS quote requests');
}

main()
  .then(() => {
    console.log('quotes ok');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
