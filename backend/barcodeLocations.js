const activityLog = require('./activityLog');
const { get, all, withTransaction } = require('./dbAsync');
const { httpError } = require('./httpError');
const { parseText, parseBool, parseInteger } = require('./fields');

function present(row) {
  return {
    id: row.id,
    location: row.location,
    department_name: row.department_name || '',
    stage_name: row.stage_name || '',
    sort_order: row.sort_order || 0,
    is_active: row.is_active !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at || null,
  };
}

async function listLocations() {
  const rows = await all(
    `SELECT id, location, department_name, stage_name, sort_order, is_active, created_at, updated_at
     FROM barcode_locations
     ORDER BY sort_order ASC, location COLLATE NOCASE ASC, id ASC`
  );
  return rows.map(present);
}

async function parsePayload(body) {
  const source = body || {};
  const location = parseText(source.location, 'location', { required: true, max: 120 });
  if (location.error) throw httpError(400, location.error);
  const department = parseText(source.department_name, 'department_name', { max: 120 });
  if (department.error) throw httpError(400, department.error);
  const stage = parseText(source.stage_name, 'stage_name', { max: 120 });
  if (stage.error) throw httpError(400, stage.error);
  if (!department.value && !stage.value) {
    throw httpError(400, 'location must map to a department, a stage, or both');
  }
  const sortOrder = parseInteger(source.sort_order, 'sort_order', { min: 0, max: 10000, allowNull: true });
  if (sortOrder.error) throw httpError(400, sortOrder.error);
  const active = parseBool(source.is_active, 'is_active', true);
  if (active.error) throw httpError(400, active.error);

  let departmentName = null;
  if (department.value) {
    const row = await get(
      `SELECT name FROM departments WHERE is_active = 1 AND lower(name) = lower(?)`,
      [department.value]
    );
    if (!row) throw httpError(400, 'department_name must be an active department');
    departmentName = row.name;
  }
  let stageName = null;
  if (stage.value) {
    const row = await get(
      `SELECT name FROM production_stages WHERE lower(name) = lower(?)`,
      [stage.value]
    );
    if (!row) throw httpError(400, 'stage_name must be an existing production stage');
    stageName = row.name;
  }
  return {
    location: location.value,
    departmentName,
    stageName,
    sortOrder: sortOrder.value == null ? 0 : sortOrder.value,
    isActive: active.value,
  };
}

async function assertUnique(location, exceptId) {
  const row = await get(
    `SELECT id FROM barcode_locations WHERE lower(location) = lower(?) AND id != ?`,
    [location, exceptId || 0]
  );
  if (row) throw httpError(409, 'A location with that name already exists');
}

async function createLocation(actorId, body) {
  const value = await parsePayload(body);
  await assertUnique(value.location, null);
  const id = await withTransaction(async (tx) => {
    const inserted = await tx.run(
      `INSERT INTO barcode_locations (location, department_name, stage_name, sort_order, is_active, updated_at)
       VALUES (?,?,?,?,?,datetime('now'))`,
      [value.location, value.departmentName, value.stageName, value.sortOrder, value.isActive]
    );
    await activityLog.recordOn(tx, actorId, 'barcode_location.created', 'barcode_location', inserted.lastID, {
      location: value.location,
      department_name: value.departmentName,
      stage_name: value.stageName,
      message: `Added scan location ${value.location}`,
    });
    return inserted.lastID;
  });
  const row = await get('SELECT * FROM barcode_locations WHERE id = ?', [id]);
  return present(row);
}

async function updateLocation(actorId, id, body) {
  const parsedId = parseInteger(id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
  if (parsedId.error || !parsedId.value) throw httpError(400, 'id must be a positive integer');
  const existing = await get('SELECT * FROM barcode_locations WHERE id = ?', [parsedId.value]);
  if (!existing) throw httpError(404, 'Location not found');
  const value = await parsePayload(body);
  await assertUnique(value.location, existing.id);
  await withTransaction(async (tx) => {
    await tx.run(
      `UPDATE barcode_locations
       SET location = ?, department_name = ?, stage_name = ?, sort_order = ?, is_active = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [value.location, value.departmentName, value.stageName, value.sortOrder, value.isActive, existing.id]
    );
    await activityLog.recordOn(tx, actorId, 'barcode_location.updated', 'barcode_location', existing.id, {
      location: value.location,
      department_name: value.departmentName,
      stage_name: value.stageName,
      is_active: value.isActive === 1,
      message: `Updated scan location ${value.location}`,
    });
  });
  const row = await get('SELECT * FROM barcode_locations WHERE id = ?', [existing.id]);
  return present(row);
}

async function removeLocation(actorId, id) {
  const parsedId = parseInteger(id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
  if (parsedId.error || !parsedId.value) throw httpError(400, 'id must be a positive integer');
  const existing = await get('SELECT * FROM barcode_locations WHERE id = ?', [parsedId.value]);
  if (!existing) throw httpError(404, 'Location not found');
  await withTransaction(async (tx) => {
    await tx.run('DELETE FROM barcode_locations WHERE id = ?', [existing.id]);
    await activityLog.recordOn(tx, actorId, 'barcode_location.removed', 'barcode_location', existing.id, {
      location: existing.location,
      department_name: existing.department_name,
      stage_name: existing.stage_name,
      message: `Removed scan location ${existing.location}`,
    });
  });
  return { ok: true, id: existing.id };
}

module.exports = {
  listLocations,
  createLocation,
  updateLocation,
  removeLocation,
  present,
};
