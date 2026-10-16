const { get, all } = require('./dbAsync');
const { httpError } = require('./httpError');
const { toCsv } = require('./reports');
const {
  parseText,
  parseLimit,
  parseOffset,
  parseDirection,
  parseSort,
  parseDateBound,
  likePattern,
} = require('./fields');

const SORTS = {
  created_at: 'a.created_at',
  action: 'a.action',
};

const CSV_COLUMNS = [
  { key: 'created_at', header: 'created_at' },
  { key: 'actor_username', header: 'actor_username' },
  { key: 'action', header: 'action' },
  { key: 'entity_type', header: 'entity_type' },
  { key: 'entity_id', header: 'entity_id' },
  { key: 'summary', header: 'summary' },
];

function parseDetail(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return { message: value };
  }
}

function summaryOf(detail, action) {
  if (detail && typeof detail === 'object' && detail.message) return String(detail.message);
  return action;
}

function present(row) {
  const detail = parseDetail(row.detail);
  return {
    id: row.id,
    actor_id: row.actor_id,
    actor_username: row.actor_username || '',
    actor_name: row.actor_name || '',
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    detail,
    summary: summaryOf(detail, row.action),
    created_at: row.created_at,
  };
}

function parseListQuery(query) {
  const source = query || {};
  const limit = parseLimit(source.limit, 50, 200);
  if (limit.error) return limit;
  const offset = parseOffset(source.offset);
  if (offset.error) return offset;
  const sort = parseSort(source.sort, SORTS, 'created_at');
  if (sort.error) return sort;
  const dir = parseDirection(source.dir || 'desc');
  if (dir.error) return dir;
  const q = parseText(source.q, 'q', { max: 80 });
  if (q.error) return q;
  const type = parseText(source.type, 'type', { max: 80 });
  if (type.error) return type;
  if (type.value && !/^[A-Za-z0-9._-]+$/.test(type.value)) return { error: 'type is invalid' };
  const from = parseDateBound(source.from, 'from');
  if (from.error) return from;
  const to = parseDateBound(source.to, 'to');
  if (to.error) return to;
  if (from.value && to.value && from.value > to.value) return { error: 'from must be before to' };
  let userId = null;
  let username = null;
  if (source.user != null && String(source.user).trim() !== '') {
    const text = String(source.user).trim();
    if (/^[1-9]\d*$/.test(text)) {
      userId = Number(text);
      if (!Number.isSafeInteger(userId)) return { error: 'user must be a user id or username' };
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,79}$/.test(text)) {
      return { error: 'user must be a user id or username' };
    } else {
      username = text;
    }
  }
  const format = source.format == null || source.format === '' ? 'json' : String(source.format).trim().toLowerCase();
  if (format !== 'json' && format !== 'csv') return { error: 'format must be json or csv' };
  return {
    value: {
      limit: limit.value,
      offset: offset.value,
      sort: sort.value,
      dir: dir.value,
      q: q.value,
      type: type.value,
      from: from.value,
      to: to.value,
      userId,
      username,
      format,
    },
  };
}

function whereFor(filters) {
  const clauses = [];
  const params = [];
  if (filters.from) {
    clauses.push('a.created_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push('a.created_at <= ?');
    params.push(filters.to);
  }
  if (filters.type) {
    clauses.push('a.action = ?');
    params.push(filters.type);
  }
  if (filters.userId) {
    clauses.push('a.actor_id = ?');
    params.push(filters.userId);
  }
  if (filters.username) {
    clauses.push('lower(u.username) = lower(?)');
    params.push(filters.username);
  }
  if (filters.q) {
    const pattern = likePattern(filters.q);
    clauses.push(`(
      a.action LIKE ? ESCAPE '\\'
      OR IFNULL(a.entity_type, '') LIKE ? ESCAPE '\\'
      OR IFNULL(a.detail, '') LIKE ? ESCAPE '\\'
      OR IFNULL(u.username, '') LIKE ? ESCAPE '\\'
      OR IFNULL(u.display_name, '') LIKE ? ESCAPE '\\'
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

async function listActivity(query) {
  const parsed = parseListQuery(query);
  if (parsed.error) throw httpError(400, parsed.error);
  const filters = parsed.value;
  const where = whereFor(filters);
  const fromSql = `
    FROM activity_log a
    LEFT JOIN users u ON u.id = a.actor_id
    ${where.sql}
  `;
  const count = await get(`SELECT COUNT(*) AS count ${fromSql}`, where.params);
  const rows = await all(
    `SELECT a.id, a.actor_id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at,
            u.username AS actor_username, u.display_name AS actor_name
     ${fromSql}
     ORDER BY ${SORTS[filters.sort]} ${filters.dir.toUpperCase()}, a.id DESC
     LIMIT ? OFFSET ?`,
    [...where.params, filters.limit, filters.offset]
  );
  const entries = rows.map(present);
  return {
    entries,
    total: count ? count.count : 0,
    limit: filters.limit,
    offset: filters.offset,
    format: filters.format,
    csv: filters.format === 'csv' ? toCsv(CSV_COLUMNS, entries) : null,
  };
}

module.exports = {
  listActivity,
  CSV_COLUMNS,
};
