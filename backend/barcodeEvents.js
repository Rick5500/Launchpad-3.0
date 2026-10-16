const db = require('./db');
const activityLog = require('./activityLog');
const { withTransaction } = require('./dbAsync');

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
    `SELECT id, external_id, description, department, status
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
        'SELECT id, external_id, description, department, status FROM work_orders WHERE id = ?',
        [id],
        (err2, byId) => cb(err2, byId || null)
      );
    }
  );
}

function resolveStageByName(stageName, cb) {
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

function resolveStage(location, cb) {
  resolveStageByName(stageNameForLocation(location), cb);
}

// An empty barcode_locations table keeps the environment stage map and department-name match.
// Once any row exists, only active rows in that table move a department or advance a stage.
function fallbackPolicy(location) {
  const text = location ? String(location).trim() : '';
  return {
    mode: 'fallback',
    matched: Boolean(text),
    configuredLocation: text || null,
    departmentName: text || null,
    stageName: stageNameForLocation(text),
  };
}

function resolvePolicy(location, cb) {
  const text = location ? String(location).trim() : '';
  db.get('SELECT COUNT(*) AS count FROM barcode_locations', [], (err, row) => {
    if (err) {
      if (/no such table/i.test(String(err.message || ''))) return cb(null, fallbackPolicy(text));
      return cb(err);
    }
    if (!row || !row.count) return cb(null, fallbackPolicy(text));
    if (!text) {
      return cb(null, {
        mode: 'table',
        matched: false,
        configuredLocation: null,
        departmentName: null,
        stageName: null,
      });
    }
    db.get(
      `SELECT location, department_name, stage_name
       FROM barcode_locations
       WHERE is_active = 1 AND lower(location) = lower(?)`,
      [text],
      (err2, found) => {
        if (err2) return cb(err2);
        if (!found) {
          return cb(null, {
            mode: 'table',
            matched: false,
            configuredLocation: null,
            departmentName: null,
            stageName: null,
          });
        }
        cb(null, {
          mode: 'table',
          matched: true,
          configuredLocation: found.location,
          departmentName: found.department_name || null,
          stageName: found.stage_name || null,
        });
      }
    );
  });
}

function isCompleteDepartment(name) {
  return String(name || '').trim().toLowerCase() === 'complete';
}

const EVENT_INSERT_SQL = `INSERT INTO barcode_events
  (scanned_value, work_order_id, operator_id, location, event_time, stage_id, from_department, to_department)
 VALUES (?,?,?,?,?,?,?,?)`;

function eventParams({ scannedValue, workOrder, operatorId, location, storedTime, stage, fromDepartment, toDepartment }) {
  return [
    scannedValue,
    workOrder.id,
    operatorId,
    location || null,
    storedTime,
    stage ? stage.id : null,
    fromDepartment,
    toDepartment,
  ];
}

// Event, department, history, and activity commit together. A failure rolls all four back.
async function writeDepartmentMove(tx, move) {
  const inserted = await tx.run(EVENT_INSERT_SQL, eventParams(move));
  const { matchedDepartment, nextStatus, workOrder, operator, operatorId, fromDepartment } = move;

  await tx.run(
    `UPDATE work_orders
     SET department = ?,
         assigned_department_id = ?,
         next_department = ?,
         status = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
    [
      matchedDepartment.name,
      matchedDepartment.id,
      matchedDepartment.next_department || null,
      nextStatus,
      workOrder.id,
    ]
  );

  const scannedBy = operator?.display_name || operator?.username || 'Staff';
  await tx.run(
    `INSERT INTO production_history (work_order_id, department, status, scanned_by, user_id, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      workOrder.id,
      matchedDepartment.name,
      nextStatus,
      scannedBy,
      operatorId || null,
      `Moved from ${fromDepartment || 'unassigned'} to ${matchedDepartment.name}`,
    ]
  );

  const entries = activityLog.transitionEntries({
    actorId: operatorId,
    previous: workOrder,
    next: {
      id: workOrder.id,
      external_id: workOrder.external_id,
      department: matchedDepartment.name,
      status: nextStatus,
    },
  });
  for (const entry of entries) {
    await tx.run(activityLog.INSERT_SQL, activityLog.bindParams(entry));
  }
  return inserted;
}

// departmentName comes from the barcode location map. An empty map falls back to
// matching the scanned location against a department name. Stage-only locations do not move the department.
async function applyScan({ scannedValue, location, eventTime, operatorId, workOrder, stage, departmentName }) {
  const storedTime = eventTime || utcNowNaive();
  const departmentLookup = departmentName == null ? '' : String(departmentName).trim();
  const fromDepartment = workOrder.department || null;

  // Lookups and the insert share the writer queue so a scan does not busy-wait
  // on the shared connection while another transaction holds the write lock.
  const { inserted, matchedDepartment, moved, nextStatus } = await withTransaction(async (tx) => {
    const matched = departmentLookup
      ? await tx.get(
        `SELECT id, name, next_department FROM departments
         WHERE is_active = 1 AND lower(name) = lower(?)`,
        [departmentLookup]
      )
      : null;
    const scannedBy = operatorId
      ? await tx.get('SELECT id, display_name, username FROM users WHERE id = ?', [operatorId])
      : null;
    const toDepartment = matched ? matched.name : null;
    const didMove = Boolean(matched) && String(fromDepartment || '').trim() !== matched.name;
    let status = workOrder.status || 'open';
    if (didMove && isCompleteDepartment(matched.name) && !activityLog.isFinishedStatus(status)) {
      status = 'completed';
    }
    const move = {
      scannedValue,
      location,
      storedTime,
      operatorId,
      workOrder,
      stage,
      matchedDepartment: matched,
      operator: scannedBy,
      fromDepartment,
      toDepartment,
      nextStatus: status,
    };
    const written = didMove
      ? await writeDepartmentMove(tx, move)
      : await tx.run(EVENT_INSERT_SQL, eventParams(move));
    return {
      inserted: written,
      matchedDepartment: matched,
      moved: didMove,
      nextStatus: status,
    };
  });
  const toDepartment = matchedDepartment ? matchedDepartment.name : null;

  const payload = {
    id: inserted.lastID,
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
    from_department: fromDepartment,
    to_department: toDepartment,
    department_moved: moved,
  };
  if (moved) payload.status = nextStatus;

  if (stage) {
    try {
      const stageUpdate = await withTransaction((tx) => tx.run(
        `UPDATE work_orders SET stage_id = ?, updated_at = datetime('now') WHERE id = ?`,
        [stage.id, workOrder.id]
      ));
      payload.stage_advanced = stageUpdate.changes > 0;
    } catch (stageErr) {
      console.error('BARCODE STAGE UPDATE ERROR:', stageErr);
    }
  }

  return payload;
}

function recordScan({ scannedValue, location, eventTime, operatorId }, cb) {
  resolveWorkOrder(scannedValue, (err, workOrder) => {
    if (err) return cb(err);
    if (!workOrder) return cb(httpError(404, 'Work order not found'));

    resolvePolicy(location, (policyErr, policy) => {
      if (policyErr) return cb(policyErr);
      resolveStageByName(policy.stageName, (stageErr, stage) => {
        if (stageErr) return cb(stageErr);
        applyScan({
          scannedValue,
          location,
          eventTime,
          operatorId,
          workOrder,
          stage,
          departmentName: policy.departmentName,
        })
          .then((payload) => cb(null, payload))
          .catch(cb);
      });
    });
  });
}

function previewScan({ scannedValue, location }, cb) {
  resolveWorkOrder(scannedValue, (err, workOrder) => {
    if (err) return cb(err);
    resolvePolicy(location, (policyErr, policy) => {
      if (policyErr) return cb(policyErr);
      resolveStageByName(policy.stageName, (stageErr, stage) => {
        if (stageErr) return cb(stageErr);
        const finish = (department) => {
          const fromDepartment = workOrder ? (workOrder.department || null) : null;
          const toName = department ? department.name : null;
          const moved = Boolean(workOrder && department && String(fromDepartment || '').trim() !== department.name);
          let resultingStatus = workOrder ? workOrder.status : null;
          const wouldComplete = Boolean(
            moved
            && isCompleteDepartment(department.name)
            && !activityLog.isFinishedStatus(workOrder.status)
          );
          if (wouldComplete) resultingStatus = 'completed';
          cb(null, {
            scanned_value: scannedValue,
            dry_run: true,
            work_order: workOrder ? {
              id: workOrder.id,
              external_id: workOrder.external_id,
              description: workOrder.description,
              department: workOrder.department,
              status: workOrder.status,
              detail_path: `/work-orders/${workOrder.id}`,
              print_path: `/work-orders/${workOrder.id}/print`,
            } : null,
            location: {
              input: location || null,
              matched: Boolean(policy.matched && policy.mode === 'table'),
              source: policy.mode,
              configured_location: policy.configuredLocation,
              department_name: policy.departmentName,
              stage_name: policy.stageName,
              department_found: Boolean(department),
              stage_found: Boolean(stage),
              would_move_department: moved,
              would_advance_stage: Boolean(workOrder && stage),
              would_complete: wouldComplete,
              resulting_department: moved ? toName : fromDepartment,
              resulting_status: resultingStatus,
            },
          });
        };
        if (!policy.departmentName) return finish(null);
        db.get(
          `SELECT id, name, next_department FROM departments
           WHERE is_active = 1 AND lower(name) = lower(?)`,
          [String(policy.departmentName).trim()],
          (deptErr, department) => {
            if (deptErr) return cb(deptErr);
            finish(department || null);
          }
        );
      });
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
         e.from_department,
         e.to_department,
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
  previewScan,
  listEvents,
};
