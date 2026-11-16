/**
 * Catalog field checks: Signs & Graphics and Small Format upgrades.
 * Fresh seed, an untouched previous seed, an admin's list, and a legacy order.
 * Usage (from backend/): node scripts/verify-catalog-fields.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const catalog = require('../smallFormatCatalog');
const signs = require('../signsCatalog');

const backendDir = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-catalog-'));
process.env.DATABASE_FILE = path.join(tmp, 'module.db');
const fields = require('../serviceFields');
const freshDb = path.join(tmp, 'fresh.db');
const upgradeDb = path.join(tmp, 'upgrade.db');
const customDb = path.join(tmp, 'custom.db');
const uploadDir = path.join(tmp, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const port = 3121;
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

function activeNames(raw) {
  return optionValues(raw).filter((option) => option.active !== false).map((option) => option.value);
}

function jsonOptions(names) {
  return JSON.stringify(names.map((value) => ({ value, active: true })));
}

async function serviceId(db, name) {
  const row = await db.get('SELECT id FROM services WHERE name = ?', [name]);
  assert(row, `${name} service should exist`);
  return row.id;
}

async function fieldsFor(db, serviceName) {
  const rows = await db.all(
    `SELECT service_fields.key, service_fields.label, service_fields.type, service_fields.required,
            service_fields.is_active, service_fields.options_json
     FROM service_fields
     JOIN services ON services.id = service_fields.service_id
     WHERE services.name = ?
     ORDER BY service_fields.sort_order, service_fields.id`,
    [serviceName]
  );
  return new Map(rows.map((row) => [row.key, row]));
}

function assertExact(row, names, label) {
  assert(row, `${label} should exist`);
  const values = activeNames(row.options_json);
  assert(values.join('|') === names.join('|'), `${label} options should be ${names.join(', ')}, got ${values.join(', ')}`);
  const lowered = values.map((value) => value.toLowerCase());
  assert(new Set(lowered).size === lowered.length, `${label} options should not be duplicated`);
}

function assertNoGlossText(names, label) {
  const gloss = names.filter((name) => /60#/i.test(name) && /gloss/i.test(name));
  assert(gloss.length === 0, `${label} should not add 60# gloss text, got ${gloss.join(', ')}`);
  assert(names.includes('60# Offset'), `${label} should keep 60# Offset`);
  assert(names.includes('80# Uncoated Text'), `${label} should include 80# Uncoated Text`);
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

function startServer(databaseFile) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...baseEnv(databaseFile) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let settled = false;
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const closed = new Promise((resolve) => child.on('close', resolve));
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
    closed,
    logs: () => logs,
    stop() {
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch (err) {
        // The process already exited.
      }
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

function orderBody(serviceIds, lineItems, extra = {}) {
  return {
    company: 'Catalog Co',
    contact_name: 'Riley Chen',
    phone: '919-555-0155',
    email: 'riley@catalog.example',
    project_name: 'Catalog fields',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '500 Field Road',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Accent Truck',
    due_date: weekdayIso(),
    due_time: '10:00',
    payment_method: 'Mastercard',
    service_ids: serviceIds,
    line_items: lineItems,
    ...extra,
  };
}

function signsValues(extra = {}) {
  return {
    product_type: 'Fence Screen',
    material: 'Banner',
    size: '6x3',
    qty: 2,
    ink: 'Outdoor',
    mount: 'No',
    laminate: 'Matte',
    finishing: ['Hems', 'Pole Pockets', 'Wind Slits'],
    ...extra,
  };
}

function fieldDisplay(item, key) {
  const field = (item.fields || []).find((row) => row.key === key);
  return field ? field.display : null;
}

function assertAliases() {
  const { validateLineFields } = fields;
  const finishing = {
    key: 'finishing',
    label: 'Finishing',
    type: 'multiselect',
    required: 1,
    is_active: 1,
    options_json: jsonOptions(signs.SIGNS_FINISHING),
  };
  const mount = {
    key: 'mount',
    label: 'Mount',
    type: 'select',
    required: 1,
    is_active: 1,
    options_json: jsonOptions(signs.SIGNS_MOUNT),
  };
  const laminate = {
    key: 'laminate',
    label: 'Laminate',
    type: 'select',
    required: 1,
    is_active: 1,
    options_json: jsonOptions(signs.SIGNS_LAMINATE),
  };
  const equipment = {
    key: 'equipment',
    label: 'Equipment',
    type: 'select',
    required: 1,
    is_active: 0,
    options_json: jsonOptions(signs.SIGNS_EQUIPMENT),
  };
  const legacy = validateLineFields(
    [finishing, mount, laminate, equipment],
    { finishing: 'Grommets', mount: 'Corplast', laminate: 'Matt', equipment: 'Flatbed' },
    'line item 1'
  );
  assert(legacy.error && /equipment/.test(legacy.error), `a new line should not accept equipment, got ${legacy.error || 'ok'}`);
  const edited = validateLineFields(
    [finishing, mount, laminate],
    { finishing: 'Grommets', mount: 'Corplast', laminate: 'Matt' },
    'line item 1'
  );
  assert(!edited.error, edited.error || 'legacy spellings should validate');
  assert(edited.value.finishing.join('|') === 'Grommets', 'a single finishing string should be kept');
  assert(edited.value.mount === 'Coroplast' && edited.value.laminate === 'Matte', 'old spellings should store the corrected option');
  const shown = fields.displayFieldList(
    [finishing, mount, laminate, equipment],
    { finishing: 'Grommets', mount: 'Corplast', laminate: 'Matt', equipment: 'Flatbed' }
  );
  const byKey = Object.fromEntries(shown.map((field) => [field.key, field.display]));
  assert(byKey.finishing === 'Grommets', 'a stored finishing string should display');
  assert(byKey.mount === 'Coroplast' && byKey.laminate === 'Matte', 'stored typos should display with the corrected spelling');
  assert(byKey.equipment === 'Flatbed', 'a stored equipment value should still display');
  assert(fields.canonicalPaymentMethod('Master Card') === 'Mastercard', 'Master Card should canonicalize');
  assert(fields.paymentMethodLabel('Master Card') === 'Mastercard', 'Master Card should display as Mastercard');
  assert(fields.paymentMethodLabel(null) === 'Not specified', 'a blank payment should stay Not specified');
}

async function assertFresh(db) {
  const count = await db.get('SELECT COUNT(*) AS count FROM service_fields');
  assert(count.count === 58, `fresh init should leave 58 service fields, found ${count.count}`);
  const signsFields = await fieldsFor(db, 'Signs & Graphics');
  const products = signsFields.get('product_type');
  assertExact(products, signs.SIGNS_PRODUCTS, 'fresh product type');
  assert(products.options_json.includes('Fence Screen') && products.options_json.includes('Construction Sign'), 'fresh product types should add the new signs');
  const equipment = signsFields.get('equipment');
  assert(equipment && equipment.is_active === 0, 'fresh equipment should be inactive, not deleted');
  assertExact(equipment, signs.SIGNS_EQUIPMENT, 'fresh equipment options');
  const finishing = signsFields.get('finishing');
  assert(finishing.type === 'multiselect' && finishing.required === 1, 'fresh finishing should be a required multiselect');
  assertExact(finishing, signs.SIGNS_FINISHING, 'fresh finishing');
  assertExact(signsFields.get('mount'), signs.SIGNS_MOUNT, 'fresh mount');
  assertExact(signsFields.get('laminate'), signs.SIGNS_LAMINATE, 'fresh laminate');
  for (const row of signsFields.values()) {
    if (row.type !== 'select' && row.type !== 'multiselect') continue;
    const names = activeNames(row.options_json);
    assert(!names.includes('Corplast') && !names.includes('Matt'), `${row.key} should not keep a typo`);
  }
  const small = await fieldsFor(db, 'Small Format');
  assertExact(small.get('media'), catalog.SMALL_FORMAT_PAPER, 'fresh paper');
  assertNoGlossText(activeNames(small.get('media').options_json), 'fresh paper');
  assert(activeNames(small.get('product').options_json).includes('Mailing Services'), 'Mailing Services should stay a Small Format product');
  assert(activeNames(small.get('finishing').options_json).includes('Bulk Mailing/EDDM'), 'Bulk Mailing/EDDM should stay a Small Format finishing option');
  const mailing = await db.get(`SELECT id FROM services WHERE name = 'Mailing'`);
  assert(!mailing, 'mailing should not be its own service');
}

async function restorePrevious(db) {
  const id = await serviceId(db, 'Signs & Graphics');
  for (const [key, previous] of Object.entries(signs.SIGNS_PREVIOUS)) {
    const updated = await db.run(
      `UPDATE service_fields
       SET label = ?, type = 'select', options_json = ?, is_active = 1
       WHERE service_id = ? AND key = ?`,
      [previous.label, jsonOptions(previous.options), id, key]
    );
    assert(updated.changes === 1, `previous ${key} row should be restored`);
  }
  const equipment = await db.run(
    `UPDATE service_fields SET is_active = 1 WHERE service_id = ? AND key = 'equipment'`,
    [id]
  );
  assert(equipment.changes === 1, 'equipment should be active before the upgrade');
  const smallId = await serviceId(db, 'Small Format');
  const paper = await db.run(
    `UPDATE service_fields SET options_json = ? WHERE service_id = ? AND key = 'media'`,
    [jsonOptions(catalog.SMALL_FORMAT_PAPER_BEFORE_UNCOATED), smallId]
  );
  assert(paper.changes === 1, 'previous paper list should be restored');
}

async function main() {
  assertAliases();
  console.log('PASS legacy values display and validate');

  await initDatabase(freshDb);
  await initDatabase(freshDb);
  const fresh = openDb(freshDb);
  await assertFresh(fresh);
  const freshFinishing = (await fieldsFor(fresh, 'Signs & Graphics')).get('finishing').options_json;
  await fresh.close();
  await initDatabase(freshDb);
  const again = openDb(freshDb);
  const againFinishing = (await fieldsFor(again, 'Signs & Graphics')).get('finishing').options_json;
  assert(againFinishing === freshFinishing, 'a second init should not rewrite an untouched finishing list');
  const againCount = await again.get('SELECT COUNT(*) AS count FROM service_fields');
  assert(againCount.count === 58, `a second init should not duplicate fields, found ${againCount.count}`);
  await again.close();
  console.log('PASS fresh catalog seed, twice');

  await initDatabase(upgradeDb);
  const before = openDb(upgradeDb);
  await restorePrevious(before);
  await before.close();
  await initDatabase(upgradeDb);
  await initDatabase(upgradeDb);
  const upgraded = openDb(upgradeDb);
  const upgradedSigns = await fieldsFor(upgraded, 'Signs & Graphics');
  assertExact(upgradedSigns.get('product_type'), signs.SIGNS_PRODUCTS, 'upgraded product type');
  assertExact(upgradedSigns.get('mount'), signs.SIGNS_MOUNT, 'upgraded mount');
  assertExact(upgradedSigns.get('laminate'), signs.SIGNS_LAMINATE, 'upgraded laminate');
  assert(upgradedSigns.get('finishing').type === 'multiselect', 'an untouched finishing field should become a multiselect');
  assertExact(upgradedSigns.get('finishing'), signs.SIGNS_FINISHING, 'upgraded finishing');
  assert(upgradedSigns.get('equipment').is_active === 0, 'upgrade should deactivate equipment');
  assertExact(await fieldsFor(upgraded, 'Small Format').then((rows) => rows.get('media')), catalog.SMALL_FORMAT_PAPER, 'upgraded paper');
  await upgraded.close();
  console.log('PASS untouched lists upgrade in seed order');

  await initDatabase(customDb);
  const custom = openDb(customDb);
  const signsId = await serviceId(custom, 'Signs & Graphics');
  const smallId = await serviceId(custom, 'Small Format');
  await custom.run(
    `UPDATE service_fields SET label = 'Job', options_json = ? WHERE service_id = ? AND key = 'product_type'`,
    [jsonOptions(['Yard Signs', 'Mylar Signs', 'Banners']), signsId]
  );
  await custom.run(
    `UPDATE service_fields SET options_json = ? WHERE service_id = ? AND key = 'laminate'`,
    [jsonOptions(['Gloss', 'Matt', 'Matte', 'Shop Film']), signsId]
  );
  await custom.run(
    `UPDATE service_fields SET type = 'select', options_json = ? WHERE service_id = ? AND key = 'finishing'`,
    [jsonOptions(['Grommets', 'Custom Hem']), signsId]
  );
  const equipmentOptions = jsonOptions(['Flatbed', 'Plotter']);
  await custom.run(
    `UPDATE service_fields SET is_active = 1, options_json = ? WHERE service_id = ? AND key = 'equipment'`,
    [equipmentOptions, signsId]
  );
  await custom.run(
    `UPDATE service_fields SET label = 'Stock', options_json = ? WHERE service_id = ? AND key = 'media'`,
    [JSON.stringify([
      { value: 'Shop Rag', active: true },
      ...catalog.SMALL_FORMAT_PAPER_BEFORE_UNCOATED.map((value) => ({ value, active: true })),
    ]), smallId]
  );
  await custom.close();
  await initDatabase(customDb);
  const customized = openDb(customDb);
  const customSigns = await fieldsFor(customized, 'Signs & Graphics');
  const product = customSigns.get('product_type');
  assert(product.label === 'Job', 'a renamed product field should keep the admin label');
  const productNames = activeNames(product.options_json);
  assert(productNames[0] === 'Yard Signs' && productNames[1] === 'Mylar Signs' && productNames[2] === 'Banners', 'admin product options should stay first');
  signs.SIGNS_PRODUCTS.forEach((name) => {
    assert(productNames.filter((value) => value.toLowerCase() === name.toLowerCase()).length === 1, `${name} should be present once`);
  });
  assert(productNames.includes('Mylar Signs'), 'an admin product should stay');
  const laminateNames = activeNames(customSigns.get('laminate').options_json);
  assert(laminateNames.filter((value) => value.toLowerCase() === 'matte').length === 1, 'Matt and Matte should merge to one Matte');
  assert(!laminateNames.includes('Matt'), 'the Matt typo should not remain beside Matte');
  assert(laminateNames.includes('Shop Film'), 'an admin laminate should stay');
  const finishing = customSigns.get('finishing');
  assert(finishing.type === 'select', 'a customised finishing field should keep the type the admin saved');
  const finishingNames = activeNames(finishing.options_json);
  assert(finishingNames[0] === 'Grommets' && finishingNames[1] === 'Custom Hem', 'admin finishing options should stay first');
  signs.SIGNS_FINISHING.forEach((name) => {
    assert(finishingNames.filter((value) => value.toLowerCase() === name.toLowerCase()).length === 1, `${name} should be present once`);
  });
  const equipment = customSigns.get('equipment');
  assert(equipment.is_active === 0, 'a customised equipment field should still be deactivated');
  assert(equipment.options_json === equipmentOptions, 'deactivating equipment should not rewrite the admin options');
  const mediaNames = activeNames((await fieldsFor(customized, 'Small Format')).get('media').options_json);
  assert(mediaNames[0] === 'Shop Rag', 'an admin paper should stay first');
  assert(mediaNames.filter((value) => value.toLowerCase() === '80# uncoated text').length === 1, '80# Uncoated Text should be added once');
  assertNoGlossText(mediaNames, 'custom paper');
  const beforeSecond = finishing.options_json;
  const equipmentBefore = equipment.options_json;
  await customized.close();
  await initDatabase(customDb);
  const customAgain = openDb(customDb);
  const againSigns = await fieldsFor(customAgain, 'Signs & Graphics');
  assert(againSigns.get('finishing').options_json === beforeSecond, 'a second init should not add the same finishing options again');
  assert(againSigns.get('equipment').is_active === 0 && againSigns.get('equipment').options_json === equipmentBefore, 'a second init should leave equipment inactive');
  await customAgain.close();
  console.log('PASS customised lists only gain missing options');

  const server = startServer(freshDb);
  await server.ready;
  try {
    const admin = await login('admin', adminPassword);
    const customerResponse = await request({
      method: 'POST',
      path: '/api/customers',
      token: admin.token,
      json: {
        display_name: 'Catalog Customer',
        username: 'catalogcust',
        password: 'CustomerPass1',
        company: 'Catalog Co',
        contact_name: 'Riley Chen',
        phone: '919-555-0155',
        email: 'riley@catalog.example',
      },
    });
    assert(customerResponse.status === 201, `customer create failed: ${customerResponse.text}`);
    const customer = await login('catalogcust', 'CustomerPass1');
    const options = await request({ method: 'GET', path: '/api/orders/options', token: customer.token });
    assert(options.status === 200, options.text);
    assert(options.json.payment_methods.includes('Mastercard'), 'payment methods should list Mastercard');
    assert(!options.json.payment_methods.includes('Master Card'), 'payment methods should not list Master Card');
    const byName = Object.fromEntries(options.json.services.map((service) => [service.name, service]));
    const signsService = byName['Signs & Graphics'];
    const smallService = byName['Small Format'];
    const signsByKey = Object.fromEntries(signsService.fields.map((field) => [field.key, field]));
    assert(!signsByKey.equipment, 'the order form should not offer Equipment');
    assert(signsByKey.product_type.options.includes('Fence Screen') && signsByKey.product_type.options.includes('Construction Sign'), 'the order form should offer the new product types');
    assert(signsByKey.finishing.type === 'multiselect', 'finishing should be a multiselect on the order form');
    assert(signsByKey.finishing.options.includes('Hems') && signsByKey.finishing.options.includes('Stakes'), 'the order form should offer the new finishing options');
    const smallByKey = Object.fromEntries(smallService.fields.map((field) => [field.key, field]));
    assert(smallByKey.media.options.includes('80# Uncoated Text'), 'paper stock should offer 80# Uncoated Text');
    assert(!smallByKey.media.options.some((name) => /60#/i.test(name) && /gloss/i.test(name)), 'paper stock should not offer 60# gloss text');
    assert(smallByKey.product.options.includes('Mailing Services'), 'Mailing Services should be on the order form');
    assert(smallByKey.finishing.options.includes('Bulk Mailing/EDDM'), 'Bulk Mailing/EDDM should be on the order form');

    const created = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody([signsService.id], [{
        description: 'New fence screen',
        service_id: signsService.id,
        field_values: signsValues(),
      }]),
    });
    assert(created.status === 201, `signs order failed: ${created.text}`);
    const createdLine = created.json.order.line_items[0];
    assert(fieldDisplay(createdLine, 'finishing') === 'Hems, Pole Pockets, Wind Slits', created.text);
    assert(fieldDisplay(createdLine, 'product_type') === 'Fence Screen', 'the new product type should be stored');
    assert(!createdLine.fields.some((field) => field.key === 'equipment'), 'a new line should not store equipment');
    const printed = await request({
      method: 'GET',
      path: `/api/orders/${created.json.order.id}/print`,
      token: customer.token,
    });
    assert(printed.status === 200, printed.text);
    assert(fieldDisplay(printed.json.work_orders[0].line_items[0], 'finishing') === 'Hems, Pole Pockets, Wind Slits', 'print should show each finishing choice');

    const card = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody([signsService.id], [{
        service_id: signsService.id,
        field_values: signsValues({ product_type: 'Construction Sign', finishing: 'Stakes', mount: 'Corplast', laminate: 'Matt' }),
      }], { payment_method: 'Master Card', project_name: 'Legacy spellings' }),
    });
    assert(card.status === 201, `alias order failed: ${card.text}`);
    assert(card.json.order.payment_method === 'Mastercard', 'Master Card should be stored as Mastercard');
    assert(card.json.order.payment_method_label === 'Mastercard', 'the payment label should be Mastercard');
    const aliasLine = card.json.order.line_items[0];
    assert(aliasLine.field_values.mount === 'Coroplast' && aliasLine.field_values.laminate === 'Matte', 'submitted typos should be stored corrected');
    assert(aliasLine.field_values.finishing.join('|') === 'Stakes', 'a single finishing string should be stored as a list');
    assert(fieldDisplay(aliasLine, 'finishing') === 'Stakes', 'a submitted finishing string should display');

    const withEquipment = await request({
      method: 'POST',
      path: '/api/orders',
      token: customer.token,
      json: orderBody([signsService.id], [{
        service_id: signsService.id,
        field_values: signsValues({ equipment: 'Flatbed' }),
      }]),
    });
    assert(withEquipment.status === 400 && /equipment/.test(withEquipment.json.error || ''), withEquipment.text);

    server.stop();
    await server.closed;

    const legacyValues = {
      product_type: 'Banners',
      equipment: 'Flatbed',
      material: 'Banner',
      size: '3x6',
      qty: 2,
      ink: 'Outdoor',
      mount: 'Corplast',
      laminate: 'Matt',
      finishing: 'Grommets',
    };
    const parked = openDb(freshDb);
    await parked.run(`UPDATE orders SET payment_method = 'Master Card' WHERE id = ?`, [created.json.order.id]);
    await parked.run(
      `UPDATE order_line_items SET field_values = ?, finishing = 'Grommets', description = 'Legacy fence banner' WHERE order_id = ?`,
      [JSON.stringify(legacyValues), created.json.order.id]
    );
    await parked.close();
    await initDatabase(freshDb);
    const migrated = openDb(freshDb);
    const payment = await migrated.get('SELECT payment_method FROM orders WHERE id = ?', [created.json.order.id]);
    assert(payment.payment_method === 'Mastercard', 'init should rewrite Master Card to Mastercard');
    const storedLine = await migrated.get('SELECT field_values FROM order_line_items WHERE order_id = ?', [created.json.order.id]);
    assert(storedLine.field_values.includes('Corplast') && storedLine.field_values.includes('"finishing":"Grommets"'), 'init should not rewrite stored line JSON');
    await migrated.close();

    const restarted = startServer(freshDb);
    await restarted.ready;
    try {
      const adminAgain = await login('admin', adminPassword);
      const customerAgain = await login('catalogcust', 'CustomerPass1');
      const loaded = await request({
        method: 'GET',
        path: `/api/orders/${created.json.order.id}`,
        token: customerAgain.token,
      });
      assert(loaded.status === 200, loaded.text);
      assert(loaded.json.order.payment_method === 'Mastercard', 'the migrated payment should stay Mastercard');
      assert(loaded.json.order.payment_method_label === 'Mastercard', 'the migrated payment should display as Mastercard');
      const line = loaded.json.order.line_items[0];
      assert(line.field_values.mount === 'Corplast' && line.field_values.laminate === 'Matt', 'stored typos should remain in field_values');
      assert(line.field_values.finishing === 'Grommets', 'a stored finishing string should remain a string');
      assert(fieldDisplay(line, 'mount') === 'Coroplast', 'order detail should show Coroplast');
      assert(fieldDisplay(line, 'laminate') === 'Matte', 'order detail should show Matte');
      assert(fieldDisplay(line, 'finishing') === 'Grommets', 'order detail should show the finishing string');
      assert(fieldDisplay(line, 'equipment') === 'Flatbed', 'order detail should show the equipment value');
      const legacyPrint = await request({
        method: 'GET',
        path: `/api/orders/${created.json.order.id}/print`,
        token: customerAgain.token,
      });
      assert(legacyPrint.status === 200, legacyPrint.text);
      const printLine = legacyPrint.json.work_orders[0].line_items[0];
      assert(fieldDisplay(printLine, 'equipment') === 'Flatbed', 'the print should show equipment');
      assert(fieldDisplay(printLine, 'finishing') === 'Grommets', 'the print should show the finishing string');
      assert(fieldDisplay(printLine, 'mount') === 'Coroplast' && fieldDisplay(printLine, 'laminate') === 'Matte', 'the print should show the corrected spellings');
      const workOrder = await request({
        method: 'GET',
        path: `/api/workorders/${created.json.work_orders[0].id}`,
        token: adminAgain.token,
      });
      assert(workOrder.status === 200, workOrder.text);
      const spec = JSON.stringify(workOrder.json.specification_lines || []);
      assert(spec.includes('Equipment') && spec.includes('Flatbed'), 'work order detail should show equipment');
      assert(spec.includes('Grommets') && spec.includes('Coroplast') && spec.includes('Matte'), 'work order detail should show the legacy answers');
      console.log('PASS orders accept the new lists and legacy rows still render');
    } finally {
      restarted.stop();
      await restarted.closed;
    }
  } finally {
    server.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
