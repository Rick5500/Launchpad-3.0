const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'launchpad.db');

// Initialize database schema and safely add any missing columns
function initDatabase() {
  return new Promise((resolve) => {
    // Defer requiring sqlite3 until needed
    let sqlite3;
    try {
      sqlite3 = require('sqlite3').verbose();
    } catch (err) {
      console.log('Database already initialized');
      resolve();
      return;
    }

    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('Error opening database:', err);
        resolve(); // Don't fail - database may be locked or already in use
        return;
      }

      // Enable foreign keys
      db.run('PRAGMA foreign_keys = ON', (err) => {
        if (err) {
          console.error('Error enabling foreign keys:', err);
          db.close();
          resolve();
          return;
        }

        // Read and execute schema
        const schemaPath = path.join(__dirname, 'schema.sql');
        try {
          const schema = fs.readFileSync(schemaPath, 'utf8');
          db.exec(schema, (err) => {
            if (err) {
              console.error('Error executing schema:', err);
              db.close();
              resolve();
              return;
            }

            // Add missing columns safely
            addMissingColumns(db)
              .then(() => {
                db.close((err) => {
                  if (err) {
                    console.error('Error closing database:', err);
                  } else {
                    console.log('Database initialized');
                  }
                  resolve();
                });
              })
              .catch((err) => {
                console.error('Error adding columns:', err);
                db.close();
                resolve();
              });
          });
        } catch (err) {
          console.error('Error reading schema file:', err);
          db.close();
          resolve();
        }
      });
    });
  });
}

// Safely add missing columns to work_orders table
function addMissingColumns(db) {
  return new Promise((resolve, reject) => {
    const columns = [
      {
        name: 'delivery_method',
        definition: "TEXT DEFAULT 'delivery'",
        check: "PRAGMA table_info(work_orders) WHERE name = 'delivery_method'",
      },
      {
        name: 'requested_delivery_time',
        definition: 'DATETIME',
        check: "PRAGMA table_info(work_orders) WHERE name = 'requested_delivery_time'",
      },
    ];

    let completed = 0;

    columns.forEach((col) => {
      db.get(col.check, [], (err, row) => {
        if (err) {
          console.error(`Error checking for ${col.name}:`, err);
          reject(err);
          return;
        }

        if (!row) {
          // Column doesn't exist, add it
          const alterSql = `ALTER TABLE work_orders ADD COLUMN ${col.name} ${col.definition}`;
          db.run(alterSql, (err) => {
            if (err) {
              if (err.message.includes('duplicate column name')) {
                console.log(`Column ${col.name} already exists`);
              } else {
                console.error(`Error adding ${col.name}:`, err);
                reject(err);
                return;
              }
            } else {
              console.log(`Added column ${col.name} to work_orders`);
            }

            completed++;
            if (completed === columns.length) {
              resolve();
            }
          });
        } else {
          console.log(`Column ${col.name} already exists`);
          completed++;
          if (completed === columns.length) {
            resolve();
          }
        }
      });
    });
  });
}

// Run if called directly
if (require.main === module) {
  initDatabase()
    .then(() => {
      console.log('Database ready');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed to initialize database:', err);
      process.exit(1);
    });
}

module.exports = { initDatabase };
