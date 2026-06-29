const sqlite3 = require('sqlite3');
const path = require('path');

const dbFile = path.join(__dirname, '..', 'database', 'launchpad.db');
const db = new sqlite3.Database(dbFile);

console.log('Querying work order 2 and its line items...\n');

db.all('SELECT * FROM work_orders WHERE id = 2', (err, workOrders) => {
  if (err) {
    console.error('Error querying work orders:', err.message);
    db.close();
    return;
  }
  
  console.log('Work Order:');
  if (workOrders && workOrders.length > 0) {
    const wo = workOrders[0];
    console.log(`  ID: ${wo.id}`);
    console.log(`  Description: ${wo.description}`);
    console.log(`  Customer ID: ${wo.customer_id}`);
    console.log(`  Status: ${wo.status}`);
    console.log(`  Quantity: ${wo.quantity}`);
  } else {
    console.log('  (Work order not found)');
  }
  
  db.all(`
    SELECT woli.*, 
           p.name as product_name
    FROM work_order_line_items woli
    LEFT JOIN products p ON woli.product_id = p.id
    WHERE woli.work_order_id = 2
  `, (err2, lineItems) => {
    if (err2) {
      console.error('Error querying line items:', err2.message);
      db.close();
      return;
    }
    
    console.log('\nLine Items:');
    if (lineItems && lineItems.length > 0) {
      lineItems.forEach(item => {
        console.log(`  - Product: ${item.product_name} (ID: ${item.product_id})`);
        console.log(`    Quantity: ${item.quantity}`);
        console.log(`    Description: ${item.description}`);
        console.log(`    Notes: ${item.notes}`);
        console.log(`    Created: ${item.created_at}`);
      });
    } else {
      console.log('  (No line items found)');
    }
    
    db.close();
  });
});
