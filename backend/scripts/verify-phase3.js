/**
 * Phase 3 checks: printable work order payload, customer isolation, and Code 128 scan round trip.
 * Usage (from backend/): node scripts/verify-phase3.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const { code128Svg } = require('../barcodeSvg');
const { decodeCode128Svg } = require('../code128');

const { fillOrderLines, setServiceNames } = require('./orderLineDefaults');
const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase3-'));
const freshDb = path.join(tmp, 'fresh.db');
const uploadDir = path.join(tmp, 'uploads');
const port = 3117;
const adminPassword = 'AdminPass123';

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

function baseEnv(databaseFile) {
  return {
    DATABASE_FILE: databaseFile,
    INIT_ADMIN_PASSWORD: adminPassword,
    DELIVERY_TIMEZONE: 'UTC',
    DELIVERY_WINDOW_START: '09:00',
    DELIVERY_WINDOW_END: '14:00',
    DELIVERY_SLOT_MINUTES: '15',
    PORT: String(port),
    NODE_ENV: 'test',
    UPLOAD_DIR: uploadDir,
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
  };
}

function utcDate(offsetDays = 0) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dueDate() {
  const today = utcDate(0);
  const day = today.getUTCDay();
  if (day !== 0 && day !== 6) return isoDate(today);
  for (let offset = 1; offset <= 7; offset += 1) {
    const date = utcDate(offset);
    if (date.getUTCDay() === 1) return isoDate(date);
  }
  throw new Error('no weekday found');
}

function request({ method, path: requestPath, token, json, raw, contentType }) {
  return new Promise((resolve, reject) => {
    const body = json != null ? Buffer.from(JSON.stringify(json)) : raw;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json != null) headers['Content-Type'] = 'application/json';
    if (contentType) headers['Content-Type'] = contentType;
    if (body) headers['Content-Length'] = body.length;
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

function multipartBody(files) {
  const boundary = `----Launchpad${Date.now()}`;
  const parts = [];
  for (const file of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
    ));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    raw: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function orderBody(overrides = {}) {
  return fillOrderLines({
    company: 'Acme Construction',
    contact_name: 'John Smith',
    phone: '919-555-1234',
    email: 'jsmith@acmeconstruction.com',
    po_number: 'PO-5521',
    project_number: '20045',
    project_name: 'New City Center',
    notes: 'Please deliver to loading dock.',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '1234 Builder Way',
    address_line2: 'Suite 200',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Accent Truck',
    ship_to: 'Acme Construction\n1234 Builder Way\nRaleigh, NC 27601',
    attention: 'Receiving Dock',
    due_date: dueDate(),
    due_time: '09:15',
    service_ids: [],
    line_items: [{ description: 'Default line', quantity: '1' }],
    ...overrides,
  });
}

function decodePrinted(svg, expected) {
  let decoded = '';
  try {
    decoded = decodeCode128Svg(svg);
  } catch (err) {
    assert(false, `could not decode Code 128 for ${expected}: ${err.message}`);
  }
  assert(decoded === expected, `decoded barcode ${decoded} did not match ${expected}`);
  return decoded;
}

async function initDatabase(databaseFile) {
  const result = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv(databaseFile));
  if (result.code !== 0) {
    throw new Error(`init_db failed (${result.code})\n${result.out}\n${result.err}`);
  }
  return result;
}

async function initFreshTwice() {
  await initDatabase(freshDb);
  const second = await initDatabase(freshDb);
  assert(/Admin user already exists/.test(second.out), 'second init should keep the existing admin');
  assert(!/Generated admin password/.test(second.out), 'second init should not print a new admin password');
  const db = openDb(freshDb);
  const services = await db.get('SELECT COUNT(*) AS count FROM services');
  assert(services.count === 7, 'fresh init twice should leave 7 services');
  const fieldCount = await db.get('SELECT COUNT(*) AS count FROM service_fields');
  assert(fieldCount.count === 58, `fresh init twice should leave 58 service fields, found ${fieldCount.count}`);
  const orderColumns = await db.all(`PRAGMA table_info(orders)`);
  const orderNames = new Set(orderColumns.map((row) => row.name));
  assert(orderNames.has('payment_method') && orderNames.has('bill_to_name'), 'fresh orders should include payment and bill-to columns');
  await db.close();
  console.log('PASS fresh init_db twice');
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...baseEnv(freshDb) },
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

function assertNoSecrets(text, secrets) {
  for (const secret of secrets) {
    assert(secret && !text.includes(secret), 'print payload leaked a sensitive value');
  }
  assert(!text.includes('password_hash'), 'print payload should not name password hashes');
  assert(!text.includes('stored_name'), 'print payload should not name stored filenames');
  assert(!text.includes('approval_by'), 'print payload should not include approval actors');
}

function assertCustomerHistory(rows) {
  assert(rows.length >= 1, 'customer print should include production history');
  for (const row of rows) {
    assert(!Object.prototype.hasOwnProperty.call(row, 'scanned_by'), 'customer history should omit scanned_by');
    assert(!Object.prototype.hasOwnProperty.call(row, 'notes'), 'customer history should omit staff notes');
    assert(!Object.prototype.hasOwnProperty.call(row, 'user_id'), 'customer history should omit user ids');
    assert(row.department && row.status && row.event_time, 'customer history should keep department, status, and time');
  }
}

async function runApiChecks() {
  const server = startServer();
  await server.ready;
  console.log('PASS backend startup');
  const db = openDb(freshDb);
  try {
    const unauthWorkOrder = await request({ method: 'GET', path: '/api/workorders/1/print' });
    const unauthOrder = await request({ method: 'GET', path: '/api/orders/1/print' });
    assert(unauthWorkOrder.status === 401, `unsigned work order print should be 401, got ${unauthWorkOrder.status}`);
    assert(unauthOrder.status === 401, `unsigned order print should be 401, got ${unauthOrder.status}`);

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
      },
    });
    assert(otherResponse.status === 201, `second customer create failed: ${otherResponse.text}`);
    const operatorHash = await bcrypt.hash('OperatorPass1', 10);
    await db.run(
      `INSERT INTO users (username, password_hash, role, display_name) VALUES ('op1', ?, 'operator', 'Operator One')`,
      [operatorHash]
    );

    const customer = await login('jsmith', 'CustomerPass1');
    const other = await login('otherco', 'OtherPass123');
    const operator = await login('op1', 'OperatorPass1');
    const passwordRow = await db.get('SELECT password_hash FROM users WHERE username = ?', ['jsmith']);

    const badWorkOrder = await request({ method: 'GET', path: '/api/workorders/abc/print', token: customer.token });
    const badOrder = await request({ method: 'GET', path: '/api/orders/0/print', token: customer.token });
    assert(badWorkOrder.status === 400, `invalid work order id should be 400, got ${badWorkOrder.status}`);
    assert(badOrder.status === 400, `invalid order id should be 400, got ${badOrder.status}`);

    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    assert(options.status === 200, 'order options should load');
    const byName = Object.fromEntries(options.json.services.map((service) => [service.name, service]));
    setServiceNames(byName);
    const upload = await request({
      method: 'POST',
      path: '/api/uploads',
      token: customer.token,
      ...multipartBody([{ name: 'Civil Plans.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 plans') }]),
    });
    assert(upload.status === 201, `upload failed: ${upload.status} ${upload.text}`);
    const fileId = upload.json.files[0].id;
    const stored = await db.get('SELECT stored_name FROM order_files WHERE id = ?', [fileId]);

    const created = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody({
        service_ids: [byName['Large Format'].id, byName['Small Format'].id, byName['Signs & Graphics'].id],
        line_items: [
          {
            description: 'Civil Plans',
            size: '24x36',
            quantity: '5 Sets',
            media: 'Bond',
            color: 'Black & White',
            binding_finish: 'Fold / Staple',
            finishing: 'Grommets',
            mount: false,
            laminate: false,
            service_id: byName['Large Format'].id,
            file_ids: [fileId],
          },
          {
            description: 'Project Specifications',
            size: '8.5x11',
            quantity: '5 Sets',
            media: 'Premium',
            color: 'Black & White',
            binding_finish: 'Bind (Left)',
            service_id: byName['Small Format'].id,
          },
          {
            description: 'Site Banner',
            size: '96x36',
            quantity: '1',
            media: 'Vinyl',
            color: 'Color',
            binding_finish: 'Hem',
            service_id: byName['Signs & Graphics'].id,
          },
        ],
      }),
    });
    assert(created.status === 201, `order create failed: ${created.status} ${created.text}`);
    const orderId = created.json.order.id;
    const workOrders = created.json.work_orders;
    assert(workOrders.length === 3, 'three services should create three work orders');
    const suffixes = workOrders.map((row) => row.external_id.slice(-2)).sort();
    assert(suffixes.join(',') === '-A,-B,-C', `expected -A/-B/-C suffixes, got ${workOrders.map((row) => row.external_id).join(', ')}`);

    const customerOrderPrint = await request({ method: 'GET', path: `/api/orders/${orderId}/print`, token: customer.token });
    assert(customerOrderPrint.status === 200, `customer order print failed: ${customerOrderPrint.status} ${customerOrderPrint.text}`);
    const customerSheets = customerOrderPrint.json.work_orders;
    assert(customerOrderPrint.json.kind === 'order', 'order print kind should be order');
    assert(customerSheets.length === 3, 'order print should include every work order');
    assert(customerOrderPrint.json.staff_history === false, 'customer print should hide staff history fields');
    assert(customerOrderPrint.json.shop.name === 'Accent Imaging, Inc.', 'shop letterhead should be Accent Imaging');
    assert(customerOrderPrint.json.shop.address_lines[0] === '8121 Brownleigh Drive', 'shop street should match the mockup');
    assert(customerOrderPrint.json.shop.phone === '919-782-3332', 'shop phone should match the mockup');
    assert(customerOrderPrint.json.delivery_window_label === '9:00 AM - 2:00 PM (15 min increments)', customerOrderPrint.json.delivery_window_label);
    assert(
      customerOrderPrint.json.scan_instructions.join('|') === 'Scan this barcode at each department.|Do NOT scan until work is ready to move.|Keep work order with the job at all times.',
      'scan instructions should match the mockup'
    );
    assertNoSecrets(customerOrderPrint.text, [passwordRow.password_hash, 'CustomerPass1', stored.stored_name]);
    assert(!customerOrderPrint.text.includes('System Auto'), 'customer print should not include the staff scanner name');
    assert(!customerOrderPrint.text.includes('Order Created'), 'customer print should not include staff history notes');

    const bySuffix = Object.fromEntries(customerSheets.map((sheet) => [sheet.external_id.slice(-1), sheet]));
    assert(bySuffix.A.service_name === 'Large Format', 'suffix A should be Large Format');
    assert(bySuffix.B.service_name === 'Small Format', 'suffix B should be Small Format');
    assert(bySuffix.C.service_name === 'Signs & Graphics', 'suffix C should be Signs & Graphics');
    for (const sheet of customerSheets) {
      assert(sheet.barcode_value === sheet.external_id, 'barcode value should be the work order number');
      assert(sheet.contact.company === 'Acme Construction', 'contact company should come from the order');
      assert(sheet.contact.contact_name === 'John Smith', 'contact name should come from the order');
      assert(sheet.contact.phone === '919-555-1234', 'phone should come from the order');
      assert(sheet.contact.email === 'jsmith@acmeconstruction.com', 'email should come from the order');
      assert(sheet.project.po_number === 'PO-5521', 'PO number should be on the print');
      assert(sheet.project.project_number === '20045', 'project number should be on the print');
      assert(sheet.project.project_name === 'New City Center', 'project name should be on the print');
      assert(sheet.project.notes === 'Please deliver to loading dock.', 'project notes should be on the print');
      assert(sheet.delivery.method === 'Accent Truck', 'delivery method should be on the print');
      assert(sheet.delivery.will_call === false, 'Accent Truck is not will call');
      assert(sheet.due_date === dueDate(), 'due date should be on the print');
      assert(sheet.due_time === '09:15', 'due time should be on the print');
      assert(sheet.special_instructions === 'Please deliver to loading dock.', 'special instructions should use the order notes');
      assert(sheet.routing.department, 'routing department should be present');
      assert(sheet.routing.current_status_label === 'Active', 'a customer print should leave a new work order Active');
      assertCustomerHistory(sheet.production_history);
      decodePrinted(sheet.barcode_svg, sheet.external_id);
    }
    const largeItem = bySuffix.A.line_items[0];
    assert(largeItem.size === 'Full Size' && largeItem.quantity === '5 Sets' && largeItem.media === 'Bond', 'line item size, quantity, and media should print');
    assert(largeItem.binding_finish === 'Staple', 'binding should print');
    assert(largeItem.finishing === 'Grommets', 'selected finishing should print');
    assert(bySuffix.B.line_items[0].finishing === '', 'omitted finishing stays blank in the payload');
    assert(bySuffix.A.address.line1 === '1234 Builder Way' && bySuffix.A.address.line2 === 'Suite 200', 'street address should print');
    assert(bySuffix.A.address.city === 'Raleigh' && bySuffix.A.address.state === 'NC' && bySuffix.A.address.zip === '27601', 'city, state, and zip should print');
    assert(bySuffix.A.originals_source_label === 'Hardcopy or digital media provided', 'originals source should print');
    assert(bySuffix.A.originals_pickup === false, 'hardcopy originals are not an inbound pickup');
    assert(largeItem.mount === false && largeItem.laminate === false, 'mount and laminate should print as booleans');
    assert(bySuffix.A.files.length === 1 && bySuffix.A.files[0].original_name === 'Civil Plans.pdf', 'attached file name should print on its work order');
    assert(bySuffix.B.files.length === 0 && bySuffix.C.files.length === 0, 'a line-item file should not be copied onto the other work orders');
    assert(bySuffix.A.process.includes('Large Format'), 'process should include the service');

    const historyRows = await db.all(
      'SELECT department, status, notes FROM production_history WHERE work_order_id = ? ORDER BY id',
      [bySuffix.A.id]
    );
    assert(historyRows.length === 1, `a customer print should not add a history row, got ${historyRows.length}`);
    assert(historyRows[0].department === 'Submitted' && historyRows[0].status === 'Submitted', 'the created row should stay');

    const otherOrder = await request({ method: 'GET', path: `/api/orders/${orderId}/print`, token: other.token });
    const otherWorkOrder = await request({ method: 'GET', path: `/api/workorders/${bySuffix.A.id}/print`, token: other.token });
    assert(otherOrder.status === 404, `other customer order print should be 404, got ${otherOrder.status}`);
    assert(otherWorkOrder.status === 404, `other customer work order print should be 404, got ${otherWorkOrder.status}`);
    const missing = await request({ method: 'GET', path: '/api/workorders/999999/print', token: admin.token });
    assert(missing.status === 404, `missing work order print should be 404, got ${missing.status}`);

    const staffPrint = await request({ method: 'GET', path: `/api/workorders/${bySuffix.A.id}/print`, token: operator.token });
    assert(staffPrint.status === 200, `operator print failed: ${staffPrint.text}`);
    assert(staffPrint.json.kind === 'work_order', 'work order print kind should be work_order');
    assert(staffPrint.json.staff_history === true, 'staff print includes history notes');
    assert(staffPrint.json.work_orders.length === 1, 'work order print returns that one sheet');
    const staffSheet = staffPrint.json.work_orders[0];
    assert(staffSheet.routing.current_status_label === 'In Progress', 'a staff print moves an open job to In Production');
    assert(staffSheet.production_history[0].scanned_by === 'System Auto', 'staff history should keep who recorded the step');
    assert(staffSheet.production_history[0].notes === 'Order Created', 'staff history should keep the real note');
    const printedHistory = await db.all(
      'SELECT department, status, notes FROM production_history WHERE work_order_id = ? ORDER BY id',
      [bySuffix.A.id]
    );
    assert(printedHistory.length === 2, `staff printing should add one history row, got ${printedHistory.length}`);
    assert(printedHistory[1].status === 'in-progress' && printedHistory[1].notes === 'Printed', 'staff printing should log In Production');
    const adminOrderPrint = await request({ method: 'GET', path: `/api/orders/${orderId}/print`, token: admin.token });
    assert(adminOrderPrint.status === 200 && adminOrderPrint.json.work_orders.length === 3, 'admin can print every work order on the order');

    const customerScan = await request({
      method: 'POST',
      path: '/api/barcode',
      token: customer.token,
      json: { scanned_value: bySuffix.A.external_id },
    });
    assert(customerScan.status === 403, `customer scan should stay 403, got ${customerScan.status}`);

    for (const letter of ['A', 'B', 'C']) {
      const sheet = bySuffix[letter];
      const decoded = decodePrinted(sheet.barcode_svg, sheet.external_id);
      const scan = await request({
        method: 'POST',
        path: '/api/barcode',
        token: operator.token,
        json: { scanned_value: decoded, location: 'Intake' },
      });
      assert(scan.status === 201, `scan of ${decoded} failed: ${scan.status} ${scan.text}`);
      assert(scan.json.work_order_id === sheet.id, `scan of ${decoded} resolved work order ${scan.json.work_order_id}, expected ${sheet.id}`);
      assert(scan.json.external_id === sheet.external_id, `scan of ${decoded} returned ${scan.json.external_id}`);
    }
    console.log('PASS barcode scan round trip for -A/-B/-C');

    const beforeMove = await db.get('SELECT department, status FROM work_orders WHERE id = ?', [bySuffix.B.id]);
    const beforeEvents = await db.get('SELECT COUNT(*) AS count FROM barcode_events WHERE work_order_id = ?', [bySuffix.B.id]);
    const beforeHistory = await db.get('SELECT COUNT(*) AS count FROM production_history WHERE work_order_id = ?', [bySuffix.B.id]);
    const beforeActivity = await db.get(
      `SELECT COUNT(*) AS count FROM activity_log WHERE entity_type = 'work_order' AND entity_id = ? AND action = 'work_order.moved'`,
      [bySuffix.B.id]
    );
    assert(beforeMove.department === 'Small Format', `suffix B should still be in Small Format, got ${beforeMove.department}`);
    await db.run(`
      CREATE TRIGGER fail_scan_move BEFORE INSERT ON activity_log
      WHEN NEW.action = 'work_order.moved'
      BEGIN
        SELECT RAISE(ABORT, 'forced activity failure');
      END
    `);
    try {
      const failedMove = await request({
        method: 'POST',
        path: '/api/barcode',
        token: operator.token,
        json: { scanned_value: bySuffix.B.external_id, location: 'Dispatch' },
      });
      assert(failedMove.status === 500, `failed department move should be 500, got ${failedMove.status} ${failedMove.text}`);
      assert(failedMove.json && failedMove.json.error === 'Failed to record barcode event', failedMove.text);
      assert(!/forced activity failure|SQLITE|activity_log/i.test(failedMove.text), 'scan error should not leak the database failure');
      const afterMoveRow = await db.get('SELECT department, status FROM work_orders WHERE id = ?', [bySuffix.B.id]);
      const afterEvents = await db.get('SELECT COUNT(*) AS count FROM barcode_events WHERE work_order_id = ?', [bySuffix.B.id]);
      const afterHistory = await db.get('SELECT COUNT(*) AS count FROM production_history WHERE work_order_id = ?', [bySuffix.B.id]);
      const afterActivity = await db.get(
        `SELECT COUNT(*) AS count FROM activity_log WHERE entity_type = 'work_order' AND entity_id = ? AND action = 'work_order.moved'`,
        [bySuffix.B.id]
      );
      const dispatchHistory = await db.get(
        `SELECT id FROM production_history WHERE work_order_id = ? AND department = 'Dispatch'`,
        [bySuffix.B.id]
      );
      assert(afterMoveRow.department === beforeMove.department && afterMoveRow.status === beforeMove.status, 'a failed move should leave the department unchanged');
      assert(afterEvents.count === beforeEvents.count, 'a failed move should not keep the barcode event');
      assert(afterHistory.count === beforeHistory.count && !dispatchHistory, 'a failed move should not keep production history');
      assert(afterActivity.count === beforeActivity.count, 'a failed move should not keep the activity row');
    } finally {
      await db.run('DROP TRIGGER IF EXISTS fail_scan_move');
    }
    console.log('PASS department move rolls back together');

    const moved = await request({
      method: 'POST',
      path: '/api/barcode',
      token: operator.token,
      json: { scanned_value: bySuffix.A.external_id, location: 'Quality' },
    });
    assert(moved.status === 201 && moved.json.department_moved === true, `quality scan should move the work order: ${moved.text}`);
    const afterMove = await request({ method: 'GET', path: `/api/workorders/${bySuffix.A.id}/print`, token: operator.token });
    const movedHistory = afterMove.json.work_orders[0].production_history;
    assert(movedHistory.length === 3, 'a department scan should add a real history row after the print row');
    const qualityRow = movedHistory.find((row) => row.department === 'Quality');
    assert(qualityRow, 'history department should be the scanned department');
    assert(qualityRow.scanned_by === 'Operator One', 'history should name the operator who scanned');
    assert(/Quality/.test(qualityRow.notes || ''), 'history notes should describe the move');
    const customerAfterMove = await request({ method: 'GET', path: `/api/workorders/${bySuffix.A.id}/print`, token: customer.token });
    assertCustomerHistory(customerAfterMove.json.work_orders[0].production_history);
    assert(
      customerAfterMove.json.work_orders[0].production_history.some((row) => row.department === 'Quality'),
      'customer should still see the department and time'
    );
    assert(!customerAfterMove.text.includes('Operator One'), 'customer print should not include the operator name');

    const willCall = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody({
        delivery_method: 'Will Call',
        ship_to: '',
        service_ids: [byName['Planroom'].id],
        line_items: [{ description: 'Pickup set', quantity: '1', service_id: byName['Planroom'].id }],
      }),
    });
    assert(willCall.status === 201, `will-call order failed: ${willCall.text}`);
    const willCallPrint = await request({
      method: 'GET',
      path: `/api/orders/${willCall.json.order.id}/print`,
      token: customer.token,
    });
    assert(willCallPrint.status === 200, willCallPrint.text);
    assert(willCallPrint.json.work_orders[0].delivery.method === 'Will Call', 'will-call method should print');
    assert(willCallPrint.json.work_orders[0].delivery.will_call === true, 'will-call flag should print');
    assert(willCallPrint.json.work_orders[0].delivery.hours_label === '8:00 AM - 5:00 PM (15 min increments)', willCallPrint.json.work_orders[0].delivery.hours_label);
    assert(willCallPrint.json.delivery_window_label === '8:00 AM - 5:00 PM (15 min increments)', 'order print should use Will Call hours');
    assert(willCallPrint.json.work_orders[0].delivery.ups_account_number == null, 'Will Call should not invent a UPS account');

    const upsOrder = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody({
        delivery_method: 'UPS',
        ups_account_number: '  AB-12 9 ',
        service_ids: [byName['Large Format'].id],
        line_items: [{ description: 'Shipped set', quantity: '1', service_id: byName['Large Format'].id }],
      }),
    });
    assert(upsOrder.status === 201, `UPS order failed: ${upsOrder.text}`);
    const upsPrint = await request({
      method: 'GET',
      path: `/api/orders/${upsOrder.json.order.id}/print`,
      token: customer.token,
    });
    assert(upsPrint.status === 200, upsPrint.text);
    assert(upsPrint.json.work_orders[0].delivery.method === 'UPS', 'UPS method should print');
    assert(upsPrint.json.work_orders[0].delivery.ups_account_number === 'AB-12 9', 'trimmed UPS account should print');
    assert(upsPrint.json.work_orders[0].delivery.hours_label === '9:00 AM - 2:00 PM (15 min increments)', 'UPS should use delivery hours');
    const upsHidden = await request({
      method: 'GET',
      path: `/api/orders/${upsOrder.json.order.id}/print`,
      token: other.token,
    });
    assert(upsHidden.status === 404 && !upsHidden.text.includes('AB-12 9'), 'another customer must not print the UPS account');

    const legacyPickup = await db.run(
      `INSERT INTO orders (
        order_number, customer_id, company, contact_name, phone, email, delivery_method, due_date, due_time
      ) VALUES ('LEGACY-PICKUP', ?, 'Acme Construction', 'John Smith', '919-555-1234', 'jsmith@acmeconstruction.com', 'Customer Pickup', ?, '18:00')`,
      [customerResponse.json.id, dueDate()]
    );
    const legacyPickupWork = await db.run(
      `INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department, order_id)
       VALUES ('LEGACY-PICKUP-A', ?, 'Legacy pickup', 1, 'open', 'Large Format', ?)`,
      [customerResponse.json.id, legacyPickup.lastID]
    );
    await db.run(
      `INSERT INTO deliveries (work_order_id, order_id, will_call, due_time, carrier, status)
       VALUES (?, ?, 1, ?, 'Customer Pickup', 'pending')`,
      [legacyPickupWork.lastID, legacyPickup.lastID, `${dueDate()} 18:00:00`]
    );
    const pickupPrint = await request({
      method: 'GET',
      path: `/api/orders/${legacyPickup.lastID}/print`,
      token: admin.token,
    });
    assert(pickupPrint.status === 200, pickupPrint.text);
    assert(pickupPrint.json.work_orders[0].delivery.method === 'Customer Pickup', 'legacy Customer Pickup label should print');
    assert(pickupPrint.json.work_orders[0].delivery.hours_label === '8:00 AM - 5:00 PM (15 min increments)', 'Customer Pickup should print Will Call hours');
    assert(pickupPrint.json.work_orders[0].project.project_name === '', 'an order without a project name should still print');
    assert(pickupPrint.json.work_orders[0].originals_source_label === 'Not specified', 'legacy originals should print as Not specified');
    assert(pickupPrint.json.work_orders[0].address.line1 === '' && pickupPrint.json.work_orders[0].address.zip === '', 'legacy address should print blank');

    const legacyFedex = await db.run(
      `INSERT INTO orders (
        order_number, customer_id, company, contact_name, phone, email, delivery_method, due_date, due_time
      ) VALUES ('LEGACY-FEDEX', ?, 'Acme Construction', 'John Smith', '919-555-1234', 'jsmith@acmeconstruction.com', 'FedEx', ?, '16:30')`,
      [customerResponse.json.id, dueDate()]
    );
    await db.run(
      `INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department, order_id)
       VALUES ('LEGACY-FEDEX-A', ?, 'Legacy FedEx', 1, 'open', 'Large Format', ?)`,
      [customerResponse.json.id, legacyFedex.lastID]
    );
    const fedexPrint = await request({
      method: 'GET',
      path: `/api/orders/${legacyFedex.lastID}/print`,
      token: admin.token,
    });
    assert(fedexPrint.status === 200 && fedexPrint.json.work_orders[0].delivery.method === 'FedEx', `legacy FedEx label should print: ${fedexPrint.text}`);
    assert(fedexPrint.json.work_orders[0].delivery.hours_label === '9:00 AM - 2:00 PM (15 min increments)', 'FedEx should print delivery hours');
    const removed = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody({ delivery_method: 'Common Carrier', service_ids: [byName['Large Format'].id] }),
    });
    assert(removed.status === 400 && /no longer available/i.test(removed.json.error), `Common Carrier should be rejected: ${removed.text}`);

    const legacy = await db.get(`SELECT id, external_id FROM work_orders WHERE external_id = 'WO-1001'`);
    assert(legacy, 'seeded WO-1001 should exist');
    const legacyDenied = await request({ method: 'GET', path: `/api/workorders/${legacy.id}/print`, token: customer.token });
    assert(legacyDenied.status === 404, 'customer should not print another customer seeded work order');
    const legacyPrint = await request({ method: 'GET', path: `/api/workorders/${legacy.id}/print`, token: admin.token });
    assert(legacyPrint.status === 200, `legacy print failed: ${legacyPrint.text}`);
    const legacyValue = legacyPrint.json.work_orders[0].barcode_value;
    assert(legacyValue === 'WO-1001', 'legacy barcode should be the external id');
    decodePrinted(legacyPrint.json.work_orders[0].barcode_svg, 'WO-1001');
    const legacyScan = await request({
      method: 'POST',
      path: '/api/barcode',
      token: admin.token,
      json: { scanned_value: decodeCode128Svg(legacyPrint.json.work_orders[0].barcode_svg), location: 'Intake' },
    });
    assert(legacyScan.status === 201 && legacyScan.json.work_order_id === legacy.id, `legacy scan failed: ${legacyScan.text}`);

    const customerId = customerResponse.json.id;
    const blankExternal = await request({
      method: 'POST',
      path: '/api/workorders',
      token: admin.token,
      json: {
        customer_id: customerId,
        description: 'No external id',
        quantity: 1,
        status: 'open',
        department: 'Large Format',
        external_id: '',
      },
    });
    assert(blankExternal.status === 201, `blank external_id should stay allowed: ${blankExternal.status} ${blankExternal.text}`);
    assert(blankExternal.json.external_id == null, 'blank external_id is stored as null');

    const cafeCreate = await request({
      method: 'POST',
      path: '/api/workorders',
      token: admin.token,
      json: {
        customer_id: customerId,
        description: 'Cafe job',
        quantity: 1,
        status: 'open',
        department: 'Large Format',
        external_id: 'Café',
      },
    });
    assert(cafeCreate.status === 400, `non-ASCII external_id create should be 400, got ${cafeCreate.status} ${cafeCreate.text}`);
    assert(/printable ASCII/.test(cafeCreate.text), cafeCreate.text);

    const described = await request({
      method: 'POST',
      path: '/api/workorders',
      token: admin.token,
      json: {
        customer_id: customerId,
        description: 'Description job',
        quantity: 1,
        status: 'open',
        department: 'Large Format',
        external_id: 'Description-1',
      },
    });
    assert(described.status === 201, `Description-1 create failed: ${described.status} ${described.text}`);
    const describedPrint = await request({
      method: 'GET',
      path: `/api/workorders/${described.json.id}/print`,
      token: admin.token,
    });
    assert(describedPrint.status === 200, describedPrint.text);
    const describedSheet = describedPrint.json.work_orders[0];
    assert(describedSheet.barcode_error == null, 'Description-1 should include a barcode');
    assert(/aria-label="Code 128 Description-1"/.test(describedSheet.barcode_svg), 'barcode label should keep Description-1');
    decodePrinted(describedSheet.barcode_svg, 'Description-1');

    const cafeUpdate = await request({
      method: 'PUT',
      path: `/api/workorders/${described.json.id}`,
      token: admin.token,
      json: {
        customer_id: customerId,
        description: 'Description job',
        quantity: 1,
        status: 'open',
        department: 'Large Format',
        external_id: 'Café',
      },
    });
    assert(cafeUpdate.status === 400, `non-ASCII external_id update should be 400, got ${cafeUpdate.status} ${cafeUpdate.text}`);
    assert(/printable ASCII/.test(cafeUpdate.text), cafeUpdate.text);
    const stillDescribed = await db.get('SELECT external_id FROM work_orders WHERE id = ?', [described.json.id]);
    assert(stillDescribed.external_id === 'Description-1', 'a rejected update should leave the saved id unchanged');

    const siblingId = willCall.json.work_orders[0].id;
    const badInsert = await db.run(
      `INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department, order_id)
       VALUES ('Café', ?, 'Legacy unprintable id', 1, 'open', 'Large Format', ?)`,
      [customerId, willCall.json.order.id]
    );
    const badPrint = await request({
      method: 'GET',
      path: `/api/workorders/${badInsert.lastID}/print`,
      token: admin.token,
    });
    assert(badPrint.status === 200, `legacy bad id should still print: ${badPrint.status} ${badPrint.text}`);
    assert(badPrint.json.work_orders[0].barcode_svg == null, 'legacy bad id should not include a barcode svg');
    assert(badPrint.json.work_orders[0].barcode_error === 'barcode unavailable', badPrint.text);
    const mixedOrder = await request({
      method: 'GET',
      path: `/api/orders/${willCall.json.order.id}/print`,
      token: admin.token,
    });
    assert(mixedOrder.status === 200, `one bad id should not fail the order print: ${mixedOrder.status} ${mixedOrder.text}`);
    assert(mixedOrder.json.work_orders.length === 2, 'order print should include the good sheet and the legacy sheet');
    const goodSheet = mixedOrder.json.work_orders.find((sheet) => sheet.id === siblingId);
    const badSheet = mixedOrder.json.work_orders.find((sheet) => sheet.id === badInsert.lastID);
    assert(goodSheet && badSheet, 'both sheets should be present');
    decodePrinted(goodSheet.barcode_svg, goodSheet.external_id);
    assert(badSheet.barcode_svg == null && badSheet.barcode_error === 'barcode unavailable', 'the bad sheet should be a placeholder');
    console.log('PASS printable barcode values');
    console.log('PASS print payload and customer isolation');
  } finally {
    await db.close();
    server.stop();
  }
}

async function main() {
  for (const value of ['20261015-001-A', '20261015-001-B', '20261015-001-C', 'WO-1001', 'Description-1']) {
    decodePrinted(code128Svg(value), value);
  }
  let rejectedBarcode = null;
  try {
    code128Svg('Café');
  } catch (err) {
    rejectedBarcode = err;
  }
  assert(rejectedBarcode && rejectedBarcode.status === 400, 'non-ASCII barcode value should throw status 400');
  assert(/printable ASCII/.test(rejectedBarcode.message), rejectedBarcode && rejectedBarcode.message);
  console.log('PASS local Code 128 encode/decode');
  await initFreshTwice();
  await runApiChecks();
  console.log('Phase 3 verification passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
