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
        if (err) console.error(err);
        else console.log('Admin user created: username=admin password=' + adminPass);
        process.exit(0);
      }
    );
  });
});
