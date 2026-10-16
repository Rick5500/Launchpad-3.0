/**
 * Phase 6 checks: Small Format product and finishing lists, on a fresh
 * database and on one that already has the previous seed.
 * Usage (from backend/): node scripts/verify-phase6.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const catalog = require('../smallFormatCatalog');
const { LINE_SUMMARY_MAX } = require('../serviceFields');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-phase6-'));
const freshDb = path.join(tmp, 'fresh.db');
const upgradeDb = path.join(tmp, 'upgrade.db');
const customDb = path.join(tmp, 'custom.db');
const uploadDir = path.join(tmp, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const port = 3106;
const adminPassword = 'AdminPass123';

const EXPECTED = {
  product: { label: 'Product', type: 'select', required: 1, options: catalog.SMALL_FORMAT_PRODUCTS },
  size: { label: 'Finished Size', type: 'select', required: 1, options: catalog.SMALL_FORMAT_SIZES },
  sides: { label: 'Sides/Color', type: 'select', required: 1, options: catalog.SMALL_FORMAT_SIDES },
  media: { label: 'Paper Stock', type: 'select', required: 1, options: catalog.SMALL_FORMAT_PAPER },
  binding: { label: 'Binding', type: 'select', required: 1, options: catalog.SMALL_FORMAT_BINDING },
  folding: { label: 'Folding', type: 'select', required: 0, options: catalog.SMALL_FORMAT_FOLDING },
  finishing: { label: 'Finishing', type: 'multiselect', required: 0, options: catalog.SMALL_FORMAT_FINISHING },
  proof: { label: 'Proof', type: 'select', required: 0, options: catalog.SMALL_FORMAT_PROOFS },
};

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
    UPLOAD_DIR: uploadDir,
    DELIVERY_TIMEZONE: 'UTC',
    DELIVERY_WINDOW_START: '09:00',
    DELIVERY_WINDOW_END: '14:00',
    DELIVERY_SLOT_MINUTES: '15',
    PORT: String(port),
    NODE_ENV: 'test',
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32',
  };
}

async function initDatabase(databaseFile) {
  const result = await spawnNode(path.join(backendDir, 'init_db.js'), baseEnv(databaseFile));
  if (result.code !== 0) throw new Error(`init_db failed (${result.code})\n${result.out}\n${result.err}`);
}

function optionValues(raw) {
  const parsed = JSON.parse(raw || '[]');
  return parsed.map((entry) => (typeof entry === 'string' ? { value: entry, active: true } : entry));
}

function activeNames(options) {
  return options.filter((option) => option.active !== false).map((option) => option.value);
}

async function smallFields(db) {
  const rows = await db.all(
    `SELECT service_fields.id, service_fields.key, service_fields.label, service_fields.type,
            service_fields.required, service_fields.sort_order, service_fields.options_json
     FROM service_fields
     JOIN services ON services.id = service_fields.service_id
     WHERE services.name = 'Small Format'
     ORDER BY service_fields.sort_order, service_fields.id`
  );
  return new Map(rows.map((row) => [row.key, row]));
}

function assertExactList(row, spec, label) {
  assert(row, `${label} should exist`);
  assert(row.label === spec.label, `${label} label should be ${spec.label}, got ${row.label}`);
  assert(row.type === spec.type, `${label} type should be ${spec.type}, got ${row.type}`);
  assert(row.required === spec.required, `${label} required should be ${spec.required}, got ${row.required}`);
  const options = optionValues(row.options_json);
  assert(options.every((option) => option.active !== false), `${label} seed options should be active`);
  const names = options.map((option) => option.value);
  assert(names.length === spec.options.length, `${label} should have ${spec.options.length} options, got ${names.length}`);
  names.forEach((name, index) => {
    assert(name === spec.options[index], `${label} option ${index + 1} should be ${spec.options[index]}, got ${name}`);
  });
  const lowered = names.map((name) => name.toLowerCase());
  assert(new Set(lowered).size === lowered.length, `${label} options should not be duplicated`);
}

async function assertFreshShape(db, label) {
  const fields = await smallFields(db);
  for (const [key, spec] of Object.entries(EXPECTED)) {
    const row = fields.get(key);
    const specForRow = key === 'binding' && label === 'upgraded' ? { ...spec, required: 0 } : spec;
    assertExactList(row, specForRow, `${label} ${key}`);
  }
  const process = fields.get('process');
  assert(process && process.label === 'Process', 'colour mode stays on the existing process field');
  const processNames = optionValues(process.options_json).map((option) => option.value);
  assert(processNames.join('|') === 'Black & White|Color', `process options should stay the colour modes, got ${processNames.join(', ')}`);
  const count = await db.get('SELECT COUNT(*) AS count FROM service_fields');
  assert(count.count === 58, `${label} init should leave 58 service fields, found ${count.count}`);
  const product = fields.get('product');
  const originals = fields.get('originals');
  assert(product.sort_order < originals.sort_order, 'product should sort ahead of originals');
  const notes = fields.get('notes');
  assert(fields.get('proof').sort_order < notes.sort_order, 'proof should sort ahead of notes');
}

function jsonOptions(names, extra = []) {
  return JSON.stringify([
    ...names.map((value) => ({ value, active: true })),
    ...extra,
  ]);
}

async function serviceId(db) {
  const row = await db.get(`SELECT id FROM services WHERE name = 'Small Format'`);
  assert(row, 'Small Format service should exist');
  return row.id;
}

async function restorePreviousSeed(db) {
  const id = await serviceId(db);
  for (const key of ['product', 'folding', 'finishing', 'proof']) {
    await db.run('DELETE FROM service_fields WHERE service_id = ? AND key = ?', [id, key]);
  }
  for (const key of ['size', 'media', 'sides', 'binding']) {
    const previous = catalog.SMALL_FORMAT_PREVIOUS[key];
    const updated = await db.run(
      `UPDATE service_fields
       SET label = ?, type = 'select', options_json = ?, required = 1
       WHERE service_id = ? AND key = ?`,
      [previous.label, jsonOptions(previous.options), id, key]
    );
    assert(updated.changes === 1, `previous ${key} row should be restored`);
  }
  await db.run('UPDATE service_fields SET required = 0 WHERE service_id = ? AND key = ?', [id, 'binding']);
}

function utcDate(offsetDays = 0) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function weekdayIso() {
  for (let offset = 0; offset < 7; offset += 1) {
    const date = utcDate(offset);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) return isoDate(date);
  }
  return isoDate(utcDate(0));
}

function request({ method, path: requestPath, token, json, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const body = json != null ? Buffer.from(JSON.stringify(json)) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json != null) headers['Content-Type'] = 'application/json';
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
        try { parsed = text ? JSON.parse(text) : null; } catch (err) { parsed = null; }
        resolve({ status: res.statusCode, json: parsed, text });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
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
        // still starting
      }
      setTimeout(poll, 200);
    };
    poll();
  });
  return {
    ready,
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

function smallValues(product, extra = {}) {
  return {
    product,
    originals: '2',
    copies: '25',
    size: '8.5x11',
    process: 'Color',
    sides: '4/4 full color both sides',
    media: '20# Bond',
    binding: 'Saddle Stitch',
    folding: 'Tri-Fold (letter)',
    ...extra,
  };
}

function orderBody(serviceId, lineItems) {
  return {
    company: 'Phase Six Co',
    contact_name: 'Riley Chen',
    phone: '919-555-0155',
    email: 'riley@phasesix.example',
    project_name: 'Small Format Products',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '500 Field Road',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Accent Truck',
    due_date: weekdayIso(),
    due_time: '10:00',
    payment_method: 'Accent Account',
    service_ids: [serviceId],
    line_items: lineItems,
  };
}

function fieldDisplay(item, key) {
  const field = (item.fields || []).find((row) => row.key === key);
  return field ? field.display : null;
}

async function main() {
  await initDatabase(freshDb);
  await initDatabase(freshDb);
  const fresh = openDb(freshDb);
  await assertFreshShape(fresh, 'fresh');
  const freshProduct = (await smallFields(fresh)).get('product');
  const freshJson = freshProduct.options_json;
  await fresh.close();
  await initDatabase(freshDb);
  const again = openDb(freshDb);
  const againProduct = (await smallFields(again)).get('product');
  assert(againProduct.options_json === freshJson, 'a second init should not rewrite an untouched product list');
  const againCount = await again.get('SELECT COUNT(*) AS count FROM service_fields');
  assert(againCount.count === 58, `a second init should not duplicate fields, found ${againCount.count}`);
  await again.close();
  console.log('PASS fresh Small Format seed, twice');

  await initDatabase(upgradeDb);
  const upgrade = openDb(upgradeDb);
  await restorePreviousSeed(upgrade);
  await upgrade.close();
  await initDatabase(upgradeDb);
  await initDatabase(upgradeDb);
  const upgraded = openDb(upgradeDb);
  await assertFreshShape(upgraded, 'upgraded');
  const upgradedSize = (await smallFields(upgraded)).get('size');
  assert(!optionValues(upgradedSize.options_json).some((option) => option.value === 'See Note'), 'an untouched size list should be replaced, not merged');
  await upgraded.close();
  console.log('PASS upgraded database replaces untouched Small Format lists');

  const emptyFile = path.join(tmp, 'empty.db');
  await initDatabase(emptyFile);
  const empty = openDb(emptyFile);
  const emptyId = await serviceId(empty);
  await empty.run(`UPDATE service_fields SET options_json = NULL WHERE service_id = ? AND key = 'product'`, [emptyId]);
  await empty.close();
  await initDatabase(emptyFile);
  const emptied = openDb(emptyFile);
  assertExactList((await smallFields(emptied)).get('product'), EXPECTED.product, 'empty product');
  await emptied.close();
  console.log('PASS empty product list is filled');

  await initDatabase(customDb);
  const custom = openDb(customDb);
  const customId = await serviceId(custom);
  const customProducts = [
    { value: 'Book Printing', active: true },
    { value: 'Window Clings', active: true },
    { value: 'Pads', active: false },
    { value: 'Brochures', active: true },
  ];
  await custom.run(
    `UPDATE service_fields SET label = 'Job Type', options_json = ? WHERE service_id = ? AND key = 'product'`,
    [JSON.stringify(customProducts), customId]
  );
  const oldMedia = [
    { value: 'Shop Rag', active: true },
    ...catalog.SMALL_FORMAT_PREVIOUS.media.options.map((value) => ({ value, active: true })),
  ];
  await custom.run(
    `UPDATE service_fields SET label = 'Stock', options_json = ? WHERE service_id = ? AND key = 'media'`,
    [JSON.stringify(oldMedia), customId]
  );
  await custom.run(
    `UPDATE service_fields SET type = 'select', options_json = ? WHERE service_id = ? AND key = 'finishing'`,
    [JSON.stringify([
      { value: 'Cut/Trim', active: true },
      { value: 'Gold Foil', active: true },
    ]), customId]
  );
  await custom.close();
  await initDatabase(customDb);
  const customized = openDb(customDb);
  const customFields = await smallFields(customized);
  const product = customFields.get('product');
  assert(product.label === 'Job Type', 'a renamed product field should keep the admin label');
  const productOptions = optionValues(product.options_json);
  assert(productOptions.slice(0, 4).map((option) => `${option.value}:${option.active}`).join('|') === 'Book Printing:true|Window Clings:true|Pads:false|Brochures:true', 'admin product options should stay in place, including an inactive one');
  const productNames = productOptions.map((option) => option.value);
  catalog.SMALL_FORMAT_PRODUCTS.forEach((name) => {
    assert(productNames.filter((value) => value.toLowerCase() === name.toLowerCase()).length === 1, `${name} should be present once`);
  });
  assert(productNames.includes('Window Clings'), 'an admin-added product should stay');
  const appended = productNames.slice(4);
  const expectedAppend = catalog.SMALL_FORMAT_PRODUCTS.filter((name) => !['Book Printing', 'Pads', 'Brochures'].includes(name));
  assert(appended.join('|') === expectedAppend.join('|'), `missing products should be appended in seed order, got ${appended.join(', ')}`);

  const media = customFields.get('media');
  assert(media.label === 'Stock', 'a renamed paper field should keep the admin label');
  const mediaNames = optionValues(media.options_json).map((option) => option.value);
  assert(mediaNames[0] === 'Shop Rag', 'an admin paper should stay first');
  catalog.SMALL_FORMAT_PREVIOUS.media.options.forEach((name) => {
    assert(mediaNames.includes(name), `custom paper list should keep ${name}`);
  });
  catalog.SMALL_FORMAT_PAPER.forEach((name) => {
    assert(mediaNames.filter((value) => value.toLowerCase() === name.toLowerCase()).length === 1, `${name} should be present once`);
  });

  const finishing = customFields.get('finishing');
  assert(finishing.type === 'select', 'a customised finishing field should keep the type the admin saved');
  const finishingNames = optionValues(finishing.options_json).map((option) => option.value);
  assert(finishingNames[0] === 'Cut/Trim' && finishingNames[1] === 'Gold Foil', 'admin finishing options should stay first');
  catalog.SMALL_FORMAT_FINISHING.forEach((name) => {
    assert(finishingNames.filter((value) => value.toLowerCase() === name.toLowerCase()).length === 1, `${name} should be present once`);
  });
  const beforeSecond = finishing.options_json;
  await customized.close();
  await initDatabase(customDb);
  const customAgain = openDb(customDb);
  const finishingAgain = (await smallFields(customAgain)).get('finishing');
  assert(finishingAgain.options_json === beforeSecond, 'a second init should not add the same finishing options again');
  await customAgain.close();
  console.log('PASS customised lists only gain missing options');

  const server = startServer();
  await server.ready;
  try {
    const admin = await login('admin', adminPassword);
    const customerResponse = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Phase Six Customer',
        username: 'phase6cust',
        password: 'CustomerPass1',
        company: 'Phase Six Co',
        contact_name: 'Riley Chen',
        phone: '919-555-0155',
        email: 'riley@phasesix.example',
      },
    });
    assert(customerResponse.status === 201, `customer create failed: ${customerResponse.text}`);
    const customer = await login('phase6cust', 'CustomerPass1');
    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    const small = options.json.services.find((service) => service.name === 'Small Format');
    assert(small, 'Small Format should be on the order form');
    const byKey = Object.fromEntries(small.fields.map((field) => [field.key, field]));
    assert(byKey.product.options[0] === 'Book Printing' && byKey.product.options.length === catalog.SMALL_FORMAT_PRODUCTS.length, 'order form should list every product');
    assert(byKey.finishing.type === 'multiselect', 'finishing should be a multiselect on the order form');
    assert(byKey.proof.options[0] === 'None', 'proof should offer None first');

    const created = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(small.id, catalog.SMALL_FORMAT_PRODUCTS.map((product) => ({
        description: product,
        service_id: small.id,
        field_values: smallValues(product),
      }))),
    });
    assert(created.status === 201, `each product should be accepted: ${created.text}`);
    assert(created.json.order.line_items.length === catalog.SMALL_FORMAT_PRODUCTS.length, 'one line per product');
    created.json.order.line_items.forEach((item, index) => {
      assert(item.field_values.product === catalog.SMALL_FORMAT_PRODUCTS[index], `stored product ${index} mismatch`);
      assert(item.field_values.proof === 'None', 'an omitted proof should default to None');
      assert(fieldDisplay(item, 'proof') === 'None', 'order detail should show Proof: None');
    });
    const printed = await request({
      method: 'GET',
      path: `/api/orders/${created.json.order.id}/print`,
      token: customer.token,
    });
    assert(printed.status === 200, printed.text);
    const printedLine = printed.json.work_orders[0].line_items[0];
    assert(fieldDisplay(printedLine, 'proof') === 'None', 'the print sheet should show Proof');
    assert(fieldDisplay(printedLine, 'product') === 'Book Printing', 'the print sheet should show the product');
    const workOrderId = created.json.work_orders[0].id;
    const workOrder = await request({ method: 'GET', path: `/api/workorders/${workOrderId}`, token: admin.token });
    assert(workOrder.status === 200, workOrder.text);
    const specFields = (workOrder.json.specification_lines || []).flatMap((line) => line.fields || []);
    assert(specFields.some((field) => field.label === 'Proof' && field.value === 'None'), 'work order detail should show Proof');

    const unknown = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(small.id, [{
        description: 'Unknown product',
        service_id: small.id,
        field_values: smallValues('Window Clings'),
      }]),
    });
    assert(unknown.status === 400 && /Product must be one of/.test(unknown.json.error), unknown.text);

    const finished = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(small.id, [{
        description: 'Finished flyer',
        service_id: small.id,
        field_values: smallValues('Flyers', {
          proof: 'Digital Proof (PDF email)',
          finishing: ['Cut/Trim', 'Score', 'Shrink Wrap'],
          size: '3.5x2 (business card)',
          media: '100# Cover Matte',
        }),
      }]),
    });
    assert(finished.status === 201, `finishing order failed: ${finished.text}`);
    const finishedLine = finished.json.order.line_items[0];
    assert(fieldDisplay(finishedLine, 'finishing') === 'Cut/Trim, Score, Shrink Wrap', finished.text);
    assert(fieldDisplay(finishedLine, 'proof') === 'Digital Proof (PDF email)', 'an explicit digital proof should be kept');
    const finishedPrint = await request({
      method: 'GET',
      path: `/api/orders/${finished.json.order.id}/print`,
      token: customer.token,
    });
    assert(fieldDisplay(finishedPrint.json.work_orders[0].line_items[0], 'finishing') === 'Cut/Trim, Score, Shrink Wrap', 'print should show each finishing choice');

    const badFinish = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(small.id, [{
        description: 'Bad finish',
        service_id: small.id,
        field_values: smallValues('Flyers', { finishing: ['Sparkles'] }),
      }]),
    });
    assert(badFinish.status === 400 && /Finishing must be one of/.test(badFinish.json.error), badFinish.text);
    const duplicateFinish = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(small.id, [{
        description: 'Duplicate finish',
        service_id: small.id,
        field_values: smallValues('Flyers', { finishing: ['Score', 'Score'] }),
      }]),
    });
    assert(duplicateFinish.status === 400 && /duplicated/.test(duplicateFinish.json.error), duplicateFinish.text);

    const longest = (list) => list.reduce((best, value) => (value.length > best.length ? value : best));
    const maximalValues = {
      product: longest(catalog.SMALL_FORMAT_PRODUCTS),
      originals: 'A'.repeat(160),
      copies: 'B'.repeat(160),
      size: longest(catalog.SMALL_FORMAT_SIZES),
      process: longest(catalog.SMALL_FORMAT_COLOR_MODES),
      sides: longest(catalog.SMALL_FORMAT_SIDES),
      media: longest(catalog.SMALL_FORMAT_PAPER),
      binding: longest(catalog.SMALL_FORMAT_BINDING),
      folding: 'Z-Fold',
      finishing: catalog.SMALL_FORMAT_FINISHING.slice(),
      proof: longest(catalog.SMALL_FORMAT_PROOFS),
      notes: `${'Press check the crop marks. '.repeat(80)}`.trim().slice(0, 2000),
    };
    assert(maximalValues.finishing.length >= 8, 'the maximal line should include at least 8 finishing options');
    const maximal = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(small.id, [{
        service_id: small.id,
        field_values: maximalValues,
      }]),
    });
    assert(maximal.status === 201, `maximal Small Format line failed: ${maximal.text}`);
    const maximalLine = maximal.json.order.line_items[0];
    const summary = maximalLine.description;
    const summaryParts = (maximalLine.fields || [])
      .filter((field) => field.display && field.display !== 'No')
      .map((field) => `${field.label}: ${field.display}`);
    const fullSummary = summaryParts.join(' · ');
    assert(fullSummary.length > LINE_SUMMARY_MAX, 'a maximal Small Format summary should exceed the cap so truncation is exercised');
    assert(summary.length <= LINE_SUMMARY_MAX, `summary length ${summary.length} exceeds ${LINE_SUMMARY_MAX}`);
    assert(summary.length > 200, 'the summary should keep more than the old 200 character cut');
    assert(summary.endsWith('…'), 'a summary over the cap should end with an ellipsis');
    const summaryBody = summary.slice(0, -1);
    assert(fullSummary.startsWith(summaryBody), 'the truncated summary should be a prefix of the full summary');
    const summaryRest = fullSummary.slice(summaryBody.length);
    assert(
      summaryRest.startsWith(' · ') || summaryRest.startsWith(' '),
      `summary was cut mid-word near ${JSON.stringify(summary.slice(-24))}`
    );
    assert(summary.includes('Folding: Z-Fold'), 'folding should stay a complete segment');
    assert(
      summary.includes(`Finishing: ${catalog.SMALL_FORMAT_FINISHING.join(', ')}`),
      'finishing options should stay intact instead of ending mid-word'
    );
    const maximalPrint = await request({
      method: 'GET',
      path: `/api/orders/${maximal.json.order.id}/print`,
      token: customer.token,
    });
    assert(maximalPrint.status === 200, maximalPrint.text);
    assert(maximalPrint.json.work_orders[0].line_items[0].description === summary, 'the print sheet should use the same summary');
    const maximalWorkOrder = await request({
      method: 'GET',
      path: `/api/workorders/${maximal.json.work_orders[0].id}`,
      token: admin.token,
    });
    assert(maximalWorkOrder.status === 200, maximalWorkOrder.text);
    assert(
      (maximalWorkOrder.json.specification_lines || [])[0].title === summary,
      'work order detail should use the same summary'
    );

    const proofRow = await openDb(freshDb);
    const proofField = (await smallFields(proofRow)).get('proof');
    const withoutNone = optionValues(proofField.options_json).map((option) => (
      option.value === 'None' ? { ...option, active: false } : option
    ));
    await proofRow.run('UPDATE service_fields SET options_json = ? WHERE id = ?', [JSON.stringify(withoutNone), proofField.id]);
    await proofRow.close();
    const digital = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody(small.id, [{
        description: 'Digital default',
        service_id: small.id,
        field_values: smallValues('Menus'),
      }]),
    });
    assert(digital.status === 201 && digital.json.order.line_items[0].field_values.proof === 'Digital Proof (PDF email)', digital.text);
    console.log('PASS Small Format orders accept each product and show proof');
  } finally {
    server.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
