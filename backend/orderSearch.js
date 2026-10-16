const { get, all } = require('./dbAsync');
const { httpError } = require('./httpError');
const {
  parseText,
  parseInteger,
  parseLimit,
  parseOffset,
  parseDirection,
  parseSort,
  parseDateBound,
  likePattern,
} = require('./fields');

const SORTS = {
  created_at: 'o.created_at',
  order_number: 'o.order_number',
  company: 'o.company COLLATE NOCASE',
  due_date: 'o.due_date',
  contact: 'o.contact_name COLLATE NOCASE',
};

const STATUSES = new Set(['open', 'in-progress', 'completed', 'on-hold', 'complete']);

function parseListQuery(query) {
  const source = query || {};
  const limit = parseLimit(source.limit, 25, 100);
  if (limit.error) return limit;
  const offset = parseOffset(source.offset);
  if (offset.error) return offset;
  const sort = parseSort(source.sort, SORTS, 'created_at');
  if (sort.error) return sort;
  const dir = parseDirection(source.dir || 'desc');
  if (dir.error) return dir;
  const fields = [
    ['order_number', 40],
    ['work_order_number', 40],
    ['company', 160],
    ['contact', 160],
    ['phone', 40],
    ['email', 160],
    ['q', 80],
  ];
  const text = {};
  for (const [name, max] of fields) {
    const parsed = parseText(source[name], name, { max });
    if (parsed.error) return parsed;
    text[name] = parsed.value;
  }
  let status = null;
  if (source.status != null && String(source.status).trim() !== '') {
    status = String(source.status).trim().toLowerCase();
    if (!STATUSES.has(status)) return { error: 'status must be open, in-progress, completed, or on-hold' };
  }
  let serviceId = null;
  if (source.service != null && String(source.service).trim() !== '') {
    const parsed = parseInteger(source.service, 'service', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
    if (parsed.error) return { error: 'service must be a positive integer' };
    serviceId = parsed.value;
  }
  const from = parseDateBound(source.from, 'from');
  if (from.error) return from;
  const to = parseDateBound(source.to, 'to');
  if (to.error) return to;
  if (from.value && to.value && from.value > to.value) return { error: 'from must be before to' };
  return {
    value: {
      limit: limit.value,
      offset: offset.value,
      sort: sort.value,
      dir: dir.value,
      ...text,
      status,
      serviceId,
      from: from.value,
      to: to.value,
    },
  };
}

function addLike(clauses, params, column, value) {
  if (!value) return;
  clauses.push(`${column} LIKE ? ESCAPE '\\'`);
  params.push(likePattern(value));
}

function buildWhere(filters) {
  const clauses = [];
  const params = [];
  addLike(clauses, params, 'o.order_number', filters.order_number);
  addLike(clauses, params, 'o.company', filters.company);
  addLike(clauses, params, 'o.contact_name', filters.contact);
  addLike(clauses, params, 'o.phone', filters.phone);
  addLike(clauses, params, 'o.email', filters.email);
  if (filters.q) {
    const pattern = likePattern(filters.q);
    clauses.push(`(
      o.order_number LIKE ? ESCAPE '\\'
      OR o.company LIKE ? ESCAPE '\\'
      OR o.contact_name LIKE ? ESCAPE '\\'
      OR o.phone LIKE ? ESCAPE '\\'
      OR o.email LIKE ? ESCAPE '\\'
      OR IFNULL(o.project_name, '') LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM work_orders wo
        WHERE wo.order_id = o.id AND IFNULL(wo.external_id, '') LIKE ? ESCAPE '\\'
      )
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (filters.from) {
    clauses.push('o.created_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push('o.created_at <= ?');
    params.push(filters.to);
  }

  const work = [];
  const workParams = [];
  if (filters.work_order_number) {
    work.push(`IFNULL(wo.external_id, '') LIKE ? ESCAPE '\\'`);
    workParams.push(likePattern(filters.work_order_number));
  }
  if (filters.status === 'completed' || filters.status === 'complete') {
    work.push(`lower(trim(coalesce(wo.status, ''))) IN ('completed', 'complete')`);
  } else if (filters.status) {
    work.push(`lower(trim(coalesce(wo.status, ''))) = ?`);
    workParams.push(filters.status);
  }
  if (filters.serviceId) {
    work.push('wo.service_id = ?');
    workParams.push(filters.serviceId);
  }
  if (work.length) {
    clauses.push(`EXISTS (
      SELECT 1 FROM work_orders wo
      WHERE wo.order_id = o.id AND ${work.join(' AND ')}
    )`);
    params.push(...workParams);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    work,
    workParams,
  };
}

function presentWorkOrder(row) {
  return {
    id: row.id,
    external_id: row.external_id,
    status: row.status,
    department: row.department,
    service_id: row.service_id,
    service_name: row.service_name || '',
    detail_path: `/work-orders/${row.id}`,
    print_path: `/work-orders/${row.id}/print`,
  };
}

async function searchOrders(query) {
  const parsed = parseListQuery(query);
  if (parsed.error) throw httpError(400, parsed.error);
  const filters = parsed.value;
  const where = buildWhere(filters);
  const count = await get(`SELECT COUNT(*) AS count FROM orders o ${where.sql}`, where.params);
  const orders = await all(
    `SELECT o.id, o.order_number, o.company, o.contact_name, o.phone, o.email,
            o.due_date, o.due_time, o.created_at, o.delivery_method, o.ups_account_number, o.project_name,
            o.originals_source, o.address_line1, o.address_line2, o.city, o.state, o.zip
     FROM orders o
     ${where.sql}
     ORDER BY ${SORTS[filters.sort]} ${filters.dir.toUpperCase()}, o.id DESC
     LIMIT ? OFFSET ?`,
    [...where.params, filters.limit, filters.offset]
  );
  const ids = orders.map((row) => row.id);
  let workOrders = [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ');
    const extra = where.work.length ? `AND ${where.work.join(' AND ')}` : '';
    workOrders = await all(
      `SELECT wo.id, wo.order_id, wo.external_id, wo.status, wo.department, wo.service_id, s.name AS service_name
       FROM work_orders wo
       LEFT JOIN services s ON s.id = wo.service_id
       WHERE wo.order_id IN (${placeholders})
       ${extra}
       ORDER BY wo.external_id ASC, wo.id ASC`,
      [...ids, ...where.workParams]
    );
  }
  const grouped = new Map();
  for (const row of workOrders) {
    const list = grouped.get(row.order_id) || [];
    list.push(presentWorkOrder(row));
    grouped.set(row.order_id, list);
  }
  return {
    orders: orders.map((row) => ({
      id: row.id,
      order_number: row.order_number,
      company: row.company,
      contact_name: row.contact_name,
      phone: row.phone,
      email: row.email,
      due_date: row.due_date,
      due_time: row.due_time,
      created_at: row.created_at,
      delivery_method: row.delivery_method,
      ups_account_number: row.ups_account_number || null,
      project_name: row.project_name || '',
      originals_source: row.originals_source || null,
      originals_source_label: row.originals_source ? String(row.originals_source) : 'Not specified',
      address_line1: row.address_line1 || '',
      address_line2: row.address_line2 || '',
      city: row.city || '',
      state: row.state || '',
      zip: row.zip || '',
      detail_path: `/orders/${row.id}`,
      work_orders: grouped.get(row.id) || [],
    })),
    total: count ? count.count : 0,
    limit: filters.limit,
    offset: filters.offset,
  };
}

module.exports = {
  searchOrders,
};
