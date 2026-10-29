// Pickup requests for customer originals. Not a delivery of finished work.
// Customers see and cancel only their own rows. Staff follow location scope:
// an operator sees one shop, a manager with no shop and an admin see every shop.

const { get, all, run, withTransaction } = require('./dbAsync');
const { httpError } = require('./httpError');
const { parseText, parsePostalAddress } = require('./fields');
const activityLog = require('./activityLog');
const originalsHold = require('./originalsHold');
const mailer = require('./mailer');
const notifications = require('./notifications');
const shopLocations = require('./shopLocations');
const { loadLetterhead, letterheadFromMap } = require('./shopProfile');
const { afterResponse } = require('./afterResponse');
const mailOutbox = require('./mailOutbox');

const ORIGINALS_VEHICLE = 'Send a vehicle to pick up originals';
const STATUSES = Object.freeze(['new', 'scheduled', 'picked_up', 'cancelled']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parsePositive(value, field) {
  if (value == null || value === '') return { value: null };
  const text = String(value).trim();
  if (!/^[1-9]\d*$/.test(text)) return { error: `${field} must be a positive integer` };
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return { error: `${field} must be a positive integer` };
  return { value: parsed };
}

function parsePhone(value) {
  const parsed = parseText(value, 'contact_phone', { required: true, max: 40 });
  if (parsed.error) return parsed;
  if (!/\d/.test(parsed.value)) return { error: 'contact_phone is invalid' };
  return parsed;
}

function parseReadyDate(value) {
  if (typeof value !== 'string') return { error: 'ready_date is required' };
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return { error: 'ready_date must be YYYY-MM-DD' };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100) return { error: 'ready_date is out of range' };
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return { error: 'ready_date is invalid' };
  }
  return { value: text };
}

function parseReadyTime(value) {
  if (value == null || String(value).trim() === '') return { value: null };
  if (typeof value !== 'string' && typeof value !== 'number') return { error: 'ready_time must be HH:MM' };
  const text = String(value).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return { error: 'ready_time must be HH:MM' };
  return { value: text };
}

function clockText(value) {
  if (value == null || String(value).trim() === '') return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value).trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseStatus(value) {
  if (typeof value !== 'string') return { error: 'status must be new, scheduled, picked_up, or cancelled' };
  const status = value.trim().toLowerCase();
  if (!STATUSES.includes(status)) return { error: 'status must be new, scheduled, picked_up, or cancelled' };
  return { value: status };
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
  if (!Number.isInteger(parsed) || parsed < 0) return { error: 'offset must be an integer of 0 or greater' };
  return { value: parsed };
}

function present(row) {
  if (!row) return null;
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer_name: row.customer_name || null,
    company: row.customer_company || row.company || null,
    location_id: row.location_id == null ? null : row.location_id,
    location_name: row.location_name || null,
    order_id: row.order_id == null ? null : row.order_id,
    order_number: row.order_number || null,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
    address_line1: row.address_line1,
    address_line2: row.address_line2 || null,
    city: row.city,
    state: row.state,
    zip: row.zip,
    ready_date: row.ready_date,
    ready_time: row.ready_time || null,
    notes: row.notes || null,
    status: row.status,
    source: row.source || 'customer',
    created_at: row.created_at,
    updated_at: row.updated_at || null,
  };
}

const SELECT_SQL = `
  SELECT p.*,
         u.display_name AS customer_name,
         u.company AS customer_company,
         u.email AS account_email,
         loc.name AS location_name,
         o.order_number,
         o.email AS order_email
  FROM pickup_requests p
  LEFT JOIN users u ON u.id = p.customer_id
  LEFT JOIN locations loc ON loc.id = p.location_id
  LEFT JOIN orders o ON o.id = p.order_id
`;

async function loadRow(id) {
  return get(`${SELECT_SQL} WHERE p.id = ?`, [id]);
}

function customerEmail(row) {
  const candidates = [row && row.order_email, row && row.account_email, row && row.email];
  for (const candidate of candidates) {
    const parsed = mailer.parseAddressList(candidate, { max: 1, field: 'email' });
    if (!parsed.error && parsed.value && parsed.value.length === 1) return parsed.value[0];
  }
  return null;
}

function publicEmail(result) {
  const notice = { status: result && result.status ? result.status : 'failed' };
  if (process.env.NODE_ENV === 'test' && result && result.preview) notice.preview = result.preview;
  return notice;
}

const mailOutcomes = new Map();

function noteMail(requestId, email) {
  const id = Number(requestId);
  if (!Number.isInteger(id)) return;
  mailOutcomes.set(id, email);
}

function mailFor(requestId) {
  return mailOutcomes.get(Number(requestId)) || null;
}

function withMail(row) {
  const body = present(row);
  const mail = mailFor(row && row.id);
  if (!mail) return body;
  const decorated = { ...body, email_status: mail.status };
  if (mail.preview) decorated.preview = mail.preview;
  return decorated;
}

function pickupKey(orderId) {
  return {
    scope: 'order',
    orderId,
    channel: 'email',
    noticeType: 'pickup_request',
  };
}

async function sendConfirmation(row, options = {}) {
  const key = row && row.order_id ? pickupKey(row.order_id) : null;
  const nested = Boolean(options.held);
  if (key && !nested && !mailOutbox.reserve(key)) return { status: 'skipped', leased: true };
  let owned = false;
  let result = { status: 'skipped', leased: true };
  try {
    if (key) {
      const gate = await mailOutbox.acquire(key);
      if (gate === 'leased') return result;
      owned = gate === 'owned';
    }
    result = await sendConfirmationNow(row);
    return result;
  } finally {
    try {
      if (owned && key) {
        if (mailOutbox.deliverySettled(result)) await mailOutbox.completeMatching(key);
        else await mailOutbox.releaseMatching(key);
      }
    } catch (err) {
      console.error('MAIL OUTBOX ERROR:', err && err.message ? err.message : 'failed');
    } finally {
      if (key && !nested) mailOutbox.release(key);
    }
  }
}

async function sendQueuedConfirmation(orderId) {
  const key = pickupKey(orderId);
  if (mailOutbox.isSending(key)) return { status: 'skipped', leased: true };
  await run(
    `UPDATE pickup_requests
     SET confirmation_email_status = NULL
     WHERE order_id = ?
       AND confirmation_email_sent_at IS NULL
       AND confirmation_email_status = 'pending'`,
    [orderId]
  );
  const existing = await get(
    `SELECT id FROM pickup_requests
     WHERE order_id = ? AND source = 'order'
     ORDER BY id DESC
     LIMIT 1`,
    [orderId]
  );
  if (!existing) return { status: 'skipped' };
  const row = await loadRow(existing.id);
  if (!row) return { status: 'skipped' };
  return sendConfirmation(row);
}

async function sendConfirmationNow(row) {
  const claimed = await run(
    `UPDATE pickup_requests
     SET confirmation_email_status = 'pending'
     WHERE id = ?
       AND confirmation_email_sent_at IS NULL
       AND COALESCE(confirmation_email_status, '') != 'pending'`,
    [row.id]
  );
  if (!claimed.changes) {
    const current = await get(
      `SELECT confirmation_email_sent_at FROM pickup_requests WHERE id = ?`,
      [row.id]
    );
    if (current && current.confirmation_email_sent_at) return { status: 'sent', skipped: true };
    return { status: 'skipped', leased: true };
  }
  const to = customerEmail(row);
  if (!to) {
    await run(`UPDATE pickup_requests SET confirmation_email_status = 'skipped' WHERE id = ?`, [row.id]);
    return { status: 'skipped' };
  }
  let letterhead;
  try {
    letterhead = await loadLetterhead();
  } catch (err) {
    letterhead = letterheadFromMap({});
  }
  const address = [row.address_line1, row.address_line2, [row.city, row.state, row.zip].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join('\n');
  const rendered = mailer.renderPickupRequestEmail({
    letterhead,
    contactName: row.contact_name,
    readyDate: row.ready_date,
    readyTime: row.ready_time,
    address,
    locationName: row.location_name,
    orderNumber: row.order_number,
    notes: row.notes,
    link: mailer.appLink('/pickups'),
  });
  const sent = await mailer.deliver({
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    noticeType: 'pickup_request',
  });
  const status = sent && sent.status ? sent.status : 'failed';
  const customerNotices = require('./customerNotices');
  await customerNotices.recordOrderNotice({
    orderId: row.order_id,
    channel: 'email',
    noticeType: 'pickup_request',
    recipient: to,
    result: status,
  });
  if (status === 'sent') {
    await run(
      `UPDATE pickup_requests
       SET confirmation_email_sent_at = ?, confirmation_email_status = 'sent'
       WHERE id = ?`,
      [new Date().toISOString().slice(0, 19).replace('T', ' '), row.id]
    );
  } else {
    await run(`UPDATE pickup_requests SET confirmation_email_status = ? WHERE id = ?`, [status, row.id]);
  }
  const result = { status, to };
  if (process.env.NODE_ENV === 'test' && sent && sent.captured) result.preview = mailer.previewFrom(sent.captured);
  return result;
}

function notifyStaff(row) {
  return new Promise((resolve) => {
    notifications.notifyPickupRequested({
      pickupId: row.id,
      locationId: row.location_id,
      company: row.customer_company || row.company,
      contactName: row.contact_name,
      orderNumber: row.order_number,
    }, () => resolve());
  });
}

let beforeSendForTest = null;

function setBeforeSendForTest(fn) {
  if (process.env.NODE_ENV === 'test') beforeSendForTest = fn;
}

async function insertRequest(fields, options = {}) {
  const key = fields.orderId ? pickupKey(fields.orderId) : null;
  const held = key ? mailOutbox.reserve(key) : false;
  let handoff = false;
  let inserted;
  try {
    inserted = await withTransaction(async (tx) => {
    const result = await tx.run(
      `INSERT INTO pickup_requests (
         customer_id, location_id, order_id, contact_name, contact_phone,
         address_line1, address_line2, city, state, zip,
         ready_date, ready_time, notes, status, source, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,datetime('now'))`,
      [
        fields.customerId,
        fields.locationId,
        fields.orderId,
        fields.contactName,
        fields.contactPhone,
        fields.addressLine1,
        fields.addressLine2,
        fields.city,
        fields.state,
        fields.zip,
        fields.readyDate,
        fields.readyTime,
        fields.notes,
        fields.source,
      ]
    );
    await activityLog.recordOn(tx, fields.actorId, 'pickup_request.created', 'pickup_request', result.lastID, {
      customer_id: fields.customerId,
      location_id: fields.locationId,
      order_id: fields.orderId,
      source: fields.source,
      message: fields.orderNumber
        ? `Pickup request for originals on order ${fields.orderNumber}`
        : 'Pickup request for customer originals',
    });
    if (fields.orderId) {
      await mailOutbox.enqueue({
        scope: 'order',
        orderId: fields.orderId,
        channel: 'email',
        noticeType: 'pickup_request',
      }, tx);
    }
    return result.lastID;
    });
    const row = await loadRow(inserted);
    try {
      await notifyStaff(row);
    } catch (err) {
      console.error('PICKUP REQUEST NOTIFY ERROR:', err && err.message ? err.message : 'failed');
    }
    if (beforeSendForTest) await beforeSendForTest(row);
    if (options.deferMail) {
      handoff = true;
      afterResponse('PICKUP REQUEST EMAIL', async () => {
        let email = { status: 'failed' };
        try {
          email = await sendConfirmation(row, { held });
        } catch (err) {
          console.error('PICKUP REQUEST EMAIL ERROR:', err && err.message ? err.message : 'failed');
        }
        noteMail(row.id, publicEmail(email));
        if (held && key) mailOutbox.release(key);
      });
      return { pickup_request: present(row), email: { status: 'pending' } };
    }
    let email = { status: 'failed' };
    try {
      email = await sendConfirmation(row, { held });
    } catch (err) {
      console.error('PICKUP REQUEST EMAIL ERROR:', err && err.message ? err.message : 'failed');
      email = { status: 'failed' };
    }
    const notice = publicEmail(email);
    noteMail(row.id, notice);
    return { pickup_request: present(await loadRow(inserted)), email: notice };
  } finally {
    if (held && key && !handoff) mailOutbox.release(key);
  }
}

async function createFromOrder(orderId) {
  try {
    const order = await get(
      `SELECT o.id, o.order_number, o.customer_id, o.location_id, o.contact_name, o.phone, o.email,
              o.address_line1, o.address_line2, o.city, o.state, o.zip, o.due_date, o.due_time, o.notes,
              o.originals_source, o.company
       FROM orders o
       WHERE o.id = ?`,
      [orderId]
    );
    if (!order || order.originals_source !== ORIGINALS_VEHICLE) return null;
    const existing = await get(
      `SELECT id FROM pickup_requests WHERE order_id = ? AND source = 'order'`,
      [orderId]
    );
    if (existing) {
      const row = await loadRow(existing.id);
      return { pickup_request: present(row), email: { status: 'skipped' }, skipped: true };
    }
    if (!order.address_line1 || !order.city || !order.state || !order.zip || !order.contact_name || !order.phone) {
      return null;
    }
    return insertRequest({
      customerId: order.customer_id,
      locationId: order.location_id,
      orderId: order.id,
      contactName: order.contact_name,
      contactPhone: order.phone,
      addressLine1: order.address_line1,
      addressLine2: order.address_line2,
      city: order.city,
      state: order.state,
      zip: order.zip,
      readyDate: order.due_date,
      readyTime: clockText(order.due_time),
      notes: order.notes
        ? `Originals for order ${order.order_number}\n${order.notes}`
        : `Originals for order ${order.order_number}`,
      source: 'order',
      actorId: order.customer_id,
      orderNumber: order.order_number,
    }, { deferMail: true });
  } catch (err) {
    console.error('PICKUP REQUEST ERROR:', err && err.message ? err.message : 'failed');
    return { email: { status: 'failed' }, failed: true };
  }
}

function parseCreate(body) {
  const source = body || {};
  const contact = parseText(source.contact_name, 'contact_name', { required: true, max: 160 });
  if (contact.error) return contact;
  const phone = parsePhone(source.contact_phone);
  if (phone.error) return phone;
  const address = parsePostalAddress(source, true);
  if (address.error) return address;
  const readyDate = parseReadyDate(source.ready_date);
  if (readyDate.error) return readyDate;
  const readyTime = parseReadyTime(source.ready_time);
  if (readyTime.error) return readyTime;
  const notes = parseText(source.notes, 'notes', { max: 2000, allowNewlines: true });
  if (notes.error) return notes;
  const location = parsePositive(source.location_id, 'location_id');
  if (location.error) return location;
  const order = parsePositive(source.order_id, 'order_id');
  if (order.error) return order;
  return {
    value: {
      contactName: contact.value,
      contactPhone: phone.value,
      address: address.value,
      readyDate: readyDate.value,
      readyTime: readyTime.value,
      notes: notes.value,
      locationId: location.value,
      orderId: order.value,
    },
  };
}

async function createForCustomer(user, body) {
  if (!user || user.role !== 'customer') throw httpError(403, 'Only a customer can request a pickup');
  const parsed = parseCreate(body);
  if (parsed.error) throw httpError(400, parsed.error);
  const fields = parsed.value;
  const access = await shopLocations.loadAccess(Number(user.userId || user.id));
  const locationValue = fields.locationId == null ? access.location_id : fields.locationId;
  const resolved = await shopLocations.resolveLocationId({ get }, locationValue, { required: true, activeOnly: true });
  if (resolved.error) throw httpError(400, resolved.error);
  if (fields.orderId) {
    const order = await get(`SELECT id, customer_id FROM orders WHERE id = ?`, [fields.orderId]);
    if (!order || Number(order.customer_id) !== Number(user.userId || user.id)) {
      throw httpError(404, 'Order not found');
    }
  }
  return insertRequest({
    customerId: Number(user.userId || user.id),
    locationId: resolved.value,
    orderId: fields.orderId,
    contactName: fields.contactName,
    contactPhone: fields.contactPhone,
    addressLine1: fields.address.addressLine1,
    addressLine2: fields.address.addressLine2,
    city: fields.address.city,
    state: fields.address.state,
    zip: fields.address.zip,
    readyDate: fields.readyDate,
    readyTime: fields.readyTime,
    notes: fields.notes,
    source: 'customer',
    actorId: Number(user.userId || user.id),
    orderNumber: null,
  });
}

async function visibleRow(user, id) {
  const parsed = parsePositive(id, 'id');
  if (parsed.error || !parsed.value) throw httpError(400, 'id must be a positive integer');
  const row = await loadRow(parsed.value);
  if (!row) return null;
  if (user.role === 'customer') {
    if (Number(row.customer_id) !== Number(user.userId || user.id)) return null;
    return row;
  }
  if (!['admin', 'manager', 'operator'].includes(user.role)) return null;
  const access = await shopLocations.loadAccess(Number(user.userId || user.id));
  if (!shopLocations.matches(access, row.location_id)) return null;
  return row;
}

async function getOne(user, id) {
  const row = await visibleRow(user, id);
  if (!row) throw httpError(404, 'Pickup request not found');
  return withMail(row);
}

async function list(user, query) {
  const limit = parseLimit(query && query.limit);
  if (limit.error) throw httpError(400, limit.error);
  const offset = parseOffset(query && query.offset);
  if (offset.error) throw httpError(400, offset.error);
  const clauses = [];
  const params = [];
  if (!user) throw httpError(401, 'Sign in required');
  if (user.role === 'customer') {
    clauses.push('p.customer_id = ?');
    params.push(Number(user.userId || user.id));
  } else if (['admin', 'manager', 'operator'].includes(user.role)) {
    const access = await shopLocations.loadAccess(Number(user.userId || user.id));
    const locked = shopLocations.predicate('p.location_id', access);
    if (locked.sql) {
      clauses.push(locked.sql);
      params.push(...locked.params);
    }
  } else {
    throw httpError(403, 'Forbidden');
  }
  if (query && query.status) {
    const status = parseStatus(query.status);
    if (status.error) throw httpError(400, status.error);
    clauses.push('p.status = ?');
    params.push(status.value);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const count = await get(`SELECT COUNT(*) AS count FROM pickup_requests p ${where}`, params);
  const rows = await all(
    `${SELECT_SQL} ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    [...params, limit.value, offset.value]
  );
  return {
    pickup_requests: rows.map(present),
    total: count ? count.count : 0,
    limit: limit.value,
    offset: offset.value,
  };
}

async function updateStatus(user, id, body) {
  const row = await visibleRow(user, id);
  if (!row) throw httpError(404, 'Pickup request not found');
  const requested = body && body.status;
  if (user.role === 'customer') {
    const status = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
    if (status !== 'cancelled') throw httpError(403, 'You can only cancel your own pickup request');
    if (row.status === 'picked_up' || row.status === 'cancelled') {
      throw httpError(400, 'This pickup can no longer be cancelled');
    }
    const updated = await withTransaction(async (tx) => {
      const result = await tx.run(
        `UPDATE pickup_requests
         SET status = 'cancelled', updated_at = datetime('now')
         WHERE id = ? AND customer_id = ? AND status IN ('new', 'scheduled')`,
        [row.id, Number(user.userId || user.id)]
      );
      if (!result.changes) return 0;
      await activityLog.recordOn(tx, Number(user.userId || user.id), 'pickup_request.cancelled', 'pickup_request', row.id, {
        message: 'Customer cancelled a pickup request',
      });
      await originalsHold.releaseOriginalsHold(tx, row.order_id, user, 'pickup cancelled');
      return result.changes;
    });
    if (!updated) throw httpError(400, 'This pickup can no longer be cancelled');
    return present(await loadRow(row.id));
  }
  const status = parseStatus(requested);
  if (status.error) throw httpError(400, status.error);
  await withTransaction(async (tx) => {
    await tx.run(
      `UPDATE pickup_requests SET status = ?, updated_at = datetime('now') WHERE id = ?`,
      [status.value, row.id]
    );
    await activityLog.recordOn(tx, Number(user.userId || user.id), 'pickup_request.updated', 'pickup_request', row.id, {
      status: status.value,
      message: `Pickup request marked ${status.value.replace(/_/g, ' ')}`,
    });
    if (status.value === 'picked_up' || status.value === 'cancelled') {
      await originalsHold.releaseOriginalsHold(
        tx,
        row.order_id,
        user,
        status.value === 'cancelled' ? 'pickup cancelled' : null
      );
    }
  });
  return present(await loadRow(row.id));
}

module.exports = {
  ORIGINALS_VEHICLE,
  STATUSES,
  createFromOrder,
  createForCustomer,
  list,
  getOne,
  updateStatus,
  present,
  sendQueuedConfirmation,
  setBeforeSendForTest,
};
