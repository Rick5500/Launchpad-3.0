require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();

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

async function ensureColumns(columns) {
  const rows = await all('PRAGMA table_info(work_orders)');
  const existingColumns = new Set(rows.map((row) => row.name));
  for (const column of columns) {
    if (existingColumns.has(column.name)) continue;
    await run(`ALTER TABLE work_orders ADD COLUMN ${column.name} ${column.definition}`);
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
      continue;
    }

    const passwordHash = await bcrypt.hash(crypto.randomBytes(18).toString('base64url'), BCRYPT_ROUNDS);
    await run(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)',
      [username, passwordHash, 'customer', displayName]
    );
    console.log(`Seeded customer user ${username} (no password issued)`);
  }
}

async function seedDepartments() {
  const departments = [
    ['Small Format', 'Small format print production', '#90caf9', 'print', 1, 1],
    ['Signs & Graphics', 'Large format and signage jobs', '#f6c343', 'branding_watermark', 2, 1],
    ['Reprographics', 'Reproduction and copy projects', '#7e57c2', 'copy_all', 3, 1],
    ['Scanning', 'Scanning and digitization tasks', '#26a69a', 'scanner', 4, 1],
    ['Delivery', 'Logistics and outbound delivery', '#ef5350', 'local_shipping', 5, 1],
    ['Admin', 'Administrative and ops support', '#78909c', 'admin_panel_settings', 6, 1],
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

async function main() {
  await exec(schema);
  await ensureColumns([
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
  await ensureColumns([
    { name: 'stage_id', definition: 'INTEGER' },
    { name: 'priority', definition: "TEXT DEFAULT 'Normal'" },
    { name: 'assigned_department_id', definition: 'INTEGER' },
    { name: 'assigned_user_id', definition: 'INTEGER' },
    { name: 'estimated_hours', definition: 'REAL' },
    { name: 'actual_hours', definition: 'REAL' },
  ]);
  await seedAdmin();
  await seedCustomers();
  await seedDepartments();
  await seedStages();
  await seedSampleOrders();
  await seedProductionBoard();
  await seedDeliveries();
  await normalizeLegacyWorkOrderStatuses();
  console.log('Database initialization complete.');
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    closeDb().finally(() => process.exit(1));
  });
