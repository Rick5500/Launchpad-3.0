// Live department names follow a rename inside the caller's transaction.
// users, services, department routes, and scan locations match the stored text
// exactly. A lower() update there would rewrite a different department that
// differs only by case. Work orders match case-insensitively and trimmed, so a
// stray-cased queue still follows the department it belongs to.
//
// Quality, Dispatch, and Complete cannot be renamed. The complete queue and the
// Quality / Dispatch scan stages still look up those names. Rejecting the rename
// keeps that logic from pointing at a name that no longer exists.
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

const SYSTEM_DEPARTMENTS = new Set(['quality', 'dispatch', 'complete']);

function isSystemDepartment(name) {
  return SYSTEM_DEPARTMENTS.has(String(name || '').trim().toLowerCase());
}

function systemDepartmentMessage(name) {
  return `${name} is a system department and cannot be renamed. The Admin Board and barcode scans use that name.`;
}

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
     WHERE lower(trim(coalesce(department, ''))) = lower(trim(?))
        OR lower(trim(coalesce(next_department, ''))) = lower(trim(?))`,
    [previousName, previousName]
  );
  await tx.run(
    `UPDATE work_orders
     SET department = ?, updated_at = datetime('now')
     WHERE lower(trim(coalesce(department, ''))) = lower(trim(?))`,
    [name, previousName]
  );
  await tx.run(
    `UPDATE work_orders
     SET next_department = ?, updated_at = datetime('now')
     WHERE lower(trim(coalesce(next_department, ''))) = lower(trim(?))`,
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
  isSystemDepartment,
  systemDepartmentMessage,
};
