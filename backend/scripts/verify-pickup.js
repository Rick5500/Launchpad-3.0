/**
 * Ready-for-pickup email and SMS: dry-run when Twilio is unset, no text
 * without opt-in, and one send per transition into Ready for Pickup.
 * Usage (from backend/): node scripts/verify-pickup.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');
const sms = require('../sms');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-pickup-'));
const dbFile = path.join(tmp, 'pickup.db');
const port = 3144;
const adminPassword = 'AdminPass123';
const customerPassword = 'CustomerPass123';
const CONSENT = 'I agree to receive order status texts from Accent Corporate Graphics. Msg & data rates may apply. Reply STOP to opt out.';

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
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  return { run, get, close };
}

function baseEnv(extra = {}) {
  return {
    DATABASE_FILE: dbFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    DELIVERY_TIMEZONE: 'UTC',
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '2525',
    SMTP_FROM: 'orders@example.com',
    MAIL_TRANSPORT: 'json',
    PUBLIC_APP_URL: 'https://launchpad.example',
    TWILIO_ACCOUNT_SID: '',
    TWILIO_AUTH_TOKEN: '',
    TWILIO_FROM_NUMBER: '',
    TWILIO_API_BASE: '',
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
        try { parsed = text ? JSON.parse(text) : null; } catch (err) { parsed = null; }
        resolve({ status: res.statusCode, text, json: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...env },
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
        const health = await request({ method: 'GET', path: '/api/health' });
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

function dryRuns(logs) {
  return (logs.match(/SMS dry-run:/g) || []).length;
}

function addressOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return addressOf(value[0]);
  if (value.address) return String(value.address);
  return '';
}

function weekdayAhead() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 3);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function orderBody(customerId, serviceId, locationId, email) {
  return fillOrderLines({
    customer_id: customerId,
    location_id: locationId,
    company: 'Pickup Co',
    contact_name: 'Casey Customer',
    phone: '919-555-0199',
    email,
    project_name: 'Pickup job',
    notes: 'Ready check',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '1 Shop Way',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Will Call',
    due_date: weekdayAhead(),
    due_time: '10:00',
    return_to: 'To Me',
    service_ids: [serviceId],
    line_items: [{ description: 'Print set', quantity: '1', service_id: serviceId }],
  });
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

async function main() {
  assert(sms.SMS_CONSENT === CONSENT, 'consent wording should match the profile checkbox');
  assert(sms.normalizeE164('(919) 555-0100') === '+19195550100', 'a 10-digit US number should become E.164');
  assert(sms.normalizeE164('19195550100') === '+19195550100', 'an 11-digit US number should keep the leading 1');
  assert(sms.normalizeE164('+447911123456') === '+447911123456', 'an international number with + should stay');
  assert(sms.normalizeE164('abc') == null && sms.normalizeE164('123') == null, 'a short or non-numeric value is not a mobile number');
  const sample = sms.pickupSmsBody({
    orderNumber: '123',
    locationName: 'Raleigh',
    locationAddress: '8121 Brownleigh Drive\nRaleigh, NC 27617',
    locationPhone: '919-782-3332',
  });
  assert(
    sample === 'Accent Corporate Graphics: Order #123 is ready for pickup at our Raleigh location, 8121 Brownleigh Drive, Raleigh, NC 27617. Questions? 919-782-3332',
    `unexpected text body: ${sample}`
  );

  fs.mkdirSync(path.join(tmp, 'uploads'), { recursive: true });
  const firstInit = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  assert(firstInit.code === 0, `init_db failed\n${firstInit.out}\n${firstInit.err}`);
  const secondInit = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  assert(secondInit.code === 0, `second init_db failed\n${secondInit.out}\n${secondInit.err}`);
  const seeded = openDb(dbFile);
  const userColumns = await seeded.get(`SELECT name FROM pragma_table_info('users') WHERE name = 'mobile_phone'`);
  const optColumn = await seeded.get(`SELECT name FROM pragma_table_info('users') WHERE name = 'sms_opt_in'`);
  const statusColumn = await seeded.get(`SELECT name FROM pragma_table_info('orders') WHERE name = 'status'`);
  assert(userColumns && optColumn && statusColumn, 'init should add the texting and order status columns');
  const acme = await seeded.get(`SELECT sms_opt_in FROM users WHERE username = 'acme'`);
  assert(acme && Number(acme.sms_opt_in) === 0, 'existing customers stay opted out');
  const raleigh = await seeded.get(`SELECT id, name, address, phone FROM locations WHERE name = 'Raleigh'`);
  assert(raleigh, 'Raleigh should be seeded');
  await seeded.close();
  console.log('PASS init columns and default opt-out');

  const server = startServer(baseEnv());
  await server.ready;
  try {
    const admin = await login('admin', adminPassword);
    const created = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        username: 'pickupcasey',
        display_name: 'Casey Pickup',
        company: 'Pickup Co',
        contact_name: 'Casey Customer',
        phone: '919-555-0199',
        email: 'casey@pickup.example',
        password: customerPassword,
      },
    });
    assert(created.status === 201, created.text);
    const quiet = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        username: 'pickupquiet',
        display_name: 'Quiet Pickup',
        company: 'Quiet Co',
        contact_name: 'Quiet Customer',
        phone: '919-555-0188',
        email: 'quiet@pickup.example',
        password: customerPassword,
      },
    });
    assert(quiet.status === 201, quiet.text);
    const manager = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'pickupmgr',
        display_name: 'Pickup Manager',
        role: 'manager',
        password: 'ManagerPass123',
        email: 'manager@pickup.example',
      },
    });
    assert(manager.status === 201, manager.text);
    const operator = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'pickupop',
        display_name: 'Pickup Operator',
        role: 'operator',
        password: 'OperatorPass123',
      },
    });
    assert(operator.status === 201, operator.text);

    const phoneOnly = await request({
      method: 'PUT',
      path: `/api/customers/${created.json.id}/texting`,
      token: admin.token,
      json: { mobile_phone: '(919) 555-0100', sms_opt_in: false },
    });
    assert(phoneOnly.status === 200 && phoneOnly.json.mobile_phone === '+19195550100' && phoneOnly.json.sms_opt_in === false, phoneOnly.text);
    const staffOn = await request({
      method: 'PUT',
      path: `/api/customers/${created.json.id}/texting`,
      token: admin.token,
      json: { mobile_phone: '(919) 555-0100', sms_opt_in: true },
    });
    assert(staffOn.status === 403, `staff must not opt a customer in: ${staffOn.status} ${staffOn.text}`);
    const createOptIn = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'pickupstaffopt',
        display_name: 'Staff Opt',
        role: 'customer',
        password: customerPassword,
        mobile_phone: '919-555-0166',
        sms_opt_in: true,
      },
    });
    assert(createOptIn.status === 403, `creating a customer must not opt them in: ${createOptIn.text}`);
    const mgrLogin = await login('pickupmgr', 'ManagerPass123');
    const managerList = await request({ method: 'GET', path: '/api/customers', token: mgrLogin.token });
    assert(managerList.status === 200 && Array.isArray(managerList.json), managerList.text);
    const managerEdit = await request({
      method: 'PUT',
      path: `/api/customers/${quiet.json.id}/texting`,
      token: mgrLogin.token,
      json: { mobile_phone: '919-555-0177', sms_opt_in: false },
    });
    assert(managerEdit.status === 200 && managerEdit.json.sms_opt_in === false && managerEdit.json.mobile_phone === '+19195550177', managerEdit.text);
    const managerOn = await request({
      method: 'PUT',
      path: `/api/customers/${quiet.json.id}/texting`,
      token: mgrLogin.token,
      json: { sms_opt_in: true },
    });
    assert(managerOn.status === 403, `a manager must not opt a customer in: ${managerOn.text}`);
    const opLogin = await login('pickupop', 'OperatorPass123');
    const operatorEdit = await request({
      method: 'PUT',
      path: `/api/customers/${created.json.id}/texting`,
      token: opLogin.token,
      json: { sms_opt_in: false },
    });
    assert(operatorEdit.status === 403, 'an operator should not edit texting preferences');
    const missingConsent = await request({
      method: 'PUT',
      path: `/api/customers/${created.json.id}/texting`,
      token: admin.token,
      json: { sms_opt_in: true, mobile_phone: '' },
    });
    assert(missingConsent.status === 400, 'opt-in without a mobile number should be rejected');

    const casey = await login('pickupcasey', customerPassword);
    assert(casey.user.sms_opt_in === false && casey.user.mobile_phone === '+19195550100', 'login should return the texting profile still opted out');
    const badLocation = await request({
      method: 'PUT',
      path: '/api/auth/profile',
      token: casey.token,
      json: { location_id: 999999, mobile_phone: '919-555-0100', sms_opt_in: true },
    });
    assert(badLocation.status === 400, `a bad location should be rejected before texting is saved: ${badLocation.text}`);
    const stillOut = await login('pickupcasey', customerPassword);
    assert(stillOut.user.sms_opt_in === false, 'an invalid location must not save the opt-in');
    const selfOff = await request({
      method: 'PUT',
      path: '/api/auth/profile',
      token: casey.token,
      json: { sms_opt_in: false },
    });
    assert(selfOff.status === 200 && selfOff.json.sms_opt_in === false, selfOff.text);
    const selfOn = await request({
      method: 'PUT',
      path: '/api/auth/profile',
      token: casey.token,
      json: { mobile_phone: '919-555-0100', sms_opt_in: true },
    });
    assert(selfOn.status === 200 && selfOn.json.sms_opt_in === true && selfOn.json.mobile_phone === '+19195550100', selfOn.text);

    const options = await request({ method: 'GET', path: '/api/orders/options', token: admin.token });
    assert(options.status === 200, options.text);
    setServiceNames(options.json.services || []);
    const large = (options.json.services || []).find((service) => service.name === 'Large Format');
    assert(large, 'Large Format should be seeded');

    const readyOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: admin.token,
      json: orderBody(created.json.id, large.id, raleigh.id, 'casey@pickup.example'),
    });
    assert(readyOrder.status === 201, readyOrder.text);
    const orderId = readyOrder.json.order.id;
    const customerStatus = await request({
      method: 'PUT',
      path: `/api/orders/${orderId}/status`,
      token: casey.token,
      json: { status: 'Ready for Pickup' },
    });
    assert(customerStatus.status === 403, 'a customer cannot mark an order ready');

    const before = dryRuns(server.logs());
    const marked = await request({
      method: 'PUT',
      path: `/api/orders/${orderId}/status`,
      token: admin.token,
      json: { status: 'Ready for Pickup' },
    });
    assert(marked.status === 200, marked.text);
    assert(marked.json.order.status === 'Ready for Pickup', marked.text);
    assert(marked.json.pickup_notice.email.status === 'sent', `email should send, got ${JSON.stringify(marked.json.pickup_notice)}`);
    assert(marked.json.pickup_notice.sms.status === 'dry_run', `sms should dry-run, got ${JSON.stringify(marked.json.pickup_notice.sms)}`);
    assert(marked.json.pickup_notice.email.sent_at && marked.json.pickup_notice.sms.sent_at, 'both channels should record a sent time');
    const hickory = (options.json.locations || []).find((location) => location.name === 'Hickory');
    assert(hickory, 'Hickory should be seeded');
    const farOperator = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'pickupfar',
        display_name: 'Far Operator',
        role: 'operator',
        password: 'OperatorPass123',
        location_id: hickory.id,
      },
    });
    assert(farOperator.status === 201, farOperator.text);
    const farLogin = await login('pickupfar', 'OperatorPass123');
    const farStatus = await request({
      method: 'PUT',
      path: `/api/orders/${orderId}/status`,
      token: farLogin.token,
      json: { status: 'Ready for Pickup' },
    });
    assert(farStatus.status === 404, `an operator at another shop should not see the order: ${farStatus.status} ${farStatus.text}`);
    const found = await request({
      method: 'GET',
      path: `/api/search/orders?status=${encodeURIComponent('ready for pickup')}`,
      token: admin.token,
    });
    assert(found.status === 200 && (found.json.orders || []).some((row) => row.id === orderId && row.status === 'Ready for Pickup'), found.text);
    const dash = await request({ method: 'GET', path: '/api/dashboard', token: admin.token });
    const farDash = await request({ method: 'GET', path: '/api/dashboard', token: farLogin.token });
    assert(dash.status === 200 && Number(dash.json.readyForPickup) >= 1, dash.text);
    assert(farDash.status === 200 && Number(farDash.json.readyForPickup) === 0, 'a Hickory operator should not count a Raleigh ready order');
    const preview = marked.json.pickup_notice.email.preview;
    assert(preview && preview.html && preview.text, 'the test transport should capture the email');
    assert(preview.html.includes(readyOrder.json.order_number), 'the email should include the order number');
    assert(preview.html.includes('Raleigh') && preview.html.includes('8121 Brownleigh Drive') && preview.html.includes('919-782-3332'), 'the email should include the location');
    assert(preview.html.includes('A service of Accent Imaging and Accent Corporate Graphics'), 'the email should include the Accent Imaging and ACG credit');
    assert(preview.html.includes('acg-logo.png') && preview.html.includes('accent-imaging-logo.png'), 'the email should include the credit logos');
    assert(preview.text.includes('A service of Accent Imaging and Accent Corporate Graphics'), 'plain text should include the credit');
    assert(addressOf(preview.to) === 'casey@pickup.example', `email should go to the order contact, got ${JSON.stringify(preview.to)}`);
    const logged = server.logs().slice(server.logs().indexOf('SMS dry-run:'));
    assert(logged.includes(readyOrder.json.order_number) && logged.includes('8121 Brownleigh Drive') && logged.includes('+19195550100'), 'the dry-run log should include the text');
    assert(dryRuns(server.logs()) === before + 1, 'one dry-run text should be logged');
    fs.writeFileSync(path.join(tmp, 'pickup-email.html'), preview.html);
    console.log('PASS dry-run email and text');

    const emailSent = marked.json.pickup_notice.email.sent_at;
    const smsSent = marked.json.pickup_notice.sms.sent_at;
    const again = await request({
      method: 'PUT',
      path: `/api/orders/${orderId}/status`,
      token: opLogin.token,
      json: { status: 'ready for pickup' },
    });
    assert(again.status === 200 && again.json.pickup_notice && again.json.pickup_notice.reason === 'already_notified', again.text);
    assert(dryRuns(server.logs()) === before + 1, 'a repeated save must not send another text');
    const check = openDb(dbFile);
    const row = await check.get(
      `SELECT status, pickup_email_sent_at, pickup_sms_sent_at, pickup_ready_generation, pickup_notified_generation
       FROM orders WHERE id = ?`,
      [orderId]
    );
    await check.close();
    assert(row.pickup_email_sent_at === emailSent && row.pickup_sms_sent_at === smsSent, 'sent timestamps should stay on a repeated save');
    assert(Number(row.pickup_ready_generation) === Number(row.pickup_notified_generation), 'the claimed generation should match');
    console.log('PASS dedupe');

    const quietOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: admin.token,
      json: orderBody(quiet.json.id, large.id, raleigh.id, 'quiet@pickup.example'),
    });
    assert(quietOrder.status === 201, quietOrder.text);
    const quietBefore = dryRuns(server.logs());
    const quietMarked = await request({
      method: 'PUT',
      path: `/api/orders/${quietOrder.json.order.id}/status`,
      token: admin.token,
      json: { status: 'Ready for Pickup' },
    });
    assert(quietMarked.status === 200, quietMarked.text);
    assert(quietMarked.json.pickup_notice.email.status === 'sent', 'opt-out should still email');
    assert(quietMarked.json.pickup_notice.sms.status === 'skipped' && !quietMarked.json.pickup_notice.sms.sent_at, quietMarked.text);
    assert(dryRuns(server.logs()) === quietBefore, 'opt-out must not log a text');
    console.log('PASS opt-out');

    const invalidDb = openDb(dbFile);
    await invalidDb.run(`UPDATE users SET mobile_phone = 'not-a-number', sms_opt_in = 1 WHERE id = ?`, [quiet.json.id]);
    await invalidDb.run(
      `UPDATE orders SET status = 'In Production', pickup_email_sent_at = NULL, pickup_sms_sent_at = NULL,
        pickup_email_status = NULL, pickup_sms_status = NULL
       WHERE id = ?`,
      [quietOrder.json.order.id]
    );
    await invalidDb.close();
    const invalidBefore = dryRuns(server.logs());
    const invalidMarked = await request({
      method: 'PUT',
      path: `/api/orders/${quietOrder.json.order.id}/status`,
      token: admin.token,
      json: { status: 'Ready for Pickup' },
    });
    assert(invalidMarked.status === 200 && invalidMarked.json.order.status === 'Ready for Pickup', invalidMarked.text);
    assert(invalidMarked.json.pickup_notice.sms.status === 'invalid', invalidMarked.text);
    assert(invalidMarked.json.pickup_notice.email.status === 'sent', 'a bad mobile number must not block the email or the status');
    assert(dryRuns(server.logs()) === invalidBefore, 'an invalid number must not be texted');
    console.log('PASS invalid number does not block the status');

    const returned = await request({
      method: 'PUT',
      path: `/api/orders/${orderId}/status`,
      token: admin.token,
      json: { status: 'In Production' },
    });
    assert(returned.status === 200 && returned.json.order.status === 'In Production', returned.text);
    const reentered = await request({
      method: 'PUT',
      path: `/api/orders/${orderId}/status`,
      token: admin.token,
      json: { status: 'Ready for Pickup' },
    });
    assert(reentered.status === 200 && reentered.json.pickup_notice.sms.status === 'dry_run', reentered.text);
    assert(dryRuns(server.logs()) === invalidBefore + 1, 'leaving and returning to ready should send once more');
    console.log('PASS a new transition sends again');

    const quietLogin = await login('pickupquiet', customerPassword);
    const quietOn = await request({
      method: 'PUT',
      path: '/api/auth/profile',
      token: quietLogin.token,
      json: { mobile_phone: '919-555-0177', sms_opt_in: true },
    });
    assert(quietOn.status === 200 && quietOn.json.sms_opt_in === true, quietOn.text);
    const staffOff = await request({
      method: 'PUT',
      path: `/api/customers/${quiet.json.id}/texting`,
      token: admin.token,
      json: { sms_opt_in: false },
    });
    assert(staffOff.status === 200 && staffOff.json.sms_opt_in === false, 'staff can turn texts off');
    const staffBack = await request({
      method: 'PUT',
      path: `/api/customers/${quiet.json.id}/texting`,
      token: mgrLogin.token,
      json: { mobile_phone: '919-555-0177', sms_opt_in: true },
    });
    assert(staffBack.status === 403, `staff must not turn texts back on: ${staffBack.text}`);
    console.log('PASS staff can turn texts off and cannot opt a customer in');
  } catch (err) {
    console.error(server.logs());
    throw err;
  } finally {
    await server.stop();
  }

  const failing = startServer(baseEnv({
    TWILIO_ACCOUNT_SID: 'AC1234567890',
    TWILIO_AUTH_TOKEN: 'not-a-real-token',
    TWILIO_FROM_NUMBER: '+15555550100',
    TWILIO_API_BASE: 'http://127.0.0.1:9',
  }));
  await failing.ready;
  try {
    const admin = await login('admin', adminPassword);
    const options = await request({ method: 'GET', path: '/api/orders/options', token: admin.token });
    setServiceNames(options.json.services || []);
    const large = (options.json.services || []).find((service) => service.name === 'Large Format');
    const db = openDb(dbFile);
    const customer = await db.get(`SELECT id FROM users WHERE username = 'pickupcasey'`);
    const shop = await db.get(`SELECT id FROM locations WHERE name = 'Raleigh'`);
    await db.close();
    assert(customer && shop, 'the opted-in customer and Raleigh should still be in the database');
    const before = dryRuns(failing.logs());
    const created = await request({
      method: 'POST',
      path: '/api/orders',
      token: admin.token,
      json: orderBody(customer.id, large.id, shop.id, 'casey@pickup.example'),
    });
    assert(created.status === 201, created.text);
    const marked = await request({
      method: 'PUT',
      path: `/api/orders/${created.json.order.id}/status`,
      token: admin.token,
      json: { status: 'Ready for Pickup' },
    });
    assert(marked.status === 200 && marked.json.order.status === 'Ready for Pickup', marked.text);
    assert(marked.json.pickup_notice.email.status === 'sent', 'a text failure must not block the email');
    assert(marked.json.pickup_notice.sms.status === 'failed' && !marked.json.pickup_notice.sms.sent_at, marked.text);
    assert(dryRuns(failing.logs()) === before, 'a configured Twilio account must not dry-run');
    assert(/SMS SEND ERROR:/.test(failing.logs()), 'a Twilio connection error should be logged');
    console.log('PASS a text failure does not block the status');
  } catch (err) {
    console.error(failing.logs());
    throw err;
  } finally {
    await failing.stop();
  }

  console.log('pickup notify ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
