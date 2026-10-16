// Staff activity rows for the Admin Board. Detail is JSON so the board can
// show a work order number and a short sentence without a second lookup.

const INSERT_SQL = `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, detail)
  VALUES (?,?,?,?,?)`;

function isFinishedStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  return value === 'completed' || value === 'complete';
}

function bindParams(entry) {
  const detail = entry.detail == null
    ? null
    : (typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail));
  return [
    entry.actorId == null ? null : Number(entry.actorId),
    entry.action,
    entry.entityType || null,
    entry.entityId == null ? null : Number(entry.entityId),
    detail,
  ];
}

function createdEntry({ actorId, workOrderId, externalId, department, orderNumber }) {
  const queue = department || 'unassigned';
  return {
    actorId,
    action: 'work_order.created',
    entityType: 'work_order',
    entityId: workOrderId,
    detail: {
      external_id: externalId || null,
      order_number: orderNumber || null,
      department: department || null,
      message: `Created in ${queue}`,
    },
  };
}

function transitionEntries({ actorId, previous, next }) {
  const entries = [];
  const from = String(previous?.department || '').trim();
  const to = String(next?.department || '').trim();
  const externalId = next?.external_id || previous?.external_id || null;
  const id = next?.id || previous?.id;
  if (!id) return entries;

  if (from !== to) {
    entries.push({
      actorId,
      action: 'work_order.moved',
      entityType: 'work_order',
      entityId: id,
      detail: {
        external_id: externalId,
        from_department: from || null,
        to_department: to || null,
        message: `Moved to ${to || 'another department'}`,
      },
    });
  }

  if (!isFinishedStatus(previous?.status) && isFinishedStatus(next?.status)) {
    entries.push({
      actorId,
      action: 'work_order.completed',
      entityType: 'work_order',
      entityId: id,
      detail: {
        external_id: externalId,
        department: to || from || null,
        message: 'Completed',
      },
    });
  }

  return entries;
}

function decisionEntry({ actorId, workOrder, decision, note }) {
  const approved = decision === 'approved';
  return {
    actorId,
    action: approved ? 'work_order.approved' : 'work_order.rejected',
    entityType: 'work_order',
    entityId: workOrder.id,
    detail: {
      external_id: workOrder.external_id || null,
      department: workOrder.department || null,
      message: approved ? 'Approved' : 'Rejected',
      note: note || null,
    },
  };
}

function record(actorId, action, entityType, entityId, detail) {
  const db = require('./db');
  return new Promise((resolve, reject) => {
    insertEntries(db, [{
      actorId,
      action,
      entityType,
      entityId,
      detail,
    }], (err) => (err ? reject(err) : resolve()));
  });
}

function recordOn(runner, actorId, action, entityType, entityId, detail) {
  return runner.run(INSERT_SQL, bindParams({
    actorId,
    action,
    entityType,
    entityId,
    detail,
  }));
}

function insertEntries(conn, entries, cb) {
  const pending = entries.slice();
  const step = () => {
    if (!pending.length) return cb(null);
    const entry = pending.shift();
    conn.run(INSERT_SQL, bindParams(entry), (err) => {
      if (err) return cb(err);
      step();
    });
  };
  step();
}

module.exports = {
  INSERT_SQL,
  isFinishedStatus,
  bindParams,
  createdEntry,
  transitionEntries,
  decisionEntry,
  insertEntries,
  record,
  recordOn,
};
