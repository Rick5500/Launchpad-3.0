const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('../launchpad.db');

// Check if table exists
db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='work_order_line_items'", (err, rows) => {
  if (err) {
    console.error('Error:', err.message);
    db.close();
    return;
  }
  
  if (rows && rows.length > 0) {
    console.log('✓ work_order_line_items table EXISTS');
    
    // Query line items
    db.all('SELECT * FROM work_order_line_items WHERE work_order_id = 2', (err2, items) => {
      if (err2) {
        console.error('Error querying:', err2.message);
      } else {
        console.log('Line items for work order 2:', JSON.stringify(items, null, 2));
      }
      
      // Also check all tables
      db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", (err3, tables) => {
        console.log('\nAll tables in database:');
        if (tables) {
          tables.forEach(t => console.log('  -', t.name));
        }
        db.close();
      });
    });
  } else {
    console.log('✗ work_order_line_items table DOES NOT EXIST');
    
    // List all tables
    db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", (err3, tables) => {
      console.log('\nAll tables in database:');
      if (tables) {
        tables.forEach(t => console.log('  -', t.name));
      }
      db.close();
    });
  }
});
