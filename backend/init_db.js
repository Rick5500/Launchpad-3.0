require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'database', 'launchpad.db');
const db = new sqlite3.Database(dbFile);

db.exec(schema, (err) => {
  if (err) {
    console.error('Failed to apply schema:', err);
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
          } else {
            console.log('Admin user created: username=admin password=' + adminPass);
            console.log('Customer data already exists.');
            process.exit(0);
          }
        });
      }
    );
  });
});
