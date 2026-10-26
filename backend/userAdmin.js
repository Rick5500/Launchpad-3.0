const crypto = require('crypto');
const auth = require('./auth');
const activityLog = require('./activityLog');
const notifyEmail = require('./notifyEmail');
const { resetUserPassword, passwordPolicyError } = require('./passwordReset');
const { get, all, withTransaction } = require('./dbAsync');
const { httpError } = require('./httpError');
const shopLocations = require('./shopLocations');
const { normalizeE164, SMS_CONSENT } = require('./sms');
const {
  parseText,
  parseBool,
  parseInteger,
  parseEmail,
  parsePostalAddress,
  parseLimit,
  parseOffset,
  parseDirection,
  parseSort,
  likePattern,
} = require('./fields');

const MIN_PASSWORD_LENGTH = 8;
const ROLES = new Set(['admin', 'manager', 'operator', 'customer']);
const SORTS = {
  username: 'username COLLATE NOCASE',
  display_name: 'display_name COLLATE NOCASE',
  role: 'role',
  created_at: 'created_at',
  is_active: 'is_active',
};

const PUBLIC_COLUMNS = `id, username, role, display_name, company, contact_name, phone, email,
  mobile_phone, sms_opt_in,
  address_line1, address_line2, city, state, zip, department, location_id, is_active, created_at, updated_at`;

function present(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    display_name: row.display_name || '',
    company: row.company || '',
    contact_name: row.contact_name || '',
    phone: row.phone || '',
    email: row.email || '',
    mobile_phone: row.mobile_phone || '',
    sms_opt_in: Number(row.sms_opt_in) === 1,
    sms_consent: SMS_CONSENT,
    address_line1: row.address_line1 || '',
    address_line2: row.address_line2 || '',
    city: row.city || '',
    state: row.state || '',
    zip: row.zip || '',
    department: row.department || null,
    location_id: row.location_id == null ? null : row.location_id,
    all_locations: row.role === 'admin' || (row.role === 'manager' && row.location_id == null),
    is_active: row.is_active !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at || null,
  };
}

function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function parseRole(value, required) {
  if (value == null || value === '') {
    if (required) return { error: 'role is required' };
    return { value: null };
  }
  const role = String(value).trim().toLowerCase();
  if (!ROLES.has(role)) return { error: 'role must be admin, manager, operator, or customer' };
  return { value: role };
}

// Shared by self-registration, admin create, and a username change. Sign-in
// accepts the same characters and does not apply a stricter pattern.
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+'-]{1,79}$/;

function parseUsername(value, required) {
  const parsed = parseText(value, 'username', { required, max: 80 });
  if (parsed.error || parsed.value == null) return parsed;
  if (!USERNAME_PATTERN.test(parsed.value)) {
    return { error: "username must be 2 to 80 characters and use letters, digits, or . _ @ - + '" };
  }
  return parsed;
}

const STAFF_OPT_IN_ERROR = 'Only the customer can opt in to order status texts';

// Staff may store a mobile number and turn texts off. Turning texts on is the
// customer's choice, so a staff save that would change opt-in from off to on
// is rejected. A different normalized number drops an existing opt-in. The
// same number, after E.164 normalization, keeps it.
function staffOptInError(existing, next, allowOptIn) {
  if (allowOptIn) return null;
  const wasOn = existing && Number(existing.sms_opt_in) === 1;
  if (next && next.smsOptIn === 1 && !wasOn) return STAFF_OPT_IN_ERROR;
  return null;
}

function applyStaffNumberChange(existing, next) {
  if (!next) return next;
  const value = { mobilePhone: next.mobilePhone, smsOptIn: next.smsOptIn };
  const previous = normalizeE164(existing && existing.mobile_phone);
  const upcoming = value.mobilePhone ? normalizeE164(value.mobilePhone) : null;
  const wasOn = existing && Number(existing.sms_opt_in) === 1;
  if (wasOn && (previous || null) !== (upcoming || null)) value.smsOptIn = 0;
  return value;
}

// Omitted fields keep the stored values. Opt-in stays off unless it is set,
// and it requires a number that normalizes to E.164.
function parseTexting(body, existing, options = {}) {
  const source = body || {};
  const mobileProvided = Object.prototype.hasOwnProperty.call(source, 'mobile_phone');
  const optProvided = Object.prototype.hasOwnProperty.call(source, 'sms_opt_in');
  if (!mobileProvided && !optProvided) {
    if (options.requireProvided) return { error: 'mobile_phone or sms_opt_in is required' };
    return {
      value: {
        mobilePhone: existing && existing.mobile_phone ? existing.mobile_phone : null,
        smsOptIn: existing && Number(existing.sms_opt_in) === 1 ? 1 : 0,
      },
    };
  }
  let mobile = existing && existing.mobile_phone ? existing.mobile_phone : null;
  if (mobileProvided) {
    if (source.mobile_phone == null || String(source.mobile_phone).trim() === '') {
      mobile = null;
    } else {
      const normalized = normalizeE164(source.mobile_phone);
      if (!normalized) return { error: 'mobile_phone must be a valid phone number' };
      mobile = normalized;
    }
  }
  let opt = existing && Number(existing.sms_opt_in) === 1 ? 1 : 0;
  if (optProvided) {
    const parsed = parseBool(source.sms_opt_in, 'sms_opt_in', false);
    if (parsed.error) return parsed;
    opt = parsed.value;
  }
  let value = { mobilePhone: mobile, smsOptIn: opt };
  if (options.staff) value = applyStaffNumberChange(existing, value);
  if (value.smsOptIn === 1 && !value.mobilePhone) return { error: 'Enter a mobile number to receive order status texts' };
  if (options.staff) {
    const blocked = staffOptInError(existing, value, false);
    if (blocked) return { error: blocked, status: 403 };
  }
  return { value };
}

function parseProfile(body) {
  const company = parseText(body.company, 'company', { max: 160 });
  if (company.error) return company;
  const contact = parseText(body.contact_name, 'contact_name', { max: 160 });
  if (contact.error) return contact;
  const phone = parseText(body.phone, 'phone', { max: 40 });
  if (phone.error) return phone;
  const email = parseEmail(body.email, false);
  if (email.error) return email;
  const address = parsePostalAddress(body, false);
  if (address.error) return address;
  return {
    value: {
      company: company.value,
      contactName: contact.value,
      phone: phone.value,
      email: email.value,
      addressLine1: address.value.addressLine1,
      addressLine2: address.value.addressLine2,
      city: address.value.city,
      state: address.value.state,
      zip: address.value.zip,
    },
  };
}

function departmentProvided(source) {
  return Object.prototype.hasOwnProperty.call(source || {}, 'department');
}

// Empty, omitted, and "All departments" store NULL. A name must match departments.name.
async function canonicalDepartment(tx, value) {
  if (value == null) return { value: null };
  if (typeof value !== 'string') return { error: 'department must be a string' };
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'all departments') return { value: null };
  const parsed = parseText(trimmed, 'department', { max: 80 });
  if (parsed.error) return parsed;
  const row = await tx.get(
    `SELECT name FROM departments WHERE lower(name) = lower(?)`,
    [parsed.value]
  );
  if (!row) {
    const names = await tx.all(`SELECT name FROM departments ORDER BY sort_order ASC, name ASC`);
    const list = names.map((item) => item.name).filter(Boolean).join(', ');
    return {
      error: list
        ? `department must be an existing department: ${list}`
        : 'department must be an existing department',
    };
  }
  return { value: row.name };
}

async function departmentForRole(tx, source, role, existingDepartment) {
  if (role === 'customer') {
    if (departmentProvided(source)) {
      const resolved = await canonicalDepartment(tx, source.department);
      if (resolved.error) return resolved;
      if (resolved.value) return { error: 'Customers are not assigned a department' };
    }
    return { value: null };
  }
  // A manager sees every department, so a department on the request is discarded.
  if (role === 'manager') return { value: null };
  if (!departmentProvided(source)) return { value: existingDepartment || null };
  return canonicalDepartment(tx, source.department);
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const parts = header.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') return parts[1];
  return null;
}

function emailAsUsername(email) {
  if (email.length > 80) return { error: 'email must be 80 characters or fewer' };
  const parsed = parseUsername(email, true);
  if (parsed.error) {
    return { error: "email cannot be used as a sign-in name. Use letters, digits, and . _ + ' @ -" };
  }
  return parsed;
}

function honeypotTripped(source) {
  if (!source || !Object.prototype.hasOwnProperty.call(source, 'website')) return false;
  const value = source.website;
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function isUniqueConstraint(err) {
  if (!err) return false;
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  const message = String(err.message || '');
  return /UNIQUE constraint failed/i.test(message) || /PRIMARY KEY constraint failed/i.test(message);
}

function conflictError(err) {
  if (err && err.status) return err;
  if (!isUniqueConstraint(err)) return err;
  if (/users\.username/i.test(String(err.message || ''))) return httpError(409, 'Username is already in use');
  return httpError(409, 'That value is already in use');
}

// Same columns as an admin-created account. Role, department, and active are arguments, never raw body fields.
async function insertUserRow(tx, row) {
  return tx.run(
    `INSERT INTO users (
       username, password_hash, role, display_name, company, contact_name, phone, email,
       mobile_phone, sms_opt_in,
       address_line1, address_line2, city, state, zip, department, location_id, is_active, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    [
      row.username,
      row.passwordHash,
      row.role,
      row.displayName,
      row.company,
      row.contactName,
      row.phone,
      row.email,
      row.mobilePhone || null,
      row.smsOptIn ? 1 : 0,
      row.addressLine1,
      row.addressLine2,
      row.city,
      row.state,
      row.zip,
      row.department,
      row.locationId == null ? null : row.locationId,
      row.isActive,
    ]
  );
}

async function countOtherActiveAdmins(tx, userId) {
  const row = await tx.get(
    `SELECT COUNT(*) AS count
     FROM users
     WHERE role = 'admin' AND COALESCE(is_active, 1) = 1 AND id != ?`,
    [userId]
  );
  return row ? row.count : 0;
}

function parseListQuery(query) {
  const source = query || {};
  const limit = parseLimit(source.limit, 25, 100);
  if (limit.error) return limit;
  const offset = parseOffset(source.offset);
  if (offset.error) return offset;
  const sort = parseSort(source.sort, SORTS, 'username');
  if (sort.error) return sort;
  const dir = parseDirection(source.dir || 'asc');
  if (dir.error) return dir;
  const q = parseText(source.q, 'q', { max: 80 });
  if (q.error) return q;
  const role = source.role == null || source.role === '' ? { value: null } : parseRole(source.role, true);
  if (role.error) return role;
  const active = source.active == null || source.active === '' ? null : parseBool(source.active, 'active');
  if (active && active.error) return active;
  return {
    value: {
      limit: limit.value,
      offset: offset.value,
      sort: sort.value,
      dir: dir.value,
      q: q.value,
      role: role.value,
      active: active ? active.value : null,
    },
  };
}

async function listUsers(query) {
  const parsed = parseListQuery(query);
  if (parsed.error) throw httpError(400, parsed.error);
  const filters = parsed.value;
  const clauses = [];
  const params = [];
  if (filters.q) {
    const pattern = likePattern(filters.q);
    clauses.push(`(username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern, pattern, pattern);
  }
  if (filters.role) {
    clauses.push('role = ?');
    params.push(filters.role);
  }
  if (filters.active != null) {
    clauses.push('COALESCE(is_active, 1) = ?');
    params.push(filters.active);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const count = await get(`SELECT COUNT(*) AS count FROM users ${where}`, params);
  const rows = await all(
    `SELECT ${PUBLIC_COLUMNS}
     FROM users
     ${where}
     ORDER BY ${SORTS[filters.sort]} ${filters.dir.toUpperCase()}, id ASC
     LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset]
  );
  return {
    users: rows.map(present),
    total: count ? count.count : 0,
    limit: filters.limit,
    offset: filters.offset,
  };
}

async function getUser(id) {
  const parsed = parseInteger(id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
  if (parsed.error || !parsed.value) throw httpError(400, 'id must be a positive integer');
  const row = await get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [parsed.value]);
  if (!row) throw httpError(404, 'User not found');
  return present(row);
}

async function createUser(actorId, body) {
  const source = body || {};
  const username = parseUsername(source.username, true);
  if (username.error) throw httpError(400, username.error);
  const displayName = parseText(source.display_name, 'display_name', { required: true, max: 160 });
  if (displayName.error) throw httpError(400, displayName.error);
  const role = parseRole(source.role, true);
  if (role.error) throw httpError(400, role.error);
  const profile = parseProfile(source);
  if (profile.error) throw httpError(400, profile.error);
  const active = parseBool(source.is_active, 'is_active', true);
  if (active.error) throw httpError(400, active.error);
  const supplied = typeof source.password === 'string' ? source.password : '';
  const generated = supplied.length === 0;
  if (!generated) {
    const policyError = passwordPolicyError(supplied);
    if (policyError) throw httpError(400, policyError);
  }
  const password = generated ? generatePassword() : supplied;
  const hash = await auth.hashPassword(password);
  let id;
  try {
    id = await withTransaction(async (tx) => {
    const taken = await tx.get('SELECT id FROM users WHERE lower(trim(username)) = lower(trim(?))', [username.value]);
    if (taken) throw httpError(409, 'Username is already in use');
    const department = await departmentForRole(tx, source, role.value, null);
    if (department.error) throw httpError(400, department.error);
    const location = await shopLocations.locationForRole(tx, source, role.value, null);
    if (location.error) throw httpError(400, location.error);
    const texting = role.value === 'customer'
      ? parseTexting(source, { mobile_phone: null, sms_opt_in: 0 })
      : { value: { mobilePhone: null, smsOptIn: 0 } };
    if (texting.error) throw httpError(400, texting.error);
    const optInError = staffOptInError({ sms_opt_in: 0 }, texting.value, false);
    if (optInError) throw httpError(403, optInError);
    const inserted = await insertUserRow(tx, {
      username: username.value,
      passwordHash: hash,
      role: role.value,
      displayName: displayName.value,
      company: profile.value.company,
      contactName: profile.value.contactName,
      phone: profile.value.phone,
      email: profile.value.email,
      addressLine1: profile.value.addressLine1,
      addressLine2: profile.value.addressLine2,
      city: profile.value.city,
      state: profile.value.state,
      zip: profile.value.zip,
      department: department.value,
      locationId: location.value,
      isActive: active.value,
      mobilePhone: texting.value.mobilePhone,
      smsOptIn: texting.value.smsOptIn,
    });
    await activityLog.recordOn(tx, actorId, 'user.created', 'user', inserted.lastID, {
      username: username.value,
      role: role.value,
      department: department.value,
      location_id: location.value,
      message: department.value
        ? `Created ${role.value} ${username.value} in ${department.value}`
        : `Created ${role.value} ${username.value}`,
    });
    return inserted.lastID;
  });
  } catch (err) {
    throw conflictError(err);
  }
  const row = await get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [id]);
  const payload = present(row);
  if (generated) payload.password = password;
  return payload;
}

async function updateUser(actorId, id, body) {
  const parsedId = parseInteger(id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
  if (parsedId.error || !parsedId.value) throw httpError(400, 'id must be a positive integer');
  const source = body || {};
  const displayName = parseText(source.display_name, 'display_name', { required: true, max: 160 });
  if (displayName.error) throw httpError(400, displayName.error);
  const role = parseRole(source.role, true);
  if (role.error) throw httpError(400, role.error);
  const profile = parseProfile(source);
  if (profile.error) throw httpError(400, profile.error);
  const active = parseBool(source.is_active, 'is_active', true);
  if (active.error) throw httpError(400, active.error);
  if (source.password != null && source.password !== '') {
    throw httpError(400, 'Use the password reset action to change a password');
  }

  const actor = Number(actorId);
  let outcome;
  try {
    outcome = await withTransaction(async (tx) => {
    const existing = await tx.get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [parsedId.value]);
    if (!existing) throw httpError(404, 'User not found');
    const suppliedName = source.username == null ? '' : String(source.username).trim();
    const usernameChanging = suppliedName !== '' && suppliedName !== existing.username;
    let nextUsername = existing.username;
    if (usernameChanging) {
      const username = parseUsername(suppliedName, true);
      if (username.error) throw httpError(400, username.error);
      nextUsername = username.value;
    }

    const currentlyActive = existing.is_active !== 0;
    if (existing.id === actor && existing.role === 'admin' && role.value !== 'admin') {
      throw httpError(400, 'You cannot change your own role');
    }
    if (existing.id === actor && currentlyActive && active.value === 0) {
      throw httpError(400, 'You cannot deactivate your own account');
    }
    const leavingAdmin = existing.role === 'admin' && currentlyActive && (role.value !== 'admin' || active.value === 0);
    if (leavingAdmin) {
      const others = await countOtherActiveAdmins(tx, existing.id);
      if (others < 1) {
        throw httpError(400, 'The last active administrator cannot be demoted or deactivated');
      }
    }

    const taken = await tx.get(
      'SELECT id FROM users WHERE lower(trim(username)) = lower(trim(?)) AND id != ?',
      [nextUsername, existing.id]
    );
    if (taken) throw httpError(409, 'Username is already in use');

    const department = await departmentForRole(tx, source, role.value, existing.department || null);
    if (department.error) throw httpError(400, department.error);
    const location = await shopLocations.locationForRole(tx, source, role.value, existing.location_id || null);
    if (location.error) throw httpError(400, location.error);
    const texting = role.value === 'customer'
      ? parseTexting(source, existing, { staff: true })
      : { value: { mobilePhone: null, smsOptIn: 0 } };
    if (texting.error) throw httpError(texting.status || 400, texting.error);
    const previousDepartment = existing.department || null;
    const departmentChanged = previousDepartment !== department.value;

    const wasActive = currentlyActive;
    const action = wasActive && active.value === 0
      ? 'user.deactivated'
      : (!wasActive && active.value === 1 ? 'user.reactivated' : 'user.updated');

    await tx.run(
      `UPDATE users
       SET username = ?, role = ?, display_name = ?, company = ?, contact_name = ?, phone = ?, email = ?,
           mobile_phone = ?, sms_opt_in = ?,
           address_line1 = ?, address_line2 = ?, city = ?, state = ?, zip = ?, department = ?,
           location_id = ?, is_active = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        nextUsername,
        role.value,
        displayName.value,
        profile.value.company,
        profile.value.contactName,
        profile.value.phone,
        profile.value.email,
        texting.value.mobilePhone,
        texting.value.smsOptIn,
        profile.value.addressLine1,
        profile.value.addressLine2,
        profile.value.city,
        profile.value.state,
        profile.value.zip,
        department.value,
        location.value,
        active.value,
        existing.id,
      ]
    );
    const departmentMessage = department.value
      ? `Updated ${nextUsername} department to ${department.value}`
      : `Updated ${nextUsername} department to all departments`;
    await activityLog.recordOn(tx, actorId, action, 'user', existing.id, {
      username: nextUsername,
      role: role.value,
      previous_role: existing.role,
      is_active: active.value === 1,
      department: department.value,
      previous_department: previousDepartment,
      message: action === 'user.deactivated'
        ? `Deactivated ${nextUsername}`
        : action === 'user.reactivated'
          ? `Reactivated ${nextUsername}`
          : (departmentChanged ? departmentMessage : `Updated ${nextUsername}`),
    });
    return {
      id: existing.id,
      previousRole: existing.role,
      wasActive,
    };
  });
  } catch (err) {
    throw conflictError(err);
  }

  if (role.value !== outcome.previousRole || (outcome.wasActive && active.value === 0)) {
    auth.clearSessionsForUser(outcome.id);
  }
  const row = await get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [outcome.id]);
  return present(row);
}

async function updateCustomerAddress(actorId, id, body) {
  const parsedId = parseInteger(id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
  if (parsedId.error || !parsedId.value) throw httpError(400, 'id must be a positive integer');
  const address = parsePostalAddress(body || {}, false);
  if (address.error) throw httpError(400, address.error);
  await withTransaction(async (tx) => {
    const existing = await tx.get(
      `SELECT id, username, role FROM users WHERE id = ?`,
      [parsedId.value]
    );
    if (!existing || existing.role !== 'customer') throw httpError(404, 'Customer not found');
    await tx.run(
      `UPDATE users
       SET address_line1 = ?, address_line2 = ?, city = ?, state = ?, zip = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        address.value.addressLine1,
        address.value.addressLine2,
        address.value.city,
        address.value.state,
        address.value.zip,
        existing.id,
      ]
    );
    await activityLog.recordOn(tx, actorId, 'user.updated', 'user', existing.id, {
      username: existing.username,
      role: 'customer',
      message: `Updated address for ${existing.username}`,
    });
  });
  const row = await get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [parsedId.value]);
  return present(row);
}

async function resetPassword(actorId, id, body, exceptToken) {
  const parsedId = parseInteger(id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
  if (parsedId.error || !parsedId.value) throw httpError(400, 'id must be a positive integer');
  const existing = await get('SELECT id, username, role FROM users WHERE id = ?', [parsedId.value]);
  if (!existing) throw httpError(404, 'User not found');
  const supplied = typeof body?.password === 'string' ? body.password : '';
  const generated = supplied.length === 0;
  if (!generated) {
    const policyError = passwordPolicyError(supplied);
    if (policyError) throw httpError(400, policyError);
  }
  const password = generated ? generatePassword() : supplied;
  const keepToken = existing.id === Number(actorId) ? exceptToken : null;
  return resetUserPassword({
    user: existing,
    password,
    actorId,
    exceptToken: keepToken,
  });
}

function loginSession(username, password) {
  return new Promise((resolve, reject) => {
    auth.login(username, password, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

// Public self sign-up. Role is always customer and the account is active immediately.
// The email is the username, which is how this account signs in.
async function registerCustomer(body) {
  const source = body || {};
  if (honeypotTripped(source)) {
    const error = httpError(400, 'Unable to create an account');
    error.honeypot = true;
    throw error;
  }

  const company = parseText(source.company, 'company', { required: true, max: 160 });
  if (company.error) throw httpError(400, company.error);
  const contact = parseText(source.contact_name, 'contact_name', { required: true, max: 160 });
  if (contact.error) throw httpError(400, contact.error);
  const phone = parseText(source.phone, 'phone', { required: true, max: 40 });
  if (phone.error) throw httpError(400, phone.error);
  if (!/\d/.test(phone.value)) throw httpError(400, 'phone is invalid');
  const email = parseEmail(source.email, true);
  if (email.error) throw httpError(400, email.error);
  const username = emailAsUsername(email.value);
  if (username.error) throw httpError(400, username.error);
  const password = typeof source.password === 'string' ? source.password : '';
  const policyError = passwordPolicyError(password);
  if (policyError) throw httpError(400, policyError);
  if (typeof source.password_confirm !== 'string' || source.password_confirm === '') {
    throw httpError(400, 'password_confirm is required');
  }
  if (source.password_confirm !== password) throw httpError(400, 'password confirmation does not match');
  const address = parsePostalAddress(source, false);
  if (address.error) throw httpError(400, address.error);

  const hash = await auth.hashPassword(password);
  let created;
  try {
    created = await withTransaction(async (tx) => {
      const taken = await tx.get(
        `SELECT id FROM users
         WHERE lower(trim(username)) = lower(trim(?))
            OR (
              email IS NOT NULL AND trim(email) != ''
              AND lower(trim(email)) = lower(trim(?))
            )`,
        [username.value, email.value]
      );
      if (taken) throw httpError(409, 'An account with that email already exists');
      const location = await shopLocations.locationForRole(tx, source, 'customer', null);
      if (location.error) throw httpError(400, location.error);
      const inserted = await insertUserRow(tx, {
        username: username.value,
        passwordHash: hash,
        role: 'customer',
        displayName: company.value,
        company: company.value,
        contactName: contact.value,
        phone: phone.value,
        email: email.value,
        addressLine1: address.value.addressLine1,
        addressLine2: address.value.addressLine2,
        city: address.value.city,
        state: address.value.state,
        zip: address.value.zip,
        department: null,
        locationId: location.value,
        isActive: 1,
      });
      await activityLog.recordOn(tx, inserted.lastID, 'customer.self_registered', 'user', inserted.lastID, {
        username: username.value,
        role: 'customer',
        company: company.value,
        email: email.value,
        message: `New customer account: ${company.value}`,
      });
      const disabled = await tx.get(
        `SELECT event_key FROM notification_settings
         WHERE event_key = 'customer_registered' AND channel = 'in_app' AND enabled = 0`
      );
      let notification = null;
      if (!disabled) {
        const stored = await tx.run(
          `INSERT INTO notifications
             (type, title, body, customer_id, work_order_id, delivery_id, location_id, dedupe_key)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            'customer_registered',
            `New customer account: ${company.value}`,
            `${contact.value} created an account for ${company.value}.`,
            null,
            null,
            null,
            location.value,
            `customer_registered:${inserted.lastID}`,
          ]
        );
        notification = {
          id: stored.lastID,
          type: 'customer_registered',
          title: `New customer account: ${company.value}`,
          body: `${contact.value} created an account for ${company.value}.`,
        };
      }
      return { id: inserted.lastID, notification };
    });
  } catch (err) {
    if (err && err.status) throw err;
    if (isUniqueConstraint(err)) throw httpError(409, 'An account with that email already exists');
    throw err;
  }

  if (created.notification) {
    try {
      notifyEmail.deliver(created.notification);
    } catch (emailErr) {
      console.error('EMAIL NOTIFICATION ERROR:', emailErr);
    }
  }

  const session = await loginSession(username.value, password);
  if (!session || !session.token) throw httpError(500, 'Unable to create an account');
  return session;
}

async function updateCustomerTexting(actorId, id, body, options = {}) {
  const parsedId = parseInteger(id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
  if (parsedId.error || !parsedId.value) throw httpError(400, 'id must be a positive integer');
  await withTransaction(async (tx) => {
    const existing = await tx.get(
      `SELECT id, username, role, mobile_phone, sms_opt_in FROM users WHERE id = ?`,
      [parsedId.value]
    );
    if (!existing || existing.role !== 'customer') throw httpError(404, 'Customer not found');
    const texting = parseTexting(body || {}, existing, {
      requireProvided: true,
      staff: options.allowOptIn !== true,
    });
    if (texting.error) throw httpError(texting.status || 400, texting.error);
    await tx.run(
      `UPDATE users
       SET mobile_phone = ?, sms_opt_in = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [texting.value.mobilePhone, texting.value.smsOptIn, existing.id]
    );
    await activityLog.recordOn(tx, actorId, 'user.updated', 'user', existing.id, {
      username: existing.username,
      role: 'customer',
      sms_opt_in: texting.value.smsOptIn === 1,
      message: `Updated texting preferences for ${existing.username}`,
    });
  });
  const row = await get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [parsedId.value]);
  return present(row);
}

async function loadAccess(userId) {
  return shopLocations.loadAccess(userId);
}

module.exports = {
  listUsers,
  getUser,
  createUser,
  updateUser,
  updateCustomerAddress,
  updateCustomerTexting,
  resetPassword,
  registerCustomer,
  present,
  bearerToken,
  parseUsername,
  loadAccess,
  MIN_PASSWORD_LENGTH,
};
