/**
 * Email Orders security guarantees.
 * Usage (from backend/): node scripts/verify-email-security.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-email-sec-'));
const dbFile = path.join(tmp, 'email-sec.db');
const uploadDir = path.join(tmp, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const port = 3172;
const graphPort = 3173;
const graphBase = `http://127.0.0.1:${graphPort}`;

process.env.DATABASE_FILE = dbFile;
process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = uploadDir;
process.env.DELIVERY_TIMEZONE = 'America/New_York';
process.env.DUE_SOON_HOURS = '1';
process.env.DELIVERY_WINDOW_START = '09:00';
process.env.DELIVERY_WINDOW_END = '16:00';
process.env.DELIVERY_SLOT_MINUTES = '15';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '2525';
process.env.SMTP_FROM = 'orders@accent.example';
process.env.OUTBOUND_REPLY_TO = 'reply@accent.example';
process.env.MAIL_TRANSPORT = 'json';
process.env.ALLOW_UNSCANNED_ATTACHMENT_EXCEPTION = 'false';
delete process.env.CLAMD_HOST;

const adminPassword = 'AdminPass123';
const csrfByToken = new Map();
let clamdPort = 0;
let attachmentMode = 'placeholder';
let deltaCalls = 0;
const deltaQueries = [];
let attachmentListGets = 0;

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
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  return { run, get, close };
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

function weekdayAhead() {
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  for (let add = 1; add < 14; add += 1) {
    const date = new Date(Date.now() + add * 24 * 60 * 60 * 1000);
    const weekday = dayFmt.format(date);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    return dateFmt.format(date);
  }
  throw new Error('no weekday');
}

function request({ method, path: requestPath, token, json, headers: extra, skipCsrf = false }) {
  return new Promise((resolve, reject) => {
    const body = json != null ? Buffer.from(JSON.stringify(json)) : null;
    const headers = { ...(extra || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (!skipCsrf && token && csrfByToken.has(token) && !headers['X-CSRF-Token']) {
      headers['X-CSRF-Token'] = csrfByToken.get(token);
    }
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    }
    const req = http.request({
      hostname: '127.0.0.1', port, path: requestPath, method, headers,
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

function startClamd(reply) {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let streaming = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!streaming) {
        const zero = buf.indexOf(0);
        if (zero < 0) return;
        buf = buf.subarray(zero + 1);
        streaming = true;
      }
      while (streaming && buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          socket.end(`${reply}\0`);
          return;
        }
        if (buf.length < 4 + len) return;
        buf = buf.subarray(4 + len);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      clamdPort = server.address().port;
      resolve(server);
    });
  });
}

function messageFor(mode) {
  const pdf = Buffer.from('%PDF-1.4 security art');
  const attachment = mode === 'ready'
    ? {
      '@odata.type': '#microsoft.graph.fileAttachment',
      id: 'att-late',
      name: 'late.pdf',
      contentType: 'application/pdf',
      size: pdf.length,
      isInline: false,
      contentBytes: pdf.toString('base64'),
    }
    : {
      '@odata.type': '#microsoft.graph.fileAttachment',
      id: 'att-late',
      name: 'late.pdf',
      contentType: 'application/pdf',
      size: pdf.length,
      isInline: false,
    };
  return {
    id: 'msg-placeholder',
    subject: 'Artwork coming',
    receivedDateTime: new Date().toISOString(),
    hasAttachments: true,
    from: { emailAddress: { name: 'Pat', address: 'pat@security.example' } },
    body: { contentType: 'text', content: 'The file is on its way.' },
    attachments: [attachment],
  };
}

function startGraph() {
  const headersFor = {
    'msg-auto': [{ name: 'Auto-Submitted', value: 'auto-replied' }],
    'msg-loop': [{ name: 'In-Reply-To', value: '<known-launchpad@accent.example>' }],
    'msg-self': [],
    'msg-placeholder': [],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, graphBase);
    const send = (status, body) => {
      const raw = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': raw.length });
      res.end(raw);
    };
    if (req.method === 'POST' && url.pathname.endsWith('/token')) {
      send(200, { token_type: 'Bearer', expires_in: 3600, access_token: 'sec-token' });
      return;
    }
    if (url.pathname.endsWith('/messages/delta') || url.pathname === '/v1.0/delta') {
      deltaCalls += 1;
      deltaQueries.push(url.search);
      if (deltaCalls > 1) {
        send(200, { value: [], '@odata.deltaLink': `${graphBase}/v1.0/delta` });
        return;
      }
      const message = messageFor('placeholder');
      send(200, {
        value: [
          message,
          {
            id: 'msg-auto',
            subject: 'Hello',
            receivedDateTime: new Date().toISOString(),
            hasAttachments: false,
            from: { emailAddress: { address: 'person@security.example' } },
            body: { contentType: 'text', content: 'Out of office' },
          },
          {
            id: 'msg-loop',
            subject: 'Re: your order',
            receivedDateTime: new Date().toISOString(),
            hasAttachments: false,
            from: { emailAddress: { address: 'person@security.example' } },
            body: { contentType: 'text', content: 'Thanks' },
          },
          {
            id: 'msg-self',
            subject: 'Copy',
            receivedDateTime: new Date().toISOString(),
            hasAttachments: false,
            from: { emailAddress: { address: 'orders@accent.example' } },
            body: { contentType: 'text', content: 'from us' },
          },
          {
            id: 'msg-subject-auto',
            subject: 'Automatic reply: away',
            receivedDateTime: new Date().toISOString(),
            hasAttachments: false,
            from: { emailAddress: { address: 'person@security.example' } },
            body: { contentType: 'text', content: 'away' },
          },
          {
            id: 'msg-kept',
            subject: 'Please print the posters',
            receivedDateTime: new Date().toISOString(),
            hasAttachments: false,
            from: { emailAddress: { address: 'person@security.example' } },
            body: { contentType: 'text', content: 'posters' },
          },
        ],
        '@odata.deltaLink': `${graphBase}/v1.0/delta`,
      });
      return;
    }
    if (url.pathname.includes('/messages/') && !url.pathname.includes('/attachments') && url.searchParams.get('$select') === 'internetMessageHeaders') {
      const id = decodeURIComponent(url.pathname.split('/messages/')[1] || '');
      headerGets.push(id);
      if (id === 'msg-subject-auto' || id === 'msg-kept') {
        send(500, { error: { message: 'headers unavailable' } });
        return;
      }
      send(200, { internetMessageHeaders: headersFor[id] || [] });
      return;
    }
    if (url.pathname.includes('/attachments')) {
      const message = messageFor(attachmentMode);
      if (url.pathname.endsWith('/attachments')) {
        attachmentListGets += 1;
        send(200, { value: message.attachments });
      } else send(200, message.attachments[0]);
      return;
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(graphPort, '127.0.0.1', () => resolve(server)));
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      DATABASE_FILE: dbFile,
      PORT: String(port),
      NODE_ENV: 'test',
      UPLOAD_DIR: uploadDir,
      INIT_ADMIN_PASSWORD: adminPassword,
      M365_TENANT_ID: 'tenant-sec',
      M365_CLIENT_ID: 'client-sec',
      M365_CLIENT_SECRET: 'secret-sec',
      M365_MAILBOX: 'orders@security.example',
      M365_LOGIN_BASE_URL: graphBase,
      M365_GRAPH_BASE_URL: graphBase,
      CLAMD_HOST: '127.0.0.1',
      CLAMD_PORT: String(clamdPort),
      ALLOW_UNSCANNED_ATTACHMENT_EXCEPTION: 'false',
      INBOUND_ATTACHMENT_BACKOFF_MS: '1500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${logs}`)), 20000);
    const poll = async () => {
      try {
        const health = await request({ method: 'GET', path: '/api/health' });
        if (health.status === 200) {
          clearTimeout(timer);
          resolve();
          return;
        }
      } catch (err) { /* starting */ }
      setTimeout(poll, 200);
    };
    poll();
  });
  return { child, ready, logs: () => logs, stop: () => child.kill() };
}

async function login(username, password) {
  const response = await request({
    method: 'POST', path: '/api/auth/login', json: { username, password },
  });
  assert(response.status === 200 && response.json.token && response.json.csrf_token, response.text);
  csrfByToken.set(response.json.token, response.json.csrf_token);
  return response.json;
}

function orderBody(byName, customerId, dueDate) {
  const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');
  setServiceNames(byName);
  return fillOrderLines({
    customer_id: customerId,
    company: 'Security Co',
    contact_name: 'Pat Security',
    phone: '919-555-0199',
    email: 'pat@security.example',
    project_name: 'Security banners',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '1 Security Lane',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    payment_method: 'Accent Account',
    delivery_method: 'Will Call',
    due_date: dueDate,
    due_time: '10:00',
    service_ids: [byName['Large Format'].id],
    line_items: [{ description: 'Banners', quantity: '2', service_id: byName['Large Format'].id }],
  });
}

async function main() {
  const init = await spawnNode(path.join(backendDir, 'init_db.js'), {
    DATABASE_FILE: dbFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    UPLOAD_DIR: uploadDir,
  });
  if (init.code !== 0) throw new Error(`init failed\n${init.out}\n${init.err}`);
  const again = await spawnNode(path.join(backendDir, 'init_db.js'), {
    DATABASE_FILE: dbFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    UPLOAD_DIR: uploadDir,
  });
  if (again.code !== 0) throw new Error(`second init failed\n${again.out}\n${again.err}`);

  const db = openDb(dbFile);
  const flag = await db.get(`SELECT value FROM system_settings WHERE key = 'inbound_email_polling_enabled'`);
  assert(flag && flag.value === '0', 'email orders polling stays off on a new database');
  const retention = await db.get(`SELECT value FROM system_settings WHERE key = 'inbound_email_retention_days'`);
  assert(retention && retention.value === '90', 'retention defaults to 90 days');
  const index = await db.get(`SELECT name FROM sqlite_master WHERE name = 'idx_orders_source_inbound_email'`);
  assert(index, 'orders.source_inbound_email_id should have a unique index');

  const { matchSender } = require('../emailDraft');
  const customers = [
    { id: 1, email: 'a@gmail.com', username: 'a@gmail.com', company: 'Gmail Co' },
    { id: 2, email: 'buyer@acme.test', username: 'buyer@acme.test', company: 'Acme' },
  ];
  const publicDomain = matchSender(customers, 'other@gmail.com');
  assert(!publicDomain.customer && publicDomain.match == null, 'a public domain must not match another customer');
  const exactPublic = matchSender(customers, 'a@gmail.com');
  assert(exactPublic.customer && exactPublic.match === 'email' && exactPublic.match_status === 'unverified', 'an exact public-mailbox address is only an unverified suggestion');
  const company = matchSender(customers, 'ap@acme.test');
  assert(company.customer && company.match === 'domain' && company.match_status === 'unverified', 'a company domain match is only an unverified suggestion');

  const graphMail = require('../graphMail');
  const savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.M365_LOGIN_BASE_URL = 'http://evil.example';
  process.env.M365_GRAPH_BASE_URL = 'http://127.0.0.1:9';
  assert(graphMail.loginBase() === 'https://login.microsoftonline.com', 'production ignores the login override');
  assert(graphMail.graphBase() === 'https://graph.microsoft.com', 'production ignores the graph override');
  let refusedHttp = false;
  try {
    await graphMail.fetchJson('http://login.microsoftonline.com/common/oauth2/v2.0/token');
  } catch (err) {
    refusedHttp = /https/i.test(err.message);
  }
  process.env.NODE_ENV = savedEnv;
  delete process.env.M365_LOGIN_BASE_URL;
  delete process.env.M365_GRAPH_BASE_URL;
  assert(refusedHttp, 'production must refuse an http mailbox address');
  delete process.env.NODE_ENV;
  process.env.M365_GRAPH_BASE_URL = 'http://127.0.0.1:9';
  assert(graphMail.graphBase() === 'https://graph.microsoft.com', 'an unset NODE_ENV keeps the production Graph host');
  process.env.NODE_ENV = 'test';
  delete process.env.M365_GRAPH_BASE_URL;

  const fileMagic = require('../fileMagic');
  const pdf = Buffer.from('%PDF-1.4 hello');
  const mismatch = fileMagic.checkAllowed('pdf', Buffer.from('MZ not a pdf'));
  assert(!mismatch.ok, 'a magic-byte mismatch is rejected');
  const encryptedPdf = Buffer.from('%PDF-1.4\n1 0 obj\n/Encrypt <<>>\nendobj\n');
  const encryptedCheck = fileMagic.checkAllowed('pdf', encryptedPdf);
  assert(encryptedCheck.ok && encryptedCheck.encrypted, 'an encrypted pdf is recognized and not treated as a normal pdf');
  const zip = Buffer.alloc(30);
  zip.write('PK\u0003\u0004', 0, 'latin1');
  zip.writeUInt16LE(0x0001, 6);
  assert(fileMagic.isEncrypted(zip, 'zip'), 'a password-protected zip is encrypted');

  const virusScan = require('../virusScan');
  const unavailable = await virusScan.scanBuffer(pdf);
  assert(unavailable.verdict === 'error', 'a scanner that is not configured stays an error');

  const mailer = require('../mailer');
  const sent = await mailer.deliver({
    to: 'pat@security.example',
    subject: 'Reply path',
    text: 'hello',
    html: '<p>hello</p>',
    noticeType: 'confirmation',
  });
  assert(sent.status === 'sent', `mail should send in the json transport: ${sent.status}`);
  assert(sent.replyTo === 'reply@accent.example', `Reply-To was ${sent.replyTo}`);
  const captured = JSON.stringify(sent.captured || {});
  assert(captured.includes('reply@accent.example'), `the captured message should include Reply-To: ${captured}`);

  const accountMail = require('../accountMail');
  const welcome = await accountMail.sendSignupWelcome({
    id: 1, email: 'admin@example.com', display_name: 'Admin', username: 'admin',
  });
  assert(welcome.status === 'sent' || welcome.status === 'not_configured' || welcome.status === 'failed' || welcome.status === 'skipped', welcome.status);
  const reset = await accountMail.sendPasswordResetNotice({ id: 1 });
  assert(reset.status, 'a password reset notice should return a result');
  const audit = await db.get(`SELECT notice_type, recipient, result, created_at FROM account_audit_log WHERE notice_type = 'welcome'`);
  assert(audit && audit.recipient && audit.result && audit.created_at, 'welcome mail is on the account audit log');
  const resetAudit = await db.get(`SELECT notice_type, result FROM account_audit_log WHERE notice_type = 'password_reset'`);
  assert(resetAudit && resetAudit.result, 'password reset mail is on the account audit log');
  const setAudit = await db.get(`SELECT COUNT(*) AS count FROM account_audit_log WHERE notice_type = 'password_set'`);
  const staffWelcome = await accountMail.sendStaffWelcome({
    id: 1, email: 'admin@example.com', display_name: 'Admin', username: 'admin',
  });
  assert(staffWelcome.status, staffWelcome.status);
  const setAfter = await db.get(`SELECT COUNT(*) AS count FROM account_audit_log WHERE notice_type = 'password_set'`);
  assert(setAfter.count === setAudit.count + 1, 'the set-password email is on the account audit log');

  const inboundAttachments = require('../inboundAttachments');
  const emailId = (await db.run(
    `INSERT INTO inbound_emails (graph_message_id, from_address, subject, status, match_status)
     VALUES ('local-sec', 'a@gmail.com', 'Local', 'new', 'unverified')`
  )).lastID;
  await inboundAttachments.storeAttachment(emailId, {
    '@odata.type': '#microsoft.graph.fileAttachment',
    id: 'bad-magic',
    name: 'notes.pdf',
    contentType: 'application/pdf',
    size: 8,
    isInline: false,
    contentBytes: Buffer.from('MZ not a pdf').toString('base64'),
  });
  const skipped = await db.get(`SELECT fetch_state, skipped_reason, stored_name FROM inbound_email_attachments WHERE graph_attachment_id = 'bad-magic'`);
  assert(skipped && skipped.fetch_state === 'skipped' && !skipped.stored_name, 'a magic-byte mismatch is not stored');
  await inboundAttachments.storeAttachment(emailId, {
    '@odata.type': '#microsoft.graph.fileAttachment',
    id: 'enc-pdf',
    name: 'secret.pdf',
    contentType: 'application/pdf',
    size: encryptedPdf.length,
    isInline: false,
    contentBytes: encryptedPdf.toString('base64'),
  });
  const encryptedRow = await db.get(`SELECT scan_status, fetch_state FROM inbound_email_attachments WHERE graph_attachment_id = 'enc-pdf'`);
  assert(encryptedRow && encryptedRow.fetch_state === 'fetched' && encryptedRow.scan_status === 'encrypted', 'an encrypted file stays quarantined');
  await inboundAttachments.storeAttachment(emailId, {
    '@odata.type': '#microsoft.graph.fileAttachment',
    id: 'plain-pdf',
    name: 'open.pdf',
    contentType: 'application/pdf',
    size: pdf.length,
    isInline: false,
    contentBytes: pdf.toString('base64'),
  });
  const quarantined = await db.get(`SELECT id, scan_status FROM inbound_email_attachments WHERE graph_attachment_id = 'plain-pdf'`);
  assert(quarantined && quarantined.scan_status !== 'clean', `scanner unavailable must leave the file quarantined, was ${quarantined && quarantined.scan_status}`);
  let blocked = false;
  try {
    await inboundAttachments.attachmentDownload({ role: 'admin', userId: 1 }, emailId, quarantined.id);
  } catch (err) {
    blocked = err.status === 403;
  }
  assert(blocked, 'a quarantined file cannot be downloaded');

  const hang = net.createServer(() => {});
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve));
  process.env.CLAMD_HOST = '127.0.0.1';
  process.env.CLAMD_PORT = String(hang.address().port);
  process.env.CLAMD_TIMEOUT_MS = '400';
  virusScan.resetScanner();
  await inboundAttachments.storeAttachment(emailId, {
    '@odata.type': '#microsoft.graph.fileAttachment',
    id: 'timeout-pdf',
    name: 'timeout.pdf',
    contentType: 'application/pdf',
    size: pdf.length,
    isInline: false,
    contentBytes: pdf.toString('base64'),
  });
  const timedOut = await db.get(`SELECT scan_status FROM inbound_email_attachments WHERE graph_attachment_id = 'timeout-pdf'`);
  assert(timedOut && timedOut.scan_status !== 'clean', `a scan timeout stays quarantined, was ${timedOut && timedOut.scan_status}`);
  await new Promise((resolve) => hang.close(() => resolve()));

  process.env.CLAMD_PORT = '1';
  await inboundAttachments.storeAttachment(emailId, {
    '@odata.type': '#microsoft.graph.fileAttachment',
    id: 'socket-pdf',
    name: 'socket.pdf',
    contentType: 'application/pdf',
    size: pdf.length,
    isInline: false,
    contentBytes: pdf.toString('base64'),
  });
  const socketRow = await db.get(`SELECT scan_status FROM inbound_email_attachments WHERE graph_attachment_id = 'socket-pdf'`);
  assert(socketRow && socketRow.scan_status !== 'clean', `a scanner socket error stays quarantined, was ${socketRow && socketRow.scan_status}`);
  delete process.env.CLAMD_HOST;
  delete process.env.CLAMD_PORT;

  virusScan.setScanner(async () => ({ verdict: 'inconclusive', detail: 'no signature decision' }));
  await inboundAttachments.storeAttachment(emailId, {
    '@odata.type': '#microsoft.graph.fileAttachment',
    id: 'maybe-pdf',
    name: 'maybe.pdf',
    contentType: 'application/pdf',
    size: pdf.length,
    isInline: false,
    contentBytes: pdf.toString('base64'),
  });
  const maybe = await db.get(`SELECT scan_status FROM inbound_email_attachments WHERE graph_attachment_id = 'maybe-pdf'`);
  assert(maybe && maybe.scan_status === 'inconclusive', `an inconclusive scan stays quarantined, was ${maybe && maybe.scan_status}`);

  const scanAlerts = require('../inboundAlerts');
  scanAlerts.resetCounts();
  virusScan.setScanner(async () => ({ verdict: 'error', detail: 'scan broke' }));
  for (let index = 0; index < 3; index += 1) {
    await inboundAttachments.storeAttachment(emailId, {
      '@odata.type': '#microsoft.graph.fileAttachment',
      id: `scan-fail-${index}`,
      name: `fail-${index}.pdf`,
      contentType: 'application/pdf',
      size: pdf.length,
      isInline: false,
      contentBytes: pdf.toString('base64'),
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const scanAlert = await db.get(`SELECT title FROM notifications WHERE type = 'inbound_mail_alert' AND title LIKE '%scanning%'`);
  assert(scanAlert, 'repeated scan failures raise an admin bell notice');
  virusScan.resetScanner();

  process.env.INBOUND_ATTACHMENT_CAP_BYTES = '30';
  await inboundAttachments.storeAttachment(emailId, {
    '@odata.type': '#microsoft.graph.fileAttachment',
    id: 'over-cap',
    name: 'over.pdf',
    contentType: 'application/pdf',
    size: pdf.length,
    isInline: false,
    contentBytes: pdf.toString('base64'),
  });
  const capped = await db.get(`SELECT fetch_state, skipped_reason, stored_name FROM inbound_email_attachments WHERE graph_attachment_id = 'over-cap'`);
  assert(capped && capped.fetch_state === 'skipped' && !capped.stored_name && /full/i.test(capped.skipped_reason || ''), `the storage cap should reject the file: ${JSON.stringify(capped)}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const storageAlert = await db.get(`SELECT title FROM notifications WHERE type = 'inbound_mail_alert' AND title LIKE '%storage%'`);
  assert(storageAlert, 'a full attachment store raises an admin bell notice');
  delete process.env.INBOUND_ATTACHMENT_CAP_BYTES;

  let releaseBlocked = false;
  try {
    await inboundAttachments.releaseAttachment(
      { role: 'admin', userId: 1 },
      emailId,
      quarantined.id,
      { exception: true, reason: 'need to look' }
    );
  } catch (err) {
    releaseBlocked = err.status === 403;
  }
  assert(releaseBlocked, 'the unscanned exception is off by default');
  const page = fs.readFileSync(path.join(backendDir, '../frontend/src/routes/EmailOrders.jsx'), 'utf8');
  assert(page.includes('unscanned_exception_enabled'), 'the page must hide release when the exception is off');
  assert(page.includes('isolated machine') || page.includes('release_warning'), 'a released file warns to use an isolated machine');

  process.env.ALLOW_UNSCANNED_ATTACHMENT_EXCEPTION = 'true';
  const firstRelease = await inboundAttachments.releaseAttachment(
    { role: 'admin', userId: 1 }, emailId, quarantined.id, { exception: true, reason: 'isolated review' }
  );
  assert(firstRelease.confirmation_required && firstRelease.confirm_token, 'release requires a second confirmation');
  let operatorBlocked = false;
  try {
    await inboundAttachments.releaseAttachment(
      { role: 'operator', userId: 2 }, emailId, quarantined.id,
      { exception: true, reason: 'isolated review', confirm_token: firstRelease.confirm_token }
    );
  } catch (err) {
    operatorBlocked = err.status === 403;
  }
  assert(operatorBlocked, 'normal staff cannot release an unscanned file');
  const [releaseA, releaseB] = await Promise.all([
    inboundAttachments.releaseAttachment(
      { role: 'admin', userId: 1 }, emailId, quarantined.id,
      { exception: true, reason: 'isolated review', confirm_token: firstRelease.confirm_token }
    ).then((body) => ({ ok: true, body })).catch((err) => ({ ok: false, status: err.status })),
    inboundAttachments.releaseAttachment(
      { role: 'admin', userId: 1 }, emailId, quarantined.id,
      { exception: true, reason: 'isolated review', confirm_token: firstRelease.confirm_token }
    ).then((body) => ({ ok: true, body })).catch((err) => ({ ok: false, status: err.status })),
  ]);
  const releaseResults = [releaseA, releaseB];
  assert(releaseResults.filter((item) => item.ok).length === 1, `only one simultaneous release succeeds: ${JSON.stringify(releaseResults)}`);
  assert(releaseResults.filter((item) => !item.ok && item.status === 400).length === 1, 'the other simultaneous release is rejected');
  let replayRejected = false;
  try {
    await inboundAttachments.releaseAttachment(
      { role: 'admin', userId: 1 }, emailId, quarantined.id,
      { exception: true, reason: 'isolated review', confirm_token: firstRelease.confirm_token }
    );
  } catch (err) {
    replayRejected = err.status === 400;
  }
  assert(replayRejected, 'replaying the release token is rejected');
  const activity = await db.get(`SELECT action FROM activity_log WHERE action = 'inbound_attachment.released'`);
  assert(activity, 'the release is logged');
  let staffDownload = false;
  try {
    await inboundAttachments.attachmentDownload({ role: 'operator', userId: 2 }, emailId, quarantined.id);
  } catch (err) {
    staffDownload = err.status === 403;
  }
  assert(staffDownload, 'normal staff still cannot download an unscanned file');
  const adminDownload = await inboundAttachments.attachmentDownload({ role: 'admin', userId: 1 }, emailId, quarantined.id);
  assert(adminDownload && adminDownload.disposition === 'attachment' && adminDownload.warning, 'an admin download stays an attachment and carries the warning');
  process.env.ALLOW_UNSCANNED_ATTACHMENT_EXCEPTION = 'false';

  const inboundRetention = require('../inboundRetention');
  const oldEmail = (await db.run(
    `INSERT INTO inbound_emails (graph_message_id, from_address, subject, status, received_at)
     VALUES ('old-sec', 'old@acme.test', 'Old', 'new', '2000-01-01 00:00:00')`
  )).lastID;
  await db.run(
    `INSERT INTO inbound_email_attachments (inbound_email_id, original_name, stored_name, size_bytes, fetch_state)
     VALUES (?, 'old.pdf', 'missing-old.pdf', 10, 'fetched')`,
    [oldEmail]
  );
  const keptEmail = (await db.run(
    `INSERT INTO inbound_emails (graph_message_id, from_address, subject, status, order_id, received_at)
     VALUES ('kept-sec', 'old@acme.test', 'Kept', 'converted', NULL, '2000-01-01 00:00:00')`
  )).lastID;
  await db.run(
    `INSERT INTO inbound_email_attachments (inbound_email_id, original_name, stored_name, size_bytes, fetch_state)
     VALUES (?, 'kept.pdf', 'missing-kept.pdf', 10, 'fetched')`,
    [keptEmail]
  );
  const cleaned = await inboundRetention.cleanupExpired();
  assert(cleaned.retention_days === 90, 'cleanup uses the 90 day default');
  const oldGone = await db.get('SELECT id FROM inbound_emails WHERE id = ?', [oldEmail]);
  const kept = await db.get('SELECT id FROM inbound_emails WHERE id = ?', [keptEmail]);
  assert(!oldGone && kept, 'only non-converted mail is deleted');

  const customerNotices = require('../customerNotices');
  await customerNotices.recordOrderNotice({
    orderId: 1, channel: 'email', noticeType: 'confirmation', recipient: 'pat@security.example', result: 'sent',
  });
  const notices = await customerNotices.orderNotices(1);
  assert(notices.some((row) => row.notice_type === 'confirmation' && row.recipient && row.created_at && row.result === 'sent'), 'order mail is on the order history');

  const alerts = require('../inboundAlerts');
  alerts.resetCounts();
  alerts.notePollFailure('mailbox down');
  alerts.notePollFailure('mailbox down');
  alerts.notePollFailure('mailbox down');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const bell = await db.get(`SELECT title FROM notifications WHERE type = 'inbound_mail_alert'`);
  const alertLog = await db.get(`SELECT id FROM activity_log WHERE action = 'inbound_mail.alert'`);
  assert(bell && alertLog, 'repeated polling failures raise an admin bell notice and a log entry');

  const emailLoop = require('../emailLoop');
  await emailLoop.rememberMessageId('<known-launchpad@accent.example>', 'confirmation');
  const loopReason = await emailLoop.ignoreReason({
    from: { emailAddress: { address: 'person@security.example' } },
    internetMessageHeaders: [{ name: 'References', value: '<known-launchpad@accent.example>' }],
  });
  assert(/Launchpad notification/i.test(loopReason), loopReason);
  const autoReason = await emailLoop.ignoreReason({
    internetMessageHeaders: [{ name: 'Precedence', value: 'bulk' }],
  });
  assert(/automatic reply/i.test(autoReason), autoReason);

  process.env.M365_TENANT_ID = 'tenant-sec';
  process.env.M365_CLIENT_ID = 'client-sec';
  process.env.M365_CLIENT_SECRET = 'secret-sec';
  process.env.M365_MAILBOX = 'orders@security.example';
  process.env.INBOUND_ATTACHMENT_FETCH_MAX_MS = '20';
  const expireEmail = (await db.run(
    `INSERT INTO inbound_emails (graph_message_id, from_address, subject, status, headers_status)
     VALUES ('expire-sec', 'pat@security.example', 'Expire', 'new', 'read')`
  )).lastID;
  await db.run(
    `INSERT INTO inbound_email_attachments (
       inbound_email_id, graph_attachment_id, original_name, fetch_state, created_at, next_fetch_at
     ) VALUES (?, 'att-expire', 'late.pdf', 'pending', datetime('now', '-1 minute'), datetime('now', '-1 minute'))`,
    [expireEmail]
  );
  const expiredRun = await inboundAttachments.retryDueAttachments();
  assert(expiredRun.expired >= 1, `expiry should be counted, saw ${JSON.stringify(expiredRun)}`);
  const expiredRow = await db.get(`SELECT fetch_state FROM inbound_email_attachments WHERE graph_attachment_id = 'att-expire'`);
  assert(expiredRow && expiredRow.fetch_state === 'expired', `the old attachment should expire, was ${expiredRow && expiredRow.fetch_state}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const expireNotice = await db.get(`SELECT title FROM notifications WHERE type = 'inbound_mail_alert' AND title LIKE '%not delivered%'`);
  assert(expireNotice, 'an expired attachment raises an admin notice');
  delete process.env.INBOUND_ATTACHMENT_FETCH_MAX_MS;

  graphMail.clearTokenCache();
  let duplicateFetches = 0;
  const duplicateServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body) => {
      const raw = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': raw.length });
      res.end(raw);
    };
    if (req.method === 'POST' && url.pathname.endsWith('/token')) {
      send(200, { token_type: 'Bearer', expires_in: 3600, access_token: 'dup-token' });
      return;
    }
    if (url.pathname.endsWith('/attachments')) {
      duplicateFetches += 1;
      setTimeout(() => {
        send(200, {
          value: [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'att-dup',
            name: 'once.pdf',
            contentType: 'application/pdf',
            size: pdf.length,
            isInline: false,
            contentBytes: pdf.toString('base64'),
          }],
        });
      }, 80);
      return;
    }
    if (url.pathname.includes('/messages/') && url.searchParams.get('$select') === 'internetMessageHeaders') {
      send(200, { internetMessageHeaders: [] });
      return;
    }
    send(404, {});
  });
  await new Promise((resolve) => duplicateServer.listen(0, '127.0.0.1', resolve));
  const duplicatePort = duplicateServer.address().port;
  process.env.M365_LOGIN_BASE_URL = `http://127.0.0.1:${duplicatePort}`;
  process.env.M365_GRAPH_BASE_URL = `http://127.0.0.1:${duplicatePort}`;
  const dupEmail = (await db.run(
    `INSERT INTO inbound_emails (graph_message_id, from_address, subject, status, headers_status)
     VALUES ('dup-msg', 'pat@security.example', 'Dup', 'new', 'read')`
  )).lastID;
  await db.run(
    `INSERT INTO inbound_email_attachments (
       inbound_email_id, graph_attachment_id, original_name, fetch_state, size_bytes, next_fetch_at
     ) VALUES (?, 'att-dup', 'once.pdf', 'pending', 0, datetime('now', '-1 minute'))`,
    [dupEmail]
  );
  await Promise.all([
    inboundAttachments.retryDueAttachments(),
    inboundAttachments.retryDueAttachments(),
  ]);
  assert(duplicateFetches === 1, `two retries should fetch the attachment once, saw ${duplicateFetches}`);
  const storedCopies = await db.get(
    `SELECT COUNT(*) AS count FROM inbound_email_attachments
     WHERE graph_attachment_id = 'att-dup' AND stored_name IS NOT NULL`
  );
  assert(storedCopies.count === 1, `the attachment should be stored once, saw ${storedCopies.count}`);
  const staleEmail = (await db.run(
    `INSERT INTO inbound_emails (
       graph_message_id, from_address, subject, status, headers_status, headers_next_fetch_at, body_text
     ) VALUES ('stale-headers', 'pat@security.example', 'Stale headers', 'new', 'reading', datetime('now', '-3 minutes'), 'Please print these.')`
  )).lastID;
  const staleRetry = await inboundAttachments.retryDueAttachments();
  assert(staleRetry.headers >= 1, `a stale reading claim should be retried, saw ${JSON.stringify(staleRetry)}`);
  const staleRow = await db.get(`SELECT headers_status, status FROM inbound_emails WHERE id = ?`, [staleEmail]);
  assert(staleRow.headers_status === 'read' && staleRow.status === 'new', `stale headers should be read: ${JSON.stringify(staleRow)}`);
  await new Promise((resolve) => duplicateServer.close(() => resolve()));
  delete process.env.M365_LOGIN_BASE_URL;
  delete process.env.M365_GRAPH_BASE_URL;

  const hickory = await db.get(`SELECT id FROM locations WHERE name = 'Hickory'`);
  const adminUser = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
  const movedCustomer = (await db.run(
    `INSERT INTO users (username, password_hash, role, display_name, email, location_id, is_active)
     VALUES ('hickory-buyer', 'x', 'customer', 'Hickory Buyer', 'buyer@hickory.example', ?, 1)`,
    [hickory.id]
  )).lastID;
  const moveEmail = (await db.run(
    `INSERT INTO inbound_emails (graph_message_id, from_address, subject, status, location_id, location_confirmed, headers_status)
     VALUES ('move-sec', 'buyer@hickory.example', 'Move', 'new', NULL, 0, 'read')`
  )).lastID;
  const inboundEmail = require('../inboundEmail');
  await inboundEmail.confirmFields(
    { id: adminUser.id, userId: adminUser.id, role: 'admin' },
    moveEmail,
    { customer_id: movedCustomer }
  );
  const moved = await db.get(`SELECT location_id, location_confirmed FROM inbound_emails WHERE id = ?`, [moveEmail]);
  assert(Number(moved.location_id) === Number(hickory.id) && Number(moved.location_confirmed) === 1, `confirming the customer sets the shop: ${JSON.stringify(moved)}`);
  const service = await db.get(`SELECT id FROM services WHERE name = 'Large Format'`);
  await inboundEmail.confirmFields(
    { id: adminUser.id, userId: adminUser.id, role: 'admin' },
    staleEmail,
    { customer_id: movedCustomer, recipient: 'pat@security.example' }
  );
  const converted = await inboundEmail.convertEmail(
    { id: adminUser.id, userId: adminUser.id, role: 'admin' },
    staleEmail,
    orderBody({ 'Large Format': service }, movedCustomer, weekdayAhead())
  );
  assert(converted && converted.order && converted.order.id, 'a reclaimed header read leaves the email convertible');

  const freshHold = (await db.run(
    `INSERT INTO inbound_emails (graph_message_id, from_address, subject, status, headers_status)
     VALUES ('prod-timing', 'pat@security.example', 'Prod timing', 'new', 'read')`
  )).lastID;
  await db.run(
    `INSERT INTO inbound_email_attachments (
       inbound_email_id, graph_attachment_id, original_name, fetch_state, created_at, next_fetch_at
     ) VALUES (?, 'att-prod', 'hold.pdf', 'pending', datetime('now'), datetime('now', '+1 hour'))`,
    [freshHold]
  );
  process.env.NODE_ENV = 'production';
  process.env.INBOUND_ATTACHMENT_FETCH_MAX_MS = '1';
  process.env.INBOUND_ATTACHMENT_BACKOFF_MS = '1';
  await inboundAttachments.retryDueAttachments();
  const held = await db.get(`SELECT fetch_state FROM inbound_email_attachments WHERE graph_attachment_id = 'att-prod'`);
  assert(held.fetch_state === 'pending', `production ignores the millisecond max age, was ${held.fetch_state}`);
  process.env.NODE_ENV = 'test';
  delete process.env.INBOUND_ATTACHMENT_FETCH_MAX_MS;
  delete process.env.INBOUND_ATTACHMENT_BACKOFF_MS;

  await db.close();

  const clamd = await startClamd('stream: OK');
  const graph = await startGraph();
  const server = startServer();
  try {
    await server.ready;
    const admin = await login('admin', adminPassword);
    const noCsrf = await request({
      method: 'POST',
      path: '/api/inbound-emails/sync',
      token: admin.token,
      skipCsrf: true,
      json: {},
    });
    assert(noCsrf.status === 403, `a missing CSRF token is rejected: ${noCsrf.status}`);

    attachmentMode = 'placeholder';
    const firstSync = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: admin.token });
    assert(firstSync.status === 200, firstSync.text);
    const listed = await request({ method: 'GET', path: '/api/inbound-emails?status=all', token: admin.token });
    const placeholder = (listed.json.emails || []).find((row) => row.subject === 'Artwork coming');
    assert(placeholder, 'the placeholder message should be stored');
    const detail = await request({ method: 'GET', path: `/api/inbound-emails/${placeholder.id}`, token: admin.token });
    const pending = (detail.json.attachments || []).find((file) => file.original_name === 'late.pdf');
    assert(pending && pending.fetch_state === 'pending' && pending.scan_status == null && !pending.clean, `a placeholder is not a scanned file: ${JSON.stringify(pending)}`);
    const ignored = await dbOpenIgnored();
    assert(ignored.auto && /Auto-Submitted/i.test(ignored.auto), ignored.auto);
    assert(ignored.loop && /Launchpad/i.test(ignored.loop), ignored.loop);
    assert(ignored.self && /outbound/i.test(ignored.self), ignored.self);
    assert(ignored.subject && /subject/i.test(ignored.subject), ignored.subject);
    assert(ignored.kept && /could not be read/i.test(ignored.kept), ignored.kept);
    assert(deltaCalls === 1, `the first poll should read delta once, saw ${deltaCalls}`);
    assert(deltaQueries.every((query) => !query.includes('internetMessageHeaders')), `delta must not select headers: ${deltaQueries.join(' ')}`);
    assert(headerGets.includes('msg-auto') && headerGets.includes('msg-kept'), `headers are fetched per message: ${headerGets.join(',')}`);
    assert(pending.fetch_state === 'pending', 'the first poll leaves the placeholder pending');

    const customer = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Security Customer',
        username: 'sec-customer',
        password: 'CustomerPass1',
        company: 'Security Co',
        contact_name: 'Pat Security',
        phone: '919-555-0199',
        email: 'pat@security.example',
        address_line1: '1 Security Lane',
        city: 'Raleigh',
        state: 'NC',
        zip: '27601',
      },
    });
    assert(customer.status === 201, customer.text);
    const options = await request({ method: 'GET', path: '/api/orders/options', token: admin.token });
    const byName = Object.fromEntries((options.json.services || []).map((service) => [service.name, service]));
    const dueDate = weekdayAhead();
    const payload = orderBody(byName, customer.json.id, dueDate);
    const keptRow = (listed.json.emails || []).find((row) => row.subject === 'Please print the posters');
    assert(keptRow, 'the message with unread headers should be kept');
    const headersBlocked = await request({
      method: 'POST',
      path: `/api/inbound-emails/${keptRow.id}/convert`,
      token: admin.token,
      json: payload,
    });
    assert(headersBlocked.status === 409 && /headers/i.test(headersBlocked.text), `missing headers block conversion: ${headersBlocked.status} ${headersBlocked.text}`);
    const headersAck = await request({
      method: 'POST',
      path: `/api/inbound-emails/${keptRow.id}/confirmations`,
      token: admin.token,
      json: {
        customer_id: customer.json.id,
        recipient: 'pat@security.example',
        acknowledge_missing_headers: true,
        attachment_ids: [],
      },
    });
    assert(headersAck.status === 200, headersAck.text);
    const headerLog = await openDb(dbFile);
    const headerActivity = await headerLog.get(`SELECT id FROM activity_log WHERE action = 'inbound_email.headers_missing_acknowledged'`);
    await headerLog.close();
    assert(headerActivity, 'acknowledging missing headers is logged');

    const expireMail = (listed.json.emails || []).find((row) => row.subject === 'Expire');
    if (expireMail) {
      const expireDetail = await request({ method: 'GET', path: `/api/inbound-emails/${expireMail.id}`, token: admin.token });
      const expiredFile = (expireDetail.json.attachments || []).find((file) => file.fetch_state === 'expired');
      const expireBlocked = await request({
        method: 'POST',
        path: `/api/inbound-emails/${expireMail.id}/convert`,
        token: admin.token,
        json: { ...payload, attachment_ids: [] },
      });
      assert(expireBlocked.status === 409 && /expired/i.test(expireBlocked.text), `an expired file blocks conversion: ${expireBlocked.status} ${expireBlocked.text}`);
      if (expiredFile) {
        const expireAck = await request({
          method: 'POST',
          path: `/api/inbound-emails/${expireMail.id}/confirmations`,
          token: admin.token,
          json: {
            customer_id: customer.json.id,
            recipient: 'pat@security.example',
            expired_attachment_ids: [expiredFile.id],
            attachment_ids: [],
          },
        });
        assert(expireAck.status === 200, expireAck.text);
        const expireLog = openDb(dbFile);
        const expireActivity = await expireLog.get(`SELECT detail FROM activity_log WHERE action = 'inbound_email.expired_attachment_acknowledged'`);
        await expireLog.close();
        assert(expireActivity && /proceeds without/i.test(expireActivity.detail || ''), 'the expired-file acknowledgement is logged');
      }
    }

    const blockedConvert = await request({
      method: 'POST',
      path: `/api/inbound-emails/${placeholder.id}/convert`,
      token: admin.token,
      json: payload,
    });
    assert(blockedConvert.status === 409, `a pending attachment blocks conversion: ${blockedConvert.status} ${blockedConvert.text}`);
    const fetchesAfterFirst = attachmentListGets;
    const early = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: admin.token });
    assert(early.status === 200, early.text);
    assert(attachmentListGets === fetchesAfterFirst, `backoff should skip the attachment fetch, saw ${attachmentListGets} after ${fetchesAfterFirst}`);
    const stillPending = await request({ method: 'GET', path: `/api/inbound-emails/${placeholder.id}`, token: admin.token });
    const waiting = (stillPending.json.attachments || []).find((file) => file.original_name === 'late.pdf');
    assert(waiting && (waiting.fetch_state === 'pending' || waiting.fetch_state === 'failed'), `the file stays unfetched during backoff: ${JSON.stringify(waiting)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    attachmentMode = 'ready';
    const secondSync = await request({ method: 'POST', path: '/api/inbound-emails/sync', token: admin.token });
    assert(secondSync.status === 200, secondSync.text);
    assert(deltaCalls >= 2, 'a later poll reads delta again without the original message');
    const ready = await request({ method: 'GET', path: `/api/inbound-emails/${placeholder.id}`, token: admin.token });
    const arrived = (ready.json.attachments || []).find((file) => file.original_name === 'late.pdf');
    assert(arrived && arrived.fetch_state === 'fetched' && arrived.clean, `the real attachment should scan clean: ${JSON.stringify(arrived)}`);
    const download = await request({
      method: 'GET',
      path: `/api/inbound-emails/${placeholder.id}/attachments/${arrived.id}/download`,
      token: admin.token,
    });
    const disposition = String(download.headers['content-disposition'] || '');
    assert(download.status === 200 && /attachment/i.test(disposition) && !/inline/i.test(disposition), `download headers: ${download.status} ${disposition}`);
    assert(String(download.headers['x-content-type-options'] || '') === 'nosniff', 'download sends nosniff');
    assert(String(download.headers['content-type'] || '').includes('pdf'), download.headers['content-type']);

    const noCsrfConvert = await request({
      method: 'POST',
      path: `/api/inbound-emails/${placeholder.id}/convert`,
      token: admin.token,
      skipCsrf: true,
      json: payload,
    });
    assert(noCsrfConvert.status === 403, `convert without CSRF is rejected: ${noCsrfConvert.status}`);
    const noCsrfConfirm = await request({
      method: 'POST',
      path: `/api/inbound-emails/${placeholder.id}/confirmations`,
      token: admin.token,
      skipCsrf: true,
      json: { customer_id: customer.json.id, recipient: 'pat@security.example' },
    });
    assert(noCsrfConfirm.status === 403, `confirm without CSRF is rejected: ${noCsrfConfirm.status}`);
    const partial = await request({
      method: 'POST',
      path: `/api/inbound-emails/${placeholder.id}/confirmations`,
      token: admin.token,
      json: { customer_id: customer.json.id, recipient: 'pat@security.example', attachment_ids: [] },
    });
    assert(partial.status === 200, partial.text);
    const missingFile = await request({
      method: 'POST',
      path: `/api/inbound-emails/${placeholder.id}/convert`,
      token: admin.token,
      json: { ...payload, attachment_ids: [arrived.id] },
    });
    assert(missingFile.status >= 400 && missingFile.status < 500 && /attachment/i.test(missingFile.text), `an unconfirmed attachment blocks conversion: ${missingFile.status} ${missingFile.text}`);

    const direct = await request({
      method: 'POST',
      path: `/api/inbound-emails/${placeholder.id}/convert`,
      token: admin.token,
      json: { ...payload, confirmations: { customer: true, recipient: true, attachment_ids: [arrived.id] } },
    });
    assert(direct.status >= 400 && direct.status < 500, `the convert body cannot bypass stored confirmations: ${direct.status} ${direct.text}`);

    const release = await request({
      method: 'POST',
      path: `/api/inbound-emails/${placeholder.id}/attachments/${arrived.id}/release`,
      token: admin.token,
      json: { exception: true, reason: 'should stay off' },
    });
    assert(release.status === 403, `the exception API is off: ${release.status} ${release.text}`);

    const crashDb = openDb(dbFile);
    await crashDb.run(
      `INSERT INTO inbound_emails (graph_message_id, from_address, subject, status, match_status)
       VALUES ('crash-sec', 'pat@security.example', 'Crash', 'new', 'unverified')`
    );
    const crashEmail = await crashDb.get(`SELECT id FROM inbound_emails WHERE graph_message_id = 'crash-sec'`);
    const confirm = await request({
      method: 'POST',
      path: `/api/inbound-emails/${crashEmail.id}/confirmations`,
      token: admin.token,
      json: { customer_id: customer.json.id, recipient: 'pat@security.example', attachment_ids: [] },
    });
    assert(confirm.status === 200 && confirm.json.match_status === 'approved', confirm.text);
    const crashed = await request({
      method: 'POST',
      path: `/api/inbound-emails/${crashEmail.id}/convert`,
      token: admin.token,
      headers: { 'X-Inbound-Crash': 'after-insert' },
      json: payload,
    });
    assert(crashed.status >= 400, `a crash during convert should fail: ${crashed.status} ${crashed.text}`);
    const afterCrash = openDb(dbFile);
    const crashOrders = await afterCrash.get(`SELECT COUNT(*) AS count FROM orders WHERE source_inbound_email_id = ?`, [crashEmail.id]);
    const crashStatus = await afterCrash.get(`SELECT status FROM inbound_emails WHERE id = ?`, [crashEmail.id]);
    assert(crashOrders.count === 0 && crashStatus.status === 'new', `a crash must not leave an order: ${crashOrders.count} ${crashStatus.status}`);
    const recovered = await request({
      method: 'POST',
      path: `/api/inbound-emails/${crashEmail.id}/convert`,
      token: admin.token,
      json: payload,
    });
    assert(recovered.status === 201, `retry after a crash should be safe: ${recovered.status} ${recovered.text}`);
    const one = await afterCrash.get(`SELECT COUNT(*) AS count FROM orders WHERE source_inbound_email_id = ?`, [crashEmail.id]);
    const linked = await afterCrash.get(`SELECT status, order_id FROM inbound_emails WHERE id = ?`, [crashEmail.id]);
    assert(one.count === 1 && linked.status === 'converted' && linked.order_id, 'retry leaves one linked order');
    const duplicate = await request({
      method: 'POST',
      path: `/api/inbound-emails/${crashEmail.id}/convert`,
      token: admin.token,
      json: payload,
    });
    assert(duplicate.status === 409, `a second submit is rejected: ${duplicate.status} ${duplicate.text}`);
    await afterCrash.run(`UPDATE inbound_emails SET status = 'new' WHERE id = ?`, [crashEmail.id]);
    const forced = await request({
      method: 'POST',
      path: `/api/inbound-emails/${crashEmail.id}/convert`,
      token: admin.token,
      json: payload,
    });
    assert(forced.status === 409, `the unique column blocks a second order: ${forced.status} ${forced.text}`);
    const stillOne = await afterCrash.get(`SELECT COUNT(*) AS count FROM orders WHERE source_inbound_email_id = ?`, [crashEmail.id]);
    assert(stillOne.count === 1, `still one order, saw ${stillOne.count}`);

    const adminId = admin.user.id;
    const secondEmail = await afterCrash.run(
      `INSERT INTO inbound_emails (graph_message_id, from_address, subject, status, match_status)
       VALUES ('double-sec', 'pat@security.example', 'Double', 'new', 'approved')`
    );
    await afterCrash.run(
      `INSERT INTO inbound_email_confirmations (inbound_email_id, kind, subject_key, confirmed_by)
       VALUES (?, 'customer', ?, ?), (?, 'recipient', 'pat@security.example', ?)`,
      [secondEmail.lastID, String(customer.json.id), adminId, secondEmail.lastID, adminId]
    );
    const [firstHit, secondHit] = await Promise.all([
      request({ method: 'POST', path: `/api/inbound-emails/${secondEmail.lastID}/convert`, token: admin.token, json: payload }),
      request({ method: 'POST', path: `/api/inbound-emails/${secondEmail.lastID}/convert`, token: admin.token, json: payload }),
    ]);
    const statuses = [firstHit.status, secondHit.status].sort((a, b) => a - b);
    assert(statuses[0] === 201 && statuses[1] === 409, `double submit creates one order: ${firstHit.status} ${secondHit.status} ${firstHit.text} ${secondHit.text}`);
    const doubleCount = await afterCrash.get(`SELECT COUNT(*) AS count FROM orders WHERE source_inbound_email_id = ?`, [secondEmail.lastID]);
    assert(doubleCount.count === 1, `double submit left ${doubleCount.count} orders`);
    const orderView = await request({
      method: 'GET',
      path: `/api/orders/${linked.order_id}`,
      token: admin.token,
    });
    assert((orderView.json.order.customer_notices || []).some((row) => row.notice_type === 'confirmation'), 'the order history includes the confirmation');
    const pickupNotify = require('../pickupNotify');
    const deliveryNotify = require('../deliveryNotify');
    await afterCrash.run(
      `UPDATE users SET mobile_phone = '9195550199', sms_opt_in = 1 WHERE id = ?`,
      [customer.json.id]
    );
    await afterCrash.run(
      `UPDATE orders SET pickup_notified_generation = 1, delivery_notified_generation = 1 WHERE id = ?`,
      [linked.order_id]
    );
    await pickupNotify.deliver(linked.order_id, 1);
    await deliveryNotify.deliver(linked.order_id, 1);
    const delivered = await customerNotices.orderNotices(linked.order_id);
    for (const noticeType of ['ready_for_pickup', 'ready_for_delivery']) {
      assert(delivered.some((row) => row.notice_type === noticeType && row.channel === 'email' && row.recipient && row.result), `${noticeType} email is on the order`);
      assert(delivered.some((row) => row.notice_type === noticeType && row.channel === 'sms' && row.result), `${noticeType} text is on the order`);
    }
    const auditApi = await request({ method: 'GET', path: '/api/account-audit', token: admin.token });
    assert(auditApi.status === 200 && (auditApi.json.entries || []).some((row) => row.notice_type === 'welcome'), auditApi.text);
    const operator = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: { username: 'sec-op', display_name: 'Op', role: 'operator', password: 'OperatorPass123', email: 'op@security.example' },
    });
    assert(operator.status === 201, operator.text);
    const operatorLogin = await login('sec-op', 'OperatorPass123');
    const hiddenAudit = await request({ method: 'GET', path: '/api/account-audit', token: operatorLogin.token });
    assert(hiddenAudit.status === 403, 'operators cannot read the account audit log');
    await afterCrash.close();
    console.log('PASS email order security');
  } finally {
    server.stop();
    await new Promise((resolve) => graph.close(() => resolve()));
    await new Promise((resolve) => clamd.close(() => resolve()));
  }
}

async function dbOpenIgnored() {
  const db = openDb(dbFile);
  try {
    const auto = await db.get(`SELECT ignore_reason FROM inbound_emails WHERE graph_message_id = 'msg-auto'`);
    const loop = await db.get(`SELECT ignore_reason FROM inbound_emails WHERE graph_message_id = 'msg-loop'`);
    const self = await db.get(`SELECT ignore_reason FROM inbound_emails WHERE graph_message_id = 'msg-self'`);
    const subject = await db.get(`SELECT ignore_reason FROM inbound_emails WHERE graph_message_id = 'msg-subject-auto'`);
    const kept = await db.get(`SELECT status, loop_check_note FROM inbound_emails WHERE graph_message_id = 'msg-kept'`);
    return {
      auto: auto && auto.ignore_reason,
      loop: loop && loop.ignore_reason,
      self: self && self.ignore_reason,
      subject: subject && subject.ignore_reason,
      kept: kept && kept.status !== 'ignored' ? kept.loop_check_note : '',
    };
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
