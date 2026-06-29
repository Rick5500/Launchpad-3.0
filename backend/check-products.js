const db = require('./db');

db.all("SELECT id, name, is_active FROM products", [], (err, rows) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }
  console.log('All products (including inactive):');
  console.log(JSON.stringify(rows, null, 2));
  
  db.all("SELECT id, name, is_active FROM products WHERE is_active = 1", [], (err, active) => {
    if (err) {
      console.error('Error:', err);
      process.exit(1);
    }
    console.log('\nActive products only:');
    console.log(JSON.stringify(active, null, 2));
    process.exit(0);
  });
});
