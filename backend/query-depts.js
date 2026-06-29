const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbFile = path.join(__dirname, '..', 'database', 'launchpad.db');
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error('DB Error:', err);
    process.exit(1);
  }
  
  db.all('SELECT id, name FROM departments ORDER BY id', [], (err, rows) => {
    if (err) {
      console.error('Query Error:', err);
    } else {
      console.log('Departments:');
      console.log(JSON.stringify(rows, null, 2));
    }
    db.close();
  });
});
