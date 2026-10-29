// Builds the throwaway test database from init_db.js, then adds known users,
// two shops' orders, and work orders. init_db.js leaves mailbox polling off.
// This file turns polling on only in the database it was given.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bcrypt = require(path.join(__dirname, '..', 'backend', 'node_modules', 'bcryptjs'));
const c = require('./constants');
const { nextWeekday } = require('./dates');

const root = path.join(__dirname, '..');

function spawnNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: path.join(root, 'backend'),
      env,
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

function dbApi() {
  const db = require(path.join(root, 'backend', 'db'));
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
  return { run, get };
}

async function insertUser(db, row) {
  const hash = await bcrypt.hash(row.password || c.MANAGER_RALEIGH.password, 10);
  const inserted = await db.run(
    `INSERT INTO users (
      username, password_hash, role, display_name, company, contact_name, phone, email,
      mobile_phone, sms_opt_in, address_line1, city, state, zip, department, location_id, is_active
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [
      row.username,
      hash,
      row.role,
      row.displayName || row.username,
      row.company || null,
      row.contact || null,
      row.phone || null,
      row.email || null,
      row.mobile || null,
      row.smsOptIn ? 1 : 0,
      row.address1 || null,
      row.city || null,
      row.state || null,
      row.zip || null,
      row.department || null,
      row.locationId == null ? null : row.locationId,
    ]
  );
  return inserted.lastID;
}

async function placeOrder(db, { user, customerId, locationId, project, notes, externalId, description }) {
  const { createOrder } = require(path.join(root, 'backend', 'orderService'));
  const service = await db.get(`SELECT id FROM services WHERE name = ?`, ['Archive File Request']);
  if (!service) throw new Error('Archive File Request was not seeded');
  const created = await createOrder(user, {
    customer_id: customerId,
    location_id: locationId,
    company: project,
    contact_name: 'Fixture Contact',
    phone: '919-555-0199',
    email: 'orders@e2e.launchpad.test',
    project_name: project,
    notes,
    originals_source: 'Hardcopy or digital media provided',
    address_line1: '1 Shop Way',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    delivery_method: 'Will Call',
    due_date: nextWeekday(),
    due_time: '10:00',
    return_to: 'To Me',
    payment_method: 'Cash',
    service_ids: [service.id],
    line_items: [],
  });
  const workOrder = (created.work_orders || [])[0];
  if (!workOrder) throw new Error(`No work order for ${project}`);
  if (externalId) {
    await db.run(
      `UPDATE work_orders SET external_id = ?, description = ? WHERE id = ?`,
      [externalId, description || project, workOrder.id]
    );
  }
  return {
    orderId: created.order.id,
    orderNumber: created.order_number,
    workOrderId: workOrder.id,
    externalId: externalId || workOrder.external_id,
  };
}

async function seedDatabase(databaseFile) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_FILE: databaseFile,
    INIT_ADMIN_PASSWORD: c.ADMIN.password,
    DELIVERY_TIMEZONE: 'America/New_York',
    MAIL_TRANSPORT: 'json',
  };
  delete env.M365_TENANT_ID;
  delete env.M365_CLIENT_ID;
  delete env.M365_CLIENT_SECRET;
  delete env.M365_MAILBOX;

  const init = await spawnNode(path.join(root, 'backend', 'init_db.js'), env);
  if (init.code !== 0) {
    throw new Error(`init_db.js failed (${init.code})\n${init.out}\n${init.err}`);
  }

  const db = dbApi();
  const raleigh = await db.get(`SELECT id FROM locations WHERE name = 'Raleigh'`);
  const hickory = await db.get(`SELECT id FROM locations WHERE name = 'Hickory'`);
  const admin = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
  if (!raleigh || !hickory || !admin) throw new Error('init_db.js did not seed shops and admin');

  const managerRaleighId = await insertUser(db, {
    username: c.MANAGER_RALEIGH.username,
    password: c.MANAGER_RALEIGH.password,
    role: 'manager',
    displayName: 'Raleigh Manager',
    locationId: raleigh.id,
  });
  const managerHickoryId = await insertUser(db, {
    username: c.MANAGER_HICKORY.username,
    password: c.MANAGER_HICKORY.password,
    role: 'manager',
    displayName: 'Hickory Manager',
    locationId: hickory.id,
  });
  const managerNoneId = await insertUser(db, {
    username: c.MANAGER_NONE.username,
    password: c.MANAGER_NONE.password,
    role: 'manager',
    displayName: 'Unassigned Manager',
    locationId: null,
  });
  const operatorId = await insertUser(db, {
    username: c.OPERATOR.username,
    password: c.OPERATOR.password,
    role: 'operator',
    displayName: 'Raleigh Operator',
    locationId: raleigh.id,
    department: null,
  });
  const raleighCustomerId = await insertUser(db, {
    ...c.CUSTOMER_RALEIGH,
    password: c.MANAGER_RALEIGH.password,
    role: 'customer',
    locationId: raleigh.id,
    smsOptIn: true,
  });
  const hickoryCustomerId = await insertUser(db, {
    ...c.CUSTOMER_HICKORY,
    password: c.MANAGER_RALEIGH.password,
    role: 'customer',
    locationId: hickory.id,
    smsOptIn: true,
  });

  const actor = { id: admin.id, userId: admin.id, role: 'admin' };
  const raleighOrder = await placeOrder(db, {
    user: actor,
    customerId: raleighCustomerId,
    locationId: raleigh.id,
    project: c.RALEIGH_PROJECT,
    notes: 'Seeded Raleigh order for the functional tests.',
    externalId: c.RALEIGH_EXTERNAL_ID,
    description: c.RALEIGH_DESCRIPTION,
  });
  const hickoryOrder = await placeOrder(db, {
    user: actor,
    customerId: hickoryCustomerId,
    locationId: hickory.id,
    project: c.HICKORY_PROJECT,
    notes: 'Seeded Hickory order for the functional tests.',
    externalId: c.HICKORY_EXTERNAL_ID,
    description: c.HICKORY_DESCRIPTION,
  });
  // Customer stays at Hickory. The order itself is at Raleigh, which is the
  // case PR #51 uses for SMS recipient scoping.
  const transferred = await placeOrder(db, {
    user: actor,
    customerId: hickoryCustomerId,
    locationId: raleigh.id,
    project: c.TRANSFER_PROJECT,
    notes: 'Order at Raleigh for a Hickory customer.',
    externalId: null,
    description: c.TRANSFER_PROJECT,
  });

  await db.run(
    `INSERT INTO order_notify_log (order_id, channel, notice_type, recipient, result)
     VALUES (?, 'sms', 'pickup', ?, 'sent')`,
    [raleighOrder.orderId, c.CUSTOMER_RALEIGH.mobile]
  );
  await db.run(
    `INSERT INTO order_notify_log (order_id, channel, notice_type, recipient, result)
     VALUES (?, 'email', 'pickup', ?, 'sent')`,
    [raleighOrder.orderId, c.EMAIL_RECIPIENT]
  );
  await db.run(
    `INSERT INTO order_notify_log (order_id, channel, notice_type, recipient, result)
     VALUES (?, 'sms', 'pickup', ?, 'sent')`,
    [hickoryOrder.orderId, c.CUSTOMER_HICKORY.mobile]
  );
  await db.run(
    `INSERT INTO order_notify_log (order_id, channel, notice_type, recipient, result)
     VALUES (?, 'sms', 'pickup', ?, 'sent')`,
    [transferred.orderId, c.TRANSFER_SMS]
  );
  await db.run(
    `INSERT INTO order_notify_log (order_id, channel, notice_type, recipient, result)
     VALUES (?, 'email', 'pickup', ?, 'sent')`,
    [transferred.orderId, c.EMAIL_RECIPIENT]
  );
  await db.run(
    `INSERT OR IGNORE INTO outbound_message_ids (message_id, notice_type, created_at)
     VALUES (?, 'confirmation', datetime('now'))`,
    [c.OUTBOUND_MESSAGE_ID]
  );

  // Production init inserts this key as 0 and a later init does not overwrite it.
  // The functional tests are the only place it is turned on, and only on this file.
  const polling = await db.run(
    `UPDATE system_settings SET value = '1', updated_at = datetime('now')
     WHERE key = 'inbound_email_polling_enabled'`
  );
  if (!polling.changes) {
    throw new Error('inbound_email_polling_enabled was not seeded by init_db.js');
  }

  const { whenSettled } = require(path.join(root, 'backend', 'afterResponse'));
  await whenSettled();

  return {
    databaseFile,
    locations: { raleigh: raleigh.id, hickory: hickory.id },
    users: {
      admin: admin.id,
      managerRaleigh: managerRaleighId,
      managerHickory: managerHickoryId,
      managerNone: managerNoneId,
      operator: operatorId,
      customerRaleigh: raleighCustomerId,
      customerHickory: hickoryCustomerId,
    },
    raleigh: raleighOrder,
    hickory: hickoryOrder,
    transferred,
  };
}

function assertThrowawayDatabase(databaseFile) {
  const runtime = path.join(root, 'e2e', '.runtime');
  const resolved = path.resolve(databaseFile);
  if (!resolved.startsWith(`${runtime}${path.sep}`)) {
    throw new Error(`Refusing to touch a database outside e2e/.runtime: ${resolved}`);
  }
  if (fs.existsSync(path.join(root, 'database', 'launchpad.db'))
    && path.resolve(path.join(root, 'database', 'launchpad.db')) === resolved) {
    throw new Error('Refusing to use database/launchpad.db');
  }
}

module.exports = {
  seedDatabase,
  assertThrowawayDatabase,
};
