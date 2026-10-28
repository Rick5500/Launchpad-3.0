// Work orders for "Send a vehicle to pick up originals" wait in Dispatch.
// production_department is the queue they enter once the originals are here.
// releaseOriginalsHold moves every flagged job on an order. A scan or manual
// move of one job uses destinationForHold so it does not follow Dispatch to Delivery.

const activityLog = require('./activityLog');

const ORIGINALS_VEHICLE = 'Send a vehicle to pick up originals';

function actorIdOf(actor) {
  if (actor == null || actor === '') return null;
  if (typeof actor === 'object') {
    const id = Number(actor.userId || actor.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  }
  const id = Number(actor);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function sameDepartmentName(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function isCompleteName(name) {
  return String(name || '').trim().toLowerCase() === 'complete';
}

function releaseNote(reason, departmentName) {
  if (reason) return String(reason);
  return `Originals picked up — moved from Dispatch to ${departmentName}`;
}

async function departmentByName(tx, name) {
  const text = String(name || '').trim();
  if (!text) return null;
  return tx.get(
    `SELECT id, name, next_department, dept_key
     FROM departments
     WHERE lower(name) = lower(?)
     ORDER BY is_active DESC, id ASC
     LIMIT 1`,
    [text]
  );
}

async function isDispatchName(tx, name) {
  const row = await departmentByName(tx, name);
  if (!row) return String(name || '').trim().toLowerCase() === 'dispatch';
  const key = String(row.dept_key || '').trim().toLowerCase();
  if (key) return key === 'dispatch';
  return String(row.name || '').trim().toLowerCase() === 'dispatch';
}

async function holdingOriginals(tx, workOrder) {
  if (!workOrder || Number(workOrder.awaiting_originals) !== 1) return false;
  return isDispatchName(tx, workOrder.department);
}

// The department a leaving job should enter. Null keeps the requested destination.
async function destinationForHold(tx, workOrder, requested) {
  if (!requested || !(await holdingOriginals(tx, workOrder))) return null;
  if (sameDepartmentName(workOrder.department, requested.name)) return null;
  const target = await departmentByName(tx, workOrder.production_department);
  if (!target) return null;
  if (sameDepartmentName(target.name, requested.name)) return null;
  return target;
}

// True when this move takes a flagged job out of Dispatch, including a move
// that was already aimed at the production department.
async function releasingHold(tx, workOrder, destination) {
  if (!destination || !(await holdingOriginals(tx, workOrder))) return false;
  return !sameDepartmentName(workOrder.department, destination.name);
}

async function clearOriginalsFlag(tx, workOrderId) {
  await tx.run(
    `UPDATE work_orders
     SET awaiting_originals = 0, updated_at = datetime('now')
     WHERE id = ?`,
    [workOrderId]
  );
}

async function markPickupPickedUpIfClear(tx, orderId, actor) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const waiting = await tx.get(
    `SELECT COUNT(*) AS count FROM work_orders
     WHERE order_id = ? AND COALESCE(awaiting_originals, 0) = 1`,
    [id]
  );
  if (waiting && Number(waiting.count) > 0) return false;
  const open = await tx.all(
    `SELECT id FROM pickup_requests
     WHERE order_id = ? AND source = 'order' AND status IN ('new', 'scheduled')`,
    [id]
  );
  if (!open.length) return false;
  await tx.run(
    `UPDATE pickup_requests
     SET status = 'picked_up', updated_at = datetime('now')
     WHERE order_id = ? AND source = 'order' AND status IN ('new', 'scheduled')`,
    [id]
  );
  const actorId = actorIdOf(actor);
  for (const row of open) {
    await activityLog.recordOn(tx, actorId, 'pickup_request.updated', 'pickup_request', row.id, {
      status: 'picked_up',
      message: 'Pickup request marked picked up',
    });
  }
  return true;
}

async function finishOriginalsDeparture(tx, workOrder, actor) {
  if (!workOrder || Number(workOrder.awaiting_originals) !== 1) return false;
  await clearOriginalsFlag(tx, workOrder.id);
  await markPickupPickedUpIfClear(tx, workOrder.order_id, actor);
  return true;
}

// Used by the work-order edit route, which does not have a transaction yet.
async function departureTarget(workOrder, requestedName) {
  if (!workOrder || Number(workOrder.awaiting_originals) !== 1) return null;
  if (sameDepartmentName(workOrder.department, requestedName)) return null;
  const { get } = require('./dbAsync');
  const reader = { get };
  if (!(await isDispatchName(reader, workOrder.department))) return null;
  return departmentByName(reader, workOrder.production_department);
}

async function releaseOriginalsHold(tx, orderId, actor, reason) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const { applyDepartmentChange } = require('./barcodeEvents');
  const actorId = actorIdOf(actor);
  const operator = actorId
    ? await tx.get('SELECT id, display_name, username FROM users WHERE id = ?', [actorId])
    : null;
  const rows = await tx.all(
    `SELECT id, external_id, description, department, status, order_id,
            awaiting_originals, production_department
     FROM work_orders
     WHERE order_id = ? AND COALESCE(awaiting_originals, 0) = 1`,
    [id]
  );
  const released = [];
  for (const workOrder of rows) {
    const target = await departmentByName(tx, workOrder.production_department);
    const destinationName = target ? target.name : (String(workOrder.production_department || '').trim() || 'unassigned');
    const note = releaseNote(reason, destinationName);
    if (target && !sameDepartmentName(workOrder.department, target.name)) {
      let status = workOrder.status || 'open';
      if (isCompleteName(target.name) && !activityLog.isFinishedStatus(status)) status = 'completed';
      await applyDepartmentChange(tx, {
        matchedDepartment: target,
        nextStatus: status,
        workOrder,
        operator,
        operatorId: actorId,
        fromDepartment: workOrder.department || null,
        manual: false,
        note,
      });
    } else {
      const scannedBy = operator?.display_name || operator?.username || 'Staff';
      await tx.run(
        `INSERT INTO production_history (work_order_id, department, status, scanned_by, user_id, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [workOrder.id, destinationName, workOrder.status || 'open', scannedBy, actorId, note]
      );
      await activityLog.recordOn(tx, actorId, 'work_order.moved', 'work_order', workOrder.id, {
        external_id: workOrder.external_id || null,
        from_department: workOrder.department || null,
        to_department: destinationName,
        message: note,
      });
    }
    await clearOriginalsFlag(tx, workOrder.id);
    released.push(workOrder.id);
  }
  return released;
}

module.exports = {
  ORIGINALS_VEHICLE,
  departmentByName,
  isDispatchName,
  destinationForHold,
  releasingHold,
  finishOriginalsDeparture,
  markPickupPickedUpIfClear,
  departureTarget,
  releaseOriginalsHold,
};
