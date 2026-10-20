/**
 * Phase 18 checks: a read-only Microsoft 365 mailbox becomes draft orders.
 * A mock Graph server covers the token, polling, dedupe, attachments, and
 * rejected file types. Staff convert or dismiss. Customers cannot.
 * Usage (from backend/): node scripts/verify-phase18.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase18-'));
const dbFile = path.join(tmp, 'phase18.db');
const uploadDir = path.join(tmp, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const port = 3148;
const graphPort = 3149;
const graphBase = `http://127.0.0.1:${graphPort}`;
const adminPassword = 'AdminPass123';
const clientSecret = 'phase18-client-secret-do-not-log';
const accessToken = 'phase18-access-token-do-not-log';
const tenantId = 'tenant-phase18';
const clientId = 'client-phase18';
const mailbox = 'orders@phase18.example';

process.env.DATABASE_FILE = dbFile;
process.env.M365_TENANT_ID = tenantId;
process.env.M365_CLIENT_ID = clientId;
process.env.M365_CLIENT_SECRET = clientSecret;
process.env.M365_MAILBOX = mailbox;
process.env.M365_LOGIN_BASE_URL = graphBase;
process.env.M365_GRAPH_BASE_URL = graphBase;
process.env.M365_HTTP_TIMEOUT_MS = '8000';

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

function weekdayAhead() {
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  for (let add = 1; add < 14; add += 1) {
    const date = new Date(Date.now() + add * 24 * 60 * 60 * 1000);
    const weekday = dayFmt.format(date);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    return dateFmt.format(date);
  }
  throw new Error('no weekday found');
}

const dueDate = weekdayAhead();
const pdfBytes = Buffer.from('%PDF-1.4 phase18 art');
const calls = [];
let graphGets = 0;
const tokenBodies = [];
const preferHeaders = [];
let tokenStatus = 200;
let graphMode = 'inbox';

function messages() {
  return [
    {
      id: 'msg-order',
      subject: 'PO 44821 <3 <script>alert(1)</script> banners',
      receivedDateTime: new Date().toISOString(),
      hasAttachments: true,
      from: { emailAddress: { name: 'Pat Eighteen', address: 'pat@phase18.example' } },
      body: {
        contentType: 'html',
        content: [
          '<p>Please print the lobby banners.</p>',
          '<p>Quantity: 12</p>',
          `<p>Due: ${dueDate}</p>`,
          '<p>Job: Lobby banner set</p>',
          '<script>alert(1)</script>',
          '<img src=x onerror="alert(1)">',
        ].join(''),
      },
    },
    {
      id: 'msg-domain',
      subject: 'Need posters',
      receivedDateTime: new Date(Date.now() - 1000).toISOString(),
      hasAttachments: false,
      from: { emailAddress: { name: 'Purchasing', address: 'purchasing@phase18.example' } },
      body: { contentType: 'text', content: 'Quantity: 4 copies for the lobby.' },
    },
    {
      id: 'msg-dismiss',
      subject: 'Hello from outside',
      receivedDateTime: new Date(Date.now() - 2000).toISOString(),
      hasAttachments: false,
      from: { emailAddress: { name: 'Stranger', address: 'stranger@elsewhere.example' } },
      body: { contentType: 'text', content: 'This is not an order.' },
    },
  ];
}

function attachmentPayload() {
  return {
    value: [
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        id: 'att-pdf',
        name: 'art.pdf',
        contentType: 'application/pdf',
        size: pdfBytes.length,
        isInline: false,
        contentBytes: pdfBytes.toString('base64'),
      },
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        id: 'att-exe',
        name: 'notes.exe',
        contentType: 'application/octet-stream',
        size: 8,
        isInline: false,
        contentBytes: Buffer.from('MZ fake').toString('base64'),
      },
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        id: 'att-html',
        name: 'page.html',
        contentType: 'text/html',
        size: 40,
        isInline: false,
        contentBytes: Buffer.from('<html><script>alert(1)</script></html>').toString('base64'),
      },
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        id: 'att-big',
        name: 'huge.pdf',
        contentType: 'application/pdf',
        size: 5 * 1024 * 1024,
        isInline: false,
        contentBytes: Buffer.from('%PDF-1.4 tiny').toString('base64'),
      },
    ],
  };
}

function sendJson(res, status, body) {
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': raw.length,
  });
  res.end(raw);
}

function startMock() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, graphBase);
    calls.push({ method: req.method, path: url.pathname });
    if (url.pathname === '/hang') return;
    if (req.method === 'POST' && url.pathname.endsWith('/oauth2/v2.0/token')) {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        tokenBodies.push(Buffer.concat(chunks).toString('utf8'));
        if (tokenStatus !== 200) {
          sendJson(res, tokenStatus, {
            error: 'invalid_client',
            error_description: 'The client credentials were rejected',
          });
          return;
        }
        sendJson(res, 200, {
          token_type: 'Bearer',
          expires_in: 30,
          access_token: accessToken,
        });
      });
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { message: 'method not allowed' } });
      return;
    }
    graphGets += 1;
    const header = String(req.headers.authorization || '');
    if (header !== `Bearer ${accessToken}`) {
      sendJson(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'bad token' } });
      return;
    }
    if (url.pathname.endsWith('/messages/delta') || url.pathname === '/v1.0/delta' || url.pathname === '/v1.0/delta-done') {
      preferHeaders.push(String(req.headers.prefer || ''));
      if (graphMode === 'deny') {
        sendJson(res, 403, { error: { code: 'ErrorAccessDenied', message: 'Access denied' } });
        return;
      }
      if (graphMode === 'backlog') {
        const page = Number(url.searchParams.get('page') || '0');
        if (!Number.isInteger(page) || page < 0 || page >= 30) {
          sendJson(res, 200, {
            value: [],
            '@odata.deltaLink': `${graphBase}/v1.0/delta-done`,
          });
          return;
        }
        sendJson(res, 200, {
          value: [{
            id: `backlog-${page}`,
            subject: `Backlog page ${page}`,
            receivedDateTime: new Date().toISOString(),
            hasAttachments: false,
            from: { emailAddress: { name: 'Queue', address: `queue${page}@elsewhere.example` } },
            body: { contentType: 'text', content: `Queued page ${page}` },
          }],
          '@odata.nextLink': `${graphBase}/v1.0/delta?page=${page + 1}`,
        });
        return;
      }
      sendJson(res, 200, {
        value: messages(),
        '@odata.deltaLink': `${graphBase}/v1.0/delta`,
      });
      return;
    }
    if (url.pathname.endsWith('/attachments')) {
      sendJson(res, 200, attachmentPayload());
      return;
    }
    sendJson(res, 404, { error: { message: 'not found' } });
  });
  return new Promise((resolve) => {
    server.listen(graphPort, '127.0.0.1', () => resolve(server));
  });
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
    MAX_UPLOAD_MB: '1',
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
    M365_TENANT_ID: tenantId,
    M365_CLIENT_ID: clientId,
    M365_CLIENT_SECRET: clientSecret,
    M365_MAILBOX: mailbox,
    M365_FOLDER: 'Inbox',
    M365_POLL_SECONDS: '180',
    M365_LOGIN_BASE_URL: graphBase,
    M365_GRAPH_BASE_URL: graphBase,
    M365_HTTP_TIMEOUT_MS: '8000',
  };
}

function request({ method, path: requestPath, token, json }) {
  return new Promise((resolve, reject) => {
    const body = json != null ? Buffer.from(JSON.stringify(json)) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) {
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
  const closed = new Promise((resolve) => child.on('close', () => resolve()));
  return {
    ready,
    closed,
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

function orderBody(byName, customerId) {
  return fillOrderLines({
    customer_id: customerId,
    company: 'Phase Eighteen Co',
    contact_name: 'Pat Eighteen',
    phone: '919-555-1818',
    email: 'pat@phase18.example',
    project_name: 'Lobby banner set',
    po_number: '44821',
    notes: 'Quantity: 12',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '18 Mail Lane',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    payment_method: 'Accent Account',
    delivery_method: 'Will Call',
    due_date: dueDate,
    due_time: '10:00',
    service_ids: [byName['Large Format'].id],
    line_items: [
      { description: 'Banners', quantity: '12', service_id: byName['Large Format'].id },
    ],
  });
}

async function waitForEmails(token) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const list = await request({ method: 'GET', path: '/api/inbound-emails?status=all', token });
    if (list.status === 200 && list.json && list.json.total >= 3) return list;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('inbound emails did not arrive');
}

async function main() {
  const mock = await startMock();
  const graphMail = require('../graphMail');
  const savedTenant = process.env.M365_TENANT_ID;
  delete process.env.M365_TENANT_ID;
  assert(graphMail.isConfigured() === false, 'polling config should be off without a tenant');
  const hidden = graphMail.publicConfig();
  assert(hidden.configured === false && hidden.mailbox == null && hidden.folder == null, `an unconfigured mailbox should stay hidden: ${JSON.stringify(hidden)}`);
  assert(!JSON.stringify(hidden).includes(mailbox), 'status config should not include the mailbox address when unset');
  process.env.M365_TENANT_ID = savedTenant;
  const shown = graphMail.publicConfig();
  assert(shown.configured === true && shown.mailbox === mailbox, 'a configured mailbox is visible to staff');
  assert(graphMail.isConfigured() === true, 'the test mailbox should be configured');
  const pollerModule = require('../inboundEmailPoller');
  assert(pollerModule.backoffDelay(1, 180) === 360000, 'the first failure waits twice the poll interval');
  assert(pollerModule.backoffDelay(2, 180) === 720000, 'backoff should double');
  assert(pollerModule.backoffDelay(10, 180) === 30 * 60 * 1000, 'backoff should cap at 30 minutes');

  const started = Date.now();
  let timedOut = false;
  try {
    process.env.M365_HTTP_TIMEOUT_MS = '1000';
    await graphMail.fetchJson(`${graphBase}/hang`);
  } catch (err) {
    timedOut = /timed out/i.test(err.message);
  } finally {
    process.env.M365_HTTP_TIMEOUT_MS = '8000';
  }
  assert(timedOut, 'a hung mailbox request should time out');
  assert(Date.now() - started < 5000, 'the timeout should not wait on the default');
  let refused = false;
  try {
    await graphMail.fetchJson('https://evil.example/steal');
  } catch (err) {
    refused = /configured host/i.test(err.message);
  }
  assert(refused, 'Graph calls should stay on the configured host');

  const initEnv = baseEnv();
  const init = await spawnNode(path.join(backendDir, 'init_db.js'), initEnv);
  if (init.code !== 0) throw new Error(`init_db failed (${init.code})\n${init.out}\n${init.err}`);
  const again = await spawnNode(path.join(backendDir, 'init_db.js'), initEnv);
  if (again.code !== 0) throw new Error(`second init_db failed (${again.code})\n${again.out}\n${again.err}`);
  console.log('PASS fresh init_db twice');

  const inboundEmail = require('../inboundEmail');
  delete process.env.M365_TENANT_ID;
  const hiddenStatus = await inboundEmail.syncStatus({ role: 'admin' });
  assert(hiddenStatus.configured === false && hiddenStatus.mailbox == null, `status should hide the mailbox when Microsoft 365 is not configured: ${JSON.stringify(hiddenStatus)}`);
  process.env.M365_TENANT_ID = savedTenant;

  const pageSource = fs.readFileSync(path.join(backendDir, '../frontend/src/routes/EmailOrders.jsx'), 'utf8');
  assert(!pageSource.includes('dangerouslySetInnerHTML'), 'the email page should render subject and body as text');
  assert(pageSource.includes('{email.subject') && pageSource.includes('{email.body_text'), 'subject and body should be text children');

  const server = startServer();
  const db = openDb(dbFile);
  try {
    await server.ready;
    const admin = await login('admin', adminPassword);
    const created = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Phase Eighteen Customer',
        username: 'phase18',
        password: 'CustomerPass1',
        company: 'Phase Eighteen Co',
        contact_name: 'Pat Eighteen',
        phone: '919-555-1818',
        email: 'pat@phase18.example',
        address_line1: '18 Mail Lane',
        city: 'Raleigh',
        state: 'NC',
        zip: '27601',
      },
    });
    assert(created.status === 201 && created.json.id, `customer create failed: ${created.status} ${created.text}`);
    const operatorUser = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'phase18op',
        display_name: 'Phase Eighteen Operator',
        role: 'operator',
        password: 'OperatorPass123',
        email: 'op@phase18.example',
        department: 'Large Format',
      },
    });
    assert(operatorUser.status === 201, operatorUser.text);
    const managerUser = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'phase18mgr',
        display_name: 'Phase Eighteen Manager',
        role: 'manager',
        password: 'ManagerPass123',
        email: 'mgr@phase18.example',
      },
    });
    assert(managerUser.status === 201, managerUser.text);
    const customer = await login('phase18', 'CustomerPass1');
    const operator = await login('phase18op', 'OperatorPass123');
    const manager = await login('phase18mgr', 'ManagerPass123');

    const anon = await request({ method: 'GET', path: '/api/inbound-emails' });
    assert(anon.status === 401, `anonymous list should be 401, was ${anon.status}`);
    const customerList = await request({ method: 'GET', path: '/api/inbound-emails', token: customer.token });
    assert(customerList.status === 403, `customer list should be 403, was ${customerList.status}`);
    const customerSync = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: customer.token });
    assert(customerSync.status === 403, 'a customer cannot check the mailbox');
    const operatorSync = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: operator.token });
    assert(operatorSync.status === 403, 'only an admin can check the mailbox now');

    const synced = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: admin.token });
    assert(synced.status === 200 && synced.json.ok === true, `sync failed: ${synced.status} ${synced.text}`);
    assert(tokenBodies.length >= 1, 'sync should request a token');
    const tokenBody = decodeURIComponent(tokenBodies[0].replace(/\+/g, ' '));
    assert(tokenBody.includes('grant_type=client_credentials'), 'the token request should use client credentials');
    assert(tokenBody.includes('scope=https://graph.microsoft.com/.default'), `scope was ${tokenBody}`);
    assert(tokenBody.includes(`client_id=${clientId}`), 'the token request should send the client id');
    assert(!server.logs().includes(clientSecret), 'the client secret should not be logged');
    assert(!server.logs().includes(accessToken), 'the access token should not be logged');
    assert(calls.every((call) => call.method === 'GET' || (call.method === 'POST' && call.path.endsWith('/oauth2/v2.0/token'))), `Graph should be read-only: ${calls.map((call) => `${call.method} ${call.path}`).join(', ')}`);
    assert(preferHeaders.some((value) => value.includes('odata.maxpagesize=50')), `delta reads should ask for 50 messages per page: ${preferHeaders.join(' | ')}`);

    const list = await waitForEmails(admin.token);
    assert(list.json.total === 3, `three emails should be stored, saw ${list.json.total}`);
    const againSync = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: admin.token });
    assert(againSync.status === 200, againSync.text);
    const listedAgain = await request({ method: 'GET', path: '/api/inbound-emails?status=all', token: admin.token });
    assert(listedAgain.json.total === 3, `a second poll should not duplicate emails, saw ${listedAgain.json.total}`);
    const rows = await db.all('SELECT graph_message_id FROM inbound_emails');
    assert(new Set(rows.map((row) => row.graph_message_id)).size === 3, 'graph message ids should be unique');

    const operatorList = await request({ method: 'GET', path: '/api/inbound-emails?status=new', token: operator.token });
    assert(operatorList.status === 200 && operatorList.json.total === 3, `operator should see new mail: ${operatorList.status} ${operatorList.text}`);
    const managerList = await request({ method: 'GET', path: '/api/inbound-emails', token: manager.token });
    assert(managerList.status === 200, 'a manager should list inbound email');

    const orderMail = listedAgain.json.emails.find((row) => row.subject && row.subject.includes('44821'));
    const domainMail = listedAgain.json.emails.find((row) => row.from_address === 'purchasing@phase18.example');
    const dismissMail = listedAgain.json.emails.find((row) => row.from_address === 'stranger@elsewhere.example');
    assert(orderMail && domainMail && dismissMail, 'the three messages should be listed');
    const detail = await request({ method: 'GET', path: `/api/inbound-emails/${orderMail.id}`, token: operator.token });
    assert(detail.status === 200, detail.text);
    assert(detail.json.subject.includes('<3'), `subject should keep <3: ${detail.json.subject}`);
    assert(detail.json.subject.includes('<script>alert(1)</script>'), `subject should be stored as text: ${detail.json.subject}`);
    assert(detail.json.subject.includes('PO 44821'), detail.json.subject);
    assert(!detail.json.body_text.includes('<') && !detail.json.body_text.includes('alert'), `body should be plain text: ${detail.json.body_text}`);
    assert(detail.json.body_text.includes('Please print the lobby banners.'), detail.json.body_text);
    assert(detail.json.body_text.includes('Quantity: 12'), detail.json.body_text);
    assert(detail.json.suggestion.po_number === '44821', `PO was ${detail.json.suggestion.po_number}`);
    assert(detail.json.suggestion.quantity === '12', `quantity was ${detail.json.suggestion.quantity}`);
    assert(detail.json.suggestion.due_date === dueDate, `due date was ${detail.json.suggestion.due_date}`);
    assert(detail.json.suggestion.project_name === 'Lobby banner set', detail.json.suggestion.project_name);
    assert(detail.json.suggestion.customer_id === created.json.id && detail.json.suggestion.match === 'email', 'the sender email should match the customer');
    assert(detail.json.suggestion.company === 'Phase Eighteen Co', 'the draft should carry the customer company');
    const domainDetail = await request({ method: 'GET', path: `/api/inbound-emails/${domainMail.id}`, token: manager.token });
    assert(domainDetail.json.suggestion.customer_id === created.json.id && domainDetail.json.suggestion.match === 'domain', 'a single company domain should match');
    const stored = detail.json.attachments.filter((file) => file.stored);
    const skipped = detail.json.attachments.filter((file) => file.skipped_reason);
    assert(stored.length === 1 && stored[0].original_name === 'art.pdf', `stored files were ${JSON.stringify(detail.json.attachments)}`);
    assert(skipped.length === 3, `skipped files were ${JSON.stringify(skipped)}`);
    assert(skipped.every((file) => !file.stored), 'rejected attachments should not be stored');
    const names = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : [];
    assert(names.some((name) => name.endsWith('.pdf')), `pdf should be on disk: ${names.join(',')}`);
    assert(!names.some((name) => name.endsWith('.exe') || name.endsWith('.html')), `disallowed files should not be saved: ${names.join(',')}`);
    const download = await request({
      method: 'GET',
      path: `/api/inbound-emails/${orderMail.id}/attachments/${stored[0].id}/download`,
      token: admin.token,
    });
    assert(download.status === 200 && download.text.includes('%PDF-1.4 phase18 art'), `download failed: ${download.status} ${download.text.slice(0, 120)}`);
    const customerDownload = await request({
      method: 'GET',
      path: `/api/inbound-emails/${orderMail.id}/attachments/${stored[0].id}/download`,
      token: customer.token,
    });
    assert(customerDownload.status === 403, 'a customer cannot download inbound mail');
    const customerDetail = await request({ method: 'GET', path: `/api/inbound-emails/${orderMail.id}`, token: customer.token });
    assert(customerDetail.status === 403, 'a customer cannot open an inbound email');

    const options = await request({ method: 'GET', path: '/api/orders/options', token: admin.token });
    assert(options.status === 200, options.text);
    const byName = Object.fromEntries((options.json.services || []).map((service) => [service.name, service]));
    setServiceNames(byName);
    const payload = orderBody(byName, created.json.id);
    const inboundFile = await db.get(
      `SELECT id, stored_name, order_file_id
       FROM inbound_email_attachments
       WHERE inbound_email_id = ? AND stored_name IS NOT NULL AND skipped_reason IS NULL`,
      [orderMail.id]
    );
    assert(inboundFile && inboundFile.stored_name, 'the pdf attachment should have a stored name');
    const inboundPath = path.join(uploadDir, inboundFile.stored_name);
    assert(fs.existsSync(inboundPath), 'the inbound pdf should be on disk before convert');
    const badCustomer = await request({
      method: 'POST',
      path: `/api/inbound-emails/${orderMail.id}/convert`,
      token: admin.token,
      json: { ...payload, customer_id: 999999 },
    });
    assert(badCustomer.status === 400, `an unknown customer should be rejected before files are copied: ${badCustomer.status} ${badCustomer.text}`);
    const filesAfterBadCustomer = await db.get('SELECT COUNT(*) AS count FROM order_files');
    assert(filesAfterBadCustomer.count === 0, 'a bad customer should not create order files');
    const stillNew = await db.get('SELECT status FROM inbound_emails WHERE id = ?', [orderMail.id]);
    assert(stillNew.status === 'new', `the email should stay new after a rejected customer: ${stillNew.status}`);
    const badOrder = await request({
      method: 'POST',
      path: `/api/inbound-emails/${orderMail.id}/convert`,
      token: admin.token,
      json: { ...payload, project_name: '' },
    });
    assert(badOrder.status === 400, `an incomplete order should fail: ${badOrder.status} ${badOrder.text}`);
    const orphans = await db.get('SELECT COUNT(*) AS count FROM order_files');
    assert(orphans.count === 0, 'a failed convert should delete the order file rows it created');
    const afterFailure = await db.get(
      'SELECT stored_name, order_file_id FROM inbound_email_attachments WHERE id = ?',
      [inboundFile.id]
    );
    assert(afterFailure.stored_name === inboundFile.stored_name, 'a failed convert should keep the inbound file name');
    assert(afterFailure.order_file_id == null, 'a failed convert should clear the order file pointer');
    assert(fs.existsSync(inboundPath), 'a failed convert should leave the inbound pdf on disk');
    const namesAfterFailure = fs.readdirSync(uploadDir).filter((name) => name !== '.launchpad-storage');
    assert(namesAfterFailure.length === 1 && namesAfterFailure[0] === inboundFile.stored_name, `only the inbound file should remain: ${namesAfterFailure.join(',')}`);
    await db.run(
      'UPDATE inbound_email_attachments SET order_file_id = ? WHERE id = ?',
      [424242, inboundFile.id]
    );
    const [first, second] = await Promise.all([
      request({ method: 'POST', path: `/api/inbound-emails/${orderMail.id}/convert`, token: admin.token, json: payload }),
      request({ method: 'POST', path: `/api/inbound-emails/${orderMail.id}/convert`, token: admin.token, json: payload }),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    assert(statuses[0] === 201 && statuses[1] === 409, `double convert should create one order: ${first.status} ${first.text} | ${second.status} ${second.text}`);
    const winner = first.status === 201 ? first : second;
    const loser = first.status === 201 ? second : first;
    assert(winner.json.order_number && winner.json.order && winner.json.order.id, 'convert should return the order');
    assert(loser.json.order_id === winner.json.order.id, 'the second convert should point at the same order');
    const third = await request({ method: 'POST', path: `/api/inbound-emails/${orderMail.id}/convert`, token: operator.token, json: payload });
    assert(third.status === 409 && third.json.order_id === winner.json.order.id, `a later convert should not create another order: ${third.status} ${third.text}`);
    const orderCount = await db.get(`SELECT COUNT(*) AS count FROM orders WHERE po_number = '44821'`);
    assert(orderCount.count === 1, `converting twice should leave one order, saw ${orderCount.count}`);
    const orderFiles = await db.all('SELECT id, original_name, stored_name FROM order_files WHERE order_id = ?', [winner.json.order.id]);
    assert(orderFiles.length === 1 && orderFiles[0].original_name === 'art.pdf', `order files were ${JSON.stringify(orderFiles)}`);
    assert(orderFiles[0].stored_name !== inboundFile.stored_name, 'the order file should be its own copy');
    const orderPath = path.join(uploadDir, orderFiles[0].stored_name);
    assert(fs.existsSync(orderPath) && fs.existsSync(inboundPath), 'the order copy and the inbound file should both stay on disk');
    assert(fs.readFileSync(orderPath).equals(fs.readFileSync(inboundPath)), 'the order copy should match the inbound pdf');
    const linked = await db.get('SELECT order_file_id FROM inbound_email_attachments WHERE id = ?', [inboundFile.id]);
    assert(linked.order_file_id === orderFiles[0].id, 'a stale order file id should be replaced with the new copy');
    const downloadAgain = await request({
      method: 'GET',
      path: `/api/inbound-emails/${orderMail.id}/attachments/${inboundFile.id}/download`,
      token: admin.token,
    });
    assert(downloadAgain.status === 200 && downloadAgain.text.includes('%PDF-1.4 phase18 art'), 'the inbound file should still download after convert');
    const converted = await request({ method: 'GET', path: `/api/inbound-emails/${orderMail.id}`, token: admin.token });
    assert(converted.json.status === 'converted' && converted.json.order_id === winner.json.order.id, 'the email should be marked converted');
    const customerOrder = await request({ method: 'GET', path: `/api/orders/${winner.json.order.id}`, token: customer.token });
    assert(customerOrder.status === 200 && customerOrder.json.order.po_number === '44821', 'the customer should see the order that was created for them');
    const customerStillBlocked = await request({ method: 'GET', path: '/api/inbound-emails', token: customer.token });
    assert(customerStillBlocked.status === 403, 'creating the order should not reveal the inbox');

    const dismissed = await request({ method: 'POST', path: `/api/inbound-emails/${dismissMail.id}/dismiss`, token: manager.token });
    assert(dismissed.status === 200 && dismissed.json.status === 'dismissed', dismissed.text);
    const dismissedAgain = await request({ method: 'POST', path: `/api/inbound-emails/${dismissMail.id}/dismiss`, token: operator.token });
    assert(dismissedAgain.status === 200 && dismissedAgain.json.status === 'dismissed', 'dismiss should be idempotent');
    const convertDismissed = await request({
      method: 'POST',
      path: `/api/inbound-emails/${dismissMail.id}/convert`,
      token: admin.token,
      json: payload,
    });
    assert(convertDismissed.status === 409, `a dismissed email should not become an order: ${convertDismissed.status} ${convertDismissed.text}`);
    const customerDismiss = await request({ method: 'POST', path: `/api/inbound-emails/${domainMail.id}/dismiss`, token: customer.token });
    assert(customerDismiss.status === 403, 'a customer cannot dismiss mail');

    const settings = await request({ method: 'GET', path: '/api/settings', token: admin.token });
    assert(settings.status === 200 && settings.json.inbound_email_polling_enabled === true, settings.text);
    assert(settings.json.inbound_mail && settings.json.inbound_mail.configured === true, 'settings should show the mailbox as configured');
    assert(settings.json.inbound_mail.last_status === 'ok', `last status was ${settings.json.inbound_mail.last_status}`);
    const operatorSettings = await request({ method: 'GET', path: '/api/settings', token: operator.token });
    assert(operatorSettings.status === 403, 'operators do not edit system settings');
    const turnedOff = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: { inbound_email_polling_enabled: false },
    });
    assert(turnedOff.status === 200 && turnedOff.json.inbound_email_polling_enabled === false, turnedOff.text);
    const getsBefore = graphGets;
    const skippedPoll = await pollerModule.runScheduledPoll();
    assert(skippedPoll.skipped === 'disabled', `scheduled polling should stop when the switch is off: ${JSON.stringify(skippedPoll)}`);
    assert(graphGets === getsBefore, 'a disabled poll should not call Graph');
    const manual = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: admin.token });
    assert(manual.status === 200, 'check now should still run when scheduled polling is off');

    graphMode = 'backlog';
    const firstBacklog = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: admin.token });
    assert(firstBacklog.status === 200, `the first backlog page set should succeed: ${firstBacklog.status} ${firstBacklog.text}`);
    const paused = await db.get('SELECT delta_link FROM inbound_mail_state WHERE id = 1');
    assert(paused.delta_link && paused.delta_link.includes('page=25'), `the next page should be saved: ${paused.delta_link}`);
    const importedBacklog = await db.get(`SELECT COUNT(*) AS count FROM inbound_emails WHERE graph_message_id LIKE 'backlog-%'`);
    assert(importedBacklog.count === 25, `the page cap should import 25 backlog messages, saw ${importedBacklog.count}`);
    const secondBacklog = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: admin.token });
    assert(secondBacklog.status === 200, `the resumed backlog check should succeed: ${secondBacklog.status} ${secondBacklog.text}`);
    const finished = await db.get('SELECT delta_link FROM inbound_mail_state WHERE id = 1');
    assert(finished.delta_link && finished.delta_link.endsWith('/v1.0/delta-done'), `the resume should finish the backlog: ${finished.delta_link}`);
    const allBacklog = await db.get(`SELECT COUNT(*) AS count FROM inbound_emails WHERE graph_message_id LIKE 'backlog-%'`);
    assert(allBacklog.count === 30, `the next check should import the rest of the backlog, saw ${allBacklog.count}`);
    graphMode = 'inbox';

    graphMode = 'deny';
    const denied = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: admin.token });
    assert(denied.status === 502, `a Microsoft 403 should be a 502, was ${denied.status} ${denied.text}`);
    assert(denied.json && /refused|Microsoft 365/i.test(denied.json.error || ''), `the 403 message should name Microsoft: ${denied.text}`);
    graphMode = 'inbox';
    tokenStatus = 401;
    const rejected = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: admin.token });
    assert(rejected.status === 502, `rejected Microsoft credentials should be a 502, was ${rejected.status} ${rejected.text}`);
    assert(rejected.json && /refused|Microsoft 365/i.test(rejected.json.error || ''), `the 401 message should name Microsoft: ${rejected.text}`);
    assert(!server.logs().includes(clientSecret), 'a rejected token should not log the client secret');
    const stillSignedIn = await request({ method: 'GET', path: '/api/inbound-emails?status=all', token: admin.token });
    assert(stillSignedIn.status === 200, `Check now must not invalidate the admin session: ${stillSignedIn.status} ${stillSignedIn.text}`);
    const statusAfter = await request({ method: 'GET', path: '/api/inbound-emails/status', token: admin.token });
    assert(statusAfter.status === 200 && statusAfter.json.mailbox === mailbox, 'a configured status should still name the mailbox');
    tokenStatus = 200;

    console.log('PASS email inbox, draft parse, convert, and roles');
  } finally {
    server.stop();
    await Promise.race([
      server.closed,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await db.close();
  }

  const after = await spawnNode(path.join(backendDir, 'init_db.js'), initEnv);
  if (after.code !== 0) throw new Error(`init after mail failed (${after.code})\n${after.out}\n${after.err}`);
  const restored = openDb(dbFile);
  try {
    const flag = await restored.get(`SELECT value FROM system_settings WHERE key = 'inbound_email_polling_enabled'`);
    assert(flag && flag.value === '0', 'a saved polling switch should survive init');
    const count = await restored.get('SELECT COUNT(*) AS count FROM inbound_emails');
    assert(count.count === 33, `init should keep inbound emails, saw ${count.count}`);
    const converted = await restored.get(`SELECT status, order_id FROM inbound_emails WHERE graph_message_id = 'msg-order'`);
    assert(converted.status === 'converted' && converted.order_id, 'init should keep the converted link');
  } finally {
    await restored.close();
  }
  await new Promise((resolve) => mock.close(() => resolve()));
  console.log('PASS phase 18');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
