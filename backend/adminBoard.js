const db = require('./db');
const activityLog = require('./activityLog');
const shopLocations = require('./shopLocations');
const { classifyDelivery, getRules, zonedParts, zonedTimeToUtc } = require('./deliveryRules');

const DEFAULT_PAGE_SIZE = 8;
const MAX_PAGE_SIZE = 100;
const ACTIVITY_PREVIEW = 8;
const SCAN_PREVIEW = 10;
const APPROVAL_PREVIEW = 5;
const QUOTE_PREVIEW = 5;
const STORED_ALERT_LIMIT = 20;

// Entry-queue stat cards. Seeded departments use sort_order 1 through 5 for
// Large Format, Small Format, Signs & Graphics, Scanning, and Planroom. A rename
// keeps that sort_order, so the card stays with the department.
const STAT_SORT_MIN = 1;
const STAT_SORT_MAX = 5;

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

function showsOnBoard(row) {
  return Boolean(row) && row.show_on_board !== 0 && row.show_on_board !== false;
}

function assignedDepartment(user) {
  const value = user && user.department != null ? String(user.department).trim() : '';
  return value || null;
}

// Operators with a department cannot widen the board. An admin with a department can pass scope=all.
// A manager is not assigned a department and sees every department.
function canWidenBoard(role) {
  return role === 'admin';
}

function resolveBoardScope(user, query) {
  const role = user && user.role;
  const assigned = role === 'manager' ? null : assignedDepartment(user);
  const canClear = canWidenBoard(role) && Boolean(assigned);
  const requested = String((query && query.scope) || '').trim().toLowerCase();
  if (!assigned || (canClear && requested === 'all')) {
    return { assigned, restricted: false, canClear, department: null };
  }
  return {
    assigned,
    restricted: true,
    canClear: canWidenBoard(role),
    department: assigned,
  };
}

function presentViewer(scope, shop, access) {
  const viewer = {
    department: scope.assigned,
    restricted: scope.restricted,
    can_clear: scope.canClear,
  };
  if (scope.restricted && scope.department && scope.department.toLowerCase() === 'complete') {
    viewer.filter = 'completed this month';
  }
  const canPick = access ? shopLocations.seesAll(access) : false;
  viewer.can_pick_location = canPick;
  viewer.all_locations = canPick && !(shop && shop.chosen);
  if (canPick && !(shop && shop.chosen)) {
    viewer.location_id = null;
    viewer.location_name = 'All locations';
  } else if (shop && shop.locationId != null) {
    viewer.location_id = shop.locationId;
    viewer.location_name = shop.locationName || (access && access.location ? access.location.name : null);
  } else if (access && access.location) {
    viewer.location_id = access.location_id;
    viewer.location_name = access.location.name;
  } else {
    viewer.location_id = null;
    viewer.location_name = null;
  }
  return viewer;
}

function pushShop(clauses, params, column, filter) {
  const extra = shopLocations.filterSql(column, filter);
  if (!extra.sql) return;
  clauses.push(extra.sql.replace(/^\s*AND\s+/, ''));
  params.push(...extra.params);
}

function scanDepartmentSql(alias = 'e') {
  return `(
    lower(trim(coalesce(${alias}.location, ''))) = lower(?)
    OR lower(trim(coalesce(${alias}.from_department, ''))) = lower(?)
    OR lower(trim(coalesce(${alias}.to_department, ''))) = lower(?)
  )`;
}

// json_extract throws on malformed JSON in this SQLite build. A plain-text
// activity row must not take down the restricted board.
function jsonDetailText(alias, path) {
  return `CASE WHEN json_valid(${alias}.detail) THEN json_extract(${alias}.detail, '${path}') ELSE NULL END`;
}

// Work-order events only. A row matches when the work order is in the
// department now, or the event names that department as current, from, or to.
function activityDepartmentSql(alias = 'a') {
  return `(
    lower(coalesce(${alias}.entity_type, '')) = 'work_order'
    AND (
      lower(trim(coalesce(${jsonDetailText(alias, '$.department')}, ''))) = lower(?)
      OR lower(trim(coalesce(${jsonDetailText(alias, '$.from_department')}, ''))) = lower(?)
      OR lower(trim(coalesce(${jsonDetailText(alias, '$.to_department')}, ''))) = lower(?)
      OR EXISTS (
        SELECT 1 FROM work_orders wo
        WHERE wo.id = ${alias}.entity_id
          AND lower(trim(coalesce(wo.department, ''))) = lower(?)
      )
    )
  )`;
}

function finishedThisMonthSql() {
  return `${FINISHED_SQL}
    AND datetime(coalesce(wo.updated_at, wo.created_at)) >= datetime(?)
    AND datetime(coalesce(wo.updated_at, wo.created_at)) < datetime(?)`;
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
    external_id: detail.external_id || detail.order_number || (row.entity_type === 'quote_request' ? (detail.project_name || null) : null),
    summary,
    manual: Boolean(detail.manual),
    note: detail.note || null,
    actor_id: row.actor_id,
    actor_name: row.actor_name || 'System',
    created_at: row.created_at,
    created_display: formatActivityTime(row.created_at, timeZone, now),
  };
}

function formatByteSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${Math.max(0, Math.round(size))} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  const shown = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${shown} ${units[unit]}`;
}

function formatFilesLabel(count, bytes) {
  const files = Number(count) || 0;
  const size = Number(bytes) || 0;
  if (files <= 0 || size <= 0) return '0 / 0';
  return `${files} / ${formatByteSize(size)}`;
}

function statusLabel(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'completed' || value === 'complete') return 'Complete';
  if (value === 'on-hold') return 'On Hold';
  if (value === 'cancelled' || value === 'canceled') return 'Cancelled';
  return 'LiveOrder';
}

function presentWorkOrder(row, timeZone) {
  const orderNumber = row.external_id || (row.id ? `WO-${row.id}` : null);
  const retrievedAt = row.retrieved_at || null;
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
    delivery_method: row.delivery_method || '',
    arrived_at: row.created_at || null,
    arrived_display: formatArrived(row.created_at, timeZone),
    retrieved_at: retrievedAt,
    retrieved: Boolean(retrievedAt),
    due_at: row.due_at || null,
    due_display: formatWall(row.due_at),
    process: row.process || row.department || '',
    status: row.status || null,
    status_label: statusLabel(row.status),
    priority: row.priority || null,
    service_name: row.service_name || null,
    file_count: Number(row.file_count) || 0,
    file_bytes: Number(row.file_bytes) || 0,
    files_label: formatFilesLabel(row.file_count, row.file_bytes),
    location_id: row.location_id || null,
    location_name: row.location_name || null,
    order_status: String(row.order_status || '').trim().toLowerCase() === 'ready for pickup'
      ? 'Ready for Pickup'
      : 'In Production',
  };
}

// Board categories are Overdue, New, and In Production. Overdue is an active job
// whose due time has passed. New is still open. In Production is in progress.
// Due today and due soon are not categories. Rush stays on the work order priority.
// On-hold, finished, and cancelled work are not overdue.
const TIME_ACTIVE_STATUSES = new Set(['open', 'in-progress']);
const BOARD_CATEGORIES = new Set(['overdue', 'new', 'in_production']);
const CATEGORY_LABELS = {
  overdue: 'Overdue',
  new: 'New',
  in_production: 'In Production',
};

function shopDateKey(parts) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function boardUrgency(row, now, rules) {
  const status = String(row.status || '').trim().toLowerCase();
  const rush = String(row.priority || '').trim().toLowerCase() === 'rush';
  const active = TIME_ACTIVE_STATUSES.has(status);
  const dueText = String(row.due_at || '').trim();
  const timed = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(dueText);
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(dueText);
  let overdue = false;
  let dueToday = false;
  let dueSoon = false;

  if (active && timed) {
    const flags = classifyDelivery({
      status: 'pending',
      due_time: `${timed[1]} ${timed[2]}:00`,
    }, now, rules);
    overdue = Boolean(flags.overdue);
    dueToday = Boolean(flags.due_today);
    dueSoon = Boolean(flags.due_soon);
  } else if (active && dateOnly) {
    const today = shopDateKey(zonedParts(now, rules.timezone));
    if (dateOnly[1] < today) overdue = true;
    else if (dateOnly[1] === today) dueToday = true;
  }

  let category = null;
  if (active && overdue) category = 'overdue';
  else if (active && status === 'in-progress') category = 'in_production';
  else if (active) category = 'new';

  return {
    overdue,
    due_today: dueToday,
    due_soon: dueSoon,
    rush,
    category,
    tone: category,
    signals: category ? [CATEGORY_LABELS[category]] : [],
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
  o.delivery_method AS delivery_method,
  ${DUE_AT_SQL} AS due_at,
  (
    SELECT COUNT(*) FROM order_files f
    WHERE f.work_order_id = wo.id
       OR (wo.order_id IS NOT NULL AND f.order_id = wo.order_id AND f.work_order_id IS NULL)
  ) AS file_count,
  (
    SELECT COALESCE(SUM(f.size_bytes), 0) FROM order_files f
    WHERE f.work_order_id = wo.id
       OR (wo.order_id IS NOT NULL AND f.order_id = wo.order_id AND f.work_order_id IS NULL)
  ) AS file_bytes,
  (
    SELECT MIN(picked.event_time) FROM (
      SELECT event_time FROM barcode_events
      WHERE work_order_id = wo.id AND trim(coalesce(event_time, '')) != ''
      UNION ALL
      SELECT event_time FROM production_history
      WHERE work_order_id = wo.id
        AND trim(coalesce(event_time, '')) != ''
        AND NOT (
          lower(trim(coalesce(scanned_by, ''))) = 'system auto'
          AND lower(trim(coalesce(notes, ''))) = 'order created'
        )
    ) AS picked
  ) AS retrieved_at,
  CASE
    WHEN s.name IS NOT NULL AND trim(s.name) != '' THEN s.name
    WHEN ps.name IS NOT NULL AND trim(ps.name) != '' THEN ps.name
    ELSE wo.department
  END AS process,
  s.name AS service_name,
  COALESCE(wo.location_id, o.location_id) AS location_id,
  l.name AS location_name,
  o.status AS order_status
`;

const workOrderFrom = `
  FROM work_orders wo
  LEFT JOIN orders o ON o.id = wo.order_id
  LEFT JOIN users u ON u.id = wo.customer_id
  LEFT JOIN services s ON s.id = wo.service_id
  LEFT JOIN production_stages ps ON ps.id = wo.stage_id
  LEFT JOIN departments d ON lower(d.name) = lower(trim(coalesce(wo.department, '')))
  LEFT JOIN locations l ON l.id = COALESCE(wo.location_id, o.location_id)
`;

function workOrderFilters(query, scope, shop) {
  const locked = Boolean(scope && scope.restricted && scope.department);
  const department = locked ? scope.department : parseOptionalToken(query.department, 'department', 80);
  const search = parseOptionalToken(query.q, 'q', 120);
  const status = parseOptionalToken(query.status, 'status', 40);
  const priority = parseOptionalToken(query.priority, 'priority', 20);
  const dueFrom = parseDateOnly(query.due_from, 'due_from');
  const dueTo = parseDateOnly(query.due_to, 'due_to');
  const requestedSort = parseOptionalToken(query.sort, 'sort', 40);
  const requestedDirection = parseOptionalToken(query.direction, 'direction', 4);

  if (status && !['open', 'in-progress', 'completed', 'on-hold'].includes(status.toLowerCase())) {
    throw new BoardError('status must be open, in-progress, completed, or on-hold');
  }
  if (priority && !['Low', 'Normal', 'High', 'Rush'].includes(priority)) {
    throw new BoardError('priority must be Low, Normal, High, or Rush');
  }
  if (dueFrom && dueTo && dueFrom > dueTo) throw new BoardError('due_from must be before due_to');

  const clauses = [];
  const params = [];
  const departmentKey = department ? department.toLowerCase() : 'all';
  const statusKey = status ? status.toLowerCase() : null;
  // Complete has no active queue. Default that login to finished work this month.
  const completeDefault = locked && departmentKey === 'complete' && !statusKey;
  // The monitor sorts by date due, earliest first. A Complete login stays newest first.
  const sort = requestedSort || (completeDefault ? 'arrived' : 'due');
  const direction = requestedDirection || (completeDefault ? 'desc' : 'asc');
  if (!SORT_COLUMNS[sort]) throw new BoardError('sort must be arrived, due, order_number, company, or department');
  if (direction !== 'asc' && direction !== 'desc') throw new BoardError('direction must be asc or desc');
  const monthWindow = completeDefault ? completionWindow() : null;

  if (completeDefault) {
    clauses.push(finishedThisMonthSql());
    params.push(monthWindow.start, monthWindow.end);
  } else if (locked) {
    if (statusKey === 'completed') {
      clauses.push(FINISHED_SQL);
    } else if (statusKey) {
      clauses.push(`lower(trim(coalesce(wo.status, ''))) = ?`);
      params.push(statusKey);
    } else {
      clauses.push(ACTIVE_SQL);
    }
    clauses.push(`lower(trim(coalesce(wo.department, ''))) = lower(?)`);
    params.push(department);
  } else if (statusKey === 'completed') {
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

  if (!locked && departmentKey === 'unassigned') {
    clauses.push(`trim(coalesce(wo.department, '')) = ''`);
  } else if (!locked && departmentKey !== 'all' && departmentKey !== 'complete') {
    clauses.push(`lower(trim(coalesce(wo.department, ''))) = lower(?)`);
    params.push(department);
  } else if (!locked && departmentKey === 'complete' && statusKey && statusKey !== 'completed') {
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

  const orderColumn = completeDefault && sort === 'arrived'
    ? `datetime(coalesce(wo.updated_at, wo.created_at))`
    : SORT_COLUMNS[sort];
  // Earliest due date first. SQLite sorts NULL before every date, so a missing
  // due date is ordered after the dated rows when the direction is ascending.
  pushShop(clauses, params, 'COALESCE(wo.location_id, o.location_id)', shop);
  const nullsLast = sort === 'due' ? `(${orderColumn} IS NULL) ASC, ` : '';
  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    orderBy: `${nullsLast}${orderColumn} ${direction.toUpperCase()}, wo.id ${direction.toUpperCase()}`,
  };
}

function parseCategory(value) {
  if (value == null || value === '') return null;
  const category = parseOptionalToken(value, 'category', 20);
  if (!category) return null;
  if (!BOARD_CATEGORIES.has(category)) {
    throw new BoardError('category must be overdue, new, or in_production');
  }
  return category;
}

async function listWorkOrders(query, user) {
  const scope = resolveBoardScope(user, query);
  const shop = await shopLocations.boardFilter(user, query);
  const limit = parseLimit(query.limit, DEFAULT_PAGE_SIZE);
  const offset = parseOffset(query.offset);
  const category = parseCategory(query.category);
  const filters = workOrderFilters(query, scope, shop);
  const rules = getRules();
  const now = new Date();
  const present = (row) => ({
    ...presentWorkOrder(row, rules.timezone),
    urgency: boardUrgency(row, now, rules),
  });

  if (category) {
    const matched = (await all(
      `SELECT ${workOrderSelect} ${workOrderFrom} ${filters.where}
       ORDER BY ${filters.orderBy}`,
      filters.params
    )).filter((row) => boardUrgency(row, now, rules).category === category);
    return {
      work_orders: matched.slice(offset, offset + limit).map(present),
      total: matched.length,
      limit,
      offset,
      timezone: rules.timezone,
      evaluated_at: now.toISOString(),
      viewer: presentViewer(scope, shop, user),
    };
  }

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
    work_orders: rows.map(present),
    total: totalRow ? totalRow.count : 0,
    limit,
    offset,
    timezone: rules.timezone,
    evaluated_at: now.toISOString(),
    viewer: presentViewer(scope, shop, user),
  };
}

async function countCategories(scope, now, shop) {
  if (scope && scope.restricted && String(scope.department || '').trim().toLowerCase() === 'complete') {
    return { overdue: 0, new: 0, in_production: 0 };
  }
  const rules = getRules();
  const params = [];
  let departmentSql = '';
  if (scope && scope.restricted && scope.department && scope.department.toLowerCase() !== 'complete') {
    departmentSql = ` AND lower(trim(coalesce(wo.department, ''))) = lower(?)`;
    params.push(scope.department);
  }
  const shopSql = shopLocations.filterSql('COALESCE(wo.location_id, o.location_id)', shop);
  departmentSql += shopSql.sql;
  params.push(...shopSql.params);
  const rows = await all(
    `SELECT wo.status, wo.priority, ${DUE_AT_SQL} AS due_at
     ${workOrderFrom}
     WHERE ${ACTIVE_SQL}${departmentSql}`,
    params
  );
  const counts = { overdue: 0, new: 0, in_production: 0 };
  for (const row of rows) {
    const category = boardUrgency(row, now, rules).category;
    if (category) counts[category] += 1;
  }
  return counts;
}

function canSeeQuoteRequests(user) {
  const role = user && user.role;
  return role === 'admin' || role === 'manager';
}

async function listActivity(query, preview, department, options = {}) {
  const includeQuotes = Boolean(options && options.includeQuotes);
  const limit = preview ? ACTIVITY_PREVIEW : parseLimit(query.limit, 20);
  const offset = preview ? 0 : parseOffset(query.offset);
  const window = completionWindow();
  const now = new Date();
  const params = [];
  const quoteClause = `lower(coalesce(a.entity_type, '')) = 'quote_request'`;
  let where = '';
  if (department && includeQuotes) {
    where = `WHERE (${activityDepartmentSql('a')} OR ${quoteClause})`;
    params.push(department, department, department, department);
  } else if (department) {
    where = `WHERE ${activityDepartmentSql('a')}`;
    params.push(department, department, department, department);
  } else if (!includeQuotes) {
    where = `WHERE lower(coalesce(a.entity_type, '')) != 'quote_request'`;
  }
  const shop = options.shop;
  if (shop && shop.locationId != null) {
    const match = shop.includeNull
      ? '(loc.location_id = ? OR loc.location_id IS NULL)'
      : 'loc.location_id = ?';
    const workMatch = shop.includeNull
      ? '(COALESCE(loc.location_id, ord.location_id) = ? OR COALESCE(loc.location_id, ord.location_id) IS NULL)'
      : 'COALESCE(loc.location_id, ord.location_id) = ?';
    const locationSql = `(
      (lower(coalesce(a.entity_type, '')) = 'work_order' AND EXISTS (
        SELECT 1 FROM work_orders loc
        LEFT JOIN orders ord ON ord.id = loc.order_id
        WHERE loc.id = a.entity_id AND ${workMatch}
      ))
      OR (lower(coalesce(a.entity_type, '')) = 'order' AND EXISTS (
        SELECT 1 FROM orders loc WHERE loc.id = a.entity_id AND ${match}
      ))
      OR (lower(coalesce(a.entity_type, '')) = 'quote_request' AND EXISTS (
        SELECT 1 FROM quote_requests loc WHERE loc.id = a.entity_id AND ${match}
      ))
      OR lower(coalesce(a.entity_type, '')) NOT IN ('work_order', 'order', 'quote_request', 'proof', 'delivery', 'inbound_email')
    )`;
    where = where ? `${where} AND ${locationSql}` : `WHERE ${locationSql}`;
    params.push(shop.locationId, shop.locationId, shop.locationId);
  }
  const totalRow = await get(`SELECT COUNT(*) AS count FROM activity_log a ${where}`, params);
  const rows = await all(
    `SELECT a.id, a.actor_id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at,
            COALESCE(NULLIF(trim(u.display_name), ''), NULLIF(trim(u.username), ''), 'System') AS actor_name
     FROM activity_log a
     LEFT JOIN users u ON u.id = a.actor_id
     ${where}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
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

async function listApprovals(query, preview, department, shop) {
  const limit = preview ? APPROVAL_PREVIEW : parseLimit(query.limit, 20);
  const offset = preview ? 0 : parseOffset(query.offset);
  const window = completionWindow();
  const params = [];
  let where = `WHERE wo.requires_approval = 1 AND lower(trim(coalesce(wo.approval_status, ''))) = 'pending'`;
  if (department) {
    where += ` AND lower(trim(coalesce(wo.department, ''))) = lower(?)`;
    params.push(department);
  }
  const shopSql = shopLocations.filterSql('COALESCE(wo.location_id, o.location_id)', shop);
  where += shopSql.sql;
  params.push(...shopSql.params);
  const totalRow = await get(`SELECT COUNT(*) AS count FROM work_orders wo LEFT JOIN orders o ON o.id = wo.order_id ${where}`, params);
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
    [...params, limit, offset]
  );
  return {
    approvals: rows.map((row) => presentApproval(row, window.timezone)),
    total: totalRow ? totalRow.count : 0,
    limit,
    offset,
  };
}

async function listScans(limit, department, shop) {
  const window = completionWindow();
  const params = [];
  const clauses = [];
  if (department) {
    clauses.push(scanDepartmentSql('e'));
    params.push(department, department, department);
  }
  const shopSql = shopLocations.filterSql('COALESCE(wo.location_id, o.location_id)', shop);
  if (shopSql.sql) {
    clauses.push(shopSql.sql.replace(/^\s*AND\s+/, ''));
    params.push(...shopSql.params);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  const rows = await all(
    `SELECT e.id, e.event_time, e.location, e.from_department, e.to_department, e.work_order_id,
            wo.external_id,
            COALESCE(NULLIF(trim(u.display_name), ''), NULLIF(trim(u.username), ''), 'Unknown') AS scanned_by
     FROM barcode_events e
     LEFT JOIN work_orders wo ON wo.id = e.work_order_id
     LEFT JOIN orders o ON o.id = wo.order_id
     LEFT JOIN users u ON u.id = e.operator_id
     ${where}
     ORDER BY e.event_time DESC, e.id DESC
     LIMIT ?`,
    params
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

async function listOpenQuoteRequests(shop) {
  const shopSql = shopLocations.filterSql('location_id', shop);
  const [newRow, acceptedRow, rows] = await Promise.all([
    get(`SELECT COUNT(*) AS count FROM quote_requests WHERE status = 'New'${shopSql.sql}`, shopSql.params),
    get(
      `SELECT COUNT(*) AS count FROM quote_requests WHERE status = 'Accepted' AND converted_order_id IS NULL${shopSql.sql}`,
      shopSql.params
    ),
    all(
      `SELECT q.id, q.project_name, q.needed_by, q.status, q.location_id, l.name AS location_name,
              COALESCE(NULLIF(trim(u.display_name), ''), NULLIF(trim(u.username), ''), '') AS customer_name
       FROM quote_requests q
       LEFT JOIN users u ON u.id = q.customer_id
       LEFT JOIN locations l ON l.id = q.location_id
       WHERE (q.status = 'New'
          OR (q.status = 'Accepted' AND q.converted_order_id IS NULL))
         ${shopLocations.filterSql('q.location_id', shop).sql}
       ORDER BY datetime(COALESCE(q.updated_at, q.created_at)) DESC, q.id DESC
       LIMIT ?`,
      [...shopLocations.filterSql('q.location_id', shop).params, QUOTE_PREVIEW]
    ),
  ]);
  return {
    new_count: newRow ? newRow.count : 0,
    accepted_count: acceptedRow ? acceptedRow.count : 0,
    quotes: rows.map((row) => ({
      id: row.id,
      customer_name: row.customer_name || '',
      project_name: row.project_name || '',
      needed_by: row.needed_by || null,
      needed_by_display: formatWall(row.needed_by),
      status: row.status,
      location_name: row.location_name || null,
    })),
  };
}

async function quoteRequestAlerts(shop) {
  const shopSql = shopLocations.filterSql('location_id', shop);
  const [newRow, acceptedRow, latestAccepted] = await Promise.all([
    get(`SELECT COUNT(*) AS count FROM quote_requests WHERE status = 'New'${shopSql.sql}`, shopSql.params),
    get(
      `SELECT COUNT(*) AS count FROM quote_requests WHERE status = 'Accepted' AND converted_order_id IS NULL${shopSql.sql}`,
      shopSql.params
    ),
    get(
      `SELECT id FROM quote_requests
       WHERE status = 'Accepted' AND converted_order_id IS NULL${shopSql.sql}
       ORDER BY datetime(COALESCE(updated_at, decided_at, created_at)) DESC, id DESC
       LIMIT 1`,
      shopSql.params
    ),
  ]);
  const alerts = [];
  const newCount = newRow ? newRow.count : 0;
  const acceptedCount = acceptedRow ? acceptedRow.count : 0;
  if (newCount > 0) {
    alerts.push({
      id: 'quote-requests',
      severity: 'info',
      source: 'computed',
      message: 'New quote requests',
      detail: `${newCount} new quote ${newCount === 1 ? 'request is' : 'requests are'} waiting.`,
      count: newCount,
      created_at: null,
      relative: null,
    });
  }
  if (acceptedCount > 0) {
    alerts.push({
      id: 'quote-accepted',
      severity: 'info',
      source: 'computed',
      message: 'Accepted quotes',
      detail: `${acceptedCount} accepted ${acceptedCount === 1 ? 'quote is' : 'quotes are'} ready to convert.`,
      count: acceptedCount,
      quote_request_id: latestAccepted ? latestAccepted.id : null,
      created_at: null,
      relative: null,
    });
  }
  return alerts;
}

async function loadAlerts(now = new Date(), scope = null, options = {}) {
  const window = completionWindow();
  const shop = options.shop || null;
  const woShop = shopLocations.filterSql('COALESCE(wo.location_id, o.location_id)', shop);
  const deliveryShop = shopLocations.filterSql('COALESCE(o.location_id, wo.location_id)', shop);
  const [departments, activeRows, deliveries, backup, stored] = await Promise.all([
    all(`SELECT name, color, sort_order, is_active, show_on_board FROM departments ORDER BY sort_order, name`),
    all(
      `SELECT trim(coalesce(wo.department, '')) AS name, COUNT(*) AS count
       FROM work_orders wo
       LEFT JOIN orders o ON o.id = wo.order_id
       WHERE ${ACTIVE_SQL}${woShop.sql}
       GROUP BY trim(coalesce(wo.department, ''))`,
      woShop.params
    ),
    all(
      `SELECT d.id, d.due_time, d.status, wo.external_id, wo.department AS work_order_department, o.order_number
       FROM deliveries d
       LEFT JOIN work_orders wo ON wo.id = d.work_order_id
       LEFT JOIN orders o ON o.id = COALESCE(d.order_id, wo.order_id)
       WHERE lower(trim(coalesce(d.status, ''))) != 'complete'${deliveryShop.sql}`,
      deliveryShop.params
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
  const trackedRows = scope && scope.restricted
    ? [known.get(String(scope.department || '').trim().toLowerCase())].filter(Boolean)
    : departments.filter((row) => showsOnBoard(row));
  for (const row of trackedRows) {
    if (!row.is_active) continue;
    if (String(row.name).trim().toLowerCase() === 'complete') continue;
    tracked += 1;
    const key = String(row.name).trim().toLowerCase();
    if ((activeByLower.get(key) || 0) === 0) emptyNames.push(row.name);
  }

  const alerts = [];
  if (options && options.includeQuotes) {
    alerts.push(...await quoteRequestAlerts(shop));
  }
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
    if (scope && scope.restricted) {
      const dept = String(delivery.work_order_department || '').trim().toLowerCase();
      if (dept !== scope.department.toLowerCase()) continue;
    }
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

async function loadSummary(user, query) {
  const scope = resolveBoardScope(user, query || {});
  const shop = await shopLocations.boardFilter(user, query || {});
  const woShop = shopLocations.filterSql('COALESCE(wo.location_id, o.location_id)', shop);
  const includeQuotes = canSeeQuoteRequests(user);
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
    quoteRequests,
  ] = await Promise.all([
    all(`SELECT name, color, sort_order, is_active, show_on_board FROM departments ORDER BY sort_order, name`),
    all(
      `SELECT trim(coalesce(wo.department, '')) AS name, COUNT(*) AS count
       FROM work_orders wo
       LEFT JOIN orders o ON o.id = wo.order_id
       WHERE ${ACTIVE_SQL}${woShop.sql}
       GROUP BY trim(coalesce(wo.department, ''))`,
      woShop.params
    ),
    get(`SELECT COUNT(*) AS count FROM work_orders wo LEFT JOIN orders o ON o.id = wo.order_id WHERE ${ACTIVE_SQL}${woShop.sql}`, woShop.params),
    get(`SELECT COUNT(*) AS count FROM work_orders wo LEFT JOIN orders o ON o.id = wo.order_id WHERE ${COMPLETE_SCOPE_SQL}${woShop.sql}`, woShop.params),
    get(
      `SELECT COUNT(*) AS count
       FROM work_orders wo
       LEFT JOIN orders o ON o.id = wo.order_id
       WHERE ${FINISHED_SQL}
         AND datetime(coalesce(wo.updated_at, wo.created_at)) >= datetime(?)
         AND datetime(coalesce(wo.updated_at, wo.created_at)) < datetime(?)${woShop.sql}`,
      [window.start, window.end, ...woShop.params]
    ),
    listActivity({}, true, scope.restricted ? scope.department : null, { includeQuotes, shop }),
    listApprovals({}, true, scope.restricted ? scope.department : null, shop),
    listScans(SCAN_PREVIEW, scope.restricted ? scope.department : null, shop),
    loadAlerts(now, scope, { includeQuotes, shop }),
    includeQuotes ? listOpenQuoteRequests(shop) : Promise.resolve(null),
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
  for (const row of departments) {
    if (!showsOnBoard(row)) continue;
    const key = String(row.name).trim().toLowerCase();
    const activeCount = activeByLower.get(key) || 0;
    if (!row.is_active && activeCount === 0) continue;
    const count = key === 'complete' ? (completeRow ? completeRow.count : 0) : activeCount;
    tabs.push({ key: row.name, label: row.name, count, color: row.color || '#607D8B' });
    shown.add(key);
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
  for (const row of departments) {
    if (!row.is_active) continue;
    const order = Number(row.sort_order);
    if (!Number.isFinite(order) || order < STAT_SORT_MIN || order > STAT_SORT_MAX) continue;
    const key = String(row.name).trim().toLowerCase();
    statDepartments.push({
      name: row.name,
      active: activeByLower.get(key) || 0,
      color: row.color || '#607D8B',
    });
  }

  const queue = tabs.filter((tab) => tab.key !== 'All').map((tab) => ({
    name: tab.label,
    count: tab.count,
    color: tab.color,
  }));
  const categories = await countCategories(scope, now, shop);
  const readyShop = shopLocations.filterSql('o.location_id', shop);
  const readyRow = await get(
    `SELECT COUNT(*) AS count FROM orders o
     WHERE lower(trim(coalesce(o.status, ''))) = 'ready for pickup'${readyShop.sql}`,
    readyShop.params
  );

  const body = {
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
      categories,
      ready_for_pickup: readyRow ? readyRow.count : 0,
    },
    queue,
    activity: activity.activity,
    activity_total: activity.total,
    scans,
    approvals: approvals.approvals,
    approvals_total: approvals.total,
    alerts,
    viewer: presentViewer(scope, shop, user),
  };
  if (quoteRequests) body.quote_requests = quoteRequests;
  if (shopLocations.seesAll(user)) {
    body.locations = await shopLocations.listLocations({ includeInactive: false });
    body.location_summary = await shopLocations.comparison();
  }

  if (!scope.restricted) return body;

  const key = scope.department.toLowerCase();
  const activeCount = activeByLower.get(key) || 0;
  const deptRow = known.get(key);
  const label = deptRow ? deptRow.name : scope.department;
  const color = (deptRow && deptRow.color) || '#607D8B';
  const completedRow = key === 'complete'
    ? await get(
      `SELECT COUNT(*) AS count FROM work_orders wo LEFT JOIN orders o ON o.id = wo.order_id WHERE ${finishedThisMonthSql()}${woShop.sql}`,
      [window.start, window.end, ...woShop.params]
    )
    : await get(
      `SELECT COUNT(*) AS count
       FROM work_orders wo
       LEFT JOIN orders o ON o.id = wo.order_id
       WHERE ${FINISHED_SQL}
         AND lower(trim(coalesce(wo.department, ''))) = lower(?)
         AND datetime(coalesce(wo.updated_at, wo.created_at)) >= datetime(?)
         AND datetime(coalesce(wo.updated_at, wo.created_at)) < datetime(?)${woShop.sql}`,
      [scope.department, window.start, window.end, ...woShop.params]
    );
  const tabCount = key === 'complete' ? (completedRow ? completedRow.count : 0) : activeCount;
  body.tabs = [{ key: label, label, count: tabCount, color }];
  body.stats = {
    ...body.stats,
    total_active: activeCount,
    completed_this_month: completedRow ? completedRow.count : 0,
    departments: [],
  };
  body.queue = [{ name: label, count: tabCount, color }];
  return body;
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
  resolveBoardScope,
  canSeeQuoteRequests,
  loadSummary,
  listWorkOrders,
  listActivity,
  listApprovals,
  decideApproval,
  completionWindow,
  boardUrgency,
};
