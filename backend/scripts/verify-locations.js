/**
 * Shop locations: idempotent Raleigh backfill, operator isolation, and
 * customer location choice.
 * Usage (from backend/): node scripts/verify-locations.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-locations-'));
const dbFile = path.join(tmp, 'shop.db');
const port = 3132;
const adminPassword = 'AdminPass123';
const staffPassword = 'StaffPass123';
const customerPassword = 'CustomerPass123';

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

function baseEnv() {
  return {
    DATABASE_FILE: dbFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    DELIVERY_TIMEZONE: 'UTC',
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
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

function multipartPdf(name) {
  const boundary = '----lp-locations';
  const raw = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from('%PDF-1.4 location'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { raw, contentType: `multipart/form-data; boundary=${boundary}` };
}

function request({ method, path: requestPath, token, json, raw, contentType }) {
  return new Promise((resolve, reject) => {
    const body = raw || (json != null ? Buffer.from(JSON.stringify(json)) : null);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (raw) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = body.length;
    } else if (json != null) {
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
        resolve({ status: res.statusCode, json: parsed, text });
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

async function login(username, password) {
  const response = await request({
    method: 'POST',
    path: '/api/auth/login',
    json: { username, password },
  });
  assert(response.status === 200 && response.json && response.json.token, `login failed for ${username}: ${response.status} ${response.text}`);
  return response.json;
}

function weekdayAhead() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 3);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function orderBody(customerId, serviceId, locationId, company) {
  return fillOrderLines({
    customer_id: customerId,
    location_id: locationId,
    company,
    contact_name: 'Casey Customer',
    phone: '919-555-0199',
    email: 'casey@locations.example',
    project_name: `${company} job`,
    notes: 'Location check',
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

function notices(body, type) {
  return ((body && body.notifications) || []).filter((row) => row.type === type);
}

async function main() {
  fs.mkdirSync(path.join(tmp, 'uploads'), { recursive: true });
  const firstInit = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  assert(firstInit.code === 0, `init_db failed\n${firstInit.out}\n${firstInit.err}`);
  const seeded = openDb(dbFile);
  const before = await seeded.all(`SELECT id, name FROM locations ORDER BY sort_order, id`);
  assert(before.map((row) => row.name).join(',') === 'Raleigh,Hickory,Charlotte', `expected three shops, got ${before.map((row) => row.name).join(',')}`);
  const raleigh = before.find((row) => row.name === 'Raleigh');
  const admin = await seeded.get(`SELECT id, location_id FROM users WHERE username = 'admin'`);
  assert(admin.location_id == null, 'an existing admin keeps all-location access');
  const seededCustomer = await seeded.get(`SELECT location_id FROM users WHERE username = 'acme'`);
  assert(seededCustomer && Number(seededCustomer.location_id) === Number(raleigh.id), 'existing customers default to Raleigh');
  await seeded.run(`DELETE FROM system_settings WHERE key = 'shop_locations_backfilled'`);
  await seeded.run(
    `INSERT INTO users (username, password_hash, role, display_name, location_id)
     VALUES ('legacy-op', 'x', 'operator', 'Legacy Op', NULL)`
  );
  await seeded.run(
    `INSERT INTO users (username, password_hash, role, display_name, location_id)
     VALUES ('legacy-mgr', 'x', 'manager', 'Legacy Manager', NULL)`
  );
  await seeded.run(
    `INSERT INTO users (username, password_hash, role, display_name, location_id)
     VALUES ('legacy-admin', 'x', 'admin', 'Legacy Admin', NULL)`
  );
  await seeded.run(
    `INSERT INTO users (username, password_hash, role, display_name, location_id)
     VALUES ('legacy-cust', 'x', 'customer', 'Legacy Customer', NULL)`
  );
  await seeded.run(
    `INSERT INTO orders (
      order_number, customer_id, company, contact_name, phone, email, delivery_method,
      due_date, due_time, location_id
    ) VALUES ('LEGACY-1', ?, 'Legacy Co', 'Legacy', '919-555-0100', 'legacy@example.com', 'Will Call', '2026-11-02', '10:00', NULL)`,
    [admin.id]
  );
  await seeded.run(
    `INSERT INTO quote_requests (customer_id, project_name, status, location_id)
     VALUES (?, 'Legacy quote', 'New', NULL)`,
    [admin.id]
  );
  await seeded.run(
    `INSERT INTO work_orders (external_id, customer_id, description, department, location_id)
     VALUES ('LEGACY-WO', ?, 'Legacy job', 'Large Format', NULL)`,
    [admin.id]
  );
  await seeded.run(
    `INSERT INTO notifications (type, title, dedupe_key, location_id)
     VALUES ('order_created', 'Legacy notice', 'legacy-notice', NULL)`
  );
  await seeded.run(
    `INSERT INTO inbound_emails (graph_message_id, status, location_id)
     VALUES ('legacy-message', 'new', NULL)`
  );
  await seeded.close();

  const secondInit = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  assert(secondInit.code === 0, `second init_db failed\n${secondInit.out}\n${secondInit.err}`);
  assert(/Assigned existing records with no location to Raleigh/.test(secondInit.out), 'backfill should log the Raleigh assignment');
  const upgraded = openDb(dbFile);
  const shops = await upgraded.all(`SELECT name FROM locations ORDER BY sort_order, id`);
  assert(shops.length === 3, 'a second init must not duplicate shops');
  const legacyUser = await upgraded.get(`SELECT location_id FROM users WHERE username = 'legacy-op'`);
  const legacyCustomer = await upgraded.get(`SELECT location_id FROM users WHERE username = 'legacy-cust'`);
  const legacyManager = await upgraded.get(`SELECT location_id FROM users WHERE username = 'legacy-mgr'`);
  const legacyAdmin = await upgraded.get(`SELECT location_id FROM users WHERE username = 'legacy-admin'`);
  const legacyOrder = await upgraded.get(`SELECT location_id FROM orders WHERE order_number = 'LEGACY-1'`);
  const legacyQuote = await upgraded.get(`SELECT location_id FROM quote_requests WHERE project_name = 'Legacy quote'`);
  const legacyWork = await upgraded.get(`SELECT location_id FROM work_orders WHERE external_id = 'LEGACY-WO'`);
  const legacyNotice = await upgraded.get(`SELECT location_id FROM notifications WHERE dedupe_key = 'legacy-notice'`);
  const legacyMail = await upgraded.get(`SELECT location_id FROM inbound_emails WHERE graph_message_id = 'legacy-message'`);
  for (const row of [legacyUser, legacyCustomer, legacyOrder, legacyQuote, legacyWork, legacyNotice, legacyMail]) {
    assert(row && Number(row.location_id) === Number(raleigh.id), `legacy row should belong to Raleigh, got ${JSON.stringify(row)}`);
  }
  assert(legacyManager && legacyManager.location_id == null, 'an existing manager keeps all-location access');
  assert(legacyAdmin && legacyAdmin.location_id == null, 'an existing admin keeps all-location access');
  await upgraded.run(
    `INSERT INTO users (username, password_hash, role, display_name, location_id)
     VALUES ('all-shops', 'x', 'manager', 'All Shops', NULL)`
  );
  await upgraded.close();
  const thirdInit = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv());
  assert(thirdInit.code === 0, `third init_db failed\n${thirdInit.out}\n${thirdInit.err}`);
  assert(!/Assigned existing records with no location to Raleigh/.test(thirdInit.out), 'backfill must run only once');
  const kept = openDb(dbFile);
  const allShops = await kept.get(`SELECT location_id FROM users WHERE username = 'all-shops'`);
  assert(allShops && allShops.location_id == null, 'a later init must leave an all-location manager unset');
  await kept.close();

  const server = startServer();
  const db = openDb(dbFile);
  try {
    await server.ready;
    const adminLogin = await login('admin', adminPassword);
    assert(adminLogin.user.all_locations === true, 'admin sees every location');
    const config = await request({ method: 'GET', path: '/api/auth/config' });
    assert(config.status === 200 && (config.json.locations || []).length === 3, config.text);
    const listed = await request({ method: 'GET', path: '/api/locations?all=1', token: adminLogin.token });
    assert(listed.status === 200, listed.text);
    const byName = Object.fromEntries((listed.json.locations || []).map((row) => [row.name, row]));
    assert(byName.Raleigh && byName.Hickory && byName.Charlotte, 'settings list should include the three shops');
    assert(String(byName.Raleigh.address).includes('Brownleigh'), 'Raleigh address should be seeded');
    assert(byName.Hickory.phone === '828-322-5050', 'Hickory phone should be seeded');

    async function makeUser(username, role, locationId) {
      const response = await request({
        method: 'POST',
        path: '/api/users',
        token: adminLogin.token,
        json: {
          username,
          display_name: username,
          role,
          password: role === 'customer' ? customerPassword : staffPassword,
          email: `${username}@locations.example`,
          location_id: locationId,
        },
      });
      assert(response.status === 201, `${username} create failed: ${response.text}`);
      return response.json;
    }

    const hickoryOp = await makeUser('hickory-op', 'operator', byName.Hickory.id);
    const raleighOp = await makeUser('raleigh-op', 'operator', byName.Raleigh.id);
    const hickoryMgr = await makeUser('hickory-mgr', 'manager', byName.Hickory.id);
    const raleighMgr = await makeUser('raleigh-mgr', 'manager', byName.Raleigh.id);
    const allMgr = await makeUser('all-mgr', 'manager', null);
    const customer = await makeUser('casey', 'customer', byName.Hickory.id);
    assert(hickoryOp.location_id === byName.Hickory.id, 'operator home location should be stored');
    assert(allMgr.all_locations === true && allMgr.location_id == null, 'omitted manager location means every shop');

    const hickoryLogin = await login('hickory-op', staffPassword);
    const raleighLogin = await login('raleigh-op', staffPassword);
    const hickoryManager = await login('hickory-mgr', staffPassword);
    const raleighManager = await login('raleigh-mgr', staffPassword);
    const allManager = await login('all-mgr', staffPassword);
    const customerLogin = await login('casey', customerPassword);
    assert(hickoryLogin.user.all_locations === false && hickoryLogin.user.location_name === 'Hickory', JSON.stringify(hickoryLogin.user));
    assert(allManager.user.all_locations === true, 'all-location manager flag');
    assert(customerLogin.user.location_id === byName.Hickory.id, 'customer default location');

    const options = await request({ method: 'GET', path: '/api/orders/options', token: customerLogin.token });
    assert(options.status === 200 && (options.json.locations || []).length >= 3, options.text);
    const service = (options.json.services || [])[0];
    assert(service && service.id, 'an active service is required');
    setServiceNames(options.json.services);

    const charlotteOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerLogin.token,
      json: orderBody(customer.id, service.id, byName.Charlotte.id, 'Charlotte Co'),
    });
    assert(charlotteOrder.status === 201, charlotteOrder.text);
    assert(charlotteOrder.json.order.location_id === byName.Charlotte.id, `order should be Charlotte: ${charlotteOrder.text}`);
    assert(charlotteOrder.json.order.location_name === 'Charlotte', charlotteOrder.text);
    const charlotteWorkId = charlotteOrder.json.work_orders[0].id;

    const hickoryOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: adminLogin.token,
      json: orderBody(customer.id, service.id, byName.Hickory.id, 'Hickory Co'),
    });
    assert(hickoryOrder.status === 201 && hickoryOrder.json.order.location_name === 'Hickory', hickoryOrder.text);
    const hickoryWorkId = hickoryOrder.json.work_orders[0].id;

    const quote = await request({
      method: 'POST',
      path: '/api/quote-requests',
      token: customerLogin.token,
      json: {
        project_name: 'Charlotte banner',
        description: 'Banner',
        quantity: '1',
        needed_by: weekdayAhead(),
        location_id: byName.Charlotte.id,
      },
    });
    assert(quote.status === 201 && quote.json.quote.location_id === byName.Charlotte.id, quote.text);
    const me = await request({ method: 'GET', path: '/api/auth/me', token: customerLogin.token });
    assert(me.json.user && me.json.user.location_id === byName.Hickory.id, 'choosing Charlotte for one order leaves the Hickory default in place');

    const defaultedBody = orderBody(customer.id, service.id, byName.Hickory.id, 'Default Co');
    delete defaultedBody.location_id;
    const defaultedOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: customerLogin.token,
      json: defaultedBody,
    });
    assert(defaultedOrder.status === 201, defaultedOrder.text);
    assert(defaultedOrder.json.order.location_id === byName.Hickory.id, 'an order with no location uses the customer default');

    const customerUpload = await request({
      method: 'POST',
      path: '/api/uploads',
      token: customerLogin.token,
      ...multipartPdf('customer-plan.pdf'),
    });
    assert(customerUpload.status === 201, customerUpload.text);
    const customerFileId = customerUpload.json.files[0].id;
    const operatorUpload = await request({
      method: 'POST',
      path: '/api/uploads',
      token: hickoryLogin.token,
      ...multipartPdf('operator-plan.pdf'),
    });
    assert(operatorUpload.status === 201, operatorUpload.text);
    const operatorFileId = operatorUpload.json.files[0].id;
    const managerUpload = await request({
      method: 'POST',
      path: '/api/uploads',
      token: hickoryManager.token,
      ...multipartPdf('manager-plan.pdf'),
    });
    assert(managerUpload.status === 201, managerUpload.text);
    const managerFileId = managerUpload.json.files[0].id;

    async function downloadStatus(fileId, token) {
      const response = await request({ method: 'GET', path: `/api/uploads/${fileId}/download`, token });
      return response.status;
    }
    assert(await downloadStatus(customerFileId, customerLogin.token) === 200, 'the owning customer can download an unattached file');
    assert(await downloadStatus(customerFileId, hickoryLogin.token) === 404, 'an operator cannot download an unattached file');
    assert(await downloadStatus(operatorFileId, hickoryLogin.token) === 404, 'an operator cannot download a file they uploaded');
    assert(await downloadStatus(customerFileId, hickoryManager.token) === 200, 'the customer home-shop manager can download the file');
    assert(await downloadStatus(customerFileId, raleighManager.token) === 404, 'another shop manager cannot download the file');
    assert(await downloadStatus(operatorFileId, hickoryManager.token) === 200, 'the uploader home-shop manager can download an operator file');
    assert(await downloadStatus(operatorFileId, raleighManager.token) === 404, 'another shop manager cannot download an operator file');
    assert(await downloadStatus(managerFileId, hickoryManager.token) === 200, 'the uploading manager can download their own file');
    assert(await downloadStatus(managerFileId, adminLogin.token) === 200, 'an admin can download an unattached file');
    const operatorDelete = await request({ method: 'DELETE', path: `/api/uploads/${customerFileId}`, token: hickoryLogin.token });
    assert(operatorDelete.status === 404, 'an operator cannot delete an unattached file');
    const ownOperatorDelete = await request({ method: 'DELETE', path: `/api/uploads/${operatorFileId}`, token: hickoryLogin.token });
    assert(ownOperatorDelete.status === 404, 'an operator cannot delete a file they uploaded');
    const managerDelete = await request({ method: 'DELETE', path: `/api/uploads/${operatorFileId}`, token: hickoryManager.token });
    assert(managerDelete.status === 200, 'the home-shop manager can delete the operator file');
    const customerDelete = await request({ method: 'DELETE', path: `/api/uploads/${customerFileId}`, token: customerLogin.token });
    assert(customerDelete.status === 200, 'the owning customer can delete an unattached file');

    await db.run(`UPDATE work_orders SET location_id = NULL WHERE id = ?`, [charlotteWorkId]);
    await db.run(
      `INSERT INTO production_board (work_order_id, lane, position, status) VALUES (?, 'print', 1, 'queued')`,
      [hickoryWorkId]
    );
    await db.run(
      `INSERT INTO production_board (work_order_id, lane, position, status) VALUES (?, 'print', 2, 'queued')`,
      [charlotteWorkId]
    );
    await db.run(
      `INSERT INTO deliveries (work_order_id, order_id, status, due_time) VALUES (?, ?, 'pending', '2026-11-02 10:00')`,
      [hickoryWorkId, hickoryOrder.json.order.id]
    );
    await db.run(
      `INSERT INTO deliveries (work_order_id, order_id, status, due_time) VALUES (?, ?, 'pending', '2026-11-02 11:00')`,
      [charlotteWorkId, charlotteOrder.json.order.id]
    );
    const hickoryDash = await request({ method: 'GET', path: '/api/dashboard', token: hickoryLogin.token });
    const hickoryManagerDash = await request({ method: 'GET', path: '/api/dashboard', token: hickoryManager.token });
    const raleighDash = await request({ method: 'GET', path: '/api/dashboard', token: raleighManager.token });
    const adminDash = await request({ method: 'GET', path: '/api/dashboard', token: adminLogin.token });
    assert(hickoryDash.status === 200, hickoryDash.text);
    const hickoryWorkCount = await db.get(
      `SELECT COUNT(*) AS count
       FROM work_orders wo
       LEFT JOIN orders o ON o.id = wo.order_id
       WHERE COALESCE(wo.location_id, o.location_id) = ?`,
      [byName.Hickory.id]
    );
    assert(hickoryDash.json.totalWorkOrders === hickoryWorkCount.count, 'operator dashboard counts only the home shop');
    assert(hickoryManagerDash.json.totalWorkOrders === hickoryDash.json.totalWorkOrders, 'a single-location manager matches the operator count');
    assert(hickoryDash.json.activeWorkOrders === hickoryDash.json.totalWorkOrders, 'the Hickory jobs are active');
    const hickoryBoardCount = await db.get(
      `SELECT COUNT(*) AS count
       FROM production_board pb
       LEFT JOIN work_orders wo ON wo.id = pb.work_order_id
       LEFT JOIN orders o ON o.id = wo.order_id
       WHERE COALESCE(wo.location_id, o.location_id) = ?`,
      [byName.Hickory.id]
    );
    const hickoryDeliveryCount = await db.get(
      `SELECT COUNT(*) AS count
       FROM deliveries d
       LEFT JOIN work_orders wo ON wo.id = d.work_order_id
       LEFT JOIN orders o ON o.id = COALESCE(d.order_id, wo.order_id)
       WHERE lower(d.status) != 'complete'
         AND COALESCE(wo.location_id, o.location_id) = ?`,
      [byName.Hickory.id]
    );
    const allDeliveryCount = await db.get(
      `SELECT COUNT(*) AS count FROM deliveries d WHERE lower(d.status) != 'complete'`
    );
    assert(hickoryDash.json.productionBoardItems === hickoryBoardCount.count, 'production board count stays on the home shop');
    assert(hickoryBoardCount.count >= 1 && hickoryBoardCount.count < adminDash.json.productionBoardItems, 'Charlotte board rows stay off the Hickory dashboard');
    assert(hickoryDash.json.pendingDeliveries === hickoryDeliveryCount.count, 'pending deliveries stay on the home shop');
    assert(hickoryDeliveryCount.count < allDeliveryCount.count, 'another shop delivery is left out of the Hickory count');
    assert(adminDash.json.totalWorkOrders > hickoryDash.json.totalWorkOrders, 'an admin dashboard includes every shop');
    assert(raleighDash.json.totalWorkOrders < adminDash.json.totalWorkOrders, 'a Raleigh manager does not count Hickory or Charlotte');
    assert(
      !(hickoryDash.json.departmentSummary || []).some((row) => row.count > hickoryWorkCount.count),
      'department counts cannot exceed the home shop'
    );
    const hickoryStatus = await request({ method: 'GET', path: '/api/reports/work-orders/status', token: hickoryLogin.token });
    const adminStatus = await request({ method: 'GET', path: '/api/reports/work-orders/status', token: adminLogin.token });
    assert(hickoryStatus.status === 200 && hickoryStatus.json.total === hickoryWorkCount.count, hickoryStatus.text);
    assert(adminStatus.json.total > hickoryStatus.json.total, 'the status report keeps Charlotte work whose shop is stored on the order');
    const hickoryDepartments = await request({ method: 'GET', path: '/api/reports/work-orders/department', token: hickoryManager.token });
    assert(hickoryDepartments.status === 200 && hickoryDepartments.json.total === hickoryWorkCount.count, hickoryDepartments.text);

    const sheet = await db.get(
      `SELECT customer_id, description, quantity, status, department, priority, external_id
       FROM work_orders WHERE id = ?`,
      [charlotteWorkId]
    );
    const hiddenUpdate = await request({
      method: 'PUT',
      path: `/api/workorders/${charlotteWorkId}`,
      token: hickoryLogin.token,
      json: sheet,
    });
    assert(hiddenUpdate.status === 404, `Hickory operator must not edit a Charlotte work order stored on the order: ${hiddenUpdate.status} ${hiddenUpdate.text}`);
    const allowedUpdate = await request({
      method: 'PUT',
      path: `/api/workorders/${charlotteWorkId}`,
      token: adminLogin.token,
      json: sheet,
    });
    assert(allowedUpdate.status === 200, allowedUpdate.text);

    await db.run(
      `INSERT INTO notifications (type, title, dedupe_key, location_id, work_order_id)
       VALUES ('work_order_rush', 'Hickory rush', 'rush-hickory', ?, ?)`,
      [byName.Hickory.id, hickoryWorkId]
    );
    await db.run(
      `INSERT INTO notifications (type, title, dedupe_key, location_id, work_order_id)
       VALUES ('work_order_rush', 'Charlotte rush', 'rush-charlotte', ?, ?)`,
      [byName.Charlotte.id, charlotteWorkId]
    );
    const marked = await request({ method: 'POST', path: '/api/notifications/read-all', token: hickoryLogin.token });
    assert(marked.status === 200, marked.text);
    const rushH = await db.get(`SELECT id FROM notifications WHERE dedupe_key = 'rush-hickory'`);
    const rushC = await db.get(`SELECT id FROM notifications WHERE dedupe_key = 'rush-charlotte'`);
    const hickoryOrderNote = await db.get(
      `SELECT id FROM notifications WHERE type = 'order_created' AND order_id = ?`,
      [hickoryOrder.json.order.id]
    );
    const operatorReadRush = await db.get(
      `SELECT user_id FROM notification_reads WHERE notification_id = ? AND user_id = ?`,
      [rushH.id, hickoryOp.id]
    );
    const operatorReadOther = await db.get(
      `SELECT user_id FROM notification_reads WHERE notification_id = ? AND user_id = ?`,
      [rushC.id, hickoryOp.id]
    );
    const operatorReadOrder = await db.get(
      `SELECT user_id FROM notification_reads WHERE notification_id = ? AND user_id = ?`,
      [hickoryOrderNote.id, hickoryOp.id]
    );
    assert(operatorReadRush, 'mark all read includes the operator home shop');
    assert(!operatorReadOther, 'mark all read skips another shop');
    assert(!operatorReadOrder, 'mark all read still skips manager-only notices');
    const managerMarked = await request({ method: 'POST', path: '/api/notifications/read-all', token: hickoryManager.token });
    assert(managerMarked.status === 200, managerMarked.text);
    const managerReadHome = await db.get(
      `SELECT user_id FROM notification_reads WHERE notification_id = ? AND user_id = ?`,
      [hickoryOrderNote.id, hickoryMgr.id]
    );
    const charlotteOrderNote = await db.get(
      `SELECT id FROM notifications WHERE type = 'order_created' AND order_id = ?`,
      [charlotteOrder.json.order.id]
    );
    const managerReadAway = await db.get(
      `SELECT user_id FROM notification_reads WHERE notification_id = ? AND user_id = ?`,
      [charlotteOrderNote.id, hickoryMgr.id]
    );
    assert(managerReadHome, 'a shop manager marks that shop order notice read');
    assert(!managerReadAway, 'a shop manager does not mark another shop notice read');

    const profile = await request({
      method: 'PUT',
      path: '/api/auth/profile',
      token: customerLogin.token,
      json: { location_id: byName.Charlotte.id },
    });
    assert(profile.status === 200 && profile.json.location_id === byName.Charlotte.id, profile.text);
    const afterProfile = await request({ method: 'GET', path: '/api/auth/me', token: customerLogin.token });
    assert(afterProfile.json.user && afterProfile.json.user.location_id === byName.Charlotte.id, 'a customer can change their default location');

    const hiddenOrder = await request({
      method: 'GET',
      path: `/api/orders/${charlotteOrder.json.order.id}`,
      token: hickoryLogin.token,
    });
    assert(hiddenOrder.status === 404, `hickory operator must not open a Charlotte order: ${hiddenOrder.status} ${hiddenOrder.text}`);
    const hiddenWork = await request({
      method: 'GET',
      path: `/api/workorders/${charlotteWorkId}`,
      token: hickoryLogin.token,
    });
    assert(hiddenWork.status === 404, `hickory operator must not open a Charlotte work order: ${hiddenWork.status}`);
    const hiddenPrint = await request({
      method: 'GET',
      path: `/api/workorders/${charlotteWorkId}/print`,
      token: hickoryLogin.token,
    });
    assert(hiddenPrint.status === 404, `hickory operator must not print a Charlotte work order: ${hiddenPrint.status}`);
    const widened = await request({
      method: 'GET',
      path: `/api/admin-board/work-orders?location_id=${byName.Charlotte.id}&limit=100`,
      token: hickoryLogin.token,
    });
    assert(widened.status === 200, widened.text);
    assert(
      (widened.json.work_orders || []).every((row) => row.location_name === 'Hickory' || row.location_id === byName.Hickory.id),
      `operator query must stay on Hickory: ${JSON.stringify(widened.json.work_orders)}`
    );
    const hickoryBoard = await request({ method: 'GET', path: '/api/admin-board', token: hickoryLogin.token });
    assert(hickoryBoard.status === 200 && hickoryBoard.json.viewer.location_name === 'Hickory', hickoryBoard.text);
    assert(hickoryBoard.json.viewer.can_pick_location === false, 'operators cannot pick another shop');
    const ownWork = await request({
      method: 'GET',
      path: `/api/workorders/${hickoryWorkId}`,
      token: hickoryLogin.token,
    });
    assert(ownWork.status === 200 && ownWork.json.location_name === 'Hickory', ownWork.text);

    const search = await request({
      method: 'GET',
      path: '/api/search/orders?limit=50',
      token: hickoryLogin.token,
    });
    assert(search.status === 200, search.text);
    assert(
      (search.json.orders || []).every((row) => row.location_name === 'Hickory'),
      `search leaked another shop: ${JSON.stringify(search.json.orders)}`
    );
    const managerHidden = await request({
      method: 'GET',
      path: `/api/orders/${charlotteOrder.json.order.id}`,
      token: hickoryManager.token,
    });
    assert(managerHidden.status === 404, 'a Hickory manager must not open a Charlotte order');
    const allSee = await request({
      method: 'GET',
      path: `/api/orders/${charlotteOrder.json.order.id}`,
      token: allManager.token,
    });
    assert(allSee.status === 200 && allSee.json.order.location_name === 'Charlotte', allSee.text);
    const adminBoard = await request({ method: 'GET', path: '/api/admin-board?location_id=all', token: adminLogin.token });
    assert(adminBoard.status === 200 && adminBoard.json.viewer.can_pick_location === true, adminBoard.text);
    const summaryNames = (adminBoard.json.location_summary || []).map((row) => row.name);
    assert(summaryNames.join(',') === 'Raleigh,Hickory,Charlotte', `all-locations summary missing shops: ${summaryNames.join(',')}`);

    const quoteListOther = await request({
      method: 'GET',
      path: '/api/quote-requests?status=New',
      token: raleighManager.token,
    });
    assert(quoteListOther.status === 200, quoteListOther.text);
    assert(
      !(quoteListOther.json.quotes || []).some((row) => row.project_name === 'Charlotte banner'),
      'Raleigh manager must not see the Charlotte quote'
    );
    const quoteListHome = await request({
      method: 'GET',
      path: '/api/quote-requests?status=New',
      token: allManager.token,
    });
    assert((quoteListHome.json.quotes || []).some((row) => row.project_name === 'Charlotte banner'), 'all-location manager sees the quote');

    async function hasNotice(token, type, titlePart) {
      const response = await request({ method: 'GET', path: '/api/notifications?limit=50', token });
      assert(response.status === 200, response.text);
      return notices(response.json, type).some((row) => !titlePart || String(row.title || '').includes(titlePart) || String(row.body || '').includes(titlePart));
    }
    assert(await hasNotice(hickoryManager.token, 'order_created', 'Hickory Co'), 'Hickory manager should hear about the Hickory order');
    assert(!(await hasNotice(raleighManager.token, 'order_created', 'Hickory Co')), 'Raleigh manager should not hear about the Hickory order');
    assert(await hasNotice(allManager.token, 'order_created', 'Hickory Co'), 'all-location manager should hear about the Hickory order');
    assert(await hasNotice(adminLogin.token, 'order_created', 'Hickory Co'), 'admin should hear about the Hickory order');
    assert(!(await hasNotice(hickoryLogin.token, 'order_created')), 'operators do not receive new-order notices');
    assert(await hasNotice(allManager.token, 'quote_requested', 'Charlotte'), 'all-location manager should hear about the Charlotte quote');
    assert(!(await hasNotice(hickoryManager.token, 'quote_requested', 'Charlotte')), 'Hickory manager should not hear about the Charlotte quote');

    const moved = await request({
      method: 'POST',
      path: `/api/orders/${hickoryOrder.json.order.id}/location`,
      token: raleighManager.token,
      json: { location_id: byName.Charlotte.id },
    });
    assert(moved.status === 404, 'Raleigh manager cannot transfer an order they cannot see');
    await db.run(
      `INSERT INTO notifications (type, title, dedupe_key, order_id, location_id)
       VALUES ('files_shared', 'Move with order', 'xfer-order', ?, ?)`,
      [hickoryOrder.json.order.id, byName.Hickory.id]
    );
    await db.run(
      `INSERT INTO notifications (type, title, dedupe_key, work_order_id, location_id)
       VALUES ('files_shared', 'Move with work order', 'xfer-work', ?, ?)`,
      [hickoryWorkId, byName.Hickory.id]
    );
    await db.run(
      `INSERT INTO inbound_emails (graph_message_id, status, order_id, location_id)
       VALUES ('xfer-mail', 'converted', ?, ?)`,
      [hickoryOrder.json.order.id, byName.Hickory.id]
    );
    await db.run(
      `INSERT INTO quote_requests (customer_id, project_name, status, location_id, converted_order_id)
       VALUES (?, 'Moved quote', 'Accepted', ?, ?)`,
      [customer.id, byName.Hickory.id, hickoryOrder.json.order.id]
    );
    const transfer = await request({
      method: 'POST',
      path: `/api/orders/${hickoryOrder.json.order.id}/location`,
      token: hickoryManager.token,
      json: { location_id: byName.Charlotte.id },
    });
    assert(transfer.status === 200 && transfer.json.transferred === true && transfer.json.location_name === 'Charlotte', transfer.text);
    const movedOrderNote = await db.get(`SELECT location_id FROM notifications WHERE dedupe_key = 'xfer-order'`);
    const movedWorkNote = await db.get(`SELECT location_id FROM notifications WHERE dedupe_key = 'xfer-work'`);
    const movedMail = await db.get(`SELECT location_id FROM inbound_emails WHERE graph_message_id = 'xfer-mail'`);
    const movedQuote = await db.get(`SELECT location_id FROM quote_requests WHERE project_name = 'Moved quote'`);
    const movedWork = await db.get(`SELECT location_id FROM work_orders WHERE id = ?`, [hickoryWorkId]);
    for (const row of [movedOrderNote, movedWorkNote, movedMail, movedQuote, movedWork]) {
      assert(row && Number(row.location_id) === Number(byName.Charlotte.id), `transfer should move related rows, got ${JSON.stringify(row)}`);
    }
    const lost = await request({
      method: 'GET',
      path: `/api/orders/${hickoryOrder.json.order.id}`,
      token: hickoryLogin.token,
    });
    assert(lost.status === 404, 'Hickory operator loses the order after transfer');
    const gained = await request({
      method: 'GET',
      path: `/api/workorders/${hickoryWorkId}`,
      token: raleighLogin.token,
    });
    assert(gained.status === 404, 'Raleigh operator still cannot see a Charlotte work order');
    const charlottePrint = await request({
      method: 'GET',
      path: `/api/workorders/${charlotteWorkId}/print`,
      token: adminLogin.token,
    });
    assert(charlottePrint.status === 200, charlottePrint.text);
    assert(charlottePrint.json.location && charlottePrint.json.location.name === 'Charlotte', JSON.stringify(charlottePrint.json.location));
    assert((charlottePrint.json.location.address_lines || []).some((line) => /Blairhill/.test(line)), JSON.stringify(charlottePrint.json.location));
    assert(charlottePrint.json.location.phone === '980-237-6922', JSON.stringify(charlottePrint.json.location));
    assert(charlottePrint.json.shop.location_name === 'Charlotte', JSON.stringify(charlottePrint.json.shop));
    const activity = await db.get(
      `SELECT detail FROM activity_log WHERE action = 'order.transferred' AND entity_id = ?`,
      [hickoryOrder.json.order.id]
    );
    assert(activity && /Charlotte/.test(activity.detail), 'transfer should be written to activity');

    const forbidden = await request({
      method: 'POST',
      path: '/api/orders',
      token: hickoryLogin.token,
      json: orderBody(customer.id, service.id, byName.Raleigh.id, 'Wrong shop'),
    });
    assert(forbidden.status === 403, `operator must not place work at another shop: ${forbidden.status} ${forbidden.text}`);
  } finally {
    await server.stop();
    await db.close();
  }
  console.log('Location checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
