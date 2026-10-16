const crypto = require('crypto');
const auth = require('./auth');
const activityLog = require('./activityLog');
const { resetUserPassword, passwordPolicyError } = require('./passwordReset');
const { get, all, withTransaction } = require('./dbAsync');
const { httpError } = require('./httpError');
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
const ROLES = new Set(['admin', 'operator', 'customer']);
const SORTS = {
  username: 'username COLLATE NOCASE',
  display_name: 'display_name COLLATE NOCASE',
  role: 'role',
  created_at: 'created_at',
  is_active: 'is_active',
};

const PUBLIC_COLUMNS = `id, username, role, display_name, company, contact_name, phone, email,
  address_line1, address_line2, city, state, zip, is_active, created_at, updated_at`;

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
    address_line1: row.address_line1 || '',
    address_line2: row.address_line2 || '',
    city: row.city || '',
    state: row.state || '',
    zip: row.zip || '',
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
  if (!ROLES.has(role)) return { error: 'role must be admin, operator, or customer' };
  return { value: role };
}

function parseUsername(value, required) {
  const parsed = parseText(value, 'username', { required, max: 80 });
  if (parsed.error || parsed.value == null) return parsed;
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{1,79}$/.test(parsed.value)) {
    return { error: 'username must be 2 to 80 characters and use letters, digits, or . _ @ -' };
  }
  return parsed;
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

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const parts = header.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') return parts[1];
  return null;
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
  const id = await withTransaction(async (tx) => {
    const taken = await tx.get('SELECT id FROM users WHERE lower(username) = lower(?)', [username.value]);
    if (taken) throw httpError(409, 'Username is already in use');
    const inserted = await tx.run(
      `INSERT INTO users (
         username, password_hash, role, display_name, company, contact_name, phone, email,
         address_line1, address_line2, city, state, zip, is_active, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      [
        username.value,
        hash,
        role.value,
        displayName.value,
        profile.value.company,
        profile.value.contactName,
        profile.value.phone,
        profile.value.email,
        profile.value.addressLine1,
        profile.value.addressLine2,
        profile.value.city,
        profile.value.state,
        profile.value.zip,
        active.value,
      ]
    );
    await activityLog.recordOn(tx, actorId, 'user.created', 'user', inserted.lastID, {
      username: username.value,
      role: role.value,
      message: `Created ${role.value} ${username.value}`,
    });
    return inserted.lastID;
  });
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
  const outcome = await withTransaction(async (tx) => {
    const existing = await tx.get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [parsedId.value]);
    if (!existing) throw httpError(404, 'User not found');
    const username = parseUsername(source.username == null || source.username === '' ? existing.username : source.username, true);
    if (username.error) throw httpError(400, username.error);

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
      'SELECT id FROM users WHERE lower(username) = lower(?) AND id != ?',
      [username.value, existing.id]
    );
    if (taken) throw httpError(409, 'Username is already in use');

    const wasActive = currentlyActive;
    const action = wasActive && active.value === 0
      ? 'user.deactivated'
      : (!wasActive && active.value === 1 ? 'user.reactivated' : 'user.updated');

    await tx.run(
      `UPDATE users
       SET username = ?, role = ?, display_name = ?, company = ?, contact_name = ?, phone = ?, email = ?,
           address_line1 = ?, address_line2 = ?, city = ?, state = ?, zip = ?,
           is_active = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        username.value,
        role.value,
        displayName.value,
        profile.value.company,
        profile.value.contactName,
        profile.value.phone,
        profile.value.email,
        profile.value.addressLine1,
        profile.value.addressLine2,
        profile.value.city,
        profile.value.state,
        profile.value.zip,
        active.value,
        existing.id,
      ]
    );
    await activityLog.recordOn(tx, actorId, action, 'user', existing.id, {
      username: username.value,
      role: role.value,
      previous_role: existing.role,
      is_active: active.value === 1,
      message: action === 'user.deactivated'
        ? `Deactivated ${username.value}`
        : action === 'user.reactivated'
          ? `Reactivated ${username.value}`
          : `Updated ${username.value}`,
    });
    return {
      id: existing.id,
      previousRole: existing.role,
      wasActive,
    };
  });

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

module.exports = {
  listUsers,
  getUser,
  createUser,
  updateUser,
  updateCustomerAddress,
  resetPassword,
  present,
  bearerToken,
  parseUsername,
  MIN_PASSWORD_LENGTH,
};
