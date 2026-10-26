const db = require('./db');
const barcodeEvents = require('./barcodeEvents');
const { classifyDelivery, getRules } = require('./deliveryRules');
const { WORK_ORDER_STATUSES } = require('./statuses');

const STAGE_TIME_NOTE = 'Average time counts a completed stay between barcode scans that recorded a production stage. The current open stay is excluded. Scans without a stage are ignored.';

function csvCell(value) {
  if (value == null) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(columns, rows) {
  const header = columns.map((column) => csvCell(column.header)).join(',');
  const lines = (rows || []).map((row) => columns.map((column) => csvCell(row[column.key])).join(','));
  return `${[header, ...lines].join('\r\n')}\r\n`;
}

function parseFormat(value) {
  if (value == null || value === '') return { value: 'json' };
  const format = String(value).trim().toLowerCase();
  if (format !== 'json' && format !== 'csv') return { error: 'format must be json or csv' };
  return { value: format };
}

function parseBucket(value) {
  if (value == null || value === '') return { value: 'day' };
  const bucket = String(value).trim().toLowerCase();
  if (bucket !== 'day' && bucket !== 'week') return { error: 'bucket must be day or week' };
  return { value: bucket };
}

function parseReportQuery(query, options = {}) {
  const source = query || {};
  const from = barcodeEvents.parseRangeBound(source.from, 'from');
  if (from.error) return { error: 'from is invalid' };
  const to = barcodeEvents.parseRangeBound(source.to, 'to');
  if (to.error) return { error: 'to is invalid' };
  if (from.value && to.value && from.value > to.value) return { error: 'from must be before to' };

  const format = parseFormat(source.format);
  if (format.error) return { error: format.error };

  let bucket = 'day';
  if (options.bucket) {
    const parsedBucket = parseBucket(source.bucket);
    if (parsedBucket.error) return { error: parsedBucket.error };
    bucket = parsedBucket.value;
  }

  return {
    value: {
      from: from.value,
      to: to.value,
      format: format.value,
      bucket,
    },
  };
}

function dateClauses(column, range, params) {
  const clauses = [];
  if (range.from) {
    clauses.push(`${column} >= ?`);
    params.push(range.from);
  }
  if (range.to) {
    clauses.push(`${column} <= ?`);
    params.push(range.to);
  }
  return clauses;
}

function whereSql(clauses) {
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

function pushShop(clauses, params, column, range) {
  if (!range || range.shopLocationId == null) return;
  if (range.shopLocationNull) clauses.push(`(${column} = ? OR ${column} IS NULL)`);
  else clauses.push(`${column} = ?`);
  params.push(range.shopLocationId);
}

function reportBase(range, extra) {
  return {
    from: range.from,
    to: range.to,
    generated_at: new Date().toISOString(),
    ...extra,
  };
}

function loadStatusReport(range, cb) {
  const params = [];
  const clauses = dateClauses('wo.created_at', range, params);
  pushShop(clauses, params, 'COALESCE(wo.location_id, o.location_id)', range);
  db.all(
    `SELECT
       CASE
         WHEN trim(COALESCE(wo.status, '')) = '' THEN '(none)'
         WHEN lower(trim(wo.status)) = 'complete' THEN 'completed'
         ELSE lower(trim(wo.status))
       END AS status,
       COUNT(*) AS count
     FROM work_orders wo
     LEFT JOIN orders o ON o.id = wo.order_id
     ${whereSql(clauses)}
     GROUP BY 1`,
    params,
    (err, rows) => {
      if (err) return cb(err);
      const counts = new Map();
      for (const row of rows || []) counts.set(row.status, row.count);
      const result = WORK_ORDER_STATUSES.map((status) => ({
        status,
        count: counts.get(status) || 0,
      }));
      for (const [status, count] of counts) {
        if (!WORK_ORDER_STATUSES.includes(status)) result.push({ status, count });
      }
      const total = result.reduce((sum, row) => sum + row.count, 0);
      cb(null, reportBase(range, { rows: result, total }));
    }
  );
}

function loadDepartmentReport(range, cb) {
  const params = [];
  const clauses = dateClauses('wo.created_at', range, params);
  pushShop(clauses, params, 'COALESCE(wo.location_id, o.location_id)', range);
  db.all(
    `SELECT
       CASE
         WHEN wo.department IS NULL OR trim(wo.department) = '' THEN '(none)'
         ELSE trim(wo.department)
       END AS department,
       COUNT(*) AS count
     FROM work_orders wo
     LEFT JOIN orders o ON o.id = wo.order_id
     ${whereSql(clauses)}
     GROUP BY 1
     ORDER BY count DESC, department COLLATE NOCASE ASC`,
    params,
    (err, rows) => {
      if (err) return cb(err);
      const result = rows || [];
      const total = result.reduce((sum, row) => sum + row.count, 0);
      cb(null, reportBase(range, { rows: result, total }));
    }
  );
}

function loadStageReport(range, cb) {
  const params = [];
  const clauses = dateClauses('wo.created_at', range, params);
  pushShop(clauses, params, 'COALESCE(wo.location_id, o.location_id)', range);
  db.all(
    `SELECT wo.stage_id AS stage_id, COUNT(*) AS count
     FROM work_orders wo
     LEFT JOIN orders o ON o.id = wo.order_id
     ${whereSql(clauses)}
     GROUP BY wo.stage_id`,
    params,
    (err, counts) => {
      if (err) return cb(err);
      db.all(
        `SELECT id, name FROM production_stages ORDER BY sort_order ASC, name COLLATE NOCASE ASC`,
        [],
        (stageErr, stages) => {
          if (stageErr) return cb(stageErr);
          const byId = new Map((counts || []).map((row) => [row.stage_id, row.count]));
          const known = new Set();
          const rows = (stages || []).map((stage) => {
            known.add(stage.id);
            return {
              stage_id: stage.id,
              stage_name: stage.name,
              count: byId.get(stage.id) || 0,
            };
          });
          const unassigned = byId.get(null) || 0;
          if (unassigned) rows.push({ stage_id: null, stage_name: '(unassigned)', count: unassigned });
          for (const row of counts || []) {
            if (row.stage_id != null && !known.has(row.stage_id)) {
              rows.push({
                stage_id: row.stage_id,
                stage_name: `(stage ${row.stage_id})`,
                count: row.count,
              });
            }
          }
          const total = rows.reduce((sum, row) => sum + row.count, 0);
          cb(null, reportBase(range, { rows, total }));
        }
      );
    }
  );
}

function loadThroughputReport(range, bucket, cb) {
  const format = bucket === 'week' ? '%Y-W%W' : '%Y-%m-%d';
  const params = [format];
  const clauses = [
    `lower(trim(COALESCE(wo.status, ''))) IN ('completed', 'complete')`,
    `COALESCE(wo.updated_at, wo.created_at) IS NOT NULL`,
  ];
  if (range.from) {
    clauses.push('COALESCE(wo.updated_at, wo.created_at) >= ?');
    params.push(range.from);
  }
  if (range.to) {
    clauses.push('COALESCE(wo.updated_at, wo.created_at) <= ?');
    params.push(range.to);
  }
  pushShop(clauses, params, 'COALESCE(wo.location_id, o.location_id)', range);
  db.all(
    `SELECT
       strftime(?, COALESCE(wo.updated_at, wo.created_at)) AS bucket,
       COUNT(*) AS count
     FROM work_orders wo
     LEFT JOIN orders o ON o.id = wo.order_id
     WHERE ${clauses.join(' AND ')}
     GROUP BY bucket
     ORDER BY bucket ASC`,
    params,
    (err, rows) => {
      if (err) return cb(err);
      const result = rows || [];
      const total = result.reduce((sum, row) => sum + row.count, 0);
      cb(null, reportBase(range, {
        bucket,
        rows: result,
        total,
        note: 'Completed work orders are grouped by updated_at, or by created_at when updated_at is empty. Weeks use Monday as the first day.',
      }));
    }
  );
}

function loadDeliveryReport(range, cb) {
  const params = [];
  const clauses = [
    `d.due_time IS NOT NULL`,
    `trim(d.due_time) != ''`,
    `lower(trim(COALESCE(d.status, ''))) != 'complete'`,
  ];
  if (range.from) {
    clauses.push('d.due_time >= ?');
    params.push(range.from);
  }
  if (range.to) {
    clauses.push('d.due_time <= ?');
    params.push(range.to);
  }
  pushShop(clauses, params, 'COALESCE(o.location_id, wo.location_id)', range);
  const now = new Date();
  const rules = getRules();
  db.all(
    `SELECT
       d.id,
       d.work_order_id,
       d.will_call,
       d.due_time,
       d.carrier,
       d.status,
       wo.external_id,
       wo.customer_id,
       u.display_name AS customer_name,
       o.delivery_method,
       o.ups_account_number,
       o.payment_method,
       o.bill_to_company
     FROM deliveries d
     LEFT JOIN work_orders wo ON wo.id = d.work_order_id
     LEFT JOIN users u ON u.id = wo.customer_id
     LEFT JOIN orders o ON o.id = COALESCE(d.order_id, wo.order_id)
     WHERE ${clauses.join(' AND ')}
     ORDER BY d.due_time ASC, d.id ASC`,
    params,
    (err, rows) => {
      if (err) return cb(err);
      const result = [];
      for (const row of rows || []) {
        const flags = classifyDelivery(row, now, rules);
        if (!flags.overdue && !flags.due_today) continue;
        result.push({
          id: row.id,
          work_order_id: row.work_order_id,
          external_id: row.external_id,
          customer_name: row.customer_name,
          will_call: row.will_call ? 1 : 0,
          due_time: row.due_time,
          carrier: row.carrier,
          delivery_method: row.delivery_method || row.carrier || null,
          ups_account_number: row.ups_account_number || null,
          payment_method: row.payment_method || 'Not specified',
          bill_to_company: row.bill_to_company || '',
          status: row.status,
          overdue: flags.overdue,
          due_today: flags.due_today,
          timing: flags.timing,
        });
      }
      cb(null, reportBase(range, { rows: result, total: result.length }));
    }
  );
}

function loadScansByOperator(range, cb) {
  const params = [];
  const clauses = dateClauses('e.event_time', range, params);
  pushShop(clauses, params, 'COALESCE(wo.location_id, o.location_id)', range);
  db.all(
    `SELECT
       e.operator_id AS operator_id,
       u.username AS operator_username,
       u.display_name AS operator_name,
       COUNT(*) AS scan_count
     FROM barcode_events e
     LEFT JOIN users u ON u.id = e.operator_id
     LEFT JOIN work_orders wo ON wo.id = e.work_order_id
     LEFT JOIN orders o ON o.id = wo.order_id
     ${whereSql(clauses)}
     GROUP BY e.operator_id, u.username, u.display_name
     ORDER BY scan_count DESC, operator_username COLLATE NOCASE ASC`,
    params,
    (err, rows) => {
      if (err) return cb(err);
      const result = (rows || []).map((row) => ({
        operator_id: row.operator_id,
        operator_username: row.operator_id == null ? '(unassigned)' : (row.operator_username || ''),
        operator_name: row.operator_id == null ? '' : (row.operator_name || ''),
        scan_count: row.scan_count,
      }));
      const total = result.reduce((sum, row) => sum + row.scan_count, 0);
      cb(null, reportBase(range, { rows: result, total }));
    }
  );
}

function loadScansByLocation(range, cb) {
  const params = [];
  const clauses = dateClauses('e.event_time', range, params);
  pushShop(clauses, params, 'COALESCE(wo.location_id, o.location_id)', range);
  db.all(
    `SELECT
       CASE
         WHEN e.location IS NULL OR trim(e.location) = '' THEN '(none)'
         ELSE trim(e.location)
       END AS location,
       COUNT(*) AS scan_count
     FROM barcode_events e
     LEFT JOIN work_orders wo ON wo.id = e.work_order_id
     LEFT JOIN orders o ON o.id = wo.order_id
     ${whereSql(clauses)}
     GROUP BY 1
     ORDER BY scan_count DESC, location COLLATE NOCASE ASC`,
    params,
    (err, rows) => {
      if (err) return cb(err);
      const result = rows || [];
      const total = result.reduce((sum, row) => sum + row.scan_count, 0);
      cb(null, reportBase(range, { rows: result, total }));
    }
  );
}

function parseStamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
}

function stampInRange(stamp, range) {
  if (range.from && stamp < range.from) return false;
  if (range.to && stamp > range.to) return false;
  return true;
}

function averageStageRows(events, range) {
  const totals = new Map();
  let current = null;

  const closeCurrent = (endedAt) => {
    if (!current || endedAt == null || current.startedAt == null) return;
    if (!stampInRange(current.eventTime, range)) return;
    const seconds = (endedAt - current.startedAt) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const key = current.stageId;
    const entry = totals.get(key) || {
      stage_id: current.stageId,
      stage_name: current.stageName || `(stage ${current.stageId})`,
      sample_count: 0,
      total_seconds: 0,
    };
    entry.sample_count += 1;
    entry.total_seconds += seconds;
    totals.set(key, entry);
  };

  for (const event of events || []) {
    if (current && event.work_order_id !== current.workOrderId) {
      current = null;
    }
    if (current && event.stage_id === current.stageId) continue;
    if (current) closeCurrent(parseStamp(event.event_time));
    current = {
      workOrderId: event.work_order_id,
      stageId: event.stage_id,
      stageName: event.stage_name,
      eventTime: event.event_time,
      startedAt: parseStamp(event.event_time),
    };
  }

  return Array.from(totals.values())
    .map((entry) => ({
      stage_id: entry.stage_id,
      stage_name: entry.stage_name,
      sample_count: entry.sample_count,
      average_seconds: Math.round(entry.total_seconds / entry.sample_count),
    }))
    .sort((left, right) => String(left.stage_name).localeCompare(String(right.stage_name)));
}

function loadStageDurationReport(range, cb) {
  db.all(
    `SELECT e.work_order_id, e.event_time, e.stage_id, e.id, ps.name AS stage_name
     FROM barcode_events e
     LEFT JOIN production_stages ps ON ps.id = e.stage_id
     LEFT JOIN work_orders wo ON wo.id = e.work_order_id
     LEFT JOIN orders o ON o.id = wo.order_id
     WHERE e.stage_id IS NOT NULL
       ${range && range.shopLocationId != null
    ? (range.shopLocationNull
      ? 'AND (COALESCE(wo.location_id, o.location_id) = ? OR COALESCE(wo.location_id, o.location_id) IS NULL)'
      : 'AND COALESCE(wo.location_id, o.location_id) = ?')
    : ''}
     ORDER BY e.work_order_id ASC, e.event_time ASC, e.id ASC`,
    range && range.shopLocationId != null ? [range.shopLocationId] : [],
    (err, events) => {
      if (err) return cb(err);
      const rows = averageStageRows(events, range);
      const total = rows.reduce((sum, row) => sum + row.sample_count, 0);
      cb(null, reportBase(range, {
        derivable: rows.length > 0,
        note: STAGE_TIME_NOTE,
        rows,
        total,
      }));
    }
  );
}

module.exports = {
  toCsv,
  parseReportQuery,
  loadStatusReport,
  loadDepartmentReport,
  loadStageReport,
  loadThroughputReport,
  loadDeliveryReport,
  loadScansByOperator,
  loadScansByLocation,
  loadStageDurationReport,
};
