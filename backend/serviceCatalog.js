const activityLog = require('./activityLog');
const { get, all, run, withTransaction } = require('./dbAsync');
const { httpError } = require('./httpError');
const {
  parseText,
  parseBool,
  parseInteger,
  parseLimit,
  parseOffset,
  parseDirection,
  parseSort,
  likePattern,
} = require('./fields');

const SORTS = {
  sort_order: 'sort_order',
  name: 'name COLLATE NOCASE',
  code: 'code COLLATE NOCASE',
  department: 'department_name COLLATE NOCASE',
  created_at: 'created_at',
};

const SUFFIX_MODES = new Set(['sequence', 'code']);

function present(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    department_name: row.department_name,
    sort_order: row.sort_order || 0,
    is_active: row.is_active !== 0,
    requires_approval: Boolean(row.requires_approval),
    code: row.code || '',
    suffix_mode: row.suffix_mode || 'sequence',
    default_turnaround_hours: row.default_turnaround_hours == null ? null : row.default_turnaround_hours,
    created_at: row.created_at,
    updated_at: row.updated_at || null,
  };
}

function parsePayload(body, partial) {
  const source = body || {};
  const name = parseText(source.name, 'name', { required: !partial, max: 120 });
  if (name.error) return name;
  const code = parseText(source.code, 'code', { required: !partial, max: 12 });
  if (code.error) return code;
  if (code.value && !/^[A-Za-z0-9]{1,12}$/.test(code.value)) {
    return { error: 'code must be 1 to 12 letters or digits' };
  }
  let suffixMode = null;
  if (source.suffix_mode != null && source.suffix_mode !== '') {
    suffixMode = String(source.suffix_mode).trim().toLowerCase();
    if (!SUFFIX_MODES.has(suffixMode)) return { error: 'suffix_mode must be sequence or code' };
  } else if (!partial) {
    return { error: 'suffix_mode is required' };
  }
  const department = parseText(source.department_name, 'department_name', { required: !partial, max: 120 });
  if (department.error) return department;
  const description = parseText(source.description, 'description', { max: 240 });
  if (description.error) return description;
  const sortOrder = parseInteger(source.sort_order, 'sort_order', { min: 0, max: 10000, allowNull: true });
  if (sortOrder.error) return sortOrder;
  const turnaround = parseInteger(source.default_turnaround_hours, 'default_turnaround_hours', {
    min: 1,
    max: 8760,
    allowNull: true,
  });
  if (turnaround.error) return turnaround;
  const active = parseBool(source.is_active, 'is_active', partial ? null : true);
  if (active.error) return active;
  const approval = parseBool(source.requires_approval, 'requires_approval', false);
  if (approval.error) return approval;
  if (suffixMode === 'code' && !code.value) return { error: 'code is required when suffix_mode is code' };
  return {
    value: {
      name: name.value,
      code: code.value,
      suffixMode,
      departmentName: department.value,
      description: description.value,
      sortOrder: sortOrder.value == null ? 0 : sortOrder.value,
      turnaround: turnaround.value,
      isActive: active.value,
      requiresApproval: approval.value,
    },
  };
}

async function assertDepartment(name) {
  const row = await get(
    `SELECT id, name FROM departments WHERE is_active = 1 AND lower(name) = lower(?)`,
    [name]
  );
  if (!row) throw httpError(400, 'department_name must be an active department');
  return row.name;
}

async function assertUnique(name, code, exceptId) {
  const nameRow = await get(
    `SELECT id FROM services WHERE lower(name) = lower(?) AND id != ?`,
    [name, exceptId || 0]
  );
  if (nameRow) throw httpError(409, 'A service with that name already exists');
  if (code) {
    const codeRow = await get(
      `SELECT id FROM services WHERE lower(code) = lower(?) AND id != ?`,
      [code, exceptId || 0]
    );
    if (codeRow) throw httpError(409, 'A service with that code already exists');
  }
}

function parseListQuery(query) {
  const source = query || {};
  const limit = parseLimit(source.limit, 50, 100);
  if (limit.error) return limit;
  const offset = parseOffset(source.offset);
  if (offset.error) return offset;
  const sort = parseSort(source.sort, SORTS, 'sort_order');
  if (sort.error) return sort;
  const dir = parseDirection(source.dir || (sort.value === 'sort_order' ? 'asc' : 'asc'));
  if (dir.error) return dir;
  const q = parseText(source.q, 'q', { max: 80 });
  if (q.error) return q;
  const active = source.active == null || source.active === '' ? null : parseBool(source.active, 'active');
  if (active && active.error) return active;
  return {
    value: {
      limit: limit.value,
      offset: offset.value,
      sort: sort.value,
      dir: dir.value,
      q: q.value,
      active: active ? active.value : null,
    },
  };
}

async function listServices(query) {
  const parsed = parseListQuery(query);
  if (parsed.error) throw httpError(400, parsed.error);
  const filters = parsed.value;
  const clauses = [];
  const params = [];
  if (filters.q) {
    clauses.push(`(name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR department_name LIKE ? ESCAPE '\\')`);
    const pattern = likePattern(filters.q);
    params.push(pattern, pattern, pattern);
  }
  if (filters.active != null) {
    clauses.push('is_active = ?');
    params.push(filters.active);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const count = await get(`SELECT COUNT(*) AS count FROM services ${where}`, params);
  const rows = await all(
    `SELECT id, name, description, department_name, sort_order, is_active, requires_approval,
            code, suffix_mode, default_turnaround_hours, created_at, updated_at
     FROM services
     ${where}
     ORDER BY ${SORTS[filters.sort]} ${filters.dir.toUpperCase()}, id ASC
     LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset]
  );
  return {
    services: rows.map(present),
    total: count ? count.count : 0,
    limit: filters.limit,
    offset: filters.offset,
  };
}

async function createService(actorId, body) {
  const parsed = parsePayload(body, false);
  if (parsed.error) throw httpError(400, parsed.error);
  const value = parsed.value;
  if (value.suffixMode === 'code' && !value.code) throw httpError(400, 'code is required when suffix_mode is code');
  const departmentName = await assertDepartment(value.departmentName);
  await assertUnique(value.name, value.code, null);
  const id = await withTransaction(async () => {
    const inserted = await run(
      `INSERT INTO services (
         name, description, department_name, sort_order, is_active, requires_approval,
         code, suffix_mode, default_turnaround_hours, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [
        value.name,
        value.description,
        departmentName,
        value.sortOrder,
        value.isActive,
        value.requiresApproval,
        value.code,
        value.suffixMode,
        value.turnaround,
      ]
    );
    await activityLog.record(actorId, 'service.created', 'service', inserted.lastID, {
      name: value.name,
      code: value.code,
      department_name: departmentName,
      suffix_mode: value.suffixMode,
      message: `Created service ${value.name}`,
    });
    return inserted.lastID;
  });
  const row = await get('SELECT * FROM services WHERE id = ?', [id]);
  return present(row);
}

async function updateService(actorId, id, body) {
  const serviceId = parseInteger(id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
  if (serviceId.error || !serviceId.value) throw httpError(400, 'id must be a positive integer');
  const existing = await get('SELECT * FROM services WHERE id = ?', [serviceId.value]);
  if (!existing) throw httpError(404, 'Service not found');
  const parsed = parsePayload(body, false);
  if (parsed.error) throw httpError(400, parsed.error);
  const value = parsed.value;
  const departmentName = await assertDepartment(value.departmentName);
  await assertUnique(value.name, value.code, existing.id);
  const wasActive = existing.is_active !== 0;
  const action = wasActive && value.isActive === 0
    ? 'service.deactivated'
    : (!wasActive && value.isActive === 1 ? 'service.reactivated' : 'service.updated');
  await withTransaction(async () => {
    await run(
      `UPDATE services
       SET name = ?, description = ?, department_name = ?, sort_order = ?, is_active = ?,
           requires_approval = ?, code = ?, suffix_mode = ?, default_turnaround_hours = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
      [
        value.name,
        value.description,
        departmentName,
        value.sortOrder,
        value.isActive,
        value.requiresApproval,
        value.code,
        value.suffixMode,
        value.turnaround,
        existing.id,
      ]
    );
    await activityLog.record(actorId, action, 'service', existing.id, {
      name: value.name,
      code: value.code,
      department_name: departmentName,
      suffix_mode: value.suffixMode,
      is_active: value.isActive === 1,
      message: action === 'service.deactivated'
        ? `Deactivated service ${value.name}`
        : action === 'service.reactivated'
          ? `Reactivated service ${value.name}`
          : `Updated service ${value.name}`,
    });
  });
  const row = await get('SELECT * FROM services WHERE id = ?', [existing.id]);
  return present(row);
}

module.exports = {
  listServices,
  createService,
  updateService,
  present,
};
