const db = require('./db');
const { withTransaction } = require('./dbAsync');
const { classifyDelivery, getRules } = require('./deliveryRules');
const notifyEmail = require('./notifyEmail');

const DEFAULT_DUE_SOON_MINUTES = 60;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const STAFF_ROLES = new Set(['admin', 'manager', 'operator']);

function dueSoonMinutes() {
  const raw = process.env.DELIVERY_DUE_SOON_MINUTES;
  if (raw != null && String(raw).trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  // Same window as the delivery-list due_soon flag unless minutes are set on their own.
  const fromHours = getRules().dueSoonHours * 60;
  if (Number.isFinite(fromHours) && fromHours >= 0) return fromHours;
  return DEFAULT_DUE_SOON_MINUTES;
}

function notificationRules() {
  const rules = getRules();
  return {
    ...rules,
    dueSoonHours: dueSoonMinutes() / 60,
  };
}

function isStaff(user) {
  return Boolean(user) && STAFF_ROLES.has(user.role);
}

function normalizeStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'complete') return 'completed';
  return normalized;
}

function workOrderLabel(row) {
  if (!row) return 'Work order';
  if (row.external_id) return `Work order ${row.external_id}`;
  return `Work order #${row.id}`;
}

function deliveryLabel(row) {
  const order = row.external_id ? `Work order ${row.external_id}` : `Delivery ${row.id}`;
  return row.carrier ? `${order} (${row.carrier})` : order;
}

function writeNotifications(items, cb) {
  if (!items.length) return cb(null, []);
  withTransaction(async (tx) => {
    const created = [];
    for (const item of items) {
      const inserted = await tx.run(
        `INSERT OR IGNORE INTO notifications
          (type, title, body, customer_id, work_order_id, delivery_id, order_id, dedupe_key)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          item.type,
          item.title,
          item.body,
          item.customerId == null ? null : item.customerId,
          item.workOrderId == null ? null : item.workOrderId,
          item.deliveryId == null ? null : item.deliveryId,
          item.orderId == null ? null : item.orderId,
          item.dedupeKey,
        ]
      );
      if (inserted.changes > 0) {
        created.push({
          id: inserted.lastID,
          type: item.type,
          title: item.title,
          body: item.body,
          customer_id: item.customerId == null ? null : item.customerId,
          work_order_id: item.workOrderId == null ? null : item.workOrderId,
          delivery_id: item.deliveryId == null ? null : item.deliveryId,
          order_id: item.orderId == null ? null : item.orderId,
        });
      }
    }
    return created;
  }).then((created) => {
    for (const stored of created) {
      try {
        notifyEmail.deliver(stored);
      } catch (emailErr) {
        console.error('EMAIL NOTIFICATION ERROR:', emailErr);
      }
    }
    cb(null, created);
  }).catch(cb);
}

function insertNotifications(items, cb) {
  if (!items.length) return cb(null, []);
  db.all(
    `SELECT event_key FROM notification_settings WHERE channel = 'in_app' AND enabled = 0`,
    [],
    (err, rows) => {
      if (err) {
        console.error('NOTIFICATION SETTINGS ERROR:', err);
        return writeNotifications(items, cb);
      }
      const disabled = new Set((rows || []).map((row) => row.event_key));
      writeNotifications(items.filter((item) => !disabled.has(item.type)), cb);
    }
  );
}

function notifyWorkOrderCreated(row, cb) {
  if (!row || !row.id) return cb(null, []);
  const items = [];
  const status = normalizeStatus(row.status);
  const stamp = 'created';
  if (status === 'on-hold') {
    items.push({
      type: 'work_order_on_hold',
      title: 'Work order on hold',
      body: `${workOrderLabel(row)} was put on hold.`,
      customerId: row.customer_id,
      workOrderId: row.id,
      dedupeKey: `work_order_on_hold:${row.id}:${stamp}`,
    });
  }
  if (status === 'completed') {
    items.push({
      type: 'work_order_completed',
      title: 'Work order completed',
      body: `${workOrderLabel(row)} was completed.`,
      customerId: row.customer_id,
      workOrderId: row.id,
      dedupeKey: `work_order_completed:${row.id}:${stamp}`,
    });
  }
  if (row.priority === 'Rush') {
    items.push({
      type: 'work_order_rush',
      title: 'Rush work order created',
      body: `${workOrderLabel(row)} was created with rush priority.`,
      customerId: row.customer_id,
      workOrderId: row.id,
      dedupeKey: `work_order_rush:${row.id}`,
    });
  }
  insertNotifications(items, cb);
}

function notifyWorkOrderUpdated(previous, current, cb) {
  if (!previous || !current || !current.id) return cb(null, []);
  const previousStatus = normalizeStatus(previous.status);
  const nextStatus = normalizeStatus(current.status);
  const stamp = current.updated_at || 'updated';
  const items = [];
  if (previousStatus !== 'on-hold' && nextStatus === 'on-hold') {
    items.push({
      type: 'work_order_on_hold',
      title: 'Work order on hold',
      body: `${workOrderLabel(current)} was put on hold.`,
      customerId: current.customer_id,
      workOrderId: current.id,
      dedupeKey: `work_order_on_hold:${current.id}:${stamp}:${previousStatus}`,
    });
  }
  if (previousStatus !== 'completed' && nextStatus === 'completed') {
    items.push({
      type: 'work_order_completed',
      title: 'Work order completed',
      body: `${workOrderLabel(current)} was completed.`,
      customerId: current.customer_id,
      workOrderId: current.id,
      dedupeKey: `work_order_completed:${current.id}:${stamp}:${previousStatus}`,
    });
  }
  insertNotifications(items, cb);
}

function notifyProofReady(item, cb) {
  if (!item || !item.orderId || !item.proofId) return cb(null, []);
  const orderNumber = item.orderNumber || item.orderId;
  insertNotifications([{
    type: 'proof_ready',
    title: item.title || `New proof for order ${orderNumber}`,
    body: item.body || '',
    customerId: item.customerId,
    workOrderId: item.workOrderId == null ? null : item.workOrderId,
    orderId: item.orderId,
    dedupeKey: `proof_ready:${item.proofId}`,
  }], cb);
}

function notifyProofDecision(item, cb) {
  if (!item || !item.proofId) return cb(null, []);
  insertNotifications([{
    type: 'proof_decision',
    title: item.title || 'Proof decision',
    body: item.body || '',
    customerId: null,
    workOrderId: item.workOrderId == null ? null : item.workOrderId,
    orderId: item.orderId == null ? null : item.orderId,
    dedupeKey: `proof_decision:${item.proofId}:${item.status || 'decision'}`,
  }], cb);
}

function notifyFilesShared(item, cb) {
  if (!item || !item.orderId) return cb(null, []);
  const orderNumber = item.orderNumber || item.orderId;
  insertNotifications([{
    type: 'files_shared',
    title: item.title || `New files for order ${orderNumber}`,
    body: item.body || '',
    customerId: item.customerId,
    workOrderId: item.workOrderId == null ? null : item.workOrderId,
    orderId: item.orderId,
    dedupeKey: `files_shared:${item.orderId}:${item.batchId}`,
  }], cb);
}

function deliveryNotification(row, type) {
  const overdue = type === 'delivery_overdue';
  return {
    type,
    title: overdue ? 'Delivery overdue' : 'Delivery due soon',
    body: overdue
      ? `${deliveryLabel(row)} was due ${row.due_time}.`
      : `${deliveryLabel(row)} is due ${row.due_time}.`,
    customerId: row.customer_id,
    workOrderId: row.work_order_id,
    deliveryId: row.id,
    dedupeKey: `${type}:${row.id}:${row.due_time}`,
  };
}

function checkDeliveryNotifications(now = new Date(), cb) {
  if (typeof now === 'function') {
    cb = now;
    now = new Date();
  }
  const rules = notificationRules();
  db.all(
    `SELECT
       d.id,
       d.work_order_id,
       d.due_time,
       d.carrier,
       d.status,
       d.will_call,
       wo.external_id,
       wo.customer_id
     FROM deliveries d
     LEFT JOIN work_orders wo ON wo.id = d.work_order_id
     WHERE d.due_time IS NOT NULL
       AND trim(d.due_time) != ''
       AND lower(trim(COALESCE(d.status, ''))) != 'complete'`,
    [],
    (err, rows) => {
      if (err) return cb(err);
      const items = [];
      for (const row of rows || []) {
        const flags = classifyDelivery(row, now, rules);
        if (flags.overdue) items.push(deliveryNotification(row, 'delivery_overdue'));
        else if (flags.due_soon) items.push(deliveryNotification(row, 'delivery_due_soon'));
      }
      insertNotifications(items, cb);
    }
  );
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

function parsePositiveId(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function visibility(user) {
  if (isStaff(user)) return { sql: '', params: [] };
  return { sql: 'WHERE n.customer_id = ?', params: [user.userId] };
}

function mapRow(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    customer_id: row.customer_id,
    work_order_id: row.work_order_id,
    delivery_id: row.delivery_id,
    order_id: row.order_id == null ? null : row.order_id,
    created_at: row.created_at,
    read: Boolean(row.is_read),
  };
}

function listNotifications(user, query, cb) {
  const limit = parseLimit(query && query.limit);
  if (limit.error) return cb(Object.assign(new Error(limit.error), { status: 400, publicMessage: limit.error }));
  const offset = parseOffset(query && query.offset);
  if (offset.error) return cb(Object.assign(new Error(offset.error), { status: 400, publicMessage: offset.error }));

  const visible = visibility(user);
  const where = visible.sql;
  const countSql = `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN r.user_id IS NULL THEN 1 ELSE 0 END) AS unread_count
    FROM notifications n
    LEFT JOIN notification_reads r
      ON r.notification_id = n.id AND r.user_id = ?
    ${where}
  `;

  db.get(countSql, [user.userId, ...visible.params], (err, counts) => {
    if (err) return cb(err);
    db.all(
      `SELECT
         n.id,
         n.type,
         n.title,
         n.body,
         n.customer_id,
         n.work_order_id,
         n.delivery_id,
         n.order_id,
         n.created_at,
         CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END AS is_read
       FROM notifications n
       LEFT JOIN notification_reads r
         ON r.notification_id = n.id AND r.user_id = ?
       ${where}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ? OFFSET ?`,
      [user.userId, ...visible.params, limit.value, offset.value],
      (listErr, rows) => {
        if (listErr) return cb(listErr);
        cb(null, {
          notifications: (rows || []).map(mapRow),
          unread_count: counts && counts.unread_count ? counts.unread_count : 0,
          total: counts ? counts.total : 0,
          limit: limit.value,
          offset: offset.value,
        });
      }
    );
  });
}

function findVisible(user, id, cb) {
  const visible = visibility(user);
  const where = visible.sql ? `${visible.sql} AND n.id = ?` : 'WHERE n.id = ?';
  db.get(
    `SELECT n.id FROM notifications n ${where}`,
    [...visible.params, id],
    (err, row) => cb(err, row || null)
  );
}

function markRead(user, id, cb) {
  const notificationId = parsePositiveId(id);
  if (!notificationId) {
    return cb(Object.assign(new Error('id must be a positive integer'), {
      status: 400,
      publicMessage: 'id must be a positive integer',
    }));
  }
  findVisible(user, notificationId, (err, row) => {
    if (err) return cb(err);
    if (!row) {
      return cb(Object.assign(new Error('Notification not found'), {
        status: 404,
        publicMessage: 'Notification not found',
      }));
    }
    withTransaction((tx) => tx.run(
      `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
       VALUES (?, ?, datetime('now'))`,
      [notificationId, user.userId]
    )).then(() => cb(null, { id: notificationId, read: true })).catch(cb);
  });
}

function markAllRead(user, cb) {
  const visible = visibility(user);
  withTransaction((tx) => tx.run(
    `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
     SELECT n.id, ?, datetime('now')
     FROM notifications n
     LEFT JOIN notification_reads r
       ON r.notification_id = n.id AND r.user_id = ?
     ${visible.sql ? `${visible.sql} AND` : 'WHERE'} r.user_id IS NULL`,
    [user.userId, user.userId, ...visible.params]
  )).then((result) => cb(null, { updated: result.changes || 0 })).catch(cb);
}

module.exports = {
  dueSoonMinutes,
  notifyWorkOrderCreated,
  notifyWorkOrderUpdated,
  notifyFilesShared,
  notifyProofReady,
  notifyProofDecision,
  checkDeliveryNotifications,
  listNotifications,
  markRead,
  markAllRead,
};
