// Shop locations (Raleigh, Hickory, Charlotte). This is not a barcode station.
// Operators are limited to one location. A manager with no location sees every
// location. Admins always see every location. Customers are shared and keep a
// default location they can change.

const { get, all, run } = require('./dbAsync');
const { httpError } = require('./httpError');
const { parseText } = require('./fields');
const { addressLines, loadLetterhead } = require('./shopProfile');

const DEFAULT_LOCATION_NAME = 'Raleigh';

const SEEDS = [
  {
    name: 'Raleigh',
    address: '8121 Brownleigh Drive\nRaleigh, NC 27617',
    phone: '919-782-3332',
    sort_order: 1,
  },
  {
    name: 'Hickory',
    address: '725 11th Ave Blvd SE\nHickory, NC 28602',
    phone: '828-322-5050',
    sort_order: 2,
  },
  {
    name: 'Charlotte',
    address: '920 Blairhill Road, Suite B115\nCharlotte, NC 28217',
    phone: '980-237-6922',
    sort_order: 3,
  },
];

function present(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    address: row.address || '',
    phone: row.phone || '',
    is_active: row.is_active !== 0 && row.is_active !== false,
    sort_order: row.sort_order || 0,
  };
}

function dbOf(executor) {
  if (executor && typeof executor.get === 'function') return executor;
  return { get, all, run };
}

async function defaultLocationId(executor) {
  const db = dbOf(executor);
  const named = await db.get(
    `SELECT id FROM locations WHERE lower(name) = lower(?) ORDER BY id LIMIT 1`,
    [DEFAULT_LOCATION_NAME]
  );
  if (named) return named.id;
  const fallback = await db.get(`SELECT id FROM locations WHERE is_active = 1 ORDER BY sort_order, id LIMIT 1`);
  if (fallback) return fallback.id;
  const anyRow = await db.get(`SELECT id FROM locations ORDER BY sort_order, id LIMIT 1`);
  return anyRow ? anyRow.id : null;
}

function isAllToken(value) {
  if (value == null) return true;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === '' || text === 'all' || text === 'all locations';
  }
  return false;
}

async function resolveLocationId(executor, value, options = {}) {
  const allowAll = Boolean(options.allowAll);
  const required = Boolean(options.required);
  const activeOnly = options.activeOnly !== false;
  if (isAllToken(value)) {
    if (allowAll) return { value: null, name: null };
    if (!required) return { value: null, name: null };
    return { error: 'Choose a location' };
  }
  const text = String(value).trim();
  const db = dbOf(executor);
  let row = null;
  if (/^[1-9]\d*$/.test(text)) {
    row = await db.get(`SELECT id, name, is_active FROM locations WHERE id = ?`, [Number(text)]);
  } else {
    row = await db.get(
      `SELECT id, name, is_active FROM locations WHERE lower(name) = lower(?)`,
      [text]
    );
  }
  if (!row) return { error: 'Choose an active location' };
  if (activeOnly && Number(row.is_active) === 0) return { error: 'That location is not active' };
  return { value: row.id, name: row.name };
}

async function loadAccess(userId, executor) {
  const db = dbOf(executor);
  const row = await db.get(
    `SELECT id, role, department, location_id FROM users WHERE id = ?`,
    [userId]
  );
  const raleighId = await defaultLocationId(db);
  if (!row) {
    return {
      userId: null,
      role: null,
      department: null,
      location_id: null,
      stored_location_id: null,
      all_locations: false,
      location: null,
      raleigh_id: raleighId,
    };
  }
  const department = row.department && String(row.department).trim() ? String(row.department).trim() : null;
  const stored = row.location_id == null ? null : Number(row.location_id);
  let locationId = stored;
  let allLocations = false;
  if (row.role === 'admin') {
    allLocations = true;
  } else if (row.role === 'manager') {
    allLocations = stored == null;
    locationId = stored;
  } else if (row.role === 'operator' || row.role === 'customer') {
    locationId = stored || raleighId;
    allLocations = false;
  }
  let location = null;
  if (locationId) {
    location = present(await db.get(`SELECT * FROM locations WHERE id = ?`, [locationId]));
  }
  return {
    userId: row.id,
    role: row.role,
    department,
    location_id: locationId,
    stored_location_id: stored,
    all_locations: allLocations,
    location,
    raleigh_id: raleighId,
  };
}

function seesAll(access) {
  if (!access) return false;
  if (access.role === 'admin' || access.all_locations) return true;
  if (access.role === 'manager' && access.stored_location_id == null && access.location_id == null) return true;
  return false;
}

function includeNullFor(access, locationId) {
  if (locationId == null) return false;
  const raleigh = access && access.raleigh_id != null ? Number(access.raleigh_id) : null;
  return raleigh != null && Number(locationId) === raleigh;
}

// SQL predicate. NULL location_id counts as Raleigh so rows written before
// the column was filled stay with the original shop.
function predicate(column, access) {
  if (!access || seesAll(access) || access.role === 'customer') return { sql: '', params: [] };
  const id = access.location_id;
  if (!id) return { sql: '1 = 0', params: [] };
  if (includeNullFor(access, id)) {
    return { sql: `(${column} = ? OR ${column} IS NULL)`, params: [id] };
  }
  return { sql: `(${column} = ?)`, params: [id] };
}

function andPredicate(column, access) {
  const pred = predicate(column, access);
  if (!pred.sql) return pred;
  return { sql: ` AND ${pred.sql}`, params: pred.params };
}

function matches(access, locationId) {
  if (!access) return false;
  if (access.role === 'customer') return true;
  if (seesAll(access)) return true;
  const record = locationId == null ? access.raleigh_id : Number(locationId);
  return Number(access.location_id) === Number(record);
}

// Mobile numbers fail closed. An admin sees every number. A manager sees a
// number only when shopLocations.matches says the customer is at that
// manager's shop. A manager with no shop is not treated as every shop here.
// Operators and customers do not see another person's mobile number.
function seesCustomerMobile(access, customerLocationId) {
  if (!access || access.role === 'operator' || access.role === 'customer') return false;
  if (access.role === 'admin') return true;
  if (access.role !== 'manager') return false;
  if (access.stored_location_id == null) return false;
  return matches(access, customerLocationId);
}

function assertVisible(access, locationId, message = 'Not found') {
  if (!matches(access, locationId)) throw httpError(404, message);
}

async function boardFilter(access, query) {
  if (!access || access.role === 'customer') {
    return { locked: false, locationId: null, includeNull: false, chosen: false };
  }
  if (!seesAll(access)) {
    return {
      locked: true,
      locationId: access.location_id,
      includeNull: includeNullFor(access, access.location_id),
      chosen: false,
      locationName: access.location ? access.location.name : null,
    };
  }
  const raw = query && query.location_id != null && query.location_id !== ''
    ? query.location_id
    : (query && query.shop_location);
  if (isAllToken(raw)) {
    return { locked: false, locationId: null, includeNull: false, chosen: false };
  }
  const resolved = await resolveLocationId({ get }, raw, { required: true, activeOnly: false });
  if (resolved.error) throw httpError(400, resolved.error);
  return {
    locked: true,
    locationId: resolved.value,
    includeNull: includeNullFor(access, resolved.value),
    chosen: true,
    locationName: resolved.name,
  };
}

function filterSql(column, filter) {
  if (!filter || filter.locationId == null) return { sql: '', params: [] };
  if (filter.includeNull) {
    return { sql: ` AND (${column} = ? OR ${column} IS NULL)`, params: [filter.locationId] };
  }
  return { sql: ` AND ${column} = ?`, params: [filter.locationId] };
}

async function listLocations({ includeInactive = false } = {}) {
  const rows = await all(
    `SELECT id, name, address, phone, is_active, sort_order
     FROM locations
     ${includeInactive ? '' : 'WHERE is_active = 1'}
     ORDER BY sort_order, name COLLATE NOCASE, id`
  );
  return rows.map(present);
}

async function getLocation(id) {
  const parsed = Number(id);
  if (!Number.isInteger(parsed) || parsed <= 0) throw httpError(400, 'id must be a positive integer');
  const row = await get(`SELECT * FROM locations WHERE id = ?`, [parsed]);
  if (!row) throw httpError(404, 'Location not found');
  return present(row);
}

function parseLocationBody(body, { requireName = true } = {}) {
  const source = body || {};
  const name = parseText(source.name, 'name', { required: requireName, max: 80 });
  if (name.error) return name;
  const address = parseText(source.address, 'address', { max: 500, allowNewlines: true });
  if (address.error) return address;
  const phone = parseText(source.phone, 'phone', { max: 40 });
  if (phone.error) return phone;
  let active = null;
  if (Object.prototype.hasOwnProperty.call(source, 'is_active')) {
    if (typeof source.is_active === 'boolean') active = source.is_active;
    else if (source.is_active === 1 || source.is_active === '1' || source.is_active === 'true') active = true;
    else if (source.is_active === 0 || source.is_active === '0' || source.is_active === 'false') active = false;
    else return { error: 'is_active must be true or false' };
  }
  let sortOrder = null;
  if (source.sort_order != null && source.sort_order !== '') {
    const parsed = Number(source.sort_order);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
      return { error: 'sort_order must be an integer from 0 to 1000' };
    }
    sortOrder = parsed;
  }
  return {
    value: {
      name: name.value,
      address: address.value,
      phone: phone.value,
      isActive: active,
      sortOrder,
    },
  };
}

async function createLocation(body) {
  const parsed = parseLocationBody(body, { requireName: true });
  if (parsed.error) throw httpError(400, parsed.error);
  const value = parsed.value;
  if (!value.name) throw httpError(400, 'name is required');
  const duplicate = await get(
    `SELECT id FROM locations WHERE lower(name) = lower(?)`,
    [value.name]
  );
  if (duplicate) throw httpError(409, 'A location with that name already exists');
  const inserted = await run(
    `INSERT INTO locations (name, address, phone, is_active, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,datetime('now'),datetime('now'))`,
    [
      value.name,
      value.address,
      value.phone,
      value.isActive === false ? 0 : 1,
      value.sortOrder == null ? 0 : value.sortOrder,
    ]
  );
  return getLocation(inserted.lastID);
}

async function updateLocation(id, body) {
  const current = await getLocation(id);
  const parsed = parseLocationBody(body, { requireName: false });
  if (parsed.error) throw httpError(400, parsed.error);
  const value = parsed.value;
  const name = value.name == null ? current.name : value.name;
  if (!name) throw httpError(400, 'name is required');
  const duplicate = await get(
    `SELECT id FROM locations WHERE lower(name) = lower(?) AND id != ?`,
    [name, current.id]
  );
  if (duplicate) throw httpError(409, 'A location with that name already exists');
  const active = value.isActive == null ? current.is_active : value.isActive;
  if (!active) {
    const others = await get(
      `SELECT COUNT(*) AS count FROM locations WHERE is_active = 1 AND id != ?`,
      [current.id]
    );
    if (!others || !others.count) throw httpError(400, 'At least one location must stay active');
  }
  await run(
    `UPDATE locations
     SET name = ?, address = ?, phone = ?, is_active = ?, sort_order = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      name,
      value.address == null ? current.address : value.address,
      value.phone == null ? current.phone : value.phone,
      active ? 1 : 0,
      value.sortOrder == null ? current.sort_order : value.sortOrder,
      current.id,
    ]
  );
  return getLocation(current.id);
}

async function locationForRole(executor, source, role, existingId) {
  const provided = source && Object.prototype.hasOwnProperty.call(source, 'location_id');
  const db = dbOf(executor);
  if (role === 'admin') {
    if (!provided) return { value: existingId == null ? null : existingId };
    return resolveLocationId(db, source.location_id, { allowAll: true, activeOnly: true });
  }
  if (role === 'manager') {
    if (!provided) return { value: existingId === undefined ? null : existingId };
    return resolveLocationId(db, source.location_id, { allowAll: true, activeOnly: true });
  }
  if (role === 'operator' || role === 'customer') {
    if (!provided) {
      if (existingId) return { value: existingId };
      const raleigh = await defaultLocationId(db);
      if (!raleigh) return { error: 'Choose a location' };
      return { value: raleigh };
    }
    const resolved = await resolveLocationId(db, source.location_id, { required: true, activeOnly: true });
    return resolved;
  }
  return { value: null };
}

async function resolveOrderLocation(executor, user, rawLocationId, customerId) {
  const db = dbOf(executor);
  const access = await loadAccess(user && (user.userId || user.id), db);
  const customer = customerId
    ? await db.get(`SELECT id, location_id, role FROM users WHERE id = ?`, [customerId])
    : null;
  const customerDefault = customer && customer.location_id ? Number(customer.location_id) : null;
  const raleigh = await defaultLocationId(db);
  const provided = rawLocationId != null && String(rawLocationId).trim() !== '';

  if (access.role === 'customer') {
    const chosen = provided ? rawLocationId : (customerDefault || access.location_id || raleigh);
    const resolved = await resolveLocationId(db, chosen, { required: true, activeOnly: true });
    if (resolved.error) throw httpError(400, resolved.error);
    return resolved;
  }

  if (!seesAll(access)) {
    if (provided) {
      const resolved = await resolveLocationId(db, rawLocationId, { required: true, activeOnly: true });
      if (resolved.error) throw httpError(400, resolved.error);
      if (Number(resolved.value) !== Number(access.location_id)) {
        throw httpError(403, 'You can only use your own location');
      }
      return resolved;
    }
    const home = await db.get(`SELECT id, name FROM locations WHERE id = ?`, [access.location_id]);
    if (!home || !access.location_id) throw httpError(400, 'Choose a location');
    return { value: home.id, name: home.name };
  }

  const chosen = provided ? rawLocationId : (customerDefault || raleigh);
  const resolved = await resolveLocationId(db, chosen, { required: true, activeOnly: true });
  if (resolved.error) throw httpError(400, resolved.error);
  return resolved;
}

function overlayLetterhead(letterhead, location) {
  const base = letterhead || { name: '', address: '', address_lines: [], phone: '' };
  if (!location || !location.name) return base;
  const address = String(location.address || '').trim();
  const phone = String(location.phone || '').trim();
  return {
    ...base,
    location_name: location.name,
    location_address: address,
    location_address_lines: address ? addressLines(address) : [],
    location_phone: phone,
  };
}

async function letterheadForLocationId(locationId) {
  const base = await loadLetterhead();
  if (locationId == null) return base;
  const row = await get(`SELECT * FROM locations WHERE id = ?`, [locationId]);
  return overlayLetterhead(base, present(row));
}

async function publicUserFields(userId) {
  const access = await loadAccess(userId);
  return {
    location_id: access.role === 'admin' ? access.stored_location_id : access.location_id,
    location_name: access.location ? access.location.name : null,
    all_locations: Boolean(access.all_locations),
  };
}

async function comparison() {
  const locations = await listLocations({ includeInactive: false });
  const raleigh = await defaultLocationId();
  const work = await all(
    `SELECT location_id, COUNT(*) AS count
     FROM work_orders
     WHERE NOT (lower(trim(coalesce(status, ''))) IN ('completed', 'complete'))
       AND NOT (lower(trim(coalesce(department, ''))) = 'complete')
     GROUP BY location_id`
  );
  const orders = await all(
    `SELECT location_id, COUNT(*) AS count FROM orders GROUP BY location_id`
  );
  const quotes = await all(
    `SELECT location_id, COUNT(*) AS count FROM quote_requests WHERE status = 'New' GROUP BY location_id`
  );
  const workMap = new Map(work.map((row) => [row.location_id == null ? 0 : row.location_id, row.count]));
  const orderMap = new Map(orders.map((row) => [row.location_id == null ? 0 : row.location_id, row.count]));
  const quoteMap = new Map(quotes.map((row) => [row.location_id == null ? 0 : row.location_id, row.count]));
  const nullWork = workMap.get(0) || 0;
  const nullOrders = orderMap.get(0) || 0;
  const nullQuotes = quoteMap.get(0) || 0;
  return locations.map((location) => ({
    id: location.id,
    name: location.name,
    address: location.address,
    phone: location.phone,
    active_work_orders: (workMap.get(location.id) || 0) + (Number(location.id) === Number(raleigh) ? nullWork : 0),
    orders: (orderMap.get(location.id) || 0) + (Number(location.id) === Number(raleigh) ? nullOrders : 0),
    new_quotes: (quoteMap.get(location.id) || 0) + (Number(location.id) === Number(raleigh) ? nullQuotes : 0),
  }));
}

module.exports = {
  DEFAULT_LOCATION_NAME,
  SEEDS,
  present,
  defaultLocationId,
  resolveLocationId,
  loadAccess,
  seesAll,
  predicate,
  andPredicate,
  matches,
  seesCustomerMobile,
  assertVisible,
  boardFilter,
  filterSql,
  listLocations,
  getLocation,
  createLocation,
  updateLocation,
  locationForRole,
  resolveOrderLocation,
  overlayLetterhead,
  letterheadForLocationId,
  publicUserFields,
  comparison,
};
