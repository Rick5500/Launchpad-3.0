const db = require('./db');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SCANNED_VALUE_LENGTH = 255;
const MAX_LOCATION_LENGTH = 120;
const DEFAULT_LOCATION_STAGES = 'Shipping=Shipping;Quality Control=Quality Control;Finishing=Finishing';

const missingStageNames = new Set();

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatNaive(parts) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function calendarPartsValid(parts) {
  if (parts.month < 1 || parts.month > 12) return false;
  if (parts.hour < 0 || parts.hour > 23) return false;
  if (parts.minute < 0 || parts.minute > 59) return false;
  if (parts.second < 0 || parts.second > 59) return false;
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return probe.getUTCFullYear() === parts.year
    && probe.getUTCMonth() === parts.month - 1
    && probe.getUTCDate() === parts.day;
}

function utcNowNaive() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function httpError(status, publicMessage) {
  const error = new Error(publicMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  return error;
}

// Unset BARCODE_LOCATION_STAGES uses the default map. An empty value disables advancement.
// Format: Location=Stage Name pairs separated by semicolons. Later duplicates win.
function locationStageEntries() {
  const raw = process.env.BARCODE_LOCATION_STAGES;
  const text = raw === undefined ? DEFAULT_LOCATION_STAGES : String(raw).trim();
  const entries = [];
  if (!text) return entries;

  for (const pair of text.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const location = pair.slice(0, separator).trim();
    const stage = pair.slice(separator + 1).trim();
    if (!location || !stage) continue;
    const key = location.toLowerCase();
    const existing = entries.findIndex((entry) => entry.location.toLowerCase() === key);
    if (existing >= 0) entries.splice(existing, 1);
    entries.push({ location, stage });
  }
  return entries;
}

function stageNameForLocation(location) {
  if (!location) return null;
  const key = String(location).trim().toLowerCase();
  if (!key) return null;
  const match = locationStageEntries().find((entry) => entry.location.toLowerCase() === key);
  return match ? match.stage : null;
}

function parseEventTime(value) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'event_time is invalid' };
  const text = value.trim();
  if (!text || text.length > 40) return { error: 'event_time is invalid' };

  const hasZone = /[zZ]$/.test(text) || /[+-]\d{2}:\d{2}$/.test(text);
  const naive = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (naive && !hasZone) {
    const parts = {
      year: Number(naive[1]),
      month: Number(naive[2]),
      day: Number(naive[3]),
      hour: naive[4] == null ? 0 : Number(naive[4]),
      minute: naive[5] == null ? 0 : Number(naive[5]),
      second: naive[6] == null ? 0 : Number(naive[6]),
    };
    if (!calendarPartsValid(parts)) return { error: 'event_time is invalid' };
    return { value: formatNaive(parts) };
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf())) return { error: 'event_time is invalid' };
  return { value: parsed.toISOString().slice(0, 19).replace('T', ' ') };
}

function parseRangeBound(value, bound) {
  if (value == null || value === '') return { value: null };
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const clock = bound === 'to' ? '23:59:59' : '00:00:00';
    return parseEventTime(`${text} ${clock}`);
  }
  return parseEventTime(text);
}

function parseLimit(value) {
  if (value == null || value === '') return { value: DEFAULT_LIMIT };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return { error: `limit must be an integer from 1 to ${MAX_LIMIT}` };
  }
  return { value: parsed };
}

function parseOffset(value) {
  if (value == null || value === '') return { value: 0 };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { error: 'offset must be an integer of 0 or greater' };
  }
  return { value: parsed };
}

function parseOperator(value) {
  if (value == null || String(value).trim() === '') return {};
  const text = String(value).trim();
  if (/^[1-9]\d*$/.test(text)) {
    const operatorId = Number(text);
    if (!Number.isSafeInteger(operatorId)) return { error: 'operator must be a user id or username' };
    return { operatorId };
  }
  if (!/^[A-Za-z0-9._@-]{1,80}$/.test(text)) {
    return { error: 'operator must be a user id or username' };
  }
  return { operatorUsername: text };
}

function parseListQuery(query) {
  const source = query || {};
  const limit = parseLimit(source.limit);
  if (limit.error) return { error: limit.error };
  const offset = parseOffset(source.offset);
  if (offset.error) return { error: offset.error };

  let workOrderId = null;
  if (source.work_order_id != null && source.work_order_id !== '') {
    const text = String(source.work_order_id).trim();
    if (!/^[1-9]\d*$/.test(text)) return { error: 'work_order_id must be a positive integer' };
    workOrderId = Number(text);
    if (!Number.isSafeInteger(workOrderId)) return { error: 'work_order_id must be a positive integer' };
  }

  const operator = parseOperator(source.operator);
  if (operator.error) return { error: operator.error };

  const from = parseRangeBound(source.from, 'from');
  if (from.error) return { error: 'from is invalid' };
  const to = parseRangeBound(source.to, 'to');
  if (to.error) return { error: 'to is invalid' };
  if (from.value && to.value && from.value > to.value) return { error: 'from must be before to' };

  return {
    value: {
      limit: limit.value,
      offset: offset.value,
      workOrderId,
      operatorId: operator.operatorId || null,
      operatorUsername: operator.operatorUsername || null,
      from: from.value,
      to: to.value,
    },
  };
}

function resolveWorkOrder(scannedValue, cb) {
  const value = String(scannedValue || '').trim();
  db.get(
    `SELECT id, external_id, description
     FROM work_orders
     WHERE external_id = ?
     ORDER BY id ASC`,
    [value],
    (err, byExternal) => {
      if (err) return cb(err);
      if (byExternal) return cb(null, byExternal);
      if (!/^[1-9]\d*$/.test(value)) return cb(null, null);
      const id = Number(value);
      if (!Number.isSafeInteger(id)) return cb(null, null);
      db.get(
        'SELECT id, external_id, description FROM work_orders WHERE id = ?',
        [id],
        (err2, byId) => cb(err2, byId || null)
      );
    }
  );
}

function resolveStage(location, cb) {
  const stageName = stageNameForLocation(location);
  if (!stageName) return cb(null, null);
  db.get(
    'SELECT id, name FROM production_stages WHERE lower(name) = lower(?)',
    [stageName],
    (err, row) => {
      if (err) return cb(err);
      if (!row) {
        if (!missingStageNames.has(stageName)) {
          missingStageNames.add(stageName);
          console.error(`BARCODE STAGE NOT FOUND: "${stageName}"`);
        }
        return cb(null, null);
      }
      cb(null, row);
    }
  );
}

function recordScan({ scannedValue, location, eventTime, operatorId }, cb) {
  resolveWorkOrder(scannedValue, (err, workOrder) => {
    if (err) return cb(err);
    if (!workOrder) return cb(httpError(404, 'Work order not found'));

    resolveStage(location, (stageErr, stage) => {
      if (stageErr) return cb(stageErr);
      const storedTime = eventTime || utcNowNaive();
      db.run(
        `INSERT INTO barcode_events
          (scanned_value, work_order_id, operator_id, location, event_time, stage_id)
         VALUES (?,?,?,?,?,?)`,
        [
          scannedValue,
          workOrder.id,
          operatorId,
          location || null,
          storedTime,
          stage ? stage.id : null,
        ],
        function onInsert(insertErr) {
          if (insertErr) return cb(insertErr);
          const eventId = this.lastID;
          const payload = {
            id: eventId,
            scanned_value: scannedValue,
            work_order_id: workOrder.id,
            external_id: workOrder.external_id,
            description: workOrder.description,
            operator_id: operatorId,
            location: location || null,
            event_time: storedTime,
            stage_id: stage ? stage.id : null,
            stage_name: stage ? stage.name : null,
            stage_advanced: false,
          };
          if (!stage) return cb(null, payload);

          db.run(
            `UPDATE work_orders SET stage_id = ?, updated_at = datetime('now') WHERE id = ?`,
            [stage.id, workOrder.id],
            function onStage(updateErr) {
              if (updateErr) {
                console.error('BARCODE STAGE UPDATE ERROR:', updateErr);
                return cb(null, payload);
              }
              payload.stage_advanced = this.changes > 0;
              cb(null, payload);
            }
          );
        }
      );
    });
  });
}

function listEvents(filters, cb) {
  const clauses = [];
  const params = [];
  if (filters.workOrderId) {
    clauses.push('e.work_order_id = ?');
    params.push(filters.workOrderId);
  }
  if (filters.operatorId) {
    clauses.push('e.operator_id = ?');
    params.push(filters.operatorId);
  }
  if (filters.operatorUsername) {
    clauses.push('u.username = ?');
    params.push(filters.operatorUsername);
  }
  if (filters.from) {
    clauses.push('e.event_time >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push('e.event_time <= ?');
    params.push(filters.to);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const fromSql = `
    FROM barcode_events e
    LEFT JOIN work_orders wo ON e.work_order_id = wo.id
    LEFT JOIN users u ON e.operator_id = u.id
    LEFT JOIN production_stages ps ON e.stage_id = ps.id
    ${where}
  `;

  db.get(`SELECT COUNT(*) AS count ${fromSql}`, params, (err, row) => {
    if (err) return cb(err);
    db.all(
      `SELECT
         e.id,
         e.scanned_value,
         e.work_order_id,
         e.operator_id,
         e.location,
         e.event_time,
         e.stage_id,
         wo.external_id,
         wo.description AS work_order_description,
         u.username AS operator_username,
         u.display_name AS operator_name,
         ps.name AS stage_name
       ${fromSql}
       ORDER BY e.event_time DESC, e.id DESC
       LIMIT ? OFFSET ?`,
      [...params, filters.limit, filters.offset],
      (listErr, events) => {
        if (listErr) return cb(listErr);
        cb(null, {
          events: events || [],
          total: row ? row.count : 0,
          limit: filters.limit,
          offset: filters.offset,
        });
      }
    );
  });
}

module.exports = {
  MAX_SCANNED_VALUE_LENGTH,
  MAX_LOCATION_LENGTH,
  locationStageEntries,
  parseEventTime,
  parseRangeBound,
  parseListQuery,
  resolveWorkOrder,
  recordScan,
  listEvents,
};
