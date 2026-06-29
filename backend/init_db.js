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

function ensureWorkOrderDepartmentStatusTable(next) {
  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='work_order_department_status'`, [], (err, row) => {
    if (err) return next(err);
    if (row) return next();
    db.run(`CREATE TABLE work_order_department_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL,
      department_id INTEGER NOT NULL,
      status TEXT DEFAULT 'Not Required',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE,
      FOREIGN KEY(department_id) REFERENCES departments(id),
      UNIQUE(work_order_id, department_id)
    )`, (err2) => next(err2));
  });
}

function ensureWorkOrderMatrixStateTable(next) {
  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='work_order_matrix_state'`, [], (err, row) => {
    if (err) return next(err);
    if (row) return next();
    db.run(`CREATE TABLE work_order_matrix_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL UNIQUE,
      qc_status TEXT DEFAULT 'Not Required',
      delivery_type TEXT,
      is_completed BOOLEAN DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
    )`, (err2) => next(err2));
  });
}
function ensureProductCategoriesTable(next) {
  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='product_categories'`, [], (err, row) => {
    if (err) return next(err);
    if (row) return next();
    db.run(`CREATE TABLE product_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    )`, (err2) => next(err2));
  });
}

function ensureProductsTable(next) {
  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='products'`, [], (err, row) => {
    if (err) return next(err);
    if (row) return next();
    db.run(`CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      category_id INTEGER NOT NULL,
      is_active INTEGER DEFAULT 1,
      proof_required INTEGER DEFAULT 0,
      qc_required INTEGER DEFAULT 0,
      barcode_required INTEGER DEFAULT 0,
      default_turnaround_hours INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME,
      FOREIGN KEY(category_id) REFERENCES product_categories(id)
    )`, (err2) => next(err2));
  });
}

function ensureProductRequiredDepartmentsTable(next) {
  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='product_required_departments'`, [], (err, row) => {
    if (err) return next(err);
    if (row) return next();
    db.run(`CREATE TABLE product_required_departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      department_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY(department_id) REFERENCES departments(id),
      UNIQUE(product_id, department_id)
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

            ensureWorkOrderDepartmentStatusTable((err7) => {
              if (err7) {
                console.error('Failed to ensure work order department status table:', err7);
                process.exit(1);
              }

              ensureWorkOrderMatrixStateTable((err8) => {
                if (err8) {
                  console.error('Failed to ensure work order matrix state table:', err8);
                  process.exit(1);
                }

              ensureProductCategoriesTable((err9) => {
                if (err9) {
                  console.error('Failed to ensure product categories table:', err9);
                  process.exit(1);
                }

                ensureProductsTable((err10) => {
                  if (err10) {
                    console.error('Failed to ensure products table:', err10);
                    process.exit(1);
                  }

                  ensureProductRequiredDepartmentsTable((err11) => {
                    if (err11) {
                      console.error('Failed to ensure product required departments table:', err11);
                      process.exit(1);
                    }

                    // Define required users to ensure exist
                    const requiredUsers = [
                      { username: 'admin', password: process.env.INIT_ADMIN_PASSWORD || 'adminpass', role: 'admin', display_name: 'Administrator' },
                      { username: 'manager', password: 'managerpass', role: 'manager', display_name: 'Manager Account' },
                      { username: 'employee1', password: 'employee1pass', role: 'employee', display_name: 'Employee One' },
                      { username: 'employee2', password: 'employee2pass', role: 'employee', display_name: 'Employee Two' },
                    ];

                // Function to ensure a user exists (idempotent)
                function ensureUser(user, callback) {
                  db.get('SELECT id, role FROM users WHERE username = ?', [user.username], (err, row) => {
                    if (err) {
                      console.error(`Error checking user ${user.username}:`, err);
                      return callback(err);
                }

                if (row) {
                  // User exists, skip creation but log it
                  console.log(`User ${user.username} already exists (role: ${row.role})`);
                  return callback(null);
                }

                // User doesn't exist, create it
                const hash = crypto.createHash('sha256').update(user.password).digest('hex');
                db.run(
                  'INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)',
                  [user.username, hash, user.role, user.display_name],
                  function (err) {
                    if (err) {
                      console.error(`Error creating user ${user.username}:`, err);
                      return callback(err);
                    }
                    console.log(`User ${user.username} created with role: ${user.role}`);
                    callback(null);
                  }
                );
              });
            }

            // Function to ensure all required users exist
            function ensureAllUsers(users, index, callback) {
              if (index >= users.length) {
                return callback(null);
              }

              ensureUser(users[index], (err) => {
                if (err) return callback(err);
                ensureAllUsers(users, index + 1, callback);
              });
            }

            // Ensure all required users exist
            ensureAllUsers(requiredUsers, 0, (err) => {
              if (err) {
                console.error('Failed to ensure users:', err);
                process.exit(1);
              }

              // Now seed sample customers if none exist
              db.get('SELECT COUNT(*) AS count FROM users WHERE role = ?', ['customer'], (err, row) => {
                if (err) {
                  console.error(err);
                  process.exit(1);
                }

                function seedSampleCustomers(callback) {
                  if (row.count > 0) {
                    console.log('Sample customers already exist');
                    return callback(null);
                  }

                  const sampleCustomers = [
                    { username: 'acme', password: 'customer1', role: 'customer', display_name: 'ACME Corp' },
                    { username: 'whitebox', password: 'customer2', role: 'customer', display_name: 'Whitebox Industries' },
                    { username: 'orion', password: 'customer3', role: 'customer', display_name: 'Orion Supplies' },
                  ];

                  let customerIndex = 0;
                  function insertNextCustomer() {
                    if (customerIndex >= sampleCustomers.length) {
                      return callback(null);
                    }

                    const cust = sampleCustomers[customerIndex++];
                    const hash = crypto.createHash('sha256').update(cust.password).digest('hex');
                    db.run(
                      'INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)',
                      [cust.username, hash, cust.role, cust.display_name],
                      function (err) {
                        if (err) {
                          console.error(`Error creating customer ${cust.username}:`, err);
                          return callback(err);
                        }
                        console.log(`Sample customer ${cust.username} created`);
                        insertNextCustomer();
                      }
                    );
                  }

                  insertNextCustomer();
                }

                seedSampleCustomers((err) => {
                  if (err) {
                    console.error('Failed to seed customers:', err);
                    process.exit(1);
                  }

                  // Seed sample work orders if none exist
                  db.get('SELECT COUNT(*) AS count FROM work_orders', [], (err, woCountRow) => {
                    if (err) {
                      console.error(err);
                      process.exit(1);
                    }

                    if (woCountRow.count === 0) {
                      db.get('SELECT id FROM users WHERE username = ?', ['acme'], (err, customerRow) => {
                        if (err) {
                          console.error(err);
                          process.exit(1);
                        }

                        if (customerRow) {
                          const seedOrders = [
                            ['WO-1001', customerRow.id, 'Laser cutter setup for batch A', 120, 'open', 'Manufacturing', '2026-07-12'],
                            ['WO-1002', customerRow.id, 'Finish assembly line parts', 48, 'in-progress', 'Assembly', '2026-07-09'],
                            ['WO-1003', customerRow.id, 'Quality review and packing', 36, 'open', 'Quality', '2026-07-11'],
                          ];

                          const insertOrder = db.prepare('INSERT INTO work_orders (external_id, customer_id, description, quantity, status, department, due_date) VALUES (?,?,?,?,?,?,?)');
                          seedOrders.forEach((order) => insertOrder.run(order));
                          insertOrder.finalize(() => {
                            console.log('Sample work orders seeded');
                            seedDepartments();
                          });
                        } else {
                          seedDepartments();
                        }
                      });
                    } else {
                      console.log('Work orders already exist');
                      seedDepartments();
                    }
                  });

                  function seedDepartments() {
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
                        insertDepartment.finalize(() => {
                          console.log('Departments seeded');
                          seedProductCategories();
                        });
                      } else {
                        console.log('Departments already exist');
                        seedProductCategories();
                      }
                    });
                  }

                  function seedProductCategories() {
                    db.get('SELECT COUNT(*) AS count FROM product_categories', [], (err, catCountRow) => {
                      if (err) {
                        console.error(err);
                        process.exit(1);
                      }

                      if (catCountRow.count === 0) {
                        const defaultCategories = [
                          ['Graphics', 'Graphic design and large format work', 1],
                          ['Small Format', 'Small format printing', 2],
                          ['Reprographics', 'Reprographic and copy services', 3],
                          ['Scanning', 'Document scanning and digitization', 4],
                        ];
                        const insertCategory = db.prepare('INSERT INTO product_categories (name, description, sort_order) VALUES (?,?,?)');
                        defaultCategories.forEach((cat) => insertCategory.run(cat));
                        insertCategory.finalize(() => {
                          console.log('Product categories seeded');
                          seedProductionStages();
                        });
                      } else {
                        console.log('Product categories already exist');
                        seedProductionStages();
                      }
                    });
                  }

                  function seedProductionStages() {
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
                        insertStage.finalize(() => {
                          console.log('Production stages seeded');
                          seedProductionBoard();
                        });
                      } else {
                        console.log('Production stages already exist');
                        seedProductionBoard();
                      }
                    });
                  }

                  function seedProductionBoard() {
                    db.get('SELECT COUNT(*) AS count FROM production_board', [], (err, pbCountRow) => {
                      if (err) {
                        console.error(err);
                        process.exit(1);
                      }

                      if (pbCountRow.count === 0) {
                        // Verify required work orders exist before seeding production board
                        db.get('SELECT COUNT(*) AS count FROM work_orders WHERE id IN (1, 2, 3)', [], (err, woCheckRow) => {
                          if (err) {
                            console.error(err);
                            process.exit(1);
                          }

                          if (woCheckRow.count >= 3) {
                            // Work orders 1, 2, 3 exist, safe to seed production board
                            const sampleProduction = [
                              [1, 'Cutting', 1, 'in-progress'],
                              [2, 'Assembly', 2, 'open'],
                              [3, 'Inspection', 3, 'open'],
                            ];
                            const insertProduction = db.prepare('INSERT INTO production_board (work_order_id, lane, position, status) VALUES (?,?,?,?)');
                            sampleProduction.forEach((item) => insertProduction.run(item));
                            insertProduction.finalize(() => {
                              console.log('Production board seeded');
                              seedDeliveries();
                            });
                          } else {
                            console.log('Production board seeding skipped (work orders 1-3 do not exist)');
                            seedDeliveries();
                          }
                        });
                      } else {
                        console.log('Production board already seeded');
                        seedDeliveries();
                      }
                    });
                  }

                  function seedDeliveries() {
                    db.get('SELECT COUNT(*) AS count FROM deliveries', [], (err, delCountRow) => {
                      if (err) {
                        console.error(err);
                        process.exit(1);
                      }

                      if (delCountRow.count === 0) {
                        // Verify required work orders exist before seeding deliveries
                        db.get('SELECT COUNT(*) AS count FROM work_orders WHERE id IN (1, 3)', [], (err, woCheckRow) => {
                          if (err) {
                            console.error(err);
                            process.exit(1);
                          }

                          if (woCheckRow.count >= 2) {
                            // Work orders 1 and 3 exist, safe to seed deliveries
                            const insertDelivery = db.prepare('INSERT INTO deliveries (work_order_id, will_call, due_time, carrier, status) VALUES (?,?,?,?,?)');
                            insertDelivery.run([1, 0, '2026-07-15 14:00:00', 'FedEx', 'pending']);
                            insertDelivery.run([3, 1, '2026-07-14 18:00:00', 'Will Call', 'pending']);
                            insertDelivery.finalize(() => {
                              console.log('Deliveries seeded');
                              finishInitialization();
                            });
                          } else {
                            console.log('Deliveries seeding skipped (work orders 1 and 3 do not exist)');
                            finishInitialization();
                          }
                        });
                      } else {
                        console.log('Deliveries already seeded');
                        finishInitialization();
                      }
                    });
                  }

                  function finishInitialization() {
                    console.log('Database initialization completed successfully.');
                    console.log('Default users:');
                    console.log('  - admin / adminpass (admin)');
                    console.log('  - manager / managerpass (manager)');
                    console.log('  - employee1 / employee1pass (employee)');
                    console.log('  - employee2 / employee2pass (employee)');
                    process.exit(0);
                  }
                });
              });
            });
          });
        });
      });
    });
  });
});
});
});
});
});
});
