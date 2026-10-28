/**
 * Welcome mail, order confirmation, ready-for-delivery, and originals pickups.
 * Mail uses MAIL_TRANSPORT=json. Texts dry-run when Twilio is unset.
 * Usage (from backend/): node scripts/verify-customer-notify.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-notify-'));
const dbFile = path.join(tmp, 'notify.db');
const port = 3168;
const adminPassword = 'AdminPass123';
const customerPassword = 'CustomerPass123';
const staffPassword = 'StaffSecret99';
const CREDIT = 'A service of Accent Imaging and Accent Corporate Graphics';
const STOP_LINE = 'Reply STOP to opt out.';

process.env.DATABASE_FILE = dbFile;
process.env.NODE_ENV = 'test';

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
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  return { run, get, all, close };
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
    MAIL_TEST_THROW: '',
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
    }, 20000);
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

function weekdayAhead() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 3);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function orderBody(overrides = {}) {
  return fillOrderLines({
    company: 'Notify Co',
    contact_name: 'Nora Notify',
    phone: '919-555-0170',
    email: 'nora@notify.example',
    project_name: 'Notify job',
    notes: 'Leave at the dock.',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '10 Dock Street',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Accent Truck',
    ship_to: 'Notify Co\n10 Dock Street\nRaleigh, NC 27601',
    due_date: weekdayAhead(),
    due_time: '10:00',
    service_ids: [],
    line_items: [],
    ...overrides,
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

function mailBlob(preview) {
  if (!preview) return '';
  return `${preview.subject || ''}\n${preview.text || ''}\n${preview.html || ''}`;
}

function assertCustomerMail(preview, label) {
  const blob = mailBlob(preview);
  assert(preview && preview.html && preview.text, `${label} should capture the message`);
  assert(blob.includes(CREDIT), `${label} should include the Accent Imaging and ACG credit`);
  assert(preview.html.includes('/brand/acg-logo.png'), `${label} should include the ACG logo`);
  assert(preview.html.includes('/brand/accent-imaging-logo.png'), `${label} should include the Accent Imaging logo`);
}

function tokenFrom(preview) {
  const match = /set-password\?token=([A-Za-z0-9_-]+)/.exec(mailBlob(preview));
  assert(match, `set-password link missing from welcome mail: ${mailBlob(preview).slice(0, 500)}`);
  return match[1];
}

function dryRuns(logs) {
  return (logs.match(/SMS dry-run:/g) || []).length;
}

async function main() {
  fs.mkdirSync(path.join(tmp, 'uploads'), { recursive: true });
  const firstInit = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  assert(firstInit.code === 0, `init_db failed\n${firstInit.out}\n${firstInit.err}`);
  const secondInit = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  assert(secondInit.code === 0, `second init_db failed\n${secondInit.out}\n${secondInit.err}`);

  const seeded = openDb(dbFile);
  const welcomeFlag = await seeded.get(`SELECT value FROM system_settings WHERE key = 'email_welcome_on_account'`);
  const confirmFlag = await seeded.get(`SELECT value FROM system_settings WHERE key = 'email_order_confirmation'`);
  assert(welcomeFlag && welcomeFlag.value === '1', 'welcome email should default on');
  assert(confirmFlag && confirmFlag.value === '1', 'order confirmation should default on');
  const quality = await seeded.get(`SELECT id, name, dept_key FROM departments WHERE name = 'Quality'`);
  const dispatch = await seeded.get(`SELECT dept_key FROM departments WHERE name = 'Dispatch'`);
  const delivery = await seeded.get(`SELECT dept_key FROM departments WHERE name = 'Delivery'`);
  const complete = await seeded.get(`SELECT dept_key FROM departments WHERE name = 'Complete'`);
  assert(quality && quality.dept_key === 'quality', 'Quality should keep a stable dept_key');
  assert(dispatch && dispatch.dept_key === 'dispatch', 'Dispatch should keep a stable dept_key');
  assert(delivery && delivery.dept_key === 'delivery' && complete && complete.dept_key === 'complete', 'later stages should keep stable keys');
  const confirmColumn = await seeded.get(`SELECT name FROM pragma_table_info('orders') WHERE name = 'confirmation_email_sent_at'`);
  const deliveryColumn = await seeded.get(`SELECT name FROM pragma_table_info('orders') WHERE name = 'delivery_notified_generation'`);
  const pickupTable = await seeded.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pickup_requests'`);
  const tokenTable = await seeded.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'password_reset_tokens'`);
  assert(confirmColumn && deliveryColumn && pickupTable && tokenTable, 'mail and pickup tables should be migrated');
  await seeded.close();
  console.log('PASS init settings, department keys, and columns');

  process.env.MAIL_TEST_THROW = 'welcome';
  const userAdmin = require('../userAdmin');
  const failedWelcome = await userAdmin.createUser(1, {
    username: 'mailfail',
    display_name: 'Mail Fail',
    role: 'customer',
    email: 'mailfail@notify.example',
    password: 'MailFailPass123',
    company: 'Fail Co',
  });
  assert(failedWelcome && failedWelcome.id, 'a mail failure must still create the account');
  assert(failedWelcome.welcome_email && failedWelcome.welcome_email.status === 'failed', `welcome failure should be reported, got ${JSON.stringify(failedWelcome.welcome_email)}`);
  assert(!failedWelcome.welcome_email.preview, 'a forced failure should not include a message');
  delete process.env.MAIL_TEST_THROW;
  console.log('PASS mail failure does not block account creation');

  const server = startServer(baseEnv());
  await server.ready;
  const db = openDb(dbFile);
  try {
    const admin = await login('admin', adminPassword);
    const settings = await request({ method: 'GET', path: '/api/settings', token: admin.token });
    assert(settings.status === 200 && settings.json.email_welcome_on_account === true, settings.text);
    assert(settings.json.email_order_confirmation === true, 'order confirmation should default on in settings');

    const welcomeOff = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: { email_welcome_on_account: false },
    });
    assert(welcomeOff.status === 200 && welcomeOff.json.email_welcome_on_account === false, welcomeOff.text);
    const quietUser = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'quietlogin',
        display_name: 'Quiet Login',
        role: 'customer',
        email: 'quiet@notify.example',
        password: staffPassword,
        company: 'Quiet Co',
      },
    });
    assert(quietUser.status === 201, quietUser.text);
    assert(quietUser.json.welcome_email && quietUser.json.welcome_email.status === 'disabled', quietUser.text);
    assert(!mailBlob(quietUser.json.welcome_email.preview).includes('set-password'), 'a disabled welcome must not send a link');
    const quietTokens = await db.get(`SELECT COUNT(*) AS count FROM password_reset_tokens WHERE user_id = ?`, [quietUser.json.id]);
    assert(quietTokens.count === 0, 'a disabled welcome must not issue a set-password token');

    const welcomeOn = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: { email_welcome_on_account: true },
    });
    assert(welcomeOn.status === 200 && welcomeOn.json.email_welcome_on_account === true, welcomeOn.text);

    const generated = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'generatedlogin',
        display_name: 'Generated Login',
        role: 'customer',
        email: 'generated@notify.example',
        company: 'Generated Co',
      },
    });
    assert(generated.status === 201 && generated.json.password, `a generated password should still be returned to staff: ${generated.text}`);
    assertCustomerMail(generated.json.welcome_email.preview, 'staff welcome');
    const generatedBlob = mailBlob(generated.json.welcome_email.preview);
    assert(!generatedBlob.includes(generated.json.password), 'the welcome email must not contain the generated password');
    assert(generatedBlob.includes('does not include a password'), 'the welcome should say the password is not in the message');
    const generatedToken = tokenFrom(generated.json.welcome_email.preview);

    const supplied = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'suppliedlogin',
        display_name: 'Supplied Login',
        role: 'operator',
        department: 'Large Format',
        email: 'supplied@notify.example',
        password: staffPassword,
      },
    });
    assert(supplied.status === 201, supplied.text);
    assert(!supplied.json.password, 'a supplied password should not be echoed');
    assertCustomerMail(supplied.json.welcome_email.preview, 'supplied-password welcome');
    assert(!mailBlob(supplied.json.welcome_email.preview).includes(staffPassword), 'the welcome email must not contain the staff-chosen password');

    const customerRecord = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        username: 'customernora',
        display_name: 'Nora Notify',
        company: 'Notify Co',
        contact_name: 'Nora Notify',
        phone: '919-555-0170',
        email: 'nora@notify.example',
        password: customerPassword,
        address_line1: '10 Dock Street',
        city: 'Raleigh',
        state: 'NC',
        zip: '27601',
      },
    });
    assert(customerRecord.status === 201, customerRecord.text);
    assertCustomerMail(customerRecord.json.welcome_email.preview, 'customer create welcome');
    assert(!mailBlob(customerRecord.json.welcome_email.preview).includes(customerPassword), 'customer create mail must not contain the password');

    const setPassword = await request({
      method: 'POST',
      path: '/api/auth/set-password',
      json: {
        token: generatedToken,
        password: 'ChosenPass123',
        password_confirm: 'ChosenPass123',
      },
    });
    assert(setPassword.status === 200 && setPassword.json.ok === true, setPassword.text);
    const oldLogin = await request({
      method: 'POST',
      path: '/api/auth/login',
      json: { username: 'generatedlogin', password: generated.json.password },
    });
    assert(oldLogin.status === 401, 'the generated password should stop working after the link is used');
    const newLogin = await login('generatedlogin', 'ChosenPass123');
    assert(newLogin.user.username === 'generatedlogin', 'the new password should sign in');
    const reuse = await request({
      method: 'POST',
      path: '/api/auth/set-password',
      json: { token: generatedToken, password: 'AnotherPass123', password_confirm: 'AnotherPass123' },
    });
    assert(reuse.status === 400, `a used link should be rejected: ${reuse.text}`);
    console.log('PASS welcome email, set-password link, and no password in the message');

    const signedUp = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: {
        company: 'Signup Co',
        contact_name: 'Sam Signup',
        email: 'sam@signup.example',
        phone: '919-555-0160',
        password: customerPassword,
        password_confirm: customerPassword,
        address_line1: '5 Main Street',
        city: 'Raleigh',
        state: 'NC',
        zip: '27601',
      },
    });
    assert(signedUp.status === 201 && signedUp.json.token, signedUp.text);
    assertCustomerMail(signedUp.json.welcome_email.preview, 'self sign-up welcome');
    const signupBlob = mailBlob(signedUp.json.welcome_email.preview);
    assert(signupBlob.includes('https://launchpad.example/login'), `self sign-up should link to the public sign-in page: ${signupBlob.slice(0, 400)}`);
    assert(!signupBlob.includes('set-password'), 'self sign-up should not send a set-password link');
    assert(!signupBlob.includes(customerPassword), 'self sign-up mail must not contain the password');
    console.log('PASS self sign-up welcome');

    const options = await request({ method: 'GET', path: '/api/orders/options', token: admin.token });
    assert(options.status === 200, options.text);
    setServiceNames(options.json.services || []);
    const large = (options.json.services || []).find((service) => service.name === 'Large Format');
    const small = (options.json.services || []).find((service) => service.name === 'Small Format');
    assert(large && small, 'Large Format and Small Format should be seeded');
    const config = await request({ method: 'GET', path: '/api/auth/config' });
    const raleigh = (config.json.locations || []).find((location) => location.name === 'Raleigh');
    const hickory = (config.json.locations || []).find((location) => location.name === 'Hickory');
    assert(raleigh && hickory, 'Raleigh and Hickory should be listed');

    const confirmOff = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: { email_order_confirmation: false },
    });
    assert(confirmOff.status === 200 && confirmOff.json.email_order_confirmation === false, confirmOff.text);
    const silentOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: admin.token,
      json: orderBody({
        customer_id: customerRecord.json.id,
        location_id: raleigh.id,
        service_ids: [large.id],
        line_items: [{ description: 'Silent set', quantity: '1', service_id: large.id }],
      }),
    });
    assert(silentOrder.status === 201, silentOrder.text);
    assert(silentOrder.json.confirmation.email_sent === false, silentOrder.text);
    assert(silentOrder.json.confirmation.email_status === 'disabled', silentOrder.text);
    const silentRow = await db.get(`SELECT confirmation_email_sent_at, confirmation_email_status FROM orders WHERE id = ?`, [silentOrder.json.order.id]);
    assert(silentRow && !silentRow.confirmation_email_sent_at && !silentRow.confirmation_email_status, 'a disabled confirmation must not stamp a send');

    const confirmOn = await request({
      method: 'PUT',
      path: '/api/settings',
      token: admin.token,
      json: { email_order_confirmation: true },
    });
    assert(confirmOn.status === 200 && confirmOn.json.email_order_confirmation === true, confirmOn.text);
    const confirmed = await request({
      method: 'POST',
      path: '/api/orders',
      token: admin.token,
      json: orderBody({
        customer_id: customerRecord.json.id,
        location_id: raleigh.id,
        project_name: 'Confirmed job',
        service_ids: [large.id],
        line_items: [{ description: 'Confirmed set', quantity: '1', service_id: large.id }],
      }),
    });
    assert(confirmed.status === 201, confirmed.text);
    assert(confirmed.json.confirmation.email_status === 'sent' && confirmed.json.confirmation.email_sent === true, confirmed.text);
    assertCustomerMail(confirmed.json.confirmation.preview, 'order confirmation');
    const confirmBlob = mailBlob(confirmed.json.confirmation.preview);
    assert(confirmBlob.includes(confirmed.json.order_number), 'confirmation should include the order number');
    assert(confirmBlob.includes(weekdayAhead()), 'confirmation should include the due date');
    assert(confirmBlob.includes('Accent Truck'), 'confirmation should include the delivery method');
    assert(confirmBlob.includes('10 Dock Street'), 'confirmation should include the ship-to address');
    assert(
      confirmBlob.includes(encodeURIComponent(`/orders/${confirmed.json.order.id}`)) || confirmBlob.includes(`/orders/${confirmed.json.order.id}`),
      'confirmation should link to the order'
    );
    const stamped = await db.get(`SELECT confirmation_email_sent_at FROM orders WHERE id = ?`, [confirmed.json.order.id]);
    assert(stamped && stamped.confirmation_email_sent_at, 'confirmation_email_sent_at should be set');
    const orderConfirm = require('../orderConfirm');
    const secondSend = await orderConfirm.deliver(confirmed.json.order.id);
    assert(secondSend.skipped === true, `a second confirmation should not send: ${JSON.stringify(secondSend)}`);
    const stampedAgain = await db.get(`SELECT confirmation_email_sent_at FROM orders WHERE id = ?`, [confirmed.json.order.id]);
    assert(stampedAgain.confirmation_email_sent_at === stamped.confirmation_email_sent_at, 'the send-once timestamp should stay put');
    console.log('PASS order confirmation send-once and setting');

    const opted = await login('customernora', customerPassword);
    const textOn = await request({
      method: 'PUT',
      path: '/api/auth/profile',
      token: opted.token,
      json: { mobile_phone: '919-555-0170', sms_opt_in: true },
    });
    assert(textOn.status === 200 && textOn.json.sms_opt_in === true, textOn.text);

    async function place(method, services) {
      const ids = services.map((service) => service.id);
      const response = await request({
        method: 'POST',
        path: '/api/orders',
        token: admin.token,
        json: orderBody({
          customer_id: customerRecord.json.id,
          location_id: raleigh.id,
          delivery_method: method,
          email: 'nora@notify.example',
          service_ids: ids,
          line_items: services.map((service) => ({
            description: `${service.name} line`,
            quantity: '1',
            service_id: service.id,
          })),
        }),
      });
      assert(response.status === 201, `${method} order failed: ${response.text}`);
      return response.json;
    }

    async function move(workOrderId, department) {
      return request({
        method: 'POST',
        path: `/api/workorders/${workOrderId}/move`,
        token: admin.token,
        json: { department },
      });
    }

    const willCall = await place('Will Call', [large]);
    const willMove = await move(willCall.work_orders[0].id, 'Quality');
    assert(willMove.status === 200, willMove.text);
    assert(willMove.json.delivery_notice && willMove.json.delivery_notice.reason === 'not_accent_truck', JSON.stringify(willMove.json.delivery_notice));
    const willRow = await db.get(`SELECT delivery_notified_generation, delivery_email_sent_at FROM orders WHERE id = ?`, [willCall.order.id]);
    assert(willRow.delivery_notified_generation == null && !willRow.delivery_email_sent_at, 'Will Call must not send a delivery notice');

    const ups = await place('UPS', [large]);
    const upsMove = await move(ups.work_orders[0].id, 'Quality');
    assert(upsMove.status === 200, upsMove.text);
    assert(upsMove.json.delivery_notice && upsMove.json.delivery_notice.reason === 'not_accent_truck', JSON.stringify(upsMove.json.delivery_notice));

    const truck = await place('Accent Truck', [large, small]);
    const first = truck.work_orders[0];
    const second = truck.work_orders[1];
    const partial = await move(first.id, 'Quality');
    assert(partial.status === 200, partial.text);
    assert(partial.json.delivery_notice && partial.json.delivery_notice.reason === 'work_orders_not_ready', JSON.stringify(partial.json.delivery_notice));
    const partialRow = await db.get(`SELECT delivery_email_sent_at, delivery_notified_generation FROM orders WHERE id = ?`, [truck.order.id]);
    assert(!partialRow.delivery_email_sent_at && partialRow.delivery_notified_generation == null, 'one work order at Quality is not enough');

    const beforeSms = dryRuns(server.logs());
    const ready = await move(second.id, 'Quality');
    assert(ready.status === 200, ready.text);
    assert(ready.json.delivery_notice && ready.json.delivery_notice.email && ready.json.delivery_notice.email.status === 'sent', JSON.stringify(ready.json.delivery_notice));
    assert(ready.json.delivery_notice.sms.status === 'dry_run', JSON.stringify(ready.json.delivery_notice.sms));
    assertCustomerMail(ready.json.delivery_notice.email.preview, 'ready for delivery');
    const readyBlob = mailBlob(ready.json.delivery_notice.email.preview);
    assert(readyBlob.includes('ready for delivery'), readyBlob.slice(0, 300));
    assert(readyBlob.includes(truck.order_number), 'delivery mail should include the order number');
    assert(readyBlob.includes('Accent Truck'), 'delivery mail should include the delivery method');
    assert(readyBlob.includes('10 Dock Street'), 'delivery mail should include the ship-to address');
    const smsLogs = server.logs();
    assert(dryRuns(smsLogs) === beforeSms + 1, 'one dry-run text should be logged');
    assert(smsLogs.includes(STOP_LINE), 'the text should include the opt-out line');
    assert(/SMS dry-run:.*ready for delivery/.test(smsLogs), 'the dry-run text should say the order is ready for delivery');
    const readyRow = await db.get(
      `SELECT delivery_email_sent_at, delivery_sms_sent_at, delivery_notified_generation, delivery_ready_generation, status
       FROM orders WHERE id = ?`,
      [truck.order.id]
    );
    assert(readyRow.delivery_email_sent_at && readyRow.delivery_sms_sent_at, 'delivery counters should stamp both sends');
    assert(Number(readyRow.delivery_notified_generation) === Number(readyRow.delivery_ready_generation), 'the claimed generation should match');
    assert(readyRow.status !== 'Ready for Delivery', 'orders.status should stay the production status');

    const away = await move(second.id, 'Large Format');
    assert(away.status === 200, away.text);
    const back = await move(second.id, 'Quality');
    assert(back.status === 200, back.text);
    assert(back.json.delivery_notice && back.json.delivery_notice.reason === 'already_notified', JSON.stringify(back.json.delivery_notice));
    const still = await db.get(`SELECT delivery_email_sent_at, delivery_sms_sent_at FROM orders WHERE id = ?`, [truck.order.id]);
    assert(still.delivery_email_sent_at === readyRow.delivery_email_sent_at, 'a later return to Quality must not send again');
    assert(dryRuns(server.logs()) === beforeSms + 1, 'a later return to Quality must not text again');
    console.log('PASS Accent Truck delivery notice, send-once, and other methods');

    const scannedOrder = await place('Accent Truck', [large]);
    const scanTarget = scannedOrder.work_orders[0];
    const scanned = await request({
      method: 'POST',
      path: '/api/barcode',
      token: admin.token,
      json: { scanned_value: scanTarget.external_id, location: 'Quality' },
    });
    assert(scanned.status === 201 && scanned.json.department_moved === true, scanned.text);
    assert(scanned.json.delivery_notice && scanned.json.delivery_notice.email.status === 'sent', JSON.stringify(scanned.json.delivery_notice));
    assert(scanned.json.delivery_notice.sms.status === 'dry_run', 'an opted-in scan should dry-run the text');
    const scanAgain = await request({
      method: 'POST',
      path: '/api/barcode',
      token: admin.token,
      json: { scanned_value: scanTarget.external_id, location: 'Quality' },
    });
    assert(scanAgain.status === 201 && scanAgain.json.department_moved === false, scanAgain.text);
    assert(!scanAgain.json.delivery_notice, 'a scan that stays in Quality should not notify again');
    console.log('PASS barcode scan into Quality');

    await db.run(`UPDATE departments SET name = 'QC Hold' WHERE dept_key = 'quality'`);
    const renamed = await place('Accent Truck', [large]);
    const renamedMove = await move(renamed.work_orders[0].id, 'QC Hold');
    assert(renamedMove.status === 200, renamedMove.text);
    assert(renamedMove.json.department === 'QC Hold', renamedMove.text);
    assert(renamedMove.json.delivery_notice && renamedMove.json.delivery_notice.email.status === 'sent', `a renamed Quality department should still notify: ${JSON.stringify(renamedMove.json.delivery_notice)}`);
    await db.run(`UPDATE departments SET name = 'Quality' WHERE dept_key = 'quality'`);
    console.log('PASS Quality is identified by dept_key after a rename');

    const originals = await request({
      method: 'POST',
      path: '/api/orders',
      token: opted.token,
      json: orderBody({
        originals_source: 'Send a vehicle to pick up originals',
        delivery_method: 'Will Call',
        due_time: '11:00',
        location_id: raleigh.id,
        service_ids: [large.id],
        line_items: [{ description: 'Originals', quantity: '1', service_id: large.id }],
      }),
    });
    assert(originals.status === 201 && originals.json.order.originals_pickup === true, originals.text);
    assert(originals.json.pickup_request && originals.json.pickup_request.id, originals.text);
    assert(originals.json.pickup_request.email_status === 'sent', JSON.stringify(originals.json.pickup_request));
    assertCustomerMail(originals.json.pickup_request.preview, 'automatic pickup confirmation');
    assert(mailBlob(originals.json.pickup_request.preview).includes('pick up'), 'pickup mail should describe the pickup');
    const autoRow = await db.get(`SELECT status, source, location_id, customer_id FROM pickup_requests WHERE id = ?`, [originals.json.pickup_request.id]);
    assert(autoRow.status === 'new' && autoRow.source === 'order', JSON.stringify(autoRow));
    assert(Number(autoRow.customer_id) === Number(customerRecord.json.id), 'the automatic pickup belongs to the customer');
    assert(Number(autoRow.location_id) === Number(raleigh.id), 'the automatic pickup uses the order shop');

    const otherCustomer = await request({
      method: 'POST',
      path: '/api/auth/register',
      json: {
        company: 'Other Co',
        contact_name: 'Olivia Other',
        email: 'olivia@other.example',
        phone: '919-555-0181',
        password: customerPassword,
        password_confirm: customerPassword,
        address_line1: '9 Side Street',
        city: 'Hickory',
        state: 'NC',
        zip: '28601',
        location_id: hickory.id,
      },
    });
    assert(otherCustomer.status === 201, otherCustomer.text);

    const dispatchUser = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'dispatchral',
        display_name: 'Raleigh Dispatch',
        role: 'operator',
        department: 'Dispatch',
        location_id: raleigh.id,
        password: 'OperatorPass123',
        email: 'dispatch.raleigh@notify.example',
      },
    });
    assert(dispatchUser.status === 201, dispatchUser.text);
    const floorUser = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'floorraleigh',
        display_name: 'Raleigh Floor',
        role: 'operator',
        department: 'Large Format',
        location_id: raleigh.id,
        password: 'OperatorPass123',
        email: 'floor.raleigh@notify.example',
      },
    });
    assert(floorUser.status === 201, floorUser.text);
    const hickoryDispatch = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'dispatchhky',
        display_name: 'Hickory Dispatch',
        role: 'operator',
        department: 'Dispatch',
        location_id: hickory.id,
        password: 'OperatorPass123',
        email: 'dispatch.hickory@notify.example',
      },
    });
    assert(hickoryDispatch.status === 201, hickoryDispatch.text);
    const manager = await request({
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      json: {
        username: 'notifymgr',
        display_name: 'Notify Manager',
        role: 'manager',
        password: 'ManagerPass123',
        email: 'manager@notify.example',
      },
    });
    assert(manager.status === 201, manager.text);

    const dispatchLogin = await login('dispatchral', 'OperatorPass123');
    const floorLogin = await login('floorraleigh', 'OperatorPass123');
    const hickoryLogin = await login('dispatchhky', 'OperatorPass123');
    const managerLogin = await login('notifymgr', 'ManagerPass123');

    async function seesPickupNotice(token) {
      const response = await request({ method: 'GET', path: '/api/notifications?limit=50', token });
      assert(response.status === 200, response.text);
      return (response.json.notifications || []).some((item) => item.type === 'pickup_requested' && item.title.includes('Notify Co'));
    }
    assert(await seesPickupNotice(dispatchLogin.token), 'Raleigh Dispatch should see the pickup bell');
    assert(!(await seesPickupNotice(floorLogin.token)), 'a Large Format operator should not see the Dispatch bell');
    assert(!(await seesPickupNotice(hickoryLogin.token)), 'Hickory Dispatch should not see a Raleigh pickup');
    assert(await seesPickupNotice(managerLogin.token), 'a manager should see the pickup bell');
    assert(await seesPickupNotice(admin.token), 'an admin should see the pickup bell');
    assert(!(await seesPickupNotice(opted.token)), 'the customer should not see the staff bell');

    const customerList = await request({ method: 'GET', path: '/api/pickup-requests', token: opted.token });
    assert(customerList.status === 200, customerList.text);
    assert((customerList.json.pickup_requests || []).some((row) => row.id === originals.json.pickup_request.id), 'the customer should see their automatic pickup');
    const otherList = await request({ method: 'GET', path: '/api/pickup-requests', token: otherCustomer.json.token });
    assert(otherList.status === 200, otherList.text);
    assert(!(otherList.json.pickup_requests || []).some((row) => row.id === originals.json.pickup_request.id), 'another customer must not see the pickup');
    const otherGet = await request({
      method: 'GET',
      path: `/api/pickup-requests/${originals.json.pickup_request.id}`,
      token: otherCustomer.json.token,
    });
    assert(otherGet.status === 404, `another customer must not open the pickup: ${otherGet.status}`);
    const otherCancel = await request({
      method: 'PUT',
      path: `/api/pickup-requests/${originals.json.pickup_request.id}`,
      token: otherCustomer.json.token,
      json: { status: 'cancelled' },
    });
    assert(otherCancel.status === 404, 'another customer must not cancel the pickup');

    const raleighList = await request({ method: 'GET', path: '/api/pickup-requests', token: floorLogin.token });
    assert(raleighList.status === 200 && (raleighList.json.pickup_requests || []).some((row) => row.id === originals.json.pickup_request.id), 'a Raleigh operator should see the Raleigh pickup');
    const hickoryList = await request({ method: 'GET', path: '/api/pickup-requests', token: hickoryLogin.token });
    assert(hickoryList.status === 200 && !(hickoryList.json.pickup_requests || []).some((row) => row.id === originals.json.pickup_request.id), 'a Hickory operator must not see the Raleigh pickup');
    const managerList = await request({ method: 'GET', path: '/api/pickup-requests', token: managerLogin.token });
    assert(managerList.status === 200 && (managerList.json.pickup_requests || []).some((row) => row.id === originals.json.pickup_request.id), 'a manager should see every shop');

    const hickoryUpdate = await request({
      method: 'PUT',
      path: `/api/pickup-requests/${originals.json.pickup_request.id}`,
      token: hickoryLogin.token,
      json: { status: 'scheduled' },
    });
    assert(hickoryUpdate.status === 404, 'a Hickory operator must not update a Raleigh pickup');
    const schedule = await request({
      method: 'PUT',
      path: `/api/pickup-requests/${originals.json.pickup_request.id}`,
      token: dispatchLogin.token,
      json: { status: 'scheduled' },
    });
    assert(schedule.status === 200 && schedule.json.status === 'scheduled', schedule.text);
    const customerSchedule = await request({
      method: 'PUT',
      path: `/api/pickup-requests/${originals.json.pickup_request.id}`,
      token: opted.token,
      json: { status: 'picked_up' },
    });
    assert(customerSchedule.status === 403, 'a customer cannot mark a pickup picked up');

    const manual = await request({
      method: 'POST',
      path: '/api/pickup-requests',
      token: opted.token,
      json: {
        location_id: hickory.id,
        contact_name: 'Nora Notify',
        contact_phone: '919-555-0170',
        address_line1: '10 Dock Street',
        city: 'Raleigh',
        state: 'NC',
        zip: '27601',
        ready_date: weekdayAhead(),
        ready_time: '14:30',
        notes: 'Call from the parking lot.',
        order_id: confirmed.json.order.id,
      },
    });
    assert(manual.status === 201, manual.text);
    assert(manual.json.pickup_request.location_id === hickory.id, manual.text);
    assert(manual.json.pickup_request.order_number === confirmed.json.order_number, 'the related order number should be stored');
    assert(manual.json.email.status === 'sent', JSON.stringify(manual.json.email));
    assertCustomerMail(manual.json.email.preview, 'customer pickup confirmation');
    const hickorySees = await request({ method: 'GET', path: '/api/pickup-requests', token: hickoryLogin.token });
    assert((hickorySees.json.pickup_requests || []).some((row) => row.id === manual.json.pickup_request.id), 'Hickory staff should see the Hickory request');
    const raleighMisses = await request({ method: 'GET', path: '/api/pickup-requests', token: dispatchLogin.token });
    assert(!(raleighMisses.json.pickup_requests || []).some((row) => row.id === manual.json.pickup_request.id), 'Raleigh staff must not see the Hickory request');

    const cancel = await request({
      method: 'PUT',
      path: `/api/pickup-requests/${manual.json.pickup_request.id}`,
      token: opted.token,
      json: { status: 'cancelled' },
    });
    assert(cancel.status === 200 && cancel.json.status === 'cancelled', cancel.text);
    const picked = await request({
      method: 'PUT',
      path: `/api/pickup-requests/${originals.json.pickup_request.id}`,
      token: admin.token,
      json: { status: 'picked_up' },
    });
    assert(picked.status === 200 && picked.json.status === 'picked_up', picked.text);
    const lateCancel = await request({
      method: 'PUT',
      path: `/api/pickup-requests/${originals.json.pickup_request.id}`,
      token: opted.token,
      json: { status: 'cancelled' },
    });
    assert(lateCancel.status === 400, 'a picked-up request cannot be cancelled by the customer');
    const staffCreate = await request({
      method: 'POST',
      path: '/api/pickup-requests',
      token: admin.token,
      json: {
        contact_name: 'Staff',
        contact_phone: '919-555-0100',
        address_line1: '1 Shop Way',
        city: 'Raleigh',
        state: 'NC',
        zip: '27601',
        ready_date: weekdayAhead(),
      },
    });
    assert(staffCreate.status === 403, 'staff cannot file a customer pickup request');
    console.log('PASS originals pickups, ownership, and location scope');
  } finally {
    await db.close();
    await server.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
