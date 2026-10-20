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
    show_on_board INTEGER NOT NULL DEFAULT 1,
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
  const existing = await get('SELECT id FROM users WHERE lower(username) = lower(?)', ['admin']);
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
    const existing = await get('SELECT id FROM users WHERE lower(username) = lower(?)', [username]);
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
       WHERE lower(username) = lower(?) AND role = 'customer' AND (company IS NULL OR trim(company) = '')`,
      [username]
    );
  }
}

// Names already considered by seed. A renamed default stays in this list so a
// later init does not insert the old name again. A name added to DEPARTMENT_SEEDS
// after the flag exists is inserted once.
const DEPARTMENT_SEED_SETTING = 'departments_seeded';
// The tabs the board listed before show_on_board existed. Reprographics and
// Admin stay off that list so an upgraded database matches the old board.
const BOARD_DEPARTMENT_NAMES = new Set([
  'large format',
  'small format',
  'signs & graphics',
  'scanning',
  'planroom',
  'archive file',
  'quality',
  'dispatch',
  'delivery',
  'complete',
]);

function seedShowsOnBoard(name) {
  return BOARD_DEPARTMENT_NAMES.has(String(name || '').trim().toLowerCase()) ? 1 : 0;
}
const DEPARTMENT_SEEDS = [
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

async function readSeededDepartmentNames() {
  const row = await get('SELECT value FROM system_settings WHERE key = ?', [DEPARTMENT_SEED_SETTING]);
  if (!row || row.value == null) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((name) => String(name));
  } catch (err) {
    return null;
  }
}

async function writeSeededDepartmentNames(names) {
  const value = JSON.stringify(names);
  const existing = await get('SELECT key FROM system_settings WHERE key = ?', [DEPARTMENT_SEED_SETTING]);
  if (existing) {
    await run(
      `UPDATE system_settings SET value = ?, updated_at = datetime('now') WHERE key = ?`,
      [value, DEPARTMENT_SEED_SETTING]
    );
    return;
  }
  await run(
    `INSERT INTO system_settings (key, value, updated_at) VALUES (?,?,datetime('now'))`,
    [DEPARTMENT_SEED_SETTING, value]
  );
}

async function insertDepartmentSeed(department) {
  await run(
    `INSERT INTO departments (name, description, color, icon, sort_order, is_active, show_on_board)
     VALUES (?,?,?,?,?,?,?)`,
    [...department, seedShowsOnBoard(department[0])]
  );
}

// Backfill only when this init adds the column. A later init leaves an
// administrator's toggle alone, and new departments default to shown.
async function ensureShowOnBoard() {
  const rows = await all('PRAGMA table_info(departments)');
  if (rows.some((row) => row.name === 'show_on_board')) return;
  await run('ALTER TABLE departments ADD COLUMN show_on_board INTEGER NOT NULL DEFAULT 1');
  const names = [...BOARD_DEPARTMENT_NAMES];
  await run(
    `UPDATE departments
     SET show_on_board = CASE
       WHEN lower(trim(name)) IN (${names.map(() => '?').join(',')}) THEN 1
       ELSE 0
     END`,
    names
  );
}

async function seedDepartments() {
  const tracked = await readSeededDepartmentNames();
  const countRow = await get('SELECT COUNT(*) AS count FROM departments');
  const count = countRow ? Number(countRow.count) : 0;
  if (!tracked) {
    // An older database already has departments. Record the current seeds as
    // handled so a renamed Quality is not inserted beside its new name.
    if (count === 0) {
      for (const department of DEPARTMENT_SEEDS) await insertDepartmentSeed(department);
    }
    await writeSeededDepartmentNames(DEPARTMENT_SEEDS.map((row) => row[0]));
    return;
  }

  const known = new Set(tracked);
  let changed = false;
  for (const department of DEPARTMENT_SEEDS) {
    const name = department[0];
    if (known.has(name)) continue;
    const existing = await get('SELECT id FROM departments WHERE lower(name) = lower(?)', [name]);
    if (!existing) await insertDepartmentSeed(department);
    known.add(name);
    changed = true;
  }
  if (changed) await writeSeededDepartmentNames([...known]);
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
    ['customer_registered', 1, 'in_app'],
    ['files_shared', 1, 'in_app'],
    ['proof_ready', 1, 'in_app'],
    ['proof_decision', 1, 'in_app'],
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
  const customer = await get('SELECT id FROM users WHERE lower(username) = lower(?)', ['acme']);
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
    { name: 'order_id', definition: 'INTEGER' },
    { name: 'transfer_id', definition: 'INTEGER' },
    { name: 'dedupe_key', definition: 'TEXT' },
    { name: 'created_at', definition: 'DATETIME' },
  ]);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key ON notifications(dedupe_key)');
  await run('CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)');
  await run('CREATE INDEX IF NOT EXISTS idx_notifications_customer_id ON notifications(customer_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_notifications_order_id ON notifications(order_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_notifications_transfer_id ON notifications(transfer_id)');

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

async function ensureFileTransfers() {
  await run(`CREATE TABLE IF NOT EXISTS file_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    order_id INTEGER,
    work_order_id INTEGER,
    subject TEXT,
    message TEXT,
    uploaded_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    deleted_by INTEGER,
    FOREIGN KEY(customer_id) REFERENCES users(id),
    FOREIGN KEY(order_id) REFERENCES orders(id),
    FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
    FOREIGN KEY(uploaded_by) REFERENCES users(id)
  )`);
  await ensureColumns('file_transfers', [
    { name: 'customer_id', definition: 'INTEGER' },
    { name: 'order_id', definition: 'INTEGER' },
    { name: 'work_order_id', definition: 'INTEGER' },
    { name: 'subject', definition: 'TEXT' },
    { name: 'message', definition: 'TEXT' },
    { name: 'uploaded_by', definition: 'INTEGER' },
    { name: 'created_at', definition: 'DATETIME' },
    { name: 'deleted_at', definition: 'DATETIME' },
    { name: 'deleted_by', definition: 'INTEGER' },
  ]);
  await run('CREATE INDEX IF NOT EXISTS idx_file_transfers_customer ON file_transfers(customer_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_file_transfers_order ON file_transfers(order_id)');
}

function sharedFilesCreateRequiresOrder(sql) {
  return /order_id\s+INTEGER\s+NOT\s+NULL/i.test(String(sql || ''));
}

function renameSharedFilesCreateSql(sql) {
  const match = /^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"shared_files"|`shared_files`|\[shared_files\]|shared_files)(\s*\()/i.exec(sql);
  if (!match) throw new Error('shared_files CREATE TABLE statement was not recognized');
  return `${match[1]}"shared_files__order_rebuild"${match[2]}${sql.slice(match[0].length)}`;
}

// Older databases required shared_files.order_id. A standalone send has no order.
// Rebuilding copies every column, including ones added with ALTER TABLE.
async function relaxSharedFilesOrderId() {
  const table = await get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shared_files'`);
  if (!table || !sharedFilesCreateRequiresOrder(table.sql)) return;

  let createSql = renameSharedFilesCreateSql(
    String(table.sql).replace(/order_id\s+INTEGER\s+NOT\s+NULL/i, 'order_id INTEGER')
  );
  if (sharedFilesCreateRequiresOrder(createSql)) {
    throw new Error('shared_files rebuild left order_id required');
  }
  if (!/shared_files__order_rebuild/i.test(createSql)) {
    throw new Error('shared_files CREATE TABLE statement was not recognized');
  }

  const columns = await all('PRAGMA table_info(shared_files)');
  const explicitIndexes = await all(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'shared_files' AND sql IS NOT NULL`
  );
  const triggers = await all(
    `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'shared_files' AND sql IS NOT NULL`
  );
  const names = columns.map((column) => quoteIdent(column.name)).join(', ');

  await exec('PRAGMA foreign_keys = OFF');
  try {
    await exec('BEGIN IMMEDIATE');
    await run('DROP TABLE IF EXISTS shared_files__order_rebuild');
    await run(createSql);
    const rebuildCols = await all('PRAGMA table_info(shared_files__order_rebuild)');
    const rebuildNames = new Set(rebuildCols.map((column) => column.name));
    for (const column of columns) {
      if (rebuildNames.has(column.name)) continue;
      const type = String(column.type || 'TEXT').trim() || 'TEXT';
      if (!/^[A-Za-z][A-Za-z0-9_ ]*$/.test(type)) {
        throw new Error(`Unexpected column type on shared_files.${column.name}`);
      }
      await run(`ALTER TABLE shared_files__order_rebuild ADD COLUMN ${quoteIdent(column.name)} ${type}`);
    }
    await run(`INSERT INTO shared_files__order_rebuild (${names}) SELECT ${names} FROM shared_files`);
    await run('DROP TABLE shared_files');
    await run('ALTER TABLE shared_files__order_rebuild RENAME TO shared_files');
    for (const index of explicitIndexes) {
      if (index.sql) await run(index.sql);
    }
    for (const trigger of triggers) {
      if (trigger.sql) await run(trigger.sql);
    }
    await exec('COMMIT');
  } catch (err) {
    try {
      await exec('ROLLBACK');
    } catch (rollbackErr) {
      console.error('SHARED FILES REBUILD ROLLBACK ERROR:', rollbackErr);
    }
    throw err;
  } finally {
    await exec('PRAGMA foreign_keys = ON');
  }
  console.log('Relaxed shared_files.order_id so a file can be sent without an order');
}

// Existing order shares keep their rows. Each batch becomes one transfer so the
// customer list can show them next to standalone sends. The inserts and the
// transfer_id updates commit together. A second init does nothing.
async function backfillFileTransfers() {
  const fk = await get('PRAGMA foreign_keys');
  await exec('PRAGMA foreign_keys = OFF');
  try {
    const rows = await all(
      `SELECT f.id, f.order_id, f.work_order_id, f.customer_id, f.uploaded_by, f.message,
              f.batch_id, f.created_at, o.customer_id AS order_customer_id
       FROM shared_files f
       LEFT JOIN orders o ON o.id = f.order_id
       WHERE f.transfer_id IS NULL
       ORDER BY f.id`
    );
    if (!rows.length) return;
    const groups = new Map();
    for (const row of rows) {
      const key = row.batch_id ? `b:${row.order_id || 0}:${row.batch_id}` : `f:${row.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    await exec('BEGIN IMMEDIATE');
    try {
      let created = 0;
      for (const group of groups.values()) {
        const first = group[0];
        const customerId = first.customer_id || first.order_customer_id;
        if (!customerId) continue;
        const sameWorkOrder = group.every((row) => row.work_order_id === first.work_order_id);
        const inserted = await run(
          `INSERT INTO file_transfers (
            customer_id, order_id, work_order_id, subject, message, uploaded_by, created_at
          ) VALUES (?,?,?,?,?,?,?)`,
          [
            customerId,
            first.order_id || null,
            sameWorkOrder ? first.work_order_id || null : null,
            null,
            first.message || null,
            first.uploaded_by || null,
            first.created_at || null,
          ]
        );
        const ids = group.map((row) => row.id);
        await run(
          `UPDATE shared_files
           SET transfer_id = ?, customer_id = COALESCE(customer_id, ?)
           WHERE id IN (${ids.map(() => '?').join(', ')})`,
          [inserted.lastID, customerId, ...ids]
        );
        created += 1;
      }
      await exec('COMMIT');
      if (created > 0) {
        console.log(`Grouped ${created} existing file share(s) into transfers`);
      }
    } catch (err) {
      try {
        await exec('ROLLBACK');
      } catch (rollbackErr) {
        console.error('FILE TRANSFER BACKFILL ROLLBACK ERROR:', rollbackErr);
      }
      throw err;
    }
  } finally {
    if (fk && Number(fk.foreign_keys) === 1) await exec('PRAGMA foreign_keys = ON');
  }
}

async function ensureSharedFiles() {
  await run(`CREATE TABLE IF NOT EXISTS shared_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    work_order_id INTEGER,
    customer_id INTEGER,
    uploaded_by INTEGER,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL,
    message TEXT,
    batch_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    deleted_by INTEGER,
    replaced_by_id INTEGER,
    replaces_id INTEGER,
    customer_downloaded_at DATETIME,
    transfer_id INTEGER,
    FOREIGN KEY(order_id) REFERENCES orders(id),
    FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
    FOREIGN KEY(customer_id) REFERENCES users(id),
    FOREIGN KEY(uploaded_by) REFERENCES users(id),
    FOREIGN KEY(transfer_id) REFERENCES file_transfers(id)
  )`);
  await ensureColumns('shared_files', [
    { name: 'order_id', definition: 'INTEGER' },
    { name: 'work_order_id', definition: 'INTEGER' },
    { name: 'customer_id', definition: 'INTEGER' },
    { name: 'uploaded_by', definition: 'INTEGER' },
    { name: 'original_name', definition: 'TEXT' },
    { name: 'stored_name', definition: 'TEXT' },
    { name: 'mime_type', definition: 'TEXT' },
    { name: 'size_bytes', definition: 'INTEGER' },
    { name: 'message', definition: 'TEXT' },
    { name: 'batch_id', definition: 'TEXT' },
    { name: 'created_at', definition: 'DATETIME' },
    { name: 'deleted_at', definition: 'DATETIME' },
    { name: 'deleted_by', definition: 'INTEGER' },
    { name: 'replaced_by_id', definition: 'INTEGER' },
    { name: 'replaces_id', definition: 'INTEGER' },
    { name: 'customer_downloaded_at', definition: 'DATETIME' },
    { name: 'transfer_id', definition: 'INTEGER' },
  ]);
  await relaxSharedFilesOrderId();
  await ensureFileTransfers();
  await run('CREATE INDEX IF NOT EXISTS idx_shared_files_order ON shared_files(order_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_shared_files_work_order ON shared_files(work_order_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_shared_files_customer ON shared_files(customer_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_shared_files_transfer ON shared_files(transfer_id)');
  await backfillFileTransfers();
}

async function ensureProofs() {
  await run(`CREATE TABLE IF NOT EXISTS proofs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    work_order_id INTEGER,
    customer_id INTEGER,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_by INTEGER,
    decided_at DATETIME,
    decision_comment TEXT,
    FOREIGN KEY(order_id) REFERENCES orders(id),
    FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
    FOREIGN KEY(customer_id) REFERENCES users(id),
    FOREIGN KEY(created_by) REFERENCES users(id),
    FOREIGN KEY(decided_by) REFERENCES users(id)
  )`);
  await ensureColumns('proofs', [
    { name: 'order_id', definition: 'INTEGER' },
    { name: 'work_order_id', definition: 'INTEGER' },
    { name: 'customer_id', definition: 'INTEGER' },
    { name: 'version', definition: 'INTEGER' },
    { name: 'status', definition: 'TEXT' },
    { name: 'message', definition: 'TEXT' },
    { name: 'created_by', definition: 'INTEGER' },
    { name: 'created_at', definition: 'DATETIME' },
    { name: 'decided_by', definition: 'INTEGER' },
    { name: 'decided_at', definition: 'DATETIME' },
    { name: 'decision_comment', definition: 'TEXT' },
  ]);
  await run(`CREATE TABLE IF NOT EXISTS proof_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proof_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(proof_id) REFERENCES proofs(id)
  )`);
  await ensureColumns('proof_files', [
    { name: 'proof_id', definition: 'INTEGER' },
    { name: 'original_name', definition: 'TEXT' },
    { name: 'stored_name', definition: 'TEXT' },
    { name: 'mime_type', definition: 'TEXT' },
    { name: 'size_bytes', definition: 'INTEGER' },
    { name: 'created_at', definition: 'DATETIME' },
  ]);
  await run('CREATE INDEX IF NOT EXISTS idx_proofs_order ON proofs(order_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_proofs_work_order ON proofs(work_order_id)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_proofs_scope_version ON proofs(order_id, IFNULL(work_order_id, 0), version)');
  await run('CREATE INDEX IF NOT EXISTS idx_proof_files_proof ON proof_files(proof_id)');
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
    // Missing means customers can register. An admin's saved off switch is left alone.
    ['customer_self_signup_enabled', '1'],
    // Missing means staff email the customer when files are shared. An off switch is left alone.
    ['email_customers_on_file_share', '1'],
    // Missing means staff email the customer when a proof is sent. An off switch is left alone.
    ['email_customers_on_proof', '1'],
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

function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unexpected SQL name: ${name}`);
  }
  return `"${name}"`;
}

function endOfParens(sql, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < sql.length; index += 1) {
    const ch = sql[index];
    if (quote) {
      if (ch === quote) {
        if (sql[index + 1] === quote) {
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      quote = ch === '[' ? ']' : ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('Unbalanced parentheses in users CREATE TABLE');
}

function checkBodies(sql) {
  const bodies = [];
  let quote = null;
  let index = 0;
  while (index < sql.length) {
    const ch = sql[index];
    if (quote) {
      if (ch === quote) {
        if (sql[index + 1] === quote) {
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      quote = ch === '[' ? ']' : ch;
      index += 1;
      continue;
    }
    if (ch === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (/^CHECK\s*\(/i.test(sql.slice(index)) && (index === 0 || !/[A-Za-z0-9_]/.test(sql[index - 1]))) {
      const open = sql.indexOf('(', index);
      const close = endOfParens(sql, open);
      bodies.push(sql.slice(open + 1, close));
      index = close + 1;
      continue;
    }
    index += 1;
  }
  return bodies;
}

function usersRoleCheckBlocksManager(sql) {
  if (!sql) return false;
  const roleClauses = checkBodies(sql).filter((clause) => /\brole\b/i.test(clause));
  if (!roleClauses.length) return false;
  return roleClauses.some((clause) => !/\bmanager\b/i.test(clause));
}

const CONSTRAINT_TAIL = /(?:CONSTRAINT\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)\s+)?$/i;

// Drop only a role CHECK that omits manager. Collation, other checks, and keys stay.
function rewriteUsersCreateSql(sql) {
  let result = '';
  let quote = null;
  let index = 0;
  while (index < sql.length) {
    const ch = sql[index];
    if (quote) {
      result += ch;
      if (ch === quote) {
        if (sql[index + 1] === quote) {
          result += sql[index + 1];
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      quote = ch === '[' ? ']' : ch;
      result += ch;
      index += 1;
      continue;
    }
    if (ch === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end + 1;
      result += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (ch === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      result += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (/^CHECK\s*\(/i.test(sql.slice(index)) && (index === 0 || !/[A-Za-z0-9_]/.test(sql[index - 1]))) {
      const open = sql.indexOf('(', index);
      const close = endOfParens(sql, open);
      const body = sql.slice(open + 1, close);
      const blocks = /\brole\b/i.test(body) && !/\bmanager\b/i.test(body);
      if (!blocks) {
        result += sql.slice(index, close + 1);
        index = close + 1;
        continue;
      }
      result = result.replace(CONSTRAINT_TAIL, '').replace(/,\s*$/, '');
      index = close + 1;
      continue;
    }
    result += ch;
    index += 1;
  }

  let cleaned = '';
  quote = null;
  index = 0;
  while (index < result.length) {
    const ch = result[index];
    if (quote) {
      cleaned += ch;
      if (ch === quote) {
        if (result[index + 1] === quote) {
          cleaned += result[index + 1];
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      quote = ch === '[' ? ']' : ch;
      cleaned += ch;
      index += 1;
      continue;
    }
    if (ch === ',') {
      let next = index + 1;
      while (next < result.length && /\s/.test(result[next])) next += 1;
      if (result[next] === ',' || result[next] === ')') {
        index += 1;
        continue;
      }
    }
    cleaned += ch;
    index += 1;
  }
  return cleaned;
}

function renameUsersCreateSql(sql) {
  const match = /^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"users"|`users`|\[users\]|users)(\s*\()/i.exec(sql);
  if (!match) throw new Error('users CREATE TABLE statement was not recognized');
  return `${match[1]}"users__role_rebuild"${match[2]}${sql.slice(match[0].length)}`;
}

// The current schema does not CHECK users.role. An older database might.
// Rebuilding rewrites that role CHECK in the original CREATE TABLE statement.
async function ensureUsersRoleAllowsManager() {
  const table = await get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`);
  if (!table || !usersRoleCheckBlocksManager(table.sql)) return;

  const createSql = renameUsersCreateSql(rewriteUsersCreateSql(table.sql));
  if (usersRoleCheckBlocksManager(createSql)) {
    throw new Error('users role rebuild left a CHECK that omits manager');
  }

  const columns = await all('PRAGMA table_info(users)');
  const explicitIndexes = await all(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' AND sql IS NOT NULL`
  );
  const triggers = await all(
    `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'users' AND sql IS NOT NULL`
  );
  const names = columns.map((column) => quoteIdent(column.name)).join(', ');

  await exec('PRAGMA foreign_keys = OFF');
  try {
    await exec('BEGIN IMMEDIATE');
    await run('DROP TABLE IF EXISTS users__role_rebuild');
    await run(createSql);
    await run(`INSERT INTO users__role_rebuild (${names}) SELECT ${names} FROM users`);
    await run('DROP TABLE users');
    await run('ALTER TABLE users__role_rebuild RENAME TO users');
    for (const index of explicitIndexes) {
      if (index.sql) await run(index.sql);
    }
    for (const trigger of triggers) {
      if (trigger.sql) await run(trigger.sql);
    }
    await exec('COMMIT');
  } catch (err) {
    try {
      await exec('ROLLBACK');
    } catch (rollbackErr) {
      console.error('USERS ROLE REBUILD ROLLBACK ERROR:', rollbackErr);
    }
    throw err;
  } finally {
    await exec('PRAGMA foreign_keys = ON');
  }
  console.log('Relaxed users.role so a manager account can be stored');
}

// Managers see every department. A department stored on an older manager row is cleared.
async function clearManagerDepartments() {
  const result = await run(
    `UPDATE users
     SET department = NULL, updated_at = datetime('now')
     WHERE lower(role) = 'manager'
       AND department IS NOT NULL`
  );
  if (result.changes > 0) {
    console.log(`Cleared department on ${result.changes} manager account(s)`);
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
  await ensureUsersRoleAllowsManager();
  await clearManagerDepartments();
  await ensureColumns('services', [
    { name: 'code', definition: 'TEXT' },
    { name: 'suffix_mode', definition: "TEXT DEFAULT 'sequence'" },
    { name: 'default_turnaround_hours', definition: 'INTEGER' },
    { name: 'updated_at', definition: 'DATETIME' },
  ]);
  await ensureColumns('departments', [
    { name: 'next_department', definition: 'TEXT' },
  ]);
  await ensureShowOnBoard();
  await ensureColumns('work_orders', [
    { name: 'order_id', definition: 'INTEGER' },
    { name: 'service_id', definition: 'INTEGER' },
    { name: 'next_department', definition: 'TEXT' },
    { name: 'requires_approval', definition: 'INTEGER DEFAULT 0' },
    { name: 'approval_status', definition: 'TEXT' },
    { name: 'approval_by', definition: 'INTEGER' },
    { name: 'approval_at', definition: 'DATETIME' },
    { name: 'proof_status', definition: 'TEXT' },
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
  await ensureSharedFiles();
  await ensureProofs();
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
  await ensureDepartmentNameIndex();
  await ensureExternalIdUniqueIndex();
  await ensureUserIdentityIndexes();
  console.log('Database initialization complete.');
}

// Case-insensitive uniqueness. Skip when an older database already has
// Quality and quality, and leave those rows in place.
async function ensureDepartmentNameIndex() {
  const duplicate = await get(
    `SELECT lower(name) AS name
     FROM departments
     GROUP BY lower(name)
     HAVING COUNT(*) > 1
     LIMIT 1`
  );
  if (duplicate) {
    console.warn(
      `Skipping case-insensitive unique index on departments.name because duplicates exist (${duplicate.name})`
    );
    return;
  }
  await run(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_name_nocase ON departments(name COLLATE NOCASE)'
  );
}

// Usernames are unique ignoring case. Emails are not: two companies may share an
// ordering address. Self-registration checks email itself. Drop an email index
// from an earlier build of that check so admin saves are not rejected.
async function ensureUserIdentityIndexes() {
  await run('DROP INDEX IF EXISTS idx_users_email_nocase');

  const usernameDup = await get(
    `SELECT lower(username) AS name
     FROM users
     GROUP BY lower(username)
     HAVING COUNT(*) > 1
     LIMIT 1`
  );
  if (usernameDup) {
    console.warn(
      `Skipping case-insensitive unique index on users.username because duplicates exist (${usernameDup.name})`
    );
    return;
  }
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)');
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
