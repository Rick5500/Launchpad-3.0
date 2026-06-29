const sqlite3 = require('sqlite3');
const path = require('path');

const dbFile = path.join(__dirname, '..', 'database', 'launchpad.db');
console.log('Connecting to database:', dbFile);

const db = new sqlite3.Database(dbFile);

db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", (err, tables) => {
  if (err) {
    console.error('Error querying tables:', err.message);
  } else {
    console.log('\nAll tables in database:');
    if (tables && tables.length > 0) {
      tables.forEach(t => console.log('  -', t.name));
      
      // Check specifically for work_order_line_items
      const hasLineItems = tables.some(t => t.name === 'work_order_line_items');
      if (hasLineItems) {
        console.log('\n✓ work_order_line_items table EXISTS!');
      } else {
        console.log('\n✗ work_order_line_items table MISSING');
      }
    } else {
      console.log('  (no tables found)');
    }
  }
  db.close();
});
