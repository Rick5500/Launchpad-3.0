const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'launchpad.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error opening database:', err);
    process.exit(1);
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON', (err) => {
    if (err) {
      console.error('Error enabling foreign keys:', err);
      db.close();
      process.exit(1);
    }

    // Add columns if they don't exist
    const addColumns = () => {
      db.run(
        `ALTER TABLE work_orders ADD COLUMN delivery_method TEXT DEFAULT 'delivery'`,
        (err) => {
          if (err) {
            if (err.message.includes('duplicate column name')) {
              console.log('Column delivery_method already exists');
            } else {
              console.error('Error adding delivery_method:', err.message);
            }
          } else {
            console.log('Added delivery_method column');
          }

          db.run(
            `ALTER TABLE work_orders ADD COLUMN requested_delivery_time DATETIME`,
            (err) => {
              if (err) {
                if (err.message.includes('duplicate column name')) {
                  console.log('Column requested_delivery_time already exists');
                } else {
                  console.error('Error adding requested_delivery_time:', err.message);
                }
              } else {
                console.log('Added requested_delivery_time column');
              }

              db.run(
                `CREATE TABLE IF NOT EXISTS work_order_department_packets (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  work_order_id INTEGER NOT NULL,
                  department_id INTEGER NOT NULL,
                  packet_number TEXT NOT NULL,
                  status TEXT DEFAULT 'In Progress',
                  barcode_value TEXT,
                  printed_at DATETIME,
                  received_in_qc_at DATETIME,
                  completed_at DATETIME,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY(work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE,
                  FOREIGN KEY(department_id) REFERENCES departments(id),
                  UNIQUE(work_order_id, department_id)
                )`,
                (tableErr) => {
                  if (tableErr) {
                    console.error('Error ensuring work_order_department_packets table:', tableErr.message);
                  } else {
                    console.log('Ensured work_order_department_packets table');
                  }

                  db.close((err2) => {
                    if (err2) {
                      console.error('Error closing database:', err2);
                      process.exit(1);
                    } else {
                      console.log('Migration complete');
                      process.exit(0);
                    }
                  });
                }
              );
            }
          );
        }
      );
    };

    addColumns();
  });
});
