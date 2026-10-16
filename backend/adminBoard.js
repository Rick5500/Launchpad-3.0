const db = require('./db');
const activityLog = require('./activityLog');
const { classifyDelivery, getRules, zonedParts, zonedTimeToUtc } = require('./deliveryRules');

const DEFAULT_PAGE_SIZE = 8;
const MAX_PAGE_SIZE = 100;
const ACTIVITY_PREVIEW = 8;
const SCAN_PREVIEW = 10;
const APPROVAL_PREVIEW = 5;
const STORED_ALERT_LIMIT = 20;

// Tabs follow the shop route. Other departments are added only when they have active work.
const BOARD_DEPARTMENTS = Object.freeze([
  'Large Format',
  'Small Format',
  'Signs & Graphics',
  'Scanning',
  'Planroom',
  'Archive File',
  'Quality',
  'Dispatch',
  'Delivery',
  'Complete',
]);

// Stat cards are the entry queues, plus total active and completed this month.
const STAT_DEPARTMENTS = Object.freeze([
  'Large Format',
  'Small Format',
  'Signs & Graphics',
  'Scanning',
  'Planroom',
]);

const FINISHED_SQL = `lower(trim(coalesce(wo.status, ''))) IN ('completed', 'complete')`;
const IN_COMPLETE_SQL = `lower(trim(coalesce(wo.department, ''))) = 'complete'`;
const ACTIVE_SQL = `NOT (${FINISHED_SQL}) AND NOT (${IN_COMPLETE_SQL})`;
const COMPLETE_SCOPE_SQL = `(${FINISHED_SQL} OR ${IN_COMPLETE_SQL})`;

const SORT_COLUMNS = Object.freeze({
  arrived: 'wo.created_at',
  due: 'due_at',
  order_number: 'wo.external_id',
  company: 'company_name',
  department: 'wo.department',
});

class BoardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function utcNaive(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function completionWindow(now = new Date()) {
  const { timezone } = getRules();
  const parts = zonedParts(now, timezone);
  const start = zonedTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  }, timezone);
  const nextMonth = parts.month === 12
    ? { year: parts.year + 1, month: 1 }
    : { year: parts.year, month: parts.month + 1 };
  const end = zonedTimeToUtc({
    year: nextMonth.year,
    month: nextMonth.month,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  }, timezone);
  return { timezone, start: utcNaive(start), end: utcNaive(end) };
}

function parseUtcNaive(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value || '').trim());
  if (!match) return null;
  const date = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0)
  ));
  return Number.isNaN(date.valueOf()) ? null : date;
}

function formatInstant(date, timeZone, { includeDate = true } = {}) {
  if (!date) return null;
  const options = includeDate
    ? { timeZone, month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { timeZone, hour: 'numeric', minute: '2-digit' };
  return new Intl.DateTimeFormat('en-US', options).format(date).replace(',', '');
}

function formatArrived(value, timeZone) {
  return formatInstant(parseUtcNaive(value), timeZone);
}

function formatWall(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(value || '').trim());
  if (!match) return null;
  const date = `${match[2]}/${match[3]}/${match[1]}`;
  if (!match[4]) return date;
  let hour = Number(match[4]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${date} ${hour}:${match[5]} ${suffix}`;
}

function formatActivityTime(value, timeZone, now = new Date()) {
  const instant = parseUtcNaive(value);
  if (!instant) return null;
  const nowParts = zonedParts(now, timeZone);
  const parts = zonedParts(instant, timeZone);
  const sameDay = nowParts.year === parts.year && nowParts.month === parts.month && nowParts.day === parts.day;
  if (sameDay) return formatInstant(instant, timeZone, { includeDate: false });
  return `${pad(parts.month)}/${pad(parts.day)}/${parts.year} ${formatInstant(instant, timeZone, { includeDate: false })}`;
}

function relativeFrom(value, now = new Date()) {
  const instant = parseUtcNaive(value) || new Date(value);
  if (!instant || Number.isNaN(instant.valueOf())) return null;
  const deltaSeconds = Math.round((now.getTime() - instant.getTime()) / 1000);
  if (deltaSeconds < 0) return null;
  if (deltaSeconds < 45) return 'just now';
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function parseLimit(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new BoardError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return parsed;
}

function parseOffset(value) {
  if (value == null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BoardError('offset must be an integer of 0 or greater');
  }
  return parsed;
}

function parseOptionalToken(value, field, maxLength) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BoardError(`${field} is invalid`);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) throw new BoardError(`${field} is too long`);
  if (/[\u0000-\u001F]/.test(text)) throw new BoardError(`${field} contains invalid characters`);
  return text;
}

function parseDateOnly(value, field) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new BoardError(`${field} must be YYYY-MM-DD`);
  return text;
}

function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function presentActivity(row, timeZone, now) {
  let detail = {};
  if (row.detail) {
    try {
      const parsed = JSON.parse(row.detail);
      detail = parsed && typeof parsed === 'object' ? parsed : { message: String(row.detail) };
    } catch (err) {
      detail = { message: String(row.detail) };
    }
  }
  let summary = detail.message || null;
  if (!summary) {
    if (row.action === 'work_order.moved') summary = `Moved to ${detail.to_department || 'another department'}`;
    else if (row.action === 'work_order.created') summary = 'Work order created';
    else if (row.action === 'work_order.completed') summary = 'Completed';
    else if (row.action === 'work_order.approved') summary = 'Approved';
    else if (row.action === 'work_order.rejected') summary = 'Rejected';
    else if (row.action === 'order.created') summary = 'Order submitted';
    else summary = row.action;
  }
  return {
    id: row.id,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    external_id: detail.external_id || detail.order_number || null,
    summary,
    actor_id: row.actor_id,
    actor_name: row.actor_name || 'System',
    created_at: row.created_at,
    created_display: formatActivityTime(row.created_at, timeZone, now),
  };
}

function presentWorkOrder(row, timeZone) {
  const orderNumber = row.external_id || (row.id ? `WO-${row.id}` : null);
  return {
    id: row.id,
    order_number: orderNumber,
    external_id: row.external_id || null,
    order_id: row.order_id || null,
    company: row.company_name || '',
    contact_name: row.contact_name || '',
    originals_source: row.originals_source || null,
    originals_source_label: row.originals_source ? String(row.originals_source) : 'Not specified',
    payment_method: row.payment_method || null,
    payment_method_label: row.payment_method ? String(row.payment_method) : 'Not specified',
    department: row.department || '',
    department_color: row.department_color || '#90caf9',
    arrived_at: row.created_at || null,
    arrived_display: formatArrived(row.created_at, timeZone),
    due_at: row.due_at || null,
    due_display: formatWall(row.due_at),
    process: row.process || row.department || '',
    status: row.status || null,
    priority: row.priority || null,
    service_name: row.service_name || null,
  };
}

const DUE_AT_SQL = `CASE
  WHEN o.due_date IS NOT NULL AND trim(o.due_date) != '' AND o.due_time IS NOT NULL AND trim(o.due_time) != ''
    THEN o.due_date || ' ' || o.due_time
  WHEN o.due_date IS NOT NULL AND trim(o.due_date) != '' THEN o.due_date
  ELSE wo.due_date
END`;

const workOrderSelect = `
  wo.id,
  wo.external_id,
  wo.order_id,
  wo.department,
  wo.status,
  wo.priority,
  wo.created_at,
  COALESCE(NULLIF(trim(d.color), ''), '#90caf9') AS department_color,
  COALESCE(
    NULLIF(trim(o.company), ''),
    NULLIF(trim(u.company), ''),
    NULLIF(trim(u.display_name), ''),
    ''
  ) AS company_name,
  COALESCE(
    NULLIF(trim(o.contact_name), ''),
    NULLIF(trim(u.contact_name), ''),
    NULLIF(trim(u.display_name), ''),
    ''
  ) AS contact_name,
  o.originals_source AS originals_source,
  o.payment_method AS payment_method,
  ${DUE_AT_SQL} AS due_at,
  CASE
    WHEN s.name IS NOT NULL AND trim(s.name) != '' THEN s.name
    WHEN ps.name IS NOT NULL AND trim(ps.name) != '' THEN ps.name
    ELSE wo.department
  END AS process,
  s.name AS service_name
`;

const workOrderFrom = `
  FROM work_orders wo
  LEFT JOIN orders o ON o.id = wo.order_id
  LEFT JOIN users u ON u.id = wo.customer_id
  LEFT JOIN services s ON s.id = wo.service_id
  LEFT JOIN production_stages ps ON ps.id = wo.stage_id
  LEFT JOIN departments d ON lower(d.name) = lower(trim(coalesce(wo.department, '')))
`;

function workOrderFilters(query) {
  const department = parseOptionalToken(query.department, 'department', 80);
  const search = parseOptionalToken(query.q, 'q', 120);
  const status = parseOptionalToken(query.status, 'status', 40);
  const priority = parseOptionalToken(query.priority, 'priority', 20);
  const dueFrom = parseDateOnly(query.due_from, 'due_from');
  const dueTo = parseDateOnly(query.due_to, 'due_to');
  const sort = parseOptionalToken(query.sort, 'sort', 40) || 'arrived';
  const direction = parseOptionalToken(query.direction, 'direction', 4) || 'desc';

  if (status && !['open', 'in-progress', 'completed', 'on-hold'].includes(status.toLowerCase())) {
    throw new BoardError('status must be open, in-progress, completed, or on-hold');
  }
  if (priority && !['Low', 'Normal', 'High', 'Rush'].includes(priority)) {
    throw new BoardError('priority must be Low, Normal, High, or Rush');
  }
  if (dueFrom && dueTo && dueFrom > dueTo) throw new BoardError('due_from must be before due_to');
  if (!SORT_COLUMNS[sort]) throw new BoardError('sort must be arrived, due, order_number, company, or department');
  if (direction !== 'asc' && direction !== 'desc') throw new BoardError('direction must be asc or desc');

  const clauses = [];
  const params = [];
  const departmentKey = department ? department.toLowerCase() : 'all';
  const statusKey = status ? status.toLowerCase() : null;

  if (statusKey === 'completed') {
    clauses.push(FINISHED_SQL);
  } else if (statusKey) {
    clauses.push(`lower(trim(coalesce(wo.status, ''))) = ?`);
    params.push(statusKey);
  } else if (departmentKey === 'all') {
    clauses.push(ACTIVE_SQL);
  } else if (departmentKey === 'complete') {
    clauses.push(COMPLETE_SCOPE_SQL);
  } else {
    clauses.push(ACTIVE_SQL);
  }

  if (departmentKey === 'unassigned') {
    clauses.push(`trim(coalesce(wo.department, '')) = ''`);
  } else if (departmentKey !== 'all' && departmentKey !== 'complete') {
    clauses.push(`lower(trim(coalesce(wo.department, ''))) = lower(?)`);
    params.push(department);
  } else if (departmentKey === 'complete' && statusKey && statusKey !== 'completed') {
    clauses.push(IN_COMPLETE_SQL);
  }

  if (priority) {
    clauses.push('wo.priority = ?');
    params.push(priority);
  }
  if (dueFrom) {
    clauses.push(`date(${DUE_AT_SQL}) >= date(?)`);
    params.push(dueFrom);
  }
  if (dueTo) {
    clauses.push(`date(${DUE_AT_SQL}) <= date(?)`);
    params.push(dueTo);
  }
  if (search) {
    const pattern = likePattern(search);
    clauses.push(`(
      IFNULL(wo.external_id, '') LIKE ? ESCAPE '\\'
      OR IFNULL(o.order_number, '') LIKE ? ESCAPE '\\'
      OR IFNULL(o.company, '') LIKE ? ESCAPE '\\'
      OR IFNULL(o.contact_name, '') LIKE ? ESCAPE '\\'
      OR IFNULL(u.company, '') LIKE ? ESCAPE '\\'
      OR IFNULL(u.display_name, '') LIKE ? ESCAPE '\\'
      OR IFNULL(u.contact_name, '') LIKE ? ESCAPE '\\'
      OR IFNULL(wo.description, '') LIKE ? ESCAPE '\\'
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    orderBy: `${SORT_COLUMNS[sort]} ${direction.toUpperCase()}, wo.id ${direction.toUpperCase()}`,
  };
}

async function listWorkOrders(query) {
  const limit = parseLimit(query.limit, DEFAULT_PAGE_SIZE);
  const offset = parseOffset(query.offset);
  const filters = workOrderFilters(query);
  const window = completionWindow();
  const totalRow = await get(
    `SELECT COUNT(*) AS count ${workOrderFrom} ${filters.where}`,
    filters.params
  );
  const rows = await all(
    `SELECT ${workOrderSelect} ${workOrderFrom} ${filters.where}
     ORDER BY ${filters.orderBy}
     LIMIT ? OFFSET ?`,
    [...filters.params, limit, offset]
  );
  return {
    work_orders: rows.map((row) => presentWorkOrder(row, window.timezone)),
    total: totalRow ? totalRow.count : 0,
    limit,
    offset,
  };
}

async function listActivity(query, preview) {
  const limit = preview ? ACTIVITY_PREVIEW : parseLimit(query.limit, 20);
  const offset = preview ? 0 : parseOffset(query.offset);
  const window = completionWindow();
  const now = new Date();
  const totalRow = await get('SELECT COUNT(*) AS count FROM activity_log');
  const rows = await all(
    `SELECT a.id, a.actor_id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at,
            COALESCE(NULLIF(trim(u.display_name), ''), NULLIF(trim(u.username), ''), 'System') AS actor_name
     FROM activity_log a
     LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return {
    activity: rows.map((row) => presentActivity(row, window.timezone, now)),
    total: totalRow ? totalRow.count : 0,
    limit,
    offset,
  };
}

function presentApproval(row, timeZone) {
  return {
    id: row.id,
    external_id: row.external_id || `WO-${row.id}`,
    type: row.service_name || 'Approval',
    requested_by: row.requested_by || '',
    department: row.department || '',
    approval_status: row.approval_status || null,
    requested_at: row.created_at || null,
    requested_display: formatActivityTime(row.created_at, timeZone),
  };
}

async function listApprovals(query, preview) {
  const limit = preview ? APPROVAL_PREVIEW : parseLimit(query.limit, 20);
  const offset = preview ? 0 : parseOffset(query.offset);
  const window = completionWindow();
  const where = `WHERE wo.requires_approval = 1 AND lower(trim(coalesce(wo.approval_status, ''))) = 'pending'`;
  const totalRow = await get(`SELECT COUNT(*) AS count FROM work_orders wo ${where}`);
  const rows = await all(
    `SELECT wo.id, wo.external_id, wo.department, wo.created_at, wo.approval_status, s.name AS service_name,
            COALESCE(
              NULLIF(trim(o.contact_name), ''),
              NULLIF(trim(u.contact_name), ''),
              NULLIF(trim(u.display_name), ''),
              ''
            ) AS requested_by
     FROM work_orders wo
     LEFT JOIN services s ON s.id = wo.service_id
     LEFT JOIN orders o ON o.id = wo.order_id
     LEFT JOIN users u ON u.id = wo.customer_id
     ${where}
     ORDER BY wo.created_at ASC, wo.id ASC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return {
    approvals: rows.map((row) => presentApproval(row, window.timezone)),
    total: totalRow ? totalRow.count : 0,
    limit,
    offset,
  };
}

async function listScans(limit) {
  const window = completionWindow();
  const rows = await all(
    `SELECT e.id, e.event_time, e.location, e.from_department, e.to_department, e.work_order_id,
            wo.external_id,
            COALESCE(NULLIF(trim(u.display_name), ''), NULLIF(trim(u.username), ''), 'Unknown') AS scanned_by
     FROM barcode_events e
     LEFT JOIN work_orders wo ON wo.id = e.work_order_id
     LEFT JOIN users u ON u.id = e.operator_id
     ORDER BY e.event_time DESC, e.id DESC
     LIMIT ?`,
    [limit]
  );
  return rows.map((row) => ({
    id: row.id,
    work_order_id: row.work_order_id,
    external_id: row.external_id || (row.work_order_id ? `WO-${row.work_order_id}` : row.location || 'Scan'),
    from_department: row.from_department || null,
    to_department: row.to_department || null,
    location: row.location || null,
    scanned_by: row.scanned_by,
    event_time: row.event_time,
    event_display: formatActivityTime(row.event_time, window.timezone),
  }));
}

async function loadAlerts(now = new Date()) {
  const window = completionWindow();
  const [departments, activeRows, deliveries, backup, stored] = await Promise.all([
    all(`SELECT name, color, is_active FROM departments`),
    all(
      `SELECT trim(coalesce(wo.department, '')) AS name, COUNT(*) AS count
       FROM work_orders wo
       WHERE ${ACTIVE_SQL}
       GROUP BY trim(coalesce(wo.department, ''))`
    ),
    all(
      `SELECT d.id, d.due_time, d.status, wo.external_id, o.order_number
       FROM deliveries d
       LEFT JOIN work_orders wo ON wo.id = d.work_order_id
       LEFT JOIN orders o ON o.id = d.order_id
       WHERE lower(trim(coalesce(d.status, ''))) != 'complete'`
    ),
    get(`SELECT value FROM system_settings WHERE key = 'last_backup_at'`),
    all(
      `SELECT id, severity, message, detail, created_at
       FROM system_alerts
       WHERE is_active = 1
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`,
      [STORED_ALERT_LIMIT]
    ),
  ]);

  const activeByLower = new Map();
  for (const row of activeRows) {
    const key = String(row.name || '').trim().toLowerCase();
    const current = activeByLower.get(key) || 0;
    activeByLower.set(key, current + row.count);
  }
  const known = new Map(departments.map((row) => [String(row.name).trim().toLowerCase(), row]));
  const emptyNames = [];
  let tracked = 0;
  for (const name of BOARD_DEPARTMENTS) {
    if (name.toLowerCase() === 'complete') continue;
    const row = known.get(name.toLowerCase());
    if (!row || !row.is_active) continue;
    tracked += 1;
    if ((activeByLower.get(name.toLowerCase()) || 0) === 0) emptyNames.push(row.name);
  }

  const alerts = [];
  if (emptyNames.length) {
    const allEmpty = tracked > 0 && emptyNames.length === tracked;
    const listed = emptyNames.length === 1
      ? emptyNames[0]
      : emptyNames.length === 2
        ? `${emptyNames[0]} and ${emptyNames[1]}`
        : `${emptyNames.slice(0, -1).join(', ')}, and ${emptyNames[emptyNames.length - 1]}`;
    alerts.push({
      id: 'empty-queues',
      severity: 'warning',
      source: 'computed',
      message: allEmpty ? 'No active work orders' : 'Empty queues',
      detail: allEmpty
        ? 'Every department queue is empty.'
        : `${listed} ${emptyNames.length === 1 ? 'has' : 'have'} no active work orders.`,
      departments: emptyNames,
      created_at: null,
      relative: null,
    });
  }

  const overdue = [];
  for (const delivery of deliveries) {
    const timing = classifyDelivery(delivery, now);
    if (!timing.overdue) continue;
    overdue.push(delivery.external_id || delivery.order_number || `Delivery ${delivery.id}`);
  }
  if (overdue.length) {
    const shown = overdue.slice(0, 5);
    const extra = overdue.length > shown.length ? ` (+${overdue.length - shown.length} more)` : '';
    alerts.push({
      id: 'overdue-deliveries',
      severity: 'warning',
      source: 'computed',
      message: 'Overdue deliveries',
      detail: `${overdue.length} ${overdue.length === 1 ? 'delivery is' : 'deliveries are'} past due: ${shown.join(', ')}${extra}`,
      count: overdue.length,
      created_at: null,
      relative: null,
    });
  }

  const backupValue = backup && backup.value != null ? String(backup.value).trim() : '';
  if (!backupValue) {
    alerts.push({
      id: 'backup',
      severity: 'info',
      source: 'computed',
      message: 'Backup status',
      detail: 'No backup has been recorded.',
      created_at: null,
      relative: null,
    });
  } else {
    const zoned = /[zZ]$/.test(backupValue) || /[+-]\d{2}:\d{2}$/.test(backupValue);
    alerts.push({
      id: 'backup',
      severity: 'info',
      source: 'computed',
      message: 'Backup status',
      detail: `Last recorded backup: ${formatWall(backupValue) || backupValue}`,
      created_at: backupValue,
      relative: zoned ? relativeFrom(backupValue, now) : null,
    });
  }

  const allowedSeverity = new Set(['info', 'warning', 'error', 'success']);
  for (const row of stored) {
    alerts.push({
      id: `stored-${row.id}`,
      severity: allowedSeverity.has(String(row.severity || '').toLowerCase())
        ? String(row.severity).toLowerCase()
        : 'info',
      source: 'stored',
      message: row.message,
      detail: row.detail || null,
      created_at: row.created_at || null,
      relative: row.created_at ? relativeFrom(row.created_at, now) : null,
    });
  }

  return alerts;
}

async function loadSummary() {
  const now = new Date();
  const window = completionWindow(now);
  const [
    departments,
    activeRows,
    totalActiveRow,
    completeRow,
    completedMonthRow,
    activity,
    approvals,
    scans,
    alerts,
  ] = await Promise.all([
    all(`SELECT name, color, sort_order, is_active FROM departments ORDER BY sort_order, name`),
    all(
      `SELECT trim(coalesce(wo.department, '')) AS name, COUNT(*) AS count
       FROM work_orders wo
       WHERE ${ACTIVE_SQL}
       GROUP BY trim(coalesce(wo.department, ''))`
    ),
    get(`SELECT COUNT(*) AS count FROM work_orders wo WHERE ${ACTIVE_SQL}`),
    get(`SELECT COUNT(*) AS count FROM work_orders wo WHERE ${COMPLETE_SCOPE_SQL}`),
    get(
      `SELECT COUNT(*) AS count
       FROM work_orders wo
       WHERE ${FINISHED_SQL}
         AND datetime(coalesce(wo.updated_at, wo.created_at)) >= datetime(?)
         AND datetime(coalesce(wo.updated_at, wo.created_at)) < datetime(?)`,
      [window.start, window.end]
    ),
    listActivity({}, true),
    listApprovals({}, true),
    listScans(SCAN_PREVIEW),
    loadAlerts(now),
  ]);

  const activeByLower = new Map();
  for (const row of activeRows) {
    const key = String(row.name || '').trim().toLowerCase();
    activeByLower.set(key, (activeByLower.get(key) || 0) + row.count);
  }
  const known = new Map(departments.map((row) => [String(row.name).trim().toLowerCase(), row]));
  const colorFor = (name) => {
    const row = known.get(String(name || '').trim().toLowerCase());
    return (row && row.color) || '#607D8B';
  };

  const tabs = [{ key: 'All', label: 'All', count: totalActiveRow ? totalActiveRow.count : 0, color: null }];
  const shown = new Set(['all']);
  for (const name of BOARD_DEPARTMENTS) {
    const row = known.get(name.toLowerCase());
    if (!row) continue;
    const activeCount = activeByLower.get(name.toLowerCase()) || 0;
    if (!row.is_active && activeCount === 0) continue;
    const count = name.toLowerCase() === 'complete' ? (completeRow ? completeRow.count : 0) : activeCount;
    tabs.push({ key: row.name, label: row.name, count, color: row.color || '#607D8B' });
    shown.add(name.toLowerCase());
  }
  for (const [key, count] of activeByLower) {
    if (shown.has(key) || count <= 0) continue;
    if (!key) {
      tabs.push({ key: 'Unassigned', label: 'Unassigned', count, color: '#607D8B' });
      continue;
    }
    const row = known.get(key);
    const label = row ? row.name : (activeRows.find((item) => String(item.name).trim().toLowerCase() === key)?.name || key);
    tabs.push({ key: label, label, count, color: colorFor(label) });
  }

  const statDepartments = [];
  for (const name of STAT_DEPARTMENTS) {
    const row = known.get(name.toLowerCase());
    if (!row) continue;
    statDepartments.push({
      name: row.name,
      active: activeByLower.get(name.toLowerCase()) || 0,
      color: row.color || '#607D8B',
    });
  }

  const queue = tabs.filter((tab) => tab.key !== 'All').map((tab) => ({
    name: tab.label,
    count: tab.count,
    color: tab.color,
  }));

  return {
    generated_at: now.toISOString(),
    timezone: window.timezone,
    tabs,
    stats: {
      total_active: totalActiveRow ? totalActiveRow.count : 0,
      completed_this_month: completedMonthRow ? completedMonthRow.count : 0,
      month_start: window.start,
      month_end: window.end,
      timezone: window.timezone,
      departments: statDepartments,
    },
    queue,
    activity: activity.activity,
    activity_total: activity.total,
    scans,
    approvals: approvals.approvals,
    approvals_total: approvals.total,
    alerts,
  };
}

async function decideApproval({ workOrderId, decision, actorId, note }) {
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new BoardError('decision must be approved or rejected');
  }
  const id = Number(workOrderId);
  if (!Number.isInteger(id) || id <= 0) throw new BoardError('id must be a positive integer');

  let storedNote = null;
  if (note != null && note !== '') {
    if (typeof note !== 'string') throw new BoardError('note must be a string');
    storedNote = note.trim();
    if (storedNote.length > 500) throw new BoardError('note is too long');
    if (/[\u0000-\u001F]/.test(storedNote)) throw new BoardError('note contains invalid characters');
  }

  const existing = await get(
    `SELECT id, external_id, department, requires_approval, approval_status
     FROM work_orders WHERE id = ?`,
    [id]
  );
  if (!existing) throw new BoardError('Work order not found', 404);
  if (!existing.requires_approval || String(existing.approval_status || '').trim().toLowerCase() !== 'pending') {
    throw new BoardError('This work order is not awaiting approval', 409);
  }

  const updated = await run(
    `UPDATE work_orders
     SET approval_status = ?, approval_by = ?, approval_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?
       AND requires_approval = 1
       AND lower(trim(coalesce(approval_status, ''))) = 'pending'`,
    [decision, actorId, id]
  );
  if (!updated.changes) throw new BoardError('This work order is not awaiting approval', 409);

  try {
    await new Promise((resolve, reject) => {
      activityLog.insertEntries(db, [
        activityLog.decisionEntry({
          actorId,
          workOrder: existing,
          decision,
          note: storedNote,
        }),
      ], (err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    await run(
      `UPDATE work_orders
       SET approval_status = 'pending', approval_by = NULL, approval_at = NULL, updated_at = datetime('now')
       WHERE id = ?`,
      [id]
    );
    throw err;
  }

  const row = await get(
    `SELECT wo.id, wo.external_id, wo.approval_status, wo.approval_by, wo.approval_at,
            COALESCE(NULLIF(trim(u.display_name), ''), NULLIF(trim(u.username), ''), '') AS approver_name
     FROM work_orders wo
     LEFT JOIN users u ON u.id = wo.approval_by
     WHERE wo.id = ?`,
    [id]
  );
  return {
    id: row.id,
    external_id: row.external_id,
    approval_status: row.approval_status,
    approval_by: row.approval_by,
    approval_at: row.approval_at,
    approver_name: row.approver_name || null,
  };
}

module.exports = {
  BoardError,
  ACTIVE_SQL,
  FINISHED_SQL,
  COMPLETE_SCOPE_SQL,
  loadSummary,
  listWorkOrders,
  listActivity,
  listApprovals,
  decideApproval,
  completionWindow,
};
