const db = require('./db');

// Check for product tables
db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'product%'", [], (err, rows) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }
  console.log('Product tables:', JSON.stringify(rows, null, 2));
  
  // Check product_categories table
  if (rows.some(r => r.name === 'product_categories')) {
    db.all('SELECT * FROM product_categories', [], (err, cats) => {
      if (err) {
        console.error('Error fetching categories:', err);
      } else {
        console.log('Product categories:', JSON.stringify(cats, null, 2));
      }
      process.exit(0);
    });
  } else {
    console.log('product_categories table does not exist');
    process.exit(0);
  }
});
