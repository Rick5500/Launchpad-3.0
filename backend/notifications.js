const db = require('./db');
const { withTransaction } = require('./dbAsync');
const { classifyDelivery, getRules } = require('./deliveryRules');
const notifyEmail = require('./notifyEmail');
const shopLocations = require('./shopLocations');

const DEFAULT_DUE_SOON_MINUTES = 60;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const STAFF_ROLES = new Set(['admin', 'manager', 'operator']);
const QUOTE_NOTIFICATION_TYPES = ['quote_ready', 'quote_accepted', 'quote_requested', 'quote_declined'];
const MANAGER_ONLY_TYPES = [...QUOTE_NOTIFICATION_TYPES, 'order_created'];

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
          (type, title, body, customer_id, work_order_id, delivery_id, order_id, transfer_id, quote_request_id, location_id, dedupe_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          item.type,
          item.title,
          item.body,
          item.customerId == null ? null : item.customerId,
          item.workOrderId == null ? null : item.workOrderId,
          item.deliveryId == null ? null : item.deliveryId,
          item.orderId == null ? null : item.orderId,
          item.transferId == null ? null : item.transferId,
          item.quoteRequestId == null ? null : item.quoteRequestId,
          item.locationId == null ? null : item.locationId,
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
          transfer_id: item.transferId == null ? null : item.transferId,
          quote_request_id: item.quoteRequestId == null ? null : item.quoteRequestId,
          location_id: item.locationId == null ? null : item.locationId,
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

function notifyPickupRequested(item, cb) {
  if (!item || !item.pickupId) return cb(null, []);
  const who = item.company || item.contactName || 'A customer';
  const order = item.orderNumber ? ` for order ${item.orderNumber}` : '';
  insertNotifications([{
    type: 'pickup_requested',
    title: `Pickup request from ${who}`,
    body: item.body || `${who} asked Dispatch to pick up originals${order}.`,
    customerId: null,
    orderId: item.orderId == null ? null : item.orderId,
    locationId: item.locationId == null ? null : item.locationId,
    dedupeKey: item.dedupeKey || `pickup_requested:${item.pickupId}`,
  }], cb);
}

function notifyOrderCreated(item, cb) {
  if (!item || !item.orderId) return cb(null, []);
  const number = item.orderNumber || item.orderId;
  const company = item.company ? ` from ${item.company}` : '';
  insertNotifications([{
    type: 'order_created',
    title: item.title || `New order ${number}`,
    body: item.body || `Order ${number}${company} was submitted.`,
    customerId: null,
    orderId: item.orderId,
    locationId: item.locationId == null ? null : item.locationId,
    dedupeKey: item.dedupeKey || `order_created:${item.orderId}`,
  }], cb);
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
      locationId: row.location_id == null ? null : row.location_id,
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
      locationId: row.location_id == null ? null : row.location_id,
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
      locationId: row.location_id == null ? null : row.location_id,
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
      locationId: current.location_id == null ? null : current.location_id,
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
      locationId: current.location_id == null ? null : current.location_id,
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
    locationId: item.locationId == null ? null : item.locationId,
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
    locationId: item.locationId == null ? null : item.locationId,
    dedupeKey: `proof_decision:${item.proofId}:${item.status || 'decision'}`,
  }], cb);
}

function notifyQuoteReady(item, cb) {
  if (!item || !item.quoteRequestId) return cb(null, []);
  insertNotifications([{
    type: 'quote_ready',
    title: item.title || 'Your quote is ready',
    body: item.body || '',
    customerId: item.customerId,
    quoteRequestId: item.quoteRequestId,
    locationId: item.locationId == null ? null : item.locationId,
    dedupeKey: item.dedupeKey || `quote_ready:${item.quoteRequestId}`,
  }], cb);
}

function notifyQuoteAccepted(item, cb) {
  if (!item || !item.quoteRequestId) return cb(null, []);
  insertNotifications([{
    type: 'quote_accepted',
    title: item.title || 'Quote accepted',
    body: item.body || '',
    customerId: null,
    quoteRequestId: item.quoteRequestId,
    locationId: item.locationId == null ? null : item.locationId,
    dedupeKey: item.dedupeKey || `quote_accepted:${item.quoteRequestId}`,
  }], cb);
}

function notifyQuoteRequested(item, cb) {
  if (!item || !item.quoteRequestId) return cb(null, []);
  insertNotifications([{
    type: 'quote_requested',
    title: item.title || 'New quote request',
    body: item.body || '',
    customerId: null,
    quoteRequestId: item.quoteRequestId,
    locationId: item.locationId == null ? null : item.locationId,
    dedupeKey: item.dedupeKey || `quote_requested:${item.quoteRequestId}`,
  }], cb);
}

function notifyQuoteDeclined(item, cb) {
  if (!item || !item.quoteRequestId) return cb(null, []);
  insertNotifications([{
    type: 'quote_declined',
    title: item.title || 'Quote declined',
    body: item.body || '',
    customerId: null,
    quoteRequestId: item.quoteRequestId,
    locationId: item.locationId == null ? null : item.locationId,
    dedupeKey: item.dedupeKey || `quote_declined:${item.quoteRequestId}`,
  }], cb);
}

function notifyFilesShared(item, cb) {
  if (!item || (!item.orderId && !item.transferId)) return cb(null, []);
  const orderNumber = item.orderNumber || item.orderId;
  const title = item.title || (item.orderId
    ? `New files for order ${orderNumber}`
    : 'New files from Accent');
  const dedupeKey = item.orderId
    ? `files_shared:${item.orderId}:${item.batchId}`
    : `files_shared:transfer:${item.transferId}`;
  insertNotifications([{
    type: 'files_shared',
    title,
    body: item.body || '',
    customerId: item.customerId,
    workOrderId: item.workOrderId == null ? null : item.workOrderId,
    orderId: item.orderId || null,
    transferId: item.transferId || null,
    locationId: item.locationId == null ? null : item.locationId,
    dedupeKey,
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
    locationId: row.location_id == null ? null : row.location_id,
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
       wo.customer_id,
       COALESCE(o.location_id, wo.location_id) AS location_id
     FROM deliveries d
     LEFT JOIN work_orders wo ON wo.id = d.work_order_id
     LEFT JOIN orders o ON o.id = COALESCE(d.order_id, wo.order_id)
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

function visibility(user, access) {
  if (user && user.role === 'customer') {
    return { sql: 'WHERE n.customer_id = ?', params: [user.userId] };
  }
  const clauses = [];
  const params = [];
  if (user && user.role === 'operator') {
    const placeholders = MANAGER_ONLY_TYPES.map(() => '?').join(', ');
    clauses.push(`n.type NOT IN (${placeholders})`);
    params.push(...MANAGER_ONLY_TYPES);
    // Originals pickups ring for Dispatch at that shop. A blank department
    // still sees every department, matching the production board.
    const department = access && access.department ? String(access.department).trim() : '';
    if (department) {
      clauses.push(`(n.type != 'pickup_requested' OR EXISTS (
        SELECT 1 FROM departments d
        WHERE lower(trim(d.name)) = lower(trim(?))
          AND (
            d.dept_key = 'dispatch'
            OR ((d.dept_key IS NULL OR trim(d.dept_key) = '') AND lower(trim(d.name)) = 'dispatch')
          )
      ))`);
      params.push(department);
    }
  }
  if (access && !shopLocations.seesAll(access) && user && user.role !== 'customer') {
    const pred = shopLocations.predicate('n.location_id', access);
    if (pred.sql) {
      clauses.push(pred.sql);
      params.push(...pred.params);
    }
  }
  if (!clauses.length) return { sql: '', params: [] };
  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
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
    transfer_id: row.transfer_id == null ? null : row.transfer_id,
    quote_request_id: row.quote_request_id == null ? null : row.quote_request_id,
    created_at: row.created_at,
    read: Boolean(row.is_read),
  };
}

function listNotifications(user, query, cb) {
  const limit = parseLimit(query && query.limit);
  if (limit.error) return cb(Object.assign(new Error(limit.error), { status: 400, publicMessage: limit.error }));
  const offset = parseOffset(query && query.offset);
  if (offset.error) return cb(Object.assign(new Error(offset.error), { status: 400, publicMessage: offset.error }));

  shopLocations.loadAccess(user.userId).then((access) => {
  const visible = visibility(user, access);
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
         n.transfer_id,
         n.quote_request_id,
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
  }).catch(cb);
}

function findVisible(user, id, cb) {
  shopLocations.loadAccess(user.userId).then((access) => {
    const visible = visibility(user, access);
    const where = visible.sql ? `${visible.sql} AND n.id = ?` : 'WHERE n.id = ?';
    db.get(
      `SELECT n.id FROM notifications n ${where}`,
      [...visible.params, id],
      (err, row) => cb(err, row || null)
    );
  }).catch(cb);
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
  shopLocations.loadAccess(user.userId).then((access) => {
    const visible = visibility(user, access);
    return withTransaction((tx) => tx.run(
      `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
       SELECT n.id, ?, datetime('now')
       FROM notifications n
       LEFT JOIN notification_reads r
         ON r.notification_id = n.id AND r.user_id = ?
       ${visible.sql ? `${visible.sql} AND` : 'WHERE'} r.user_id IS NULL`,
      [user.userId, user.userId, ...visible.params]
    ));
  }).then((result) => cb(null, { updated: result.changes || 0 })).catch(cb);
}

module.exports = {
  dueSoonMinutes,
  notifyOrderCreated,
  notifyPickupRequested,
  notifyWorkOrderCreated,
  notifyWorkOrderUpdated,
  notifyFilesShared,
  notifyProofReady,
  notifyProofDecision,
  notifyQuoteReady,
  notifyQuoteAccepted,
  notifyQuoteRequested,
  notifyQuoteDeclined,
  checkDeliveryNotifications,
  listNotifications,
  markRead,
  markAllRead,
};
