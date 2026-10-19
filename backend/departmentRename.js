// Live department names follow a rename inside the caller's transaction.
// Match the stored text exactly. users.department is resolved case-insensitively
// when a login is saved, so a lower() cascade would rewrite a different
// department that differs only by case.
//
// Follow the rename:
//   users.department
//   work_orders.department and work_orders.next_department (current queue and route)
//   services.department_name (the queue a new work order opens in)
//   departments.next_department (the shop route)
//   barcode_locations.department_name
//   barcode_locations.location when it is still the department name
//
// Leave history and free text as written:
//   production_history.department
//   barcode_events.from_department, barcode_events.to_department, barcode_events.location
//   activity_log.detail
//   notifications.title and notifications.body
//   system_alerts.message and system_alerts.detail
//   system_settings (no department-name setting; stage maps are environment)
//   production_board.lane (a lane, not a department)
//   work_orders.routing_instructions and production_history.notes
// work_orders.assigned_department_id is the department id, so it already follows.

async function countRows(tx, sql, params) {
  const row = await tx.get(sql, params);
  return row && row.count ? Number(row.count) : 0;
}

async function cascadeDepartmentRename(tx, previousName, name) {
  const users = await countRows(
    tx,
    'SELECT COUNT(*) AS count FROM users WHERE department = ?',
    [previousName]
  );
  await tx.run(
    `UPDATE users
     SET department = ?, updated_at = datetime('now')
     WHERE department = ?`,
    [name, previousName]
  );

  const workOrders = await countRows(
    tx,
    `SELECT COUNT(*) AS count FROM work_orders
     WHERE department = ? OR next_department = ?`,
    [previousName, previousName]
  );
  await tx.run(
    `UPDATE work_orders
     SET department = ?, updated_at = datetime('now')
     WHERE department = ?`,
    [name, previousName]
  );
  await tx.run(
    `UPDATE work_orders
     SET next_department = ?, updated_at = datetime('now')
     WHERE next_department = ?`,
    [name, previousName]
  );

  const services = await countRows(
    tx,
    'SELECT COUNT(*) AS count FROM services WHERE department_name = ?',
    [previousName]
  );
  await tx.run(
    `UPDATE services
     SET department_name = ?, updated_at = datetime('now')
     WHERE department_name = ?`,
    [name, previousName]
  );

  // Stamp updated_at so a later init does not write the seed route back over the new name.
  const departments = await countRows(
    tx,
    'SELECT COUNT(*) AS count FROM departments WHERE next_department = ?',
    [previousName]
  );
  await tx.run(
    `UPDATE departments
     SET next_department = ?, updated_at = datetime('now')
     WHERE next_department = ?`,
    [name, previousName]
  );

  const barcodeLocations = await countRows(
    tx,
    `SELECT COUNT(*) AS count FROM barcode_locations
     WHERE department_name = ? OR location = ?`,
    [previousName, previousName]
  );
  await tx.run(
    `UPDATE barcode_locations
     SET department_name = ?, updated_at = datetime('now')
     WHERE department_name = ?`,
    [name, previousName]
  );
  // Last, so a location-name collision rolls back every earlier update in this transaction.
  await tx.run(
    `UPDATE barcode_locations
     SET location = ?, updated_at = datetime('now')
     WHERE location = ?`,
    [name, previousName]
  );

  return {
    users,
    work_orders: workOrders,
    services,
    departments,
    barcode_locations: barcodeLocations,
  };
}

module.exports = {
  cascadeDepartmentRename,
};
