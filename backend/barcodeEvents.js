const db = require('./db');
const activityLog = require('./activityLog');
const deliveryNotify = require('./deliveryNotify');
const { isQualityDepartmentRow } = require('./departmentStage');
const shopLocations = require('./shopLocations');
const { withTransaction } = require('./dbAsync');
const { DEFAULT_LOCATION_STAGES, isLegacyInactiveAlias } = require('./barcodeLocationDefaults');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SCANNED_VALUE_LENGTH = 255;
const MAX_LOCATION_LENGTH = 120;

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

// Unset BARCODE_LOCATION_STAGES uses the default map: Quality advances Quality Control,
// and Dispatch advances Shipping. An empty value disables advancement.
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
  const located = `SELECT wo.id, wo.external_id, wo.description, wo.department, wo.status, wo.order_id,
            o.order_number, o.status AS order_status,
            COALESCE(wo.location_id, o.location_id) AS location_id
     FROM work_orders wo
     LEFT JOIN orders o ON o.id = wo.order_id`;
  db.get(
    `${located} WHERE wo.external_id = ? ORDER BY wo.id ASC`,
    [value],
    (err, byExternal) => {
      if (err) return cb(err);
      if (byExternal) return cb(null, byExternal);
      if (!/^[1-9]\d*$/.test(value)) return cb(null, null);
      const id = Number(value);
      if (!Number.isSafeInteger(id)) return cb(null, null);
      db.get(
        `${located} WHERE wo.id = ?`,
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
// Inactive Quality Control and Shipping aliases still resolve after the legacy migration.
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

function unmatchedPolicy() {
  return {
    mode: 'table',
    matched: false,
    configuredLocation: null,
    departmentName: null,
    stageName: null,
  };
}

function policyFromRow(found) {
  return {
    mode: 'table',
    matched: true,
    configuredLocation: found.location,
    departmentName: found.department_name || null,
    stageName: found.stage_name || null,
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
    if (!text) return cb(null, unmatchedPolicy());
    db.get(
      `SELECT location, department_name, stage_name, is_active
       FROM barcode_locations
       WHERE is_active = 1 AND lower(location) = lower(?)`,
      [text],
      (err2, found) => {
        if (err2) return cb(err2);
        if (found) return cb(null, policyFromRow(found));
        db.get(
          `SELECT location, department_name, stage_name, is_active
           FROM barcode_locations
           WHERE lower(location) = lower(?)`,
          [text],
          (err3, inactive) => {
            if (err3) return cb(err3);
            if (isLegacyInactiveAlias(inactive)) return cb(null, policyFromRow(inactive));
            cb(null, unmatchedPolicy());
          }
        );
      }
    );
  });
}

function departmentMoveReason({ location, policy, moved, fromDepartment, toDepartment }) {
  if (moved) return 'moved';
  const text = location ? String(location).trim() : '';
  if (!text) return 'no_location';
  if (!policy || !policy.matched) return 'unknown_location';
  if (!policy.departmentName) return 'stage_only';
  if (!toDepartment) return 'department_not_found';
  if (String(fromDepartment || '').trim().toLowerCase() === String(toDepartment).trim().toLowerCase()) {
    return 'same_department';
  }
  return 'unchanged';
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

function historyNote({ fromDepartment, toName, manual, note, fromLocation, toLocation }) {
  const locationChanged = Boolean(fromLocation && toLocation && fromLocation !== toLocation);
  const locationText = locationChanged ? `Location ${fromLocation} to ${toLocation}` : '';
  const samePlace = sameDepartmentName(fromDepartment, toName);
  if (manual && samePlace && locationChanged) {
    const base = `Manual move. ${locationText}.`;
    return note ? `${base} ${note}` : base;
  }
  if (!manual) {
    const base = `Moved from ${fromDepartment || 'unassigned'} to ${toName}`;
    return locationText ? `${base}. ${locationText}` : base;
  }
  const base = `Manual move from ${fromDepartment || 'unassigned'} to ${toName}`;
  if (note && locationText) return `${base}. ${locationText}. ${note}`;
  if (note) return `${base}. ${note}`;
  if (locationText) return `${base}. ${locationText}`;
  return base;
}

// Department, history, and activity commit together. A scan also writes the barcode event.
// A manual move passes stage so the stage change commits with the department.
async function applyDepartmentChange(tx, move) {
  const {
    matchedDepartment,
    nextStatus,
    workOrder,
    operator,
    operatorId,
    fromDepartment,
    manual,
    note,
    stage,
    fromLocation,
    toLocation,
    fromLocationId,
    toLocationId,
  } = move;

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

  if (stage) {
    await tx.run(
      `UPDATE work_orders SET stage_id = ?, updated_at = datetime('now') WHERE id = ?`,
      [stage.id, workOrder.id]
    );
  }

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
      historyNote({
        fromDepartment,
        toName: matchedDepartment.name,
        manual: Boolean(manual),
        note: note || null,
        fromLocation: fromLocation || null,
        toLocation: toLocation || null,
      }),
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
    manual: Boolean(manual),
    note: note || null,
    fromLocation: fromLocation || null,
    toLocation: toLocation || null,
    fromLocationId: fromLocationId || null,
    toLocationId: toLocationId || null,
  });
  for (const entry of entries) {
    await tx.run(activityLog.INSERT_SQL, activityLog.bindParams(entry));
  }
}

// Event, department, history, and activity commit together. A failure rolls all four back.
async function writeDepartmentMove(tx, move) {
  const inserted = await tx.run(EVENT_INSERT_SQL, eventParams(move));
  await applyDepartmentChange(tx, move);
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
        `SELECT id, name, next_department, dept_key FROM departments
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
    order_id: workOrder.order_id || null,
    order_number: workOrder.order_number || null,
    order_status: String(workOrder.order_status || '').trim().toLowerCase() === 'ready for pickup'
      ? 'Ready for Pickup'
      : (workOrder.order_id ? 'In Production' : null),
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

  if (moved && isQualityDepartmentRow(matchedDepartment) && workOrder.order_id) {
    try {
      payload.delivery_notice = await deliveryNotify.afterQualityEntry({
        orderId: workOrder.order_id,
        departmentId: matchedDepartment.id,
      });
    } catch (err) {
      console.error('DELIVERY NOTIFY ERROR:', err && err.message ? err.message : 'failed');
      payload.delivery_notice = { skipped: true, reason: 'failed' };
    }
  }

  return payload;
}

const MAX_MOVE_DEPARTMENT_LENGTH = 80;
const MAX_MOVE_NOTE_LENGTH = 500;

function parseManualMove(body) {
  const source = body || {};
  if (!Object.prototype.hasOwnProperty.call(source, 'department') || source.department == null || source.department === '') {
    return { error: 'department is required' };
  }
  if (typeof source.department !== 'string') return { error: 'department must be a string' };
  const department = source.department.trim();
  if (!department) return { error: 'department is required' };
  if (department.length > MAX_MOVE_DEPARTMENT_LENGTH) return { error: 'department is too long' };
  if (/[\u0000-\u001F]/.test(department)) return { error: 'department contains invalid characters' };

  let note = null;
  if (source.note != null && source.note !== '') {
    if (typeof source.note !== 'string') return { error: 'note must be a string' };
    note = source.note.trim();
    if (!note) note = null;
    else if (note.length > MAX_MOVE_NOTE_LENGTH) return { error: 'note is too long' };
    else if (/[\u0000-\u001F]/.test(note)) return { error: 'note contains invalid characters' };
  }

  const location = parseMoveLocation(source);
  if (location.error) return location;
  return { department, note, locationId: location.present ? location.value : undefined };
}

function parseMoveLocation(source) {
  if (!Object.prototype.hasOwnProperty.call(source, 'location_id')) return { present: false };
  const value = source.location_id;
  if (value == null) return { present: false };
  if (typeof value === 'string') {
    if (value.trim() === '') return { present: false };
    return { present: true, value: value.trim() };
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) return { error: 'location_id must be an active location' };
    return { present: true, value };
  }
  return { error: 'location_id must be an active location' };
}

function sameDepartmentName(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function sameShopId(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return Number(left) === Number(right);
}

// The stage follows the active barcode location for the target department, the same
// row a scan of that department uses. A blank stage stays blank. The built-in map
// applies only when that table is missing, empty, or has no active row for the department.
async function stageNameForDepartment(tx, departmentName) {
  const name = String(departmentName || '').trim();
  if (!name) return null;

  const table = await tx.get(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'barcode_locations'`
  );
  if (!table) return stageNameForLocation(name);

  const count = await tx.get('SELECT COUNT(*) AS count FROM barcode_locations');
  if (!count || !count.count) return stageNameForLocation(name);

  const row = await tx.get(
    `SELECT stage_name
     FROM barcode_locations
     WHERE is_active = 1
       AND lower(trim(COALESCE(department_name, ''))) = lower(?)
     ORDER BY CASE WHEN lower(trim(location)) = lower(?) THEN 0 ELSE 1 END,
              sort_order ASC,
              id ASC
     LIMIT 1`,
    [name, name]
  );
  if (!row) return stageNameForLocation(name);
  const stage = row.stage_name == null ? '' : String(row.stage_name).trim();
  return stage || null;
}

async function shopForMove(tx, locationId) {
  if (locationId == null) return { id: null, name: null };
  const row = await tx.get(`SELECT id, name FROM locations WHERE id = ?`, [locationId]);
  return row ? { id: row.id, name: row.name } : { id: locationId, name: null };
}

// NULL shop columns count as Raleigh, the same way the board reads a work order.
async function effectiveShop(tx, workOrder) {
  const stored = workOrder.location_id != null
    ? Number(workOrder.location_id)
    : (workOrder.order_location_id != null ? Number(workOrder.order_location_id) : null);
  const id = stored == null ? await shopLocations.defaultLocationId(tx) : stored;
  return shopForMove(tx, id);
}

// Manual move shares the scan's department update. It does not write a barcode event.
// Admin and manager can move a work order from any department. A location change is
// also admin and manager only; departments themselves are not tied to a shop.
async function moveWorkOrder({ workOrderId, department, note, actorId, actorRole, locationId }) {
  const lookup = String(department || '').trim();
  const result = await withTransaction(async (tx) => {
    const workOrder = await tx.get(
      `SELECT wo.id, wo.external_id, wo.description, wo.department, wo.status, wo.stage_id,
              wo.location_id, wo.order_id, o.location_id AS order_location_id
       FROM work_orders wo
       LEFT JOIN orders o ON o.id = wo.order_id
       WHERE wo.id = ?`,
      [workOrderId]
    );
    if (!workOrder) throw httpError(404, 'Work order not found');

    const matched = lookup
      ? await tx.get(
        `SELECT id, name, next_department, dept_key FROM departments
         WHERE is_active = 1 AND lower(name) = lower(?)`,
        [lookup]
      )
      : null;
    if (!matched) throw httpError(400, 'department must be an active department');

    const currentShop = await effectiveShop(tx, workOrder);
    let targetShop = currentShop;
    if (locationId !== undefined) {
      const resolved = await shopLocations.resolveLocationId(tx, locationId, { required: true, activeOnly: true });
      if (resolved.error) throw httpError(400, resolved.error);
      targetShop = { id: resolved.value, name: resolved.name };
    }
    const locationChanged = !sameShopId(targetShop.id, currentShop.id);
    if (locationChanged && actorRole !== 'admin' && actorRole !== 'manager') {
      throw httpError(403, 'Only an admin or manager can change the location');
    }
    const departmentChanged = !sameDepartmentName(workOrder.department, matched.name);
    if (!departmentChanged && !locationChanged) {
      throw httpError(409, `Work order is already in ${matched.name}`);
    }

    const operator = actorId
      ? await tx.get('SELECT id, display_name, username FROM users WHERE id = ?', [actorId])
      : null;
    const fromLocation = locationChanged ? (currentShop.name || 'unassigned') : null;
    const toLocation = locationChanged ? (targetShop.name || 'unassigned') : null;
    let stage = null;
    let status = workOrder.status || 'open';

    if (departmentChanged) {
      const stageName = await stageNameForDepartment(tx, matched.name);
      stage = stageName
        ? await tx.get(
          'SELECT id, name FROM production_stages WHERE lower(name) = lower(?)',
          [stageName]
        )
        : null;
      if (isCompleteDepartment(matched.name) && !activityLog.isFinishedStatus(status)) {
        status = 'completed';
      }
      await applyDepartmentChange(tx, {
        matchedDepartment: matched,
        nextStatus: status,
        workOrder,
        operator,
        operatorId: actorId || null,
        fromDepartment: workOrder.department || null,
        manual: true,
        note: note || null,
        stage,
        fromLocation,
        toLocation,
        fromLocationId: locationChanged ? currentShop.id : null,
        toLocationId: locationChanged ? targetShop.id : null,
      });
    } else {
      const scannedBy = operator?.display_name || operator?.username || 'Staff';
      await tx.run(
        `INSERT INTO production_history (work_order_id, department, status, scanned_by, user_id, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          workOrder.id,
          matched.name,
          status,
          scannedBy,
          actorId || null,
          historyNote({
            fromDepartment: workOrder.department || null,
            toName: matched.name,
            manual: true,
            note: note || null,
            fromLocation,
            toLocation,
          }),
        ]
      );
      const entries = activityLog.transitionEntries({
        actorId: actorId || null,
        previous: workOrder,
        next: {
          id: workOrder.id,
          external_id: workOrder.external_id,
          department: workOrder.department,
          status,
        },
        manual: true,
        note: note || null,
        fromLocation,
        toLocation,
        fromLocationId: currentShop.id,
        toLocationId: targetShop.id,
      });
      for (const entry of entries) {
        await tx.run(activityLog.INSERT_SQL, activityLog.bindParams(entry));
      }
    }

    if (locationChanged) {
      await tx.run(
        `UPDATE work_orders SET location_id = ?, updated_at = datetime('now') WHERE id = ?`,
        [targetShop.id, workOrder.id]
      );
    }

    const updated = await tx.get(
      `SELECT id, external_id, department, next_department, status, stage_id, location_id
       FROM work_orders
       WHERE id = ?`,
      [workOrder.id]
    );
    return {
      id: updated.id,
      external_id: updated.external_id,
      from_department: workOrder.department || null,
      department: updated.department,
      next_department: updated.next_department || null,
      status: updated.status,
      stage_id: updated.stage_id || null,
      stage_name: stage ? stage.name : null,
      stage_advanced: Boolean(stage),
      manual: true,
      note: note || null,
      location_id: updated.location_id == null ? currentShop.id : updated.location_id,
      location_name: targetShop.name || currentShop.name || null,
      from_location: locationChanged ? (currentShop.name || null) : null,
      location_changed: locationChanged,
      order_id: workOrder.order_id || null,
      department_id: matched.id,
      entered_quality: Boolean(departmentChanged && isQualityDepartmentRow(matched)),
    };
  });
  if (result && result.entered_quality && result.order_id) {
    try {
      result.delivery_notice = await deliveryNotify.afterQualityEntry({
        orderId: result.order_id,
        departmentId: result.department_id,
      });
    } catch (err) {
      console.error('DELIVERY NOTIFY ERROR:', err && err.message ? err.message : 'failed');
      result.delivery_notice = { skipped: true, reason: 'failed' };
    }
  }
  return result;
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
          .then((payload) => {
            payload.department_move_reason = departmentMoveReason({
              location,
              policy,
              moved: payload.department_moved,
              fromDepartment: payload.from_department,
              toDepartment: payload.to_department,
            });
            cb(null, payload);
          })
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
  if (filters.departmentLock) {
    clauses.push(`(
      lower(trim(coalesce(e.location, ''))) = lower(?)
      OR lower(trim(coalesce(e.from_department, ''))) = lower(?)
      OR lower(trim(coalesce(e.to_department, ''))) = lower(?)
    )`);
    params.push(filters.departmentLock, filters.departmentLock, filters.departmentLock);
  }
  if (filters.shopLocationId != null) {
    if (filters.shopLocationNull) {
      clauses.push('(COALESCE(wo.location_id, o.location_id) = ? OR COALESCE(wo.location_id, o.location_id) IS NULL)');
    } else {
      clauses.push('COALESCE(wo.location_id, o.location_id) = ?');
    }
    params.push(filters.shopLocationId);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const fromSql = `
    FROM barcode_events e
    LEFT JOIN work_orders wo ON e.work_order_id = wo.id
    LEFT JOIN orders o ON o.id = wo.order_id
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
  parseManualMove,
  moveWorkOrder,
};
