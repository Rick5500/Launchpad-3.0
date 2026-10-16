require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();

const { seedServiceFields } = require('./serviceFields');
const {
  DEFAULT_LOCATION_STAGES,
  LEGACY_MIGRATION_SETTING,
  LEGACY_STAGE_SEEDS,
  legacySeedFor,
  isOriginalLegacySeed,
  sameText,
} = require('./barcodeLocationDefaults');
const BCRYPT_ROUNDS = 10;
const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'database', 'launchpad.db');
const db = new sqlite3.Database(dbFile);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function closeDb() {
  return new Promise((resolve) => {
    db.close(() => resolve());
  });
}

async function ensureColumns(table, columns) {
  const rows = await all(`PRAGMA table_info(${table})`);
  const existingColumns = new Set(rows.map((row) => row.name));
  for (const column of columns) {
    if (existingColumns.has(column.name)) continue;
    await run(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`);
  }
}

async function ensureDepartmentsTable() {
  const row = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'departments'`);
  if (row) return;
  await run(`CREATE TABLE departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    color TEXT DEFAULT '#90caf9',
    icon TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  )`);
}

async function ensureProductionStagesTable() {
  const row = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'production_stages'`);
  if (row) return;
  await run(`CREATE TABLE production_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#90caf9',
    icon TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  )`);
}

async function seedAdmin() {
  const existing = await get('SELECT id FROM users WHERE username = ?', ['admin']);
  if (existing) {
    console.log('Admin user already exists');
    return;
  }

  const fromEnv = process.env.INIT_ADMIN_PASSWORD;
  const generated = !(typeof fromEnv === 'string' && fromEnv.length > 0);
  const password = generated ? crypto.randomBytes(18).toString('base64url') : fromEnv;
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await run(
    'INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)',
    ['admin', passwordHash, 'admin', 'Administrator']
  );

  if (generated) {
    console.log('Admin user created: username=admin');
    console.log(`Generated admin password (shown once): ${password}`);
  } else {
    console.log('Admin user created: username=admin (password taken from INIT_ADMIN_PASSWORD; not logged)');
  }
}

async function seedCustomers() {
  const customers = [
    ['acme', 'ACME Corp'],
    ['whitebox', 'Whitebox Industries'],
    ['orion', 'Orion Supplies'],
  ];

  for (const [username, displayName] of customers) {
    const existing = await get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      console.log(`Customer user already exists: ${username}`);
    } else {
      const passwordHash = await bcrypt.hash(crypto.randomBytes(18).toString('base64url'), BCRYPT_ROUNDS);
      await run(
        'INSERT INTO users (username, password_hash, role, display_name, company) VALUES (?,?,?,?,?)',
        [username, passwordHash, 'customer', displayName, displayName]
      );
      console.log(`Seeded customer user ${username} (no password issued)`);
    }

    await run(
      `UPDATE users
       SET company = display_name
       WHERE username = ? AND role = 'customer' AND (company IS NULL OR trim(company) = '')`,
      [username]
    );
  }
}

async function seedDepartments() {
  const departments = [
    ['Large Format', 'Plans, drawings, and bid sets', '#1E88E5', 'description', 1, 1],
    ['Small Format', 'Small format print production', '#43A047', 'print', 2, 1],
    ['Signs & Graphics', 'Banners, signs, and graphics', '#8E24AA', 'branding_watermark', 3, 1],
    ['Scanning', 'Scanning, OCR, and indexing', '#FB8C00', 'scanner', 4, 1],
    ['Planroom', 'Project distribution and bids', '#00897B', 'groups', 5, 1],
    ['Archive File', 'Archive retrieval', '#78909C', 'inventory_2', 6, 1],
    ['Quality', 'Quality check before dispatch', '#F9A825', 'verified', 7, 1],
    ['Dispatch', 'Ready for handoff and delivery', '#1565C0', 'outbound', 8, 1],
    ['Delivery', 'Logistics and outbound delivery', '#ef5350', 'local_shipping', 9, 1],
    ['Complete', 'Finished work orders', '#2E7D32', 'check_circle', 10, 1],
    ['Reprographics', 'Reproduction and copy projects', '#7e57c2', 'copy_all', 11, 1],
    ['Admin', 'Administrative and ops support', '#78909c', 'admin_panel_settings', 12, 1],
  ];

  for (const department of departments) {
    const existing = await get('SELECT id FROM departments WHERE name = ?', [department[0]]);
    if (existing) continue;
    await run(
      'INSERT INTO departments (name, description, color, icon, sort_order, is_active) VALUES (?,?,?,?,?,?)',
      department
    );
  }
}

async function applyDepartmentRoutes() {
  // Only rows that an administrator has not edited (updated_at is still null).
  const routes = [
    ['Large Format', 'Quality', 1],
    ['Small Format', 'Quality', 2],
    ['Signs & Graphics', 'Quality', 3],
    ['Scanning', 'Quality', 4],
    ['Planroom', 'Quality', 5],
    ['Archive File', 'Quality', 6],
    ['Quality', 'Dispatch', 7],
    ['Dispatch', 'Delivery', 8],
    ['Delivery', 'Complete', 9],
    ['Complete', null, 10],
    ['Reprographics', 'Quality', 11],
    ['Admin', null, 12],
  ];

  for (const [name, nextDepartment, sortOrder] of routes) {
    await run(
      `UPDATE departments
       SET next_department = ?, sort_order = ?
       WHERE name = ? AND updated_at IS NULL`,
      [nextDepartment, sortOrder, name]
    );
  }
}

const SERVICE_CODES = {
  'Large Format': 'LF',
  'Small Format': 'SF',
  'Signs & Graphics': 'SG',
  Scanning: 'SC',
  Planroom: 'PL',
  'Archive File Request': 'AF',
  'Ship To (3rd Party)': 'ST',
};

async function seedServices() {
  const services = [
    ['Large Format', 'Plans, Drawings, Bid Sets', 'Large Format', 1, 0],
    ['Small Format', 'Specifications, Manuals, Reports', 'Small Format', 2, 0],
    ['Signs & Graphics', 'Banners, Signs, Graphics', 'Signs & Graphics', 3, 0],
    ['Scanning', 'Scanning, OCR, Indexing', 'Scanning', 4, 0],
    ['Planroom', 'Project Distribution, Bids', 'Planroom', 5, 0],
    ['Archive File Request', 'Archive Retrieval', 'Archive File', 6, 1],
    ['Ship To (3rd Party)', 'Third Party Shipping', 'Delivery', 7, 0],
  ];

  for (const service of services) {
    const existing = await get('SELECT id FROM services WHERE name = ?', [service[0]]);
    if (existing) continue;
    await run(
      `INSERT INTO services (
         name, description, department_name, sort_order, requires_approval, is_active, code, suffix_mode
       ) VALUES (?,?,?,?,?,1,?, 'sequence')`,
      [...service, SERVICE_CODES[service[0]]]
    );
  }
}

async function backfillServiceCodes() {
  for (const [name, code] of Object.entries(SERVICE_CODES)) {
    await run(
      `UPDATE services SET code = ? WHERE name = ? AND (code IS NULL OR trim(code) = '')`,
      [code, name]
    );
  }
  await run(
    `UPDATE services SET suffix_mode = 'sequence' WHERE suffix_mode IS NULL OR trim(suffix_mode) = ''`
  );
}

async function ensureServiceCodeIndex() {
  const duplicate = await get(
    `SELECT code FROM services
     WHERE code IS NOT NULL AND trim(code) != ''
     GROUP BY lower(code)
     HAVING COUNT(*) > 1
     LIMIT 1`
  );
  if (duplicate) {
    console.warn(`Skipping unique index on services.code because duplicates exist (${duplicate.code})`);
    return;
  }
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_services_code ON services(code)');
}

async function seedDeliveryMethods() {
  const { ACTIVE_DELIVERY_METHODS, RETIRED_DELIVERY_METHODS } = require('./deliveryRules');
  for (const method of ACTIVE_DELIVERY_METHODS) {
    const existing = await get('SELECT id FROM delivery_methods WHERE name = ?', [method.name]);
    if (existing) continue;
    await run(
      'INSERT INTO delivery_methods (name, will_call, sort_order, is_active) VALUES (?,?,?,1)',
      [method.name, method.willCall ? 1 : 0, method.sortOrder]
    );
  }
  // Retired names stay in the table when an older database already has them.
  // Deactivating hides them from new orders. Rows and existing order labels are kept.
  for (const method of RETIRED_DELIVERY_METHODS) {
    await run(
      'UPDATE delivery_methods SET is_active = 0 WHERE lower(name) = lower(?) AND is_active != 0',
      [method.name]
    );
  }
}

async function seedNotificationSettings() {
  const events = [
    ['order_submitted', 0, 'email'],
    ['work_order_status', 0, 'email'],
    ['delivery_reminder', 0, 'email'],
    ['delivery_overdue', 1, 'in_app'],
    ['delivery_due_soon', 1, 'in_app'],
    ['work_order_on_hold', 1, 'in_app'],
    ['work_order_completed', 1, 'in_app'],
    ['work_order_rush', 1, 'in_app'],
  ];

  for (const event of events) {
    const existing = await get('SELECT id FROM notification_settings WHERE event_key = ?', [event[0]]);
    if (existing) continue;
    await run(
      'INSERT INTO notification_settings (event_key, enabled, channel, updated_at) VALUES (?,?,?,datetime(\'now\'))',
      event
    );
  }
}

async function seedStages() {
  const stages = [
    ['New', '#90caf9', 'fiber_new', 1],
    ['Estimating', '#42a5f5', 'calculate', 2],
    ['Customer Approval', '#ffb300', 'thumb_up', 3],
    ['Prepress', '#26a69a', 'print', 4],
    ['Small Format', '#7e57c2', 'print', 5],
    ['Signs & Graphics', '#ef5350', 'branding_watermark', 6],
    ['Reprographics', '#8d6e63', 'copy_all', 7],
    ['Scanning', '#26c6da', 'scanner', 8],
    ['Finishing', '#ab47bc', 'build', 9],
    ['Quality Control', '#66bb6a', 'verified', 10],
    ['Shipping', '#f06292', 'local_shipping', 11],
    ['Completed', '#2e7d32', 'check_circle', 12],
  ];

  for (const stage of stages) {
    const existing = await get('SELECT id FROM production_stages WHERE name = ?', [stage[0]]);
    if (existing) continue;
    await run('INSERT INTO production_stages (name, color, icon, sort_order) VALUES (?,?,?,?)', stage);
  }
}

async function seedSampleOrders() {
  const customer = await get('SELECT id FROM users WHERE username = ?', ['acme']);
  if (!customer) {
    console.log('Skipping sample work orders because customer user acme is missing');
    return;
  }

  const orders = [
    ['WO-1001', customer.id, 'Laser cutter setup for batch A', 120, 'open', 'Manufacturing', '2026-07-12'],
    ['WO-1002', customer.id, 'Finish assembly line parts', 48, 'in-progress', 'Assembly', '2026-07-09'],
    ['WO-1003', customer.id, 'Quality review and packing', 36, 'open', 'Quality', '2026-07-11'],
  ];

  for (const order of orders) {
    const existing = await get('SELECT id FROM work_orders WHERE external_id = ?', [order[0]]);
    if (existing) continue;
    await run(
      'INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department, due_date) VALUES (?,?,?,?,?,?,?)',
      order
    );
  }
}

async function seedProductionBoard() {
  const samples = [
    ['WO-1001', 'Cutting', 1, 'in-progress'],
    ['WO-1002', 'Assembly', 2, 'open'],
    ['WO-1003', 'Inspection', 3, 'open'],
  ];

  for (const [externalId, lane, position, status] of samples) {
    const order = await get('SELECT id FROM work_orders WHERE external_id = ?', [externalId]);
    if (!order) continue;
    const existing = await get('SELECT id FROM production_board WHERE work_order_id = ? AND lane = ?', [order.id, lane]);
    if (existing) continue;
    await run(
      'INSERT INTO production_board (work_order_id, lane, position, status) VALUES (?,?,?,?)',
      [order.id, lane, position, status]
    );
  }
}

async function seedDeliveries() {
  const samples = [
    ['WO-1001', 0, '2026-07-15 14:00:00', 'FedEx', 'pending'],
    ['WO-1003', 1, '2026-07-14 18:00:00', 'Will Call', 'pending'],
  ];

  for (const [externalId, willCall, dueTime, carrier, status] of samples) {
    const order = await get('SELECT id FROM work_orders WHERE external_id = ?', [externalId]);
    if (!order) continue;
    const existing = await get('SELECT id FROM deliveries WHERE work_order_id = ? AND carrier = ?', [order.id, carrier]);
    if (existing) continue;
    await run(
      'INSERT INTO deliveries (work_order_id, will_call, due_time, carrier, status) VALUES (?,?,?,?,?)',
      [order.id, willCall, dueTime, carrier, status]
    );
  }
}

async function ensureNotifications() {
  await run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    customer_id INTEGER,
    work_order_id INTEGER,
    delivery_id INTEGER,
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES users(id),
    FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
    FOREIGN KEY(delivery_id) REFERENCES deliveries(id)
  )`);
  await ensureColumns('notifications', [
    { name: 'type', definition: 'TEXT' },
    { name: 'title', definition: 'TEXT' },
    { name: 'body', definition: 'TEXT' },
    { name: 'customer_id', definition: 'INTEGER' },
    { name: 'work_order_id', definition: 'INTEGER' },
    { name: 'delivery_id', definition: 'INTEGER' },
    { name: 'dedupe_key', definition: 'TEXT' },
    { name: 'created_at', definition: 'DATETIME' },
  ]);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key ON notifications(dedupe_key)');
  await run('CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)');
  await run('CREATE INDEX IF NOT EXISTS idx_notifications_customer_id ON notifications(customer_id)');

  await run(`CREATE TABLE IF NOT EXISTS notification_reads (
    notification_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (notification_id, user_id),
    FOREIGN KEY(notification_id) REFERENCES notifications(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  await ensureColumns('notification_reads', [
    { name: 'notification_id', definition: 'INTEGER' },
    { name: 'user_id', definition: 'INTEGER' },
    { name: 'read_at', definition: 'DATETIME' },
  ]);
  await run('CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON notification_reads(user_id)');
}

async function normalizeLegacyWorkOrderStatuses() {
  const result = await run(
    `UPDATE work_orders
     SET status = 'completed', updated_at = datetime('now')
     WHERE lower(trim(status)) = 'complete'`
  );
  if (result.changes > 0) {
    console.log(`Normalized ${result.changes} legacy work order status value(s) from complete to completed`);
  }
}

function parseStageMap(raw) {
  const text = raw === undefined ? DEFAULT_LOCATION_STAGES : String(raw).trim();
  const entries = [];
  if (!text) return entries;
  for (const pair of text.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const location = pair.slice(0, separator).trim();
    const stage = pair.slice(separator + 1).trim();
    if (!location || !stage) continue;
    const key = location.toLowerCase();
    const existing = entries.findIndex((entry) => entry.location.toLowerCase() === key);
    if (existing >= 0) entries.splice(existing, 1);
    entries.push({ location, stage });
  }
  return entries;
}

async function seedSystemSettings() {
  const defaults = [
    ['company_name', 'Accent Imaging, Inc.'],
    ['company_address', '8121 Brownleigh Drive\nRaleigh, NC 27617'],
    ['company_phone', '919-782-3332'],
  ];
  for (const [key, value] of defaults) {
    const existing = await get('SELECT key FROM system_settings WHERE key = ?', [key]);
    if (existing) continue;
    await run(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?,?,datetime('now'))`,
      [key, value]
    );
  }
}

async function markBarcodeLocationsSeeded() {
  const existing = await get(`SELECT key FROM system_settings WHERE key = 'barcode_locations_seeded'`);
  if (existing) return;
  await run(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('barcode_locations_seeded', '1', datetime('now'))`
  );
}

async function attachStageToLocation(locationName, stageName) {
  const existing = await get(
    `SELECT id, stage_name FROM barcode_locations WHERE lower(location) = lower(?)`,
    [locationName]
  );
  if (!existing) return false;
  if (String(existing.stage_name || '').trim()) return true;
  await run(
    `UPDATE barcode_locations
     SET stage_name = ?, updated_at = datetime('now')
     WHERE id = ? AND (stage_name IS NULL OR trim(stage_name) = '')`,
    [stageName, existing.id]
  );
  return true;
}

async function insertBarcodeLocation({ location, departmentName, stageName, sortOrder, isActive }) {
  await run(
    `INSERT INTO barcode_locations (location, department_name, stage_name, sort_order, is_active, updated_at)
     VALUES (?,?,?,?,?,datetime('now'))`,
    [location, departmentName, stageName, sortOrder, isActive]
  );
}

async function seedBarcodeLocations() {
  const flagged = await get(`SELECT key FROM system_settings WHERE key = 'barcode_locations_seeded'`);
  if (flagged) return;
  const countRow = await get('SELECT COUNT(*) AS count FROM barcode_locations');
  if (countRow && countRow.count > 0) {
    await markBarcodeLocationsSeeded();
    return;
  }
  const departments = await all(
    'SELECT name, sort_order FROM departments WHERE is_active = 1 ORDER BY sort_order, name'
  );
  for (const department of departments) {
    await insertBarcodeLocation({
      location: department.name,
      departmentName: department.name,
      stageName: null,
      sortOrder: department.sort_order || 0,
      isActive: 1,
    });
  }
  const stages = parseStageMap(process.env.BARCODE_LOCATION_STAGES);
  let sort = 100;
  for (const entry of stages) {
    const alias = legacySeedFor(entry.location);
    if (alias && alias.department) {
      const applied = await attachStageToLocation(alias.department, entry.stage);
      if (!applied) {
        const department = await get(
          `SELECT name, sort_order FROM departments WHERE is_active = 1 AND lower(name) = lower(?)`,
          [alias.department]
        );
        if (department) {
          await insertBarcodeLocation({
            location: department.name,
            departmentName: department.name,
            stageName: entry.stage,
            sortOrder: department.sort_order || sort,
            isActive: 1,
          });
        }
      }
      continue;
    }
    if (alias && alias.deactivate) {
      await insertBarcodeLocation({
        location: entry.location,
        departmentName: null,
        stageName: entry.stage,
        sortOrder: sort,
        isActive: 0,
      });
      sort += 1;
      continue;
    }
    const attached = await attachStageToLocation(entry.location, entry.stage);
    if (!attached) {
      await insertBarcodeLocation({
        location: entry.location,
        departmentName: null,
        stageName: entry.stage,
        sortOrder: sort,
        isActive: 1,
      });
      sort += 1;
    }
  }
  await markBarcodeLocationsSeeded();
}

// One pass for databases seeded before scan locations followed department names.
// Only a row that still matches the original stage-only seed is changed.
// An admin who set a department, changed the stage, or turned the row off is left alone.
async function migrateLegacyBarcodeLocations() {
  const table = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'barcode_locations'`);
  if (!table) return;
  const settings = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_settings'`);
  if (!settings) return;
  const flagged = await get(`SELECT key FROM system_settings WHERE key = ?`, [LEGACY_MIGRATION_SETTING]);
  if (flagged) return;

  const rows = await all(
    `SELECT id, location, department_name, stage_name, is_active FROM barcode_locations`
  );
  let changed = 0;
  for (const seed of LEGACY_STAGE_SEEDS) {
    const row = rows.find((candidate) => isOriginalLegacySeed(candidate, seed));
    if (!row) continue;
    if (!seed.department || seed.deactivate) {
      const result = await run(
        `UPDATE barcode_locations
         SET is_active = 0, updated_at = datetime('now')
         WHERE id = ?
           AND (department_name IS NULL OR trim(department_name) = '')
           AND lower(location) = lower(?)
           AND lower(stage_name) = lower(?)
           AND COALESCE(is_active, 1) = 1`,
        [row.id, seed.location, seed.stage]
      );
      changed += result.changes;
      continue;
    }
    const department = await get(
      `SELECT name FROM departments WHERE is_active = 1 AND lower(name) = lower(?)`,
      [seed.department]
    );
    if (!department) continue;
    const duplicate = rows.find((candidate) => (
      candidate.id !== row.id
      && Number(candidate.is_active) !== 0
      && sameText(candidate.location, department.name)
      && sameText(candidate.department_name, department.name)
    ));
    if (duplicate && !String(duplicate.stage_name || '').trim()) {
      const staged = await run(
        `UPDATE barcode_locations
         SET stage_name = ?, updated_at = datetime('now')
         WHERE id = ?
           AND (stage_name IS NULL OR trim(stage_name) = '')
           AND lower(location) = lower(?)
           AND lower(department_name) = lower(?)`,
        [seed.stage, duplicate.id, department.name, department.name]
      );
      changed += staged.changes;
    }
    const result = await run(
      `UPDATE barcode_locations
       SET department_name = ?, is_active = ?, updated_at = datetime('now')
       WHERE id = ?
         AND (department_name IS NULL OR trim(department_name) = '')
         AND lower(location) = lower(?)
         AND lower(stage_name) = lower(?)
         AND COALESCE(is_active, 1) = 1`,
      [department.name, duplicate ? 0 : 1, row.id, seed.location, seed.stage]
    );
    changed += result.changes;
  }
  await run(
    `INSERT INTO system_settings (key, value, updated_at) VALUES (?, '1', datetime('now'))`,
    [LEGACY_MIGRATION_SETTING]
  );
  if (changed > 0) {
    console.log(`Updated ${changed} legacy barcode location row(s) to follow department names`);
  }
}

async function main() {
  await exec(schema);
  await ensureColumns('work_orders', [
    { name: 'department', definition: "TEXT DEFAULT 'General'" },
    { name: 'specifications', definition: 'TEXT' },
    { name: 'start_date', definition: 'DATETIME' },
    { name: 'production_line', definition: 'TEXT' },
    { name: 'routing_instructions', definition: 'TEXT' },
    { name: 'attachments', definition: 'TEXT' },
    { name: 'notes', definition: 'TEXT' },
  ]);
  await ensureDepartmentsTable();
  await ensureProductionStagesTable();
  await ensureColumns('work_orders', [
    { name: 'stage_id', definition: 'INTEGER' },
    { name: 'priority', definition: "TEXT DEFAULT 'Normal'" },
    { name: 'assigned_department_id', definition: 'INTEGER' },
    { name: 'assigned_user_id', definition: 'INTEGER' },
    { name: 'estimated_hours', definition: 'REAL' },
    { name: 'actual_hours', definition: 'REAL' },
  ]);
  await ensureColumns('barcode_events', [
    { name: 'stage_id', definition: 'INTEGER' },
    { name: 'from_department', definition: 'TEXT' },
    { name: 'to_department', definition: 'TEXT' },
  ]);
  await ensureColumns('deliveries', [
    { name: 'updated_at', definition: 'DATETIME' },
    { name: 'order_id', definition: 'INTEGER' },
  ]);
  await ensureColumns('users', [
    { name: 'company', definition: 'TEXT' },
    { name: 'contact_name', definition: 'TEXT' },
    { name: 'phone', definition: 'TEXT' },
    { name: 'email', definition: 'TEXT' },
    { name: 'address_line1', definition: 'TEXT' },
    { name: 'address_line2', definition: 'TEXT' },
    { name: 'city', definition: 'TEXT' },
    { name: 'state', definition: 'TEXT' },
    { name: 'zip', definition: 'TEXT' },
    { name: 'department', definition: 'TEXT' },
    { name: 'is_active', definition: 'INTEGER DEFAULT 1' },
    { name: 'updated_at', definition: 'DATETIME' },
  ]);
  await run('UPDATE users SET is_active = 1 WHERE is_active IS NULL');
  await ensureColumns('services', [
    { name: 'code', definition: 'TEXT' },
    { name: 'suffix_mode', definition: "TEXT DEFAULT 'sequence'" },
    { name: 'default_turnaround_hours', definition: 'INTEGER' },
    { name: 'updated_at', definition: 'DATETIME' },
  ]);
  await ensureColumns('departments', [
    { name: 'next_department', definition: 'TEXT' },
  ]);
  await ensureColumns('work_orders', [
    { name: 'order_id', definition: 'INTEGER' },
    { name: 'service_id', definition: 'INTEGER' },
    { name: 'next_department', definition: 'TEXT' },
    { name: 'requires_approval', definition: 'INTEGER DEFAULT 0' },
    { name: 'approval_status', definition: 'TEXT' },
    { name: 'approval_by', definition: 'INTEGER' },
    { name: 'approval_at', definition: 'DATETIME' },
  ]);
  await ensureColumns('orders', [
    { name: 'ups_account_number', definition: 'TEXT' },
    { name: 'originals_source', definition: 'TEXT' },
    { name: 'address_line1', definition: 'TEXT' },
    { name: 'address_line2', definition: 'TEXT' },
    { name: 'city', definition: 'TEXT' },
    { name: 'state', definition: 'TEXT' },
    { name: 'zip', definition: 'TEXT' },
    { name: 'payment_method', definition: 'TEXT' },
    { name: 'return_to', definition: 'TEXT' },
    { name: 'bill_to_name', definition: 'TEXT' },
    { name: 'bill_to_phone', definition: 'TEXT' },
    { name: 'bill_to_email', definition: 'TEXT' },
    { name: 'bill_to_company', definition: 'TEXT' },
    { name: 'bill_to_address_line1', definition: 'TEXT' },
    { name: 'bill_to_address_line2', definition: 'TEXT' },
    { name: 'bill_to_city', definition: 'TEXT' },
    { name: 'bill_to_state', definition: 'TEXT' },
    { name: 'bill_to_zip', definition: 'TEXT' },
  ]);
  await ensureColumns('order_line_items', [
    { name: 'field_values', definition: 'TEXT' },
  ]);
  await run('CREATE INDEX IF NOT EXISTS idx_service_fields_service ON service_fields(service_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_work_orders_order_id ON work_orders(order_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_work_orders_service_id ON work_orders(service_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_deliveries_order_id ON deliveries(order_id)');
  await ensureNotifications();
  await seedAdmin();
  await seedCustomers();
  await seedDepartments();
  await applyDepartmentRoutes();
  await seedServices();
  await seedServiceFields(run, get);
  await backfillServiceCodes();
  await ensureServiceCodeIndex();
  await seedDeliveryMethods();
  await seedNotificationSettings();
  await seedStages();
  await seedSystemSettings();
  await seedBarcodeLocations();
  await migrateLegacyBarcodeLocations();
  await seedSampleOrders();
  await seedProductionBoard();
  await seedDeliveries();
  await normalizeLegacyWorkOrderStatuses();
  await ensureExternalIdUniqueIndex();
  console.log('Database initialization complete.');
}

async function ensureExternalIdUniqueIndex() {
  const duplicate = await get(
    `SELECT external_id
     FROM work_orders
     WHERE external_id IS NOT NULL
     GROUP BY external_id
     HAVING COUNT(*) > 1
     LIMIT 1`
  );
  if (duplicate) {
    console.warn(
      `Skipping unique index on work_orders.external_id because duplicate values exist (example: ${duplicate.external_id})`
    );
    return;
  }
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_work_orders_external_id ON work_orders(external_id)');
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    closeDb().finally(() => process.exit(1));
  });
