const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('../launchpad.db');

db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", (err, tables) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('All tables in database:');
    if (tables && tables.length > 0) {
      tables.forEach(t => console.log('  -', t.name));
    } else {
      console.log('  (no tables found)');
    }
  }
  db.close();
});
