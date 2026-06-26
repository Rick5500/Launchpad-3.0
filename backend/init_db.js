require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'database', 'launchpad.db');
const db = new sqlite3.Database(dbFile);

function addColumnIfMissing(column, definition, callback) {
  db.get(`PRAGMA table_info(work_orders)`, [], (err, row) => {
    if (err) return callback(err);
    db.get(`PRAGMA table_info(work_orders)`, [], (err2) => {
      if (err2) return callback(err2);
      db.get(`PRAGMA table_info(work_orders)`, [], (err3) => {
        if (err3) return callback(err3);
      });
    });
  });
}

function ensureWorkOrderColumns(next) {
  const columns = [
    { name: 'department', definition: "TEXT DEFAULT 'General'" },
    { name: 'specifications', definition: 'TEXT' },
    { name: 'start_date', definition: 'DATETIME' },
    { name: 'production_line', definition: 'TEXT' },
    { name: 'routing_instructions', definition: 'TEXT' },
    { name: 'attachments', definition: 'TEXT' },
    { name: 'notes', definition: 'TEXT' },
  ];

  db.all(`PRAGMA table_info(work_orders)`, [], (err, rows) => {
    if (err) return next(err);

    const existingColumns = new Set((rows || []).map((row) => row.name));
    const missingColumns = columns.filter((column) => !existingColumns.has(column.name));

    if (missingColumns.length === 0) return next();

    let index = 0;
    const applyNextColumn = () => {
      if (index >= missingColumns.length) return next();
      const column = missingColumns[index++];
      db.run(`ALTER TABLE work_orders ADD COLUMN ${column.name} ${column.definition}`, (alterErr) => {
        if (alterErr) return next(alterErr);
        applyNextColumn();
      });
    };

    applyNextColumn();
  });
}

function ensureDepartmentsTable(next) {
  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='departments'`, [], (err, row) => {
    if (err) return next(err);
    if (row) return next();
    db.run(`CREATE TABLE departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      color TEXT DEFAULT '#90caf9',
      icon TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    )`, (err2) => next(err2));
  });
}

function ensureProductionStagesTable(next) {
  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='production_stages'`, [], (err, row) => {
    if (err) return next(err);
    if (row) return next();
    db.run(`CREATE TABLE production_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#90caf9',
      icon TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    )`, (err2) => next(err2));
  });
}

function ensureWorkOrderNewColumns(next) {
  const columns = [
    { name: 'stage_id', definition: 'INTEGER' },
    { name: 'priority', definition: "TEXT DEFAULT 'Normal'" },
    { name: 'assigned_department_id', definition: 'INTEGER' },
    { name: 'assigned_user_id', definition: 'INTEGER' },
    { name: 'estimated_hours', definition: 'REAL' },
    { name: 'actual_hours', definition: 'REAL' },
  ];

  db.all(`PRAGMA table_info(work_orders)`, [], (err, rows) => {
    if (err) return next(err);
    const existingColumns = new Set((rows || []).map((row) => row.name));
    const missingColumns = columns.filter((column) => !existingColumns.has(column.name));

    if (missingColumns.length === 0) return next();

    let index = 0;
    const applyNextColumn = () => {
      if (index >= missingColumns.length) return next();
      const column = missingColumns[index++];
      db.run(`ALTER TABLE work_orders ADD COLUMN ${column.name} ${column.definition}`, (alterErr) => {
        if (alterErr) return next(alterErr);
        applyNextColumn();
      });
    };

    applyNextColumn();
  });
}

function ensureWorkOrderEventsTable(next) {
  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='work_order_events'`, [], (err, row) => {
    if (err) return next(err);
    if (row) return next();
    db.run(`CREATE TABLE work_order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      from_stage_id INTEGER,
      to_stage_id INTEGER,
      from_department_id INTEGER,
      to_department_id INTEGER,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
      FOREIGN KEY(from_stage_id) REFERENCES production_stages(id),
      FOREIGN KEY(to_stage_id) REFERENCES production_stages(id),
      FOREIGN KEY(from_department_id) REFERENCES departments(id),
      FOREIGN KEY(to_department_id) REFERENCES departments(id)
    )`, (err2) => next(err2));
  });
}

db.exec(schema, (err) => {
  if (err) {
    console.error('Failed to apply schema:', err);
    process.exit(1);
  }

  ensureWorkOrderColumns((err2) => {
    if (err2) {
      console.error('Failed to ensure columns:', err2);
      process.exit(1);
    }

    ensureDepartmentsTable((err3) => {
      if (err3) {
        console.error('Failed to ensure departments table:', err3);
        process.exit(1);
      }

      ensureProductionStagesTable((err4) => {
        if (err4) {
          console.error('Failed to ensure production stages table:', err4);
          process.exit(1);
        }

        ensureWorkOrderNewColumns((err5) => {
          if (err5) {
            console.error('Failed to ensure work order columns:', err5);
            process.exit(1);
          }

          ensureWorkOrderEventsTable((err6) => {
            if (err6) {
              console.error('Failed to ensure work order events table:', err6);
              process.exit(1);
            }

            const adminPass = process.env.INIT_ADMIN_PASSWORD || 'adminpass';
          const hash = crypto.createHash('sha256').update(adminPass).digest('hex');

          db.get('SELECT id FROM users WHERE username = ?', ['admin'], (err, row) => {
            if (err) {
              console.error(err);
              process.exit(1);
            }

            if (row) {
              console.log('Admin user already exists');
              process.exit(0);
            }

            db.run(
              'INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)',
              ['admin', hash, 'admin', 'Administrator'],
              function (err) {
                if (err) {
                  console.error(err);
                  process.exit(1);
                }

                db.get('SELECT COUNT(*) AS count FROM users WHERE role = ?', ['customer'], (err, row) => {
                  if (err) {
                    console.error(err);
                    process.exit(1);
                  }

                  if (row.count === 0) {
                    const customers = [
                      ['acme', crypto.createHash('sha256').update('customer1').digest('hex'), 'customer', 'ACME Corp'],
                      ['whitebox', crypto.createHash('sha256').update('customer2').digest('hex'), 'customer', 'Whitebox Industries'],
                      ['orion', crypto.createHash('sha256').update('customer3').digest('hex'), 'customer', 'Orion Supplies'],
                    ];

                    const insertCustomer = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)');
                    customers.forEach((customer) => insertCustomer.run(customer));
                    insertCustomer.finalize(() => {
                      db.get('SELECT id FROM users WHERE username = ?', ['acme'], (err, customerRow) => {
                        if (err) {
                          console.error(err);
                          process.exit(1);
                        }

                        const seedOrders = [
                          ['WO-1001', customerRow.id, 'Laser cutter setup for batch A', 120, 'open', 'Manufacturing', '2026-07-12'],
                          ['WO-1002', customerRow.id, 'Finish assembly line parts', 48, 'in-progress', 'Assembly', '2026-07-09'],
                          ['WO-1003', customerRow.id, 'Quality review and packing', 36, 'open', 'Quality', '2026-07-11'],
                        ];

                        const insertOrder = db.prepare('INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department, due_date) VALUES (?,?,?,?,?,?,?)');
                        seedOrders.forEach((order) => insertOrder.run(order));
                        insertOrder.finalize();

                        db.get('SELECT COUNT(*) AS count FROM departments', [], (err, deptCountRow) => {
                          if (err) {
                            console.error(err);
                            process.exit(1);
                          }

                          if (deptCountRow.count === 0) {
                            const defaultDepartments = [
                              ['Small Format', 'Small format print production', '#90caf9', 'print', 1, 1],
                              ['Signs & Graphics', 'Large format and signage jobs', '#f6c343', 'branding_watermark', 2, 1],
                              ['Reprographics', 'Reproduction and copy projects', '#7e57c2', 'copy_all', 3, 1],
                              ['Scanning', 'Scanning and digitization tasks', '#26a69a', 'scanner', 4, 1],
                              ['Delivery', 'Logistics and outbound delivery', '#ef5350', 'local_shipping', 5, 1],
                              ['Admin', 'Administrative and ops support', '#78909c', 'admin_panel_settings', 6, 1],
                            ];
                            const insertDepartment = db.prepare('INSERT INTO departments (name, description, color, icon, sort_order, is_active) VALUES (?,?,?,?,?,?)');
                            defaultDepartments.forEach((dept) => insertDepartment.run(dept));
                            insertDepartment.finalize();
                          }

                          db.get('SELECT COUNT(*) AS count FROM production_stages', [], (err, stageCountRow) => {
                            if (err) {
                              console.error(err);
                              process.exit(1);
                            }

                            if (stageCountRow.count === 0) {
                              const defaultStages = [
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
                              const insertStage = db.prepare('INSERT INTO production_stages (name, color, icon, sort_order) VALUES (?,?,?,?)');
                              defaultStages.forEach((stage) => insertStage.run(stage));
                              insertStage.finalize();
                            }

                            const sampleProduction = [
                              [1, 'Cutting', 1, 'in-progress'],
                              [2, 'Assembly', 2, 'open'],
                              [3, 'Inspection', 3, 'open'],
                            ];
                            const insertProduction = db.prepare('INSERT INTO production_board (work_order_id, lane, position, status) VALUES (?,?,?,?)');
                            sampleProduction.forEach((item) => insertProduction.run(item));
                            insertProduction.finalize();

                            const insertDelivery = db.prepare('INSERT INTO deliveries (work_order_id, will_call, due_time, carrier, status) VALUES (?,?,?,?,?)');
                            insertDelivery.run([1, 0, '2026-07-15 14:00:00', 'FedEx', 'pending']);
                            insertDelivery.run([3, 1, '2026-07-14 18:00:00', 'Will Call', 'pending']);
                            insertDelivery.finalize(() => {
                              console.log('Admin user created: username=admin password=' + adminPass);
                              console.log('Sample data seeded.');
                              process.exit(0);
                            });
                          });
                        });
                      });
                    });
                  }
                });
              }
            );
          });
          });
        });
      });
    });
  });
});
