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
    assert(!(operatorNotes.json.notifications || []).some((row) => row.type === 'quote_ready' || row.type === 'quote_accepted'), 'an operator should not receive quote notifications');

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
