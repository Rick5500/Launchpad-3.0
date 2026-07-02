const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('../database/launchpad.db');

db.all(
  `SELECT 
    wods.work_order_id,
    d.name,
    wods.status
  FROM work_order_department_status wods
  JOIN departments d ON wods.department_id = d.id
  WHERE wods.work_order_id IN (2,3)
  ORDER BY wods.work_order_id, d.sort_order`,
  (err, rows) => {
    if (err) console.error(err);
    else {
      console.log('Work Order Department Status:');
      rows.forEach(r => console.log(`  WO ${r.work_order_id}: ${r.name} = ${r.status}`));
    }
    db.close();
  }
);
