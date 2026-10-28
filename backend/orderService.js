const db = require('./db');
const { withTransaction } = require('./dbAsync');
const {
  businessToday,
  validateOrderDue,
  retiredDeliveryMethod,
  retiredDeliveryMessage,
  isUpsMethod,
  usesWillCallHours,
  parseUpsAccountNumber,
  willCallWindow,
  deliveryWindow,
  windowSummary,
  hoursLabel,
} = require('./deliveryRules');
const activityLog = require('./activityLog');
const quotes = require('./quotes');
const shopLocations = require('./shopLocations');
const notifications = require('./notifications');
const pickupNotify = require('./pickupNotify');
const orderConfirm = require('./orderConfirm');
const { afterResponse, holdSideEffects } = require('./afterResponse');
const pickupRequests = require('./pickupRequests');
const { parsePostalAddress } = require('./fields');
const {
  PAYMENT_METHODS,
  PAYMENT_UNSPECIFIED,
  RETURN_TO_ME,
  RETURN_SEE_SHIP,
  RETURN_UNSPECIFIED,
  validateLineFields,
  displayFieldList,
  describeLine,
  mirrorLegacy,
  methodFromVia,
  readFieldValues,
  presentField,
} = require('./serviceFields');

const CONTROL_CHARS = /[\u0000-\u001F]/;
const CONTROL_CHARS_ALLOW_NEWLINES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

const FINISHING_OPTIONS = Object.freeze([
  'None',
  'Grommets',
  'Easel',
  'Cut/Trim',
  'Velcro',
  'Print Hanger',
  'Framing',
  'See Notes',
]);

const ORIGINALS_SOURCES = Object.freeze([
  'Files attached below',
  'Archived files at Accent Imaging',
  'Send a vehicle to pick up originals',
  'Hardcopy or digital media provided',
]);

const ORIGINALS_FILES = 'Files attached below';
const ORIGINALS_UNSPECIFIED = 'Not specified';
const ARCHIVE_SERVICE = 'Archive File Request';
const SHIP_TO_SERVICE = 'Ship To (3rd Party)';

const CUSTOMER_FORBIDDEN_FIELDS = [
  'status',
  'priority',
  'stage_id',
  'assigned_department_id',
  'assigned_user_id',
  'estimated_hours',
  'actual_hours',
  'department',
  'external_id',
  'approval_status',
  'requires_approval',
  'next_department',
  'routing_instructions',
  'production_line',
  'specifications',
  'attachments',
  'order_number',
  'work_orders',
];

class OrderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function runOn(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getOn(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function allOn(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function parsePositive(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) return null;
    return value;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function assertPlainText(text, field, allowNewlines) {
  const pattern = allowNewlines ? CONTROL_CHARS_ALLOW_NEWLINES : CONTROL_CHARS;
  if (pattern.test(text)) throw new OrderError(`${field} contains invalid characters`);
}

function requiredText(value, field, max, options = {}) {
  if (value == null || (typeof value !== 'string' && typeof value !== 'number')) {
    throw new OrderError(`${field} is required`);
  }
  const text = String(value).trim();
  if (!text) throw new OrderError(`${field} is required`);
  if (text.length > max) throw new OrderError(`${field} must be ${max} characters or fewer`);
  assertPlainText(text, field, options.allowNewlines);
  return text;
}

function optionalText(value, field, max, options = {}) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new OrderError(`${field} is invalid`);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new OrderError(`${field} must be ${max} characters or fewer`);
  assertPlainText(text, field, options.allowNewlines);
  return text;
}

function parseFinishing(value, field) {
  if (value == null || value === '') return null;
  const text = requiredText(value, field, 80);
  if (!FINISHING_OPTIONS.includes(text)) {
    throw new OrderError(`${field} must be one of ${FINISHING_OPTIONS.join(', ')}`);
  }
  return text === 'None' ? null : text;
}

function parseOriginalsSource(value) {
  const text = requiredText(value, 'originals_source', 80);
  if (!ORIGINALS_SOURCES.includes(text)) {
    throw new OrderError(`originals_source must be one of ${ORIGINALS_SOURCES.join(', ')}`);
  }
  return text;
}

function originalsLabel(value) {
  const text = value == null ? '' : String(value).trim();
  return text || ORIGINALS_UNSPECIFIED;
}

function emptyServiceMessage(service, lineItems, notes, shipTo) {
  const count = lineItems.filter((item) => item.serviceId === service.id).length;
  if (count > 0) return null;
  if (service.name === ARCHIVE_SERVICE) {
    if (notes) return null;
    return 'Archive File Request is empty. Add a line, describe the archived files in Notes, or deselect it.';
  }
  if (service.name === SHIP_TO_SERVICE) {
    if (shipTo) return null;
    return 'Ship To (3rd Party) is empty. Add a line, fill in Ship To, or deselect it.';
  }
  return `${service.name} is empty. Please add lines or deselect it.`;
}

function requireAddress(payload) {
  const parsed = parsePostalAddress(payload, true);
  if (parsed.error) throw new OrderError(parsed.error);
  return parsed.value;
}

function requiredEmail(value) {
  const email = requiredText(value, 'email', 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OrderError('email is invalid');
  return email;
}

function requiredPhone(value) {
  const phone = requiredText(value, 'phone', 40);
  if (!/\d/.test(phone)) throw new OrderError('phone is invalid');
  return phone;
}

function parseYesNo(value, field) {
  if (value == null || value === '' || value === false || value === 0 || value === '0' || value === 'no' || value === 'No' || value === 'false') {
    return 0;
  }
  if (value === true || value === 1 || value === '1' || value === 'yes' || value === 'Yes' || value === 'true') {
    return 1;
  }
  throw new OrderError(`${field} must be yes or no`);
}

function formatOrderNumber(dateKey, sequence) {
  const width = Math.max(3, String(sequence).length);
  return `${dateKey}-${String(sequence).padStart(width, '0')}`;
}

function suffixForIndex(index) {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    n -= 1;
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26);
  }
  return label;
}

function suffixForService(service, index) {
  const mode = String(service.suffix_mode || 'sequence').trim().toLowerCase();
  if (mode === 'code') {
    const code = String(service.code || '').trim();
    if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
      throw new OrderError(`Service ${service.name} has no code for its work order suffix`);
    }
    return code;
  }
  return suffixForIndex(index);
}

function suffixesFor(services) {
  const suffixes = services.map((service, index) => suffixForService(service, index));
  const keys = suffixes.map((suffix) => suffix.toLowerCase());
  if (new Set(keys).size !== keys.length) {
    throw new OrderError('Work order suffixes must be unique. Adjust service codes or suffix mode.');
  }
  return suffixes;
}

function leadingQuantity(value) {
  const match = /^(\d+)/.exec(String(value || '').trim());
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function yesNoLabel(value) {
  return value ? 'Yes' : 'No';
}

const LEGACY_SPEC_COVER = {
  size: 'Size',
  sets: 'Quantity',
  copies: 'Quantity',
  qty: 'Quantity',
  quantity: 'Quantity',
  media: 'Media',
  material: 'Media',
  process: 'Color',
  ink: 'Color',
  binding: 'Binding / Finish',
  mount: 'Mounting',
  laminate: 'Lamination',
  finishing: 'Finishing',
};

function specificationText(items, notes) {
  const blocks = (items || []).map((item, index) => {
    const title = items.length > 1 ? `Item ${index + 1}: ${item.description}` : item.description;
    const dynamic = (item.fields || []).map((field) => `${field.label}: ${field.display || '—'}`);
    const lines = dynamic.length ? dynamic : [
      `Size: ${item.size || '—'}`,
      `Quantity: ${item.quantity || '—'}`,
      `Media: ${item.media || '—'}`,
      `Color: ${item.color || '—'}`,
      `Binding / Finish: ${item.bindingFinish || item.binding_finish || '—'}`,
      `Mounting: ${item.mountLabel || yesNoLabel(item.mount)}`,
      `Lamination: ${item.laminateLabel || yesNoLabel(item.laminate)}`,
      `Finishing: ${item.finishing || 'None'}`,
    ];
    return [title, ...lines].join('\n');
  });
  if (notes) blocks.push(`Special Instructions: ${notes}`);
  return blocks.length ? blocks.join('\n\n') : null;
}

function assertCustomerFields(user, body) {
  if (user.role !== 'customer') return;
  const present = CUSTOMER_FORBIDDEN_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (present.length) {
    throw new OrderError(`Customers cannot set internal fields: ${present.join(', ')}`);
  }
}

function customerIdFor(user, body) {
  if (user.role === 'customer') {
    if (body.customer_id != null && String(body.customer_id).trim() !== '' && Number(body.customer_id) !== Number(user.userId || user.id)) {
      throw new OrderError('Customers cannot create orders for another customer', 403);
    }
    return Number(user.userId || user.id);
  }
  const customerId = parsePositive(body.customer_id);
  if (!customerId) throw new OrderError('customer_id is required');
  return customerId;
}

function parseServiceIds(body) {
  if (!Array.isArray(body.service_ids) || body.service_ids.length === 0) {
    throw new OrderError('Select at least one service');
  }
  if (body.service_ids.length > 30) throw new OrderError('Too many services');
  const ids = body.service_ids.map((value) => {
    const parsed = parsePositive(value);
    if (!parsed) throw new OrderError('service_ids must be positive integers');
    return parsed;
  });
  if (new Set(ids).size !== ids.length) throw new OrderError('Duplicate services are not allowed');
  return ids;
}

function parseLineItems(body, serviceIds) {
  if (body.line_items == null) return [];
  if (!Array.isArray(body.line_items)) throw new OrderError('line_items must be an array');
  if (body.line_items.length > 50) throw new OrderError('Too many line items');
  const selected = new Set(serviceIds);
  return body.line_items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OrderError(`line item ${index + 1} is invalid`);
    }
    let serviceId = null;
    if (item.service_id != null && item.service_id !== '') {
      serviceId = parsePositive(item.service_id);
      if (!serviceId || !selected.has(serviceId)) {
        throw new OrderError(`line item ${index + 1} service must be one of the selected services`);
      }
    } else if (serviceIds.length === 1) {
      serviceId = serviceIds[0];
    } else {
      throw new OrderError(`line item ${index + 1} must include a service when more than one service is selected`);
    }
    const fileIds = [];
    if (item.file_ids != null) {
      if (!Array.isArray(item.file_ids)) throw new OrderError(`line item ${index + 1} file_ids must be an array`);
      for (const fileId of item.file_ids) {
        const parsed = parsePositive(fileId);
        if (!parsed) throw new OrderError(`line item ${index + 1} has an invalid file id`);
        fileIds.push(parsed);
      }
    }
    const rawFields = parseRawFields(item.field_values, index + 1);
    const description = item.description == null || String(item.description).trim() === ''
      ? null
      : requiredText(item.description, `line item ${index + 1} description`, 200);
    return {
      lineNumber: index + 1,
      serviceId,
      description,
      size: optionalText(item.size, `line item ${index + 1} size`, 80),
      quantity: optionalText(item.quantity, `line item ${index + 1} quantity`, 40),
      media: optionalText(item.media, `line item ${index + 1} media`, 80),
      color: optionalText(item.color, `line item ${index + 1} color`, 80),
      bindingFinish: optionalText(item.binding_finish, `line item ${index + 1} binding/finish`, 80),
      finishing: Object.prototype.hasOwnProperty.call(rawFields, 'finishing')
        ? null
        : parseFinishing(item.finishing, `line item ${index + 1} finishing`),
      mount: parseYesNo(item.mount, `line item ${index + 1} mount`),
      laminate: parseYesNo(item.laminate, `line item ${index + 1} laminate`),
      rawFields,
      fileIds,
    };
  });
}

function parseRawFields(value, lineNumber) {
  if (value == null || value === '') return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new OrderError(`line item ${lineNumber} field_values must be an object`);
  }
  const raw = {};
  for (const key of Object.keys(value)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) {
      throw new OrderError(`line item ${lineNumber} field ${key} is invalid`);
    }
    raw[key] = value[key];
  }
  return raw;
}

async function applyServiceFields(tx, lineItems, services) {
  const ids = services.map((service) => service.id);
  const rows = ids.length
    ? await tx.all(
      `SELECT id, service_id, key, label, type, options_json, required, sort_order, is_active
       FROM service_fields
       WHERE service_id IN (${ids.map(() => '?').join(', ')})
       ORDER BY sort_order, id`,
      ids
    )
    : [];
  const byService = new Map();
  for (const row of rows) {
    if (!byService.has(row.service_id)) byService.set(row.service_id, []);
    byService.get(row.service_id).push(row);
  }
  for (const item of lineItems) {
    const definitions = byService.get(item.serviceId) || [];
    const parsed = validateLineFields(definitions, item.rawFields, `line item ${item.lineNumber}`);
    if (parsed.error) throw new OrderError(parsed.error);
    const mirrored = mirrorLegacy(parsed.value, item);
    item.size = mirrored.size;
    item.quantity = mirrored.quantity;
    item.media = mirrored.media;
    item.color = mirrored.color;
    item.bindingFinish = mirrored.bindingFinish;
    item.finishing = mirrored.finishing;
    item.mount = mirrored.mount;
    item.laminate = mirrored.laminate;
    item.fieldValues = parsed.value;
    item.fields = displayFieldList(definitions, parsed.value);
    item.mountLabel = Object.prototype.hasOwnProperty.call(parsed.value, 'mount')
      ? String(parsed.value.mount)
      : yesNoLabel(item.mount);
    item.laminateLabel = Object.prototype.hasOwnProperty.call(parsed.value, 'laminate')
      ? String(parsed.value.laminate)
      : yesNoLabel(item.laminate);
    item.description = describeLine(definitions, parsed.value, item.description);
    item.fieldValuesJson = JSON.stringify(parsed.value);
  }
}

function parsePaymentMethod(value) {
  const text = requiredText(value, 'payment_method', 40);
  if (!PAYMENT_METHODS.includes(text)) {
    throw new OrderError(`payment_method must be one of ${PAYMENT_METHODS.join(', ')}`);
  }
  return text;
}

function parseReturnTo(value, shipSelected) {
  if (value == null || String(value).trim() === '') {
    return shipSelected ? RETURN_SEE_SHIP : RETURN_TO_ME;
  }
  const text = requiredText(value, 'return_to', 20);
  if (text !== RETURN_TO_ME && text !== RETURN_SEE_SHIP) {
    throw new OrderError(`return_to must be ${RETURN_TO_ME} or ${RETURN_SEE_SHIP}`);
  }
  if (text === RETURN_SEE_SHIP && !shipSelected) {
    throw new OrderError('return_to See ShipTo requires the Ship To (3rd Party) service');
  }
  return text;
}

function billToError(message) {
  return String(message)
    .replace(/^address_line1/, 'bill_to_address_line1')
    .replace(/^address_line2/, 'bill_to_address_line2')
    .replace(/^city/, 'bill_to_city')
    .replace(/^state/, 'bill_to_state')
    .replace(/^zip/, 'bill_to_zip');
}

function parseBillTo(payload) {
  const name = optionalText(payload.bill_to_name, 'bill_to_name', 160);
  const phone = optionalText(payload.bill_to_phone, 'bill_to_phone', 40);
  if (phone && !/\d/.test(phone)) throw new OrderError('bill_to_phone is invalid');
  let email = null;
  if (payload.bill_to_email != null && String(payload.bill_to_email).trim() !== '') {
    email = requiredText(payload.bill_to_email, 'bill_to_email', 160);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OrderError('bill_to_email is invalid');
  }
  const company = optionalText(payload.bill_to_company, 'bill_to_company', 160);
  const addressSource = {
    address_line1: payload.bill_to_address_line1,
    address_line2: payload.bill_to_address_line2,
    city: payload.bill_to_city,
    state: payload.bill_to_state,
    zip: payload.bill_to_zip,
  };
  const anyAddress = ['address_line1', 'address_line2', 'city', 'state', 'zip'].some((key) => {
    const value = addressSource[key];
    return value != null && String(value).trim() !== '';
  });
  let address = { addressLine1: null, addressLine2: null, city: null, state: null, zip: null };
  if (anyAddress) {
    const parsed = parsePostalAddress(addressSource, true);
    if (parsed.error) throw new OrderError(billToError(parsed.error));
    address = parsed.value;
  }
  return {
    name,
    phone,
    email,
    company,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    city: address.city,
    state: address.state,
    zip: address.zip,
  };
}

function billToPresent(row) {
  if (!row) return null;
  const bill = {
    name: row.bill_to_name || null,
    phone: row.bill_to_phone || null,
    email: row.bill_to_email || null,
    company: row.bill_to_company || null,
    address_line1: row.bill_to_address_line1 || null,
    address_line2: row.bill_to_address_line2 || null,
    city: row.bill_to_city || null,
    state: row.bill_to_state || null,
    zip: row.bill_to_zip || null,
  };
  const present = Object.values(bill).some((value) => value);
  return present ? bill : null;
}

function paymentLabel(value) {
  const text = value == null ? '' : String(value).trim();
  return text || PAYMENT_UNSPECIFIED;
}

function returnLabel(value) {
  const text = value == null ? '' : String(value).trim();
  return text || RETURN_UNSPECIFIED;
}

function parseTopLevelFileIds(body) {
  if (body.file_ids == null) return [];
  if (!Array.isArray(body.file_ids)) throw new OrderError('file_ids must be an array');
  return body.file_ids.map((value) => {
    const parsed = parsePositive(value);
    if (!parsed) throw new OrderError('file_ids must be positive integers');
    return parsed;
  });
}

function collectFileIds(lineItems, topLevel) {
  const ids = [...topLevel];
  for (const item of lineItems) ids.push(...item.fileIds);
  if (new Set(ids).size !== ids.length) throw new OrderError('A file can only be attached once');
  if (ids.length > 50) throw new OrderError('Too many files');
  return ids;
}

function conversionQuoteId(payload) {
  if (!payload || payload.quote_request_id == null || String(payload.quote_request_id).trim() === '') return null;
  const parsed = Number(String(payload.quote_request_id).trim());
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function quoteFileMatchesConversion(user, file, quoteRequestId) {
  const converter = user.role === 'admin' || user.role === 'manager';
  return converter && quoteRequestId != null && Number(file.quote_request_id) === quoteRequestId;
}

async function allocateOrderNumber(tx, now) {
  const today = businessToday(now);
  const updated = await tx.run(
    'UPDATE order_sequences SET last_number = last_number + 1 WHERE order_date = ?',
    [today.key]
  );
  if (!updated.changes) {
    await tx.run('INSERT INTO order_sequences (order_date, last_number) VALUES (?, 1)', [today.key]);
  }
  const row = await tx.get('SELECT last_number FROM order_sequences WHERE order_date = ?', [today.key]);
  return formatOrderNumber(today.key, row.last_number);
}

function confirmationPayload(record) {
  const remembered = record && orderConfirm.outcomeFor(record.id);
  if (remembered) return orderConfirm.publicConfirmation(remembered);
  if (record && orderConfirm.isPending(record.id)) {
    return {
      email_sent: false,
      email_status: 'pending',
    };
  }
  const status = record && record.confirmation_email_status
    ? String(record.confirmation_email_status)
    : '';
  if (!status) {
    return {
      email_sent: false,
      email_status: 'disabled',
    };
  }
  return {
    email_sent: status === 'sent',
    email_status: status,
  };
}

function publicFile(row) {
  return {
    id: row.id,
    line_item_id: row.line_item_id || null,
    work_order_id: row.work_order_id || null,
    original_name: row.original_name,
    mime_type: row.mime_type || null,
    size_bytes: row.size_bytes,
    uploaded_at: row.uploaded_at,
  };
}

function publicLineItem(row, definitions) {
  const values = readFieldValues(row.field_values);
  const fields = displayFieldList(definitions || [], values);
  const mountLabel = Object.prototype.hasOwnProperty.call(values, 'mount')
    ? String(values.mount)
    : yesNoLabel(row.mount);
  const laminateLabel = Object.prototype.hasOwnProperty.call(values, 'laminate')
    ? String(values.laminate)
    : yesNoLabel(row.laminate);
  return {
    id: row.id,
    line_number: row.line_number,
    service_id: row.service_id || null,
    service_name: row.service_name || null,
    work_order_id: row.work_order_id || null,
    description: row.description,
    size: row.size || null,
    quantity: row.quantity || null,
    media: row.media || null,
    color: row.color || null,
    binding_finish: row.binding_finish || null,
    finishing: row.finishing || null,
    mount: Boolean(row.mount),
    laminate: Boolean(row.laminate),
    mount_label: mountLabel,
    laminate_label: laminateLabel,
    field_values: values,
    fields,
  };
}

async function definitionsFor(serviceIds) {
  const ids = [...new Set((serviceIds || []).filter((id) => id))];
  if (!ids.length) return new Map();
  const rows = await allOn(
    db,
    `SELECT id, service_id, key, label, type, options_json, required, sort_order, is_active
     FROM service_fields
     WHERE service_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY sort_order, id`,
    ids
  );
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.service_id)) grouped.set(row.service_id, []);
    grouped.get(row.service_id).push(row);
  }
  return grouped;
}

async function loadOrderRecord(orderId, user) {
  const params = [orderId];
  let customerClause = '';
  if (user && user.role === 'customer') {
    customerClause = ' AND o.customer_id = ?';
    params.push(Number(user.userId || user.id));
  }
  const order = await getOn(
    db,
    `SELECT o.*, u.username AS customer_username, u.display_name AS customer_display_name,
            loc.name AS location_name, loc.address AS location_address, loc.phone AS location_phone
     FROM orders o
     LEFT JOIN users u ON u.id = o.customer_id
     LEFT JOIN locations loc ON loc.id = o.location_id
     WHERE o.id = ?${customerClause}`,
    params
  );
  if (!order) return null;
  if (user && user.role && user.role !== 'customer') {
    const access = await shopLocations.loadAccess(Number(user.userId || user.id));
    if (!shopLocations.matches(access, order.location_id)) return null;
  }

  const lineItems = await allOn(
    db,
    `SELECT li.*, s.name AS service_name
     FROM order_line_items li
     LEFT JOIN services s ON s.id = li.service_id
     WHERE li.order_id = ?
     ORDER BY li.line_number, li.id`,
    [order.id]
  );
  const files = await allOn(
    db,
    `SELECT id, line_item_id, work_order_id, original_name, mime_type, size_bytes, uploaded_at
     FROM order_files
     WHERE order_id = ?
     ORDER BY uploaded_at, id`,
    [order.id]
  );
  const workOrders = await allOn(
    db,
    `SELECT wo.id, wo.external_id, wo.department, wo.status, wo.next_department,
            wo.service_id, wo.requires_approval, wo.approval_status, s.name AS service_name
     FROM work_orders wo
     LEFT JOIN services s ON s.id = wo.service_id
     WHERE wo.order_id = ?
     ORDER BY wo.external_id`,
    [order.id]
  );
  const delivery = await getOn(
    db,
    `SELECT id, work_order_id, order_id, will_call, due_time, carrier, status, created_at
     FROM deliveries
     WHERE order_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [order.id]
  );

  const fieldDefs = await definitionsFor(lineItems.map((item) => item.service_id));

  return {
    id: order.id,
    order_number: order.order_number,
    customer_id: order.customer_id,
    customer_username: order.customer_username || null,
    customer_display_name: order.customer_display_name || null,
    company: order.company,
    contact_name: order.contact_name,
    phone: order.phone,
    email: order.email,
    po_number: order.po_number,
    project_number: order.project_number,
    project_name: order.project_name,
    notes: order.notes,
    originals_source: order.originals_source || null,
    originals_source_label: originalsLabel(order.originals_source),
    originals_pickup: order.originals_source === 'Send a vehicle to pick up originals',
    address_line1: order.address_line1 || null,
    address_line2: order.address_line2 || null,
    city: order.city || null,
    state: order.state || null,
    zip: order.zip || null,
    location_id: order.location_id == null ? null : order.location_id,
    location_name: order.location_name || null,
    location_address: order.location_address || null,
    location_phone: order.location_phone || null,
    delivery_method: order.delivery_method,
    ups_account_number: order.ups_account_number || null,
    delivery_hours: deliveryHoursFor(order.delivery_method, delivery && delivery.will_call),
    ship_to: order.ship_to,
    attention: order.attention,
    payment_method: order.payment_method || null,
    payment_method_label: paymentLabel(order.payment_method),
    return_to: order.return_to || null,
    return_to_label: returnLabel(order.return_to),
    bill_to: billToPresent(order),
    due_date: order.due_date,
    due_time: order.due_time,
    status: order.status && String(order.status).trim() ? order.status : 'In Production',
    pickup_email_sent_at: order.pickup_email_sent_at || null,
    pickup_sms_sent_at: order.pickup_sms_sent_at || null,
    pickup_email_status: order.pickup_email_status || null,
    pickup_sms_status: order.pickup_sms_status || null,
    created_by: order.created_by,
    created_at: order.created_at,
    updated_at: order.updated_at,
    line_items: lineItems.map((row) => publicLineItem(row, fieldDefs.get(row.service_id))),
    files: files.map(publicFile),
    work_orders: workOrders.map((row) => ({
      id: row.id,
      external_id: row.external_id,
      department: row.department,
      status: row.status,
      next_department: row.next_department || null,
      service_id: row.service_id,
      service_name: row.service_name || null,
      requires_approval: Boolean(row.requires_approval),
      approval_status: row.approval_status || null,
    })),
    delivery: delivery
      ? {
        id: delivery.id,
        work_order_id: delivery.work_order_id,
        order_id: delivery.order_id,
        will_call: Boolean(delivery.will_call),
        due_time: delivery.due_time,
        carrier: delivery.carrier,
        status: delivery.status,
        created_at: delivery.created_at,
      }
      : null,
  };
}

function presentOrder(record) {
  return {
    order_number: record.order_number,
    order: record,
    work_orders: record.work_orders,
    delivery: record.delivery,
    confirmation: confirmationPayload(record),
  };
}

async function createOrder(user, body, now = new Date()) {
  const releaseSideEffects = holdSideEffects();
  try {
    return await createOrderNow(user, body, now);
  } finally {
    releaseSideEffects();
  }
}

async function createOrderNow(user, body, now = new Date()) {
  const payload = body || {};
  assertCustomerFields(user, payload);
  const customerId = customerIdFor(user, payload);
  const company = requiredText(payload.company, 'company', 160);
  const contactName = requiredText(payload.contact_name, 'contact_name', 160);
  const phone = requiredPhone(payload.phone);
  const email = requiredEmail(payload.email);
  const poNumber = optionalText(payload.po_number, 'po_number', 80);
  const projectNumber = optionalText(payload.project_number, 'project_number', 80);
  const projectName = requiredText(payload.project_name, 'project_name', 160);
  const notes = optionalText(payload.notes, 'notes', 2000, { allowNewlines: true });
  const shipTo = optionalText(payload.ship_to, 'ship_to', 500, { allowNewlines: true });
  const attention = optionalText(payload.attention, 'attention', 160);
  const address = requireAddress(payload);
  const originalsSource = parseOriginalsSource(payload.originals_source);
  const paymentMethod = parsePaymentMethod(payload.payment_method);
  const billTo = parseBillTo(payload);
  let requestedMethod = null;
  if (payload.delivery_method != null && String(payload.delivery_method).trim() !== '') {
    requestedMethod = requiredText(payload.delivery_method, 'delivery_method', 120);
    if (retiredDeliveryMethod(requestedMethod)) {
      throw new OrderError(retiredDeliveryMessage(requestedMethod));
    }
  }
  const upsAccount = parseUpsAccountNumber(payload.ups_account_number);
  if (upsAccount.error) throw new OrderError(upsAccount.error);
  const serviceIds = parseServiceIds(payload);
  const lineItems = parseLineItems(payload, serviceIds);
  const topLevelFileIds = parseTopLevelFileIds(payload);
  const fileIds = collectFileIds(lineItems, topLevelFileIds);
  const quoteRequestId = conversionQuoteId(payload);
  if (originalsSource === ORIGINALS_FILES && fileIds.length === 0) {
    throw new OrderError('Attach at least one file when originals source is Files attached below');
  }

  const orderId = await withTransaction(async (tx) => {
    const customer = await tx.get(
      'SELECT id, role, is_active FROM users WHERE id = ?',
      [customerId]
    );
    if (!customer || customer.role !== 'customer' || customer.is_active === 0) {
      throw new OrderError('customer_id must be an existing customer', 400);
    }

    const placeholders = serviceIds.map(() => '?').join(', ');
    const services = await tx.all(
      `SELECT id, name, description, department_name, sort_order, requires_approval, code, suffix_mode
       FROM services
       WHERE is_active = 1 AND id IN (${placeholders})
       ORDER BY sort_order, id`,
      serviceIds
    );
    if (services.length !== serviceIds.length) {
      throw new OrderError('One or more services are not available');
    }
    await applyServiceFields(tx, lineItems, services);
    const shipSelected = services.some((service) => service.name === SHIP_TO_SERVICE);
    const returnTo = parseReturnTo(payload.return_to, shipSelected);
    let deliveryMethodName = requestedMethod;
    if (!deliveryMethodName && returnTo === RETURN_SEE_SHIP) {
      const shipService = services.find((service) => service.name === SHIP_TO_SERVICE);
      const firstShip = lineItems.find((item) => item.serviceId === shipService.id);
      const via = firstShip && firstShip.fieldValues ? firstShip.fieldValues.via : null;
      if (via) {
        deliveryMethodName = methodFromVia(via);
        if (!deliveryMethodName) {
          throw new OrderError(`Ship To Via ${via} does not map to a delivery method. Choose a delivery method, or use Pickup at Accent, Accent Truck, Ground, 1 day, or 2 day.`);
        }
      }
    }
    if (!deliveryMethodName) throw new OrderError('delivery_method is required');
    if (retiredDeliveryMethod(deliveryMethodName)) {
      throw new OrderError(retiredDeliveryMessage(deliveryMethodName));
    }

    const method = await tx.get(
      `SELECT id, name, will_call, is_active FROM delivery_methods
       WHERE lower(name) = lower(?) AND is_active = 1`,
      [deliveryMethodName]
    );
    if (!method || retiredDeliveryMethod(method.name)) {
      throw new OrderError(retiredDeliveryMethod(deliveryMethodName)
        ? retiredDeliveryMessage(deliveryMethodName)
        : 'delivery_method is not available');
    }
    const due = validateOrderDue(payload.due_date, payload.due_time, now, {
      willCall: usesWillCallHours(method.name, method.will_call),
    });
    if (due.error) throw new OrderError(due.error);
    if (upsAccount.value && !isUpsMethod(method.name)) {
      throw new OrderError('ups_account_number is only accepted when the delivery method is UPS');
    }
    const storedUpsAccount = isUpsMethod(method.name) ? upsAccount.value : null;

    for (const service of services) {
      const coverageError = emptyServiceMessage(service, lineItems, notes, shipTo);
      if (coverageError) throw new OrderError(coverageError);
    }

    if (fileIds.length) {
      const filePlaceholders = fileIds.map(() => '?').join(', ');
      const files = await tx.all(
        `SELECT id, order_id, quote_request_id, customer_id, uploaded_by
         FROM order_files
         WHERE id IN (${filePlaceholders})`,
        fileIds
      );
      if (files.length !== fileIds.length) throw new OrderError('One or more files could not be found', 404);
      for (const file of files) {
        if (file.order_id) throw new OrderError('A file is already attached to an order');
        if (file.quote_request_id != null && !quoteFileMatchesConversion(user, file, quoteRequestId)) {
          throw new OrderError('A quote file can only be attached when a manager or admin converts that quote', 403);
        }
        const staff = user.role === 'admin' || user.role === 'manager' || user.role === 'operator';
        const ownsAsCustomer = Number(file.customer_id) === customerId;
        const uploadedByStaff = staff && Number(file.uploaded_by) === Number(user.userId || user.id);
        if (user.role === 'customer' && !ownsAsCustomer) {
          throw new OrderError('One or more files could not be found', 404);
        }
        if (staff && !ownsAsCustomer && !uploadedByStaff && file.customer_id != null) {
          throw new OrderError('One or more files could not be found', 404);
        }
      }
    }

    const location = await shopLocations.resolveOrderLocation(tx, user, payload.location_id, customerId);
    const orderNumber = await allocateOrderNumber(tx, now);
    const inserted = await tx.run(
      `INSERT INTO orders (
        order_number, customer_id, company, contact_name, phone, email,
        po_number, project_number, project_name, notes, delivery_method,
        ups_account_number, originals_source, address_line1, address_line2, city, state, zip,
        ship_to, attention, payment_method, return_to,
        bill_to_name, bill_to_phone, bill_to_email, bill_to_company,
        bill_to_address_line1, bill_to_address_line2, bill_to_city, bill_to_state, bill_to_zip,
        due_date, due_time, created_by, location_id, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [
        orderNumber,
        customerId,
        company,
        contactName,
        phone,
        email,
        poNumber,
        projectNumber,
        projectName,
        notes,
        method.name,
        storedUpsAccount,
        originalsSource,
        address.addressLine1,
        address.addressLine2,
        address.city,
        address.state,
        address.zip,
        shipTo,
        attention,
        paymentMethod,
        returnTo,
        billTo.name,
        billTo.phone,
        billTo.email,
        billTo.company,
        billTo.addressLine1,
        billTo.addressLine2,
        billTo.city,
        billTo.state,
        billTo.zip,
        due.value.dueDate,
        due.value.dueTime,
        Number(user.userId || user.id),
        location.value,
      ]
    );
    const newOrderId = inserted.lastID;

    const lineItemIds = [];
    for (const item of lineItems) {
      const result = await tx.run(
        `INSERT INTO order_line_items (
          order_id, service_id, line_number, description, size, quantity, media, color,
          binding_finish, finishing, mount, laminate, field_values
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          newOrderId,
          item.serviceId,
          item.lineNumber,
          item.description,
          item.size,
          item.quantity,
          item.media,
          item.color,
          item.bindingFinish,
          item.finishing,
          item.mount,
          item.laminate,
          item.fieldValuesJson || null,
        ]
      );
      lineItemIds.push(result.lastID);
    }

    const createdWorkOrders = [];
    const suffixes = suffixesFor(services);
    for (let index = 0; index < services.length; index += 1) {
      const service = services[index];
      const externalId = `${orderNumber}-${suffixes[index]}`;
      const existing = await tx.get('SELECT id FROM work_orders WHERE external_id = ?', [externalId]);
      if (existing) throw new OrderError('Could not assign a work order number', 409);

      const department = await tx.get(
        'SELECT id, name, next_department FROM departments WHERE name = ?',
        [service.department_name]
      );
      const linkedItems = lineItems
        .map((item, itemIndex) => ({ ...item, id: lineItemIds[itemIndex] }))
        .filter((item) => item.serviceId === service.id);
      const quantity = linkedItems.reduce((sum, item) => sum + leadingQuantity(item.quantity), 0) || 1;
      const description = projectName ? `${service.name} — ${projectName}` : service.name;
      const nextDepartment = department ? department.next_department : null;
      const specs = specificationText(linkedItems, notes);
      const requiresApproval = service.requires_approval ? 1 : 0;

      const workOrder = await tx.run(
        `INSERT INTO work_orders (
          external_id, customer_id, description, quantity, status, department,
          priority, assigned_department_id, specifications, due_date, notes,
          routing_instructions, order_id, service_id, next_department,
          requires_approval, approval_status, location_id, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
        [
          externalId,
          customerId,
          description,
          quantity,
          'open',
          department ? department.name : service.department_name,
          'Normal',
          department ? department.id : null,
          specs,
          due.value.dueDateTime,
          notes,
          nextDepartment ? `Next department: ${nextDepartment}` : 'Final department',
          newOrderId,
          service.id,
          nextDepartment,
          requiresApproval,
          requiresApproval ? 'pending' : null,
          location.value,
        ]
      );

      for (const item of linkedItems) {
        await tx.run('UPDATE order_line_items SET work_order_id = ? WHERE id = ?', [workOrder.lastID, item.id]);
        for (const fileId of item.fileIds) {
          await tx.run(
            `UPDATE order_files
             SET order_id = ?, line_item_id = ?, work_order_id = ?, customer_id = ?
             WHERE id = ?`,
            [newOrderId, item.id, workOrder.lastID, customerId, fileId]
          );
        }
      }

      await tx.run(
        `INSERT INTO production_history (work_order_id, department, status, scanned_by, user_id, notes)
         VALUES (?, 'Submitted', 'Submitted', 'System Auto', ?, 'Order Created')`,
        [workOrder.lastID, Number(user.userId || user.id)]
      );

      const queueName = department ? department.name : service.department_name;
      await tx.run(
        activityLog.INSERT_SQL,
        activityLog.bindParams(activityLog.createdEntry({
          actorId: Number(user.userId || user.id),
          workOrderId: workOrder.lastID,
          externalId,
          department: queueName,
          orderNumber,
        }))
      );

      createdWorkOrders.push(workOrder.lastID);
    }

    for (const fileId of topLevelFileIds) {
      await tx.run(
        'UPDATE order_files SET order_id = ?, customer_id = ? WHERE id = ?',
        [newOrderId, customerId, fileId]
      );
    }

    await tx.run(
      `INSERT INTO deliveries (work_order_id, order_id, will_call, due_time, carrier, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      [createdWorkOrders[0], newOrderId, method.will_call ? 1 : 0, due.value.dueDateTime, method.name]
    );

    await tx.run(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, detail)
       VALUES (?, 'order.created', 'order', ?, ?)`,
      [Number(user.userId || user.id), newOrderId, JSON.stringify({
        order_number: orderNumber,
        work_order_ids: createdWorkOrders,
        originals_source: originalsSource,
        message: `Created order ${orderNumber}`,
      })]
    );

    if (payload.quote_request_id != null && String(payload.quote_request_id).trim() !== '') {
      await quotes.attachConversion(tx, user, quoteRequestId == null ? payload.quote_request_id : quoteRequestId, newOrderId, customerId);
    }

    return newOrderId;
  });

  const record = await loadOrderRecord(orderId, user);
  try {
    await new Promise((resolve, reject) => {
      notifications.notifyOrderCreated({
        orderId,
        orderNumber: record && record.order_number,
        locationId: record && record.location_id,
        company: record && record.company,
      }, (err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    console.error('ORDER NOTIFICATION ERROR:', err);
  }
  let pickupRequest = null;
  try {
    pickupRequest = await pickupRequests.createFromOrder(orderId);
  } catch (err) {
    console.error('PICKUP REQUEST ERROR:', err && err.message ? err.message : 'failed');
  }
  orderConfirm.noteScheduled(orderId);
  afterResponse('ORDER CONFIRM', () => orderConfirm.deliver(orderId));
  const presented = presentOrder(record);
  if (pickupRequest && pickupRequest.pickup_request) {
    presented.pickup_request = {
      id: pickupRequest.pickup_request.id,
      status: pickupRequest.pickup_request.status,
      email_status: pickupRequest.email ? pickupRequest.email.status : null,
    };
    if (process.env.NODE_ENV === 'test' && pickupRequest.email && pickupRequest.email.preview) {
      presented.pickup_request.preview = pickupRequest.email.preview;
    }
  }
  return presented;
}

async function listOrders(user, query) {
  const limit = parseListLimit(query.limit);
  const offset = parseListOffset(query.offset);
  const params = [];
  const clauses = [];
  if (user.role === 'customer') {
    clauses.push('o.customer_id = ?');
    params.push(Number(user.userId || user.id));
  } else {
    const access = await shopLocations.loadAccess(Number(user.userId || user.id));
    const locked = shopLocations.predicate('o.location_id', access);
    if (locked.sql) {
      clauses.push(locked.sql);
      params.push(...locked.params);
    } else if (query.location_id != null && String(query.location_id).trim() !== '' && String(query.location_id).trim().toLowerCase() !== 'all') {
      const chosen = await shopLocations.resolveLocationId({ get: (sql, p) => getOn(db, sql, p) }, query.location_id, {
        required: true,
        activeOnly: false,
      });
      if (chosen.error) throw new OrderError(chosen.error, 400);
      clauses.push('o.location_id = ?');
      params.push(chosen.value);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const totalRow = await getOn(db, `SELECT COUNT(*) AS count FROM orders o ${where}`, params);
  const orders = await allOn(
    db,
    `SELECT o.id, o.order_number, o.customer_id, o.company, o.contact_name, o.phone, o.email,
            o.po_number, o.project_number, o.project_name, o.delivery_method, o.ups_account_number,
            o.due_date, o.due_time, o.created_at, o.status, o.location_id, loc.name AS location_name,
            u.display_name AS customer_display_name
     FROM orders o
     LEFT JOIN users u ON u.id = o.customer_id
     LEFT JOIN locations loc ON loc.id = o.location_id
     ${where}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  let workOrders = [];
  if (orders.length) {
    const placeholders = orders.map(() => '?').join(', ');
    workOrders = await allOn(
      db,
      `SELECT wo.id, wo.order_id, wo.external_id, wo.department, wo.status, wo.service_id, s.name AS service_name
       FROM work_orders wo
       LEFT JOIN services s ON s.id = wo.service_id
       WHERE wo.order_id IN (${placeholders})
       ORDER BY wo.external_id`,
      orders.map((order) => order.id)
    );
  }
  const grouped = new Map();
  for (const row of workOrders) {
    if (!grouped.has(row.order_id)) grouped.set(row.order_id, []);
    grouped.get(row.order_id).push({
      id: row.id,
      external_id: row.external_id,
      department: row.department,
      status: row.status,
      service_id: row.service_id,
      service_name: row.service_name || null,
    });
  }
  return {
    orders: orders.map((order) => ({
      ...order,
      work_orders: grouped.get(order.id) || [],
    })),
    total: totalRow ? totalRow.count : 0,
    limit,
    offset,
  };
}

function parseListLimit(value) {
  if (value == null || value === '') return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new OrderError('limit must be an integer from 1 to 500');
  }
  return parsed;
}

function parseListOffset(value) {
  if (value == null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new OrderError('offset must be an integer of 0 or greater');
  return parsed;
}

async function getOrder(user, id) {
  const orderId = parsePositive(id);
  if (!orderId) throw new OrderError('id must be a positive integer');
  return loadOrderRecord(orderId, user);
}

async function orderOptions() {
  const services = await allOn(
    db,
    `SELECT id, name, description, department_name, sort_order, requires_approval,
            code, suffix_mode, default_turnaround_hours
     FROM services
     WHERE is_active = 1
     ORDER BY sort_order, id`
  );
  const methods = await allOn(
    db,
    `SELECT id, name, will_call, sort_order
     FROM delivery_methods
     WHERE is_active = 1
     ORDER BY sort_order, id`
  );
  const deliveryHours = deliveryWindow();
  const willCallHours = willCallWindow();
  const selectable = methods.filter((method) => !retiredDeliveryMethod(method.name));
  const serviceIds = services.map((service) => service.id);
  const fieldRows = serviceIds.length
    ? await allOn(
      db,
      `SELECT id, service_id, key, label, type, options_json, required, sort_order, is_active
       FROM service_fields
       WHERE is_active = 1 AND service_id IN (${serviceIds.map(() => '?').join(', ')})
       ORDER BY sort_order, id`,
      serviceIds
    )
    : [];
  const fieldsByService = new Map();
  for (const row of fieldRows) {
    if (!fieldsByService.has(row.service_id)) fieldsByService.set(row.service_id, []);
    fieldsByService.get(row.service_id).push(presentField(row, false));
  }
  return {
    services: services.map((service) => ({
      ...service,
      requires_approval: Boolean(service.requires_approval),
      fields: fieldsByService.get(service.id) || [],
    })),
    payment_methods: PAYMENT_METHODS.slice(),
    return_options: [RETURN_TO_ME, RETURN_SEE_SHIP],
    delivery_methods: selectable.map((method) => ({
      ...method,
      will_call: Boolean(method.will_call),
    })),
    due_window: presentDueWindow(deliveryHours, 'delivery'),
    due_windows: {
      will_call: presentDueWindow(willCallHours, 'will_call'),
      delivery: presentDueWindow(deliveryHours, 'delivery'),
    },
    finishing_options: FINISHING_OPTIONS.slice(),
    originals_sources: ORIGINALS_SOURCES.slice(),
    locations: await shopLocations.listLocations({ includeInactive: false }),
  };
}

function presentDueWindow(window, kind) {
  return {
    start: window.start,
    end: window.end,
    increment_minutes: window.incrementMinutes,
    slots: window.slots,
    summary: windowSummary(window, kind),
    label: hoursLabel(window),
  };
}

function deliveryHoursFor(methodName, willCallFlag) {
  const willCall = usesWillCallHours(methodName, willCallFlag);
  const window = willCall ? willCallWindow() : deliveryWindow();
  return presentDueWindow(window, willCall ? 'will_call' : 'delivery');
}

async function previewOrder(query, now = new Date()) {
  let serviceIds = [];
  if (query.service_ids != null && String(query.service_ids).trim() !== '') {
    serviceIds = String(query.service_ids).split(',').map((value) => {
      const parsed = parsePositive(value);
      if (!parsed) throw new OrderError('service_ids must be positive integers');
      return parsed;
    });
    if (new Set(serviceIds).size !== serviceIds.length) throw new OrderError('Duplicate services are not allowed');
  }
  const today = businessToday(now);
  const sequence = await getOn(db, 'SELECT last_number FROM order_sequences WHERE order_date = ?', [today.key]);
  const orderNumber = formatOrderNumber(today.key, (sequence ? sequence.last_number : 0) + 1);
  let services = [];
  if (serviceIds.length) {
    const placeholders = serviceIds.map(() => '?').join(', ');
    services = await allOn(
      db,
      `SELECT id, name, department_name, sort_order, code, suffix_mode
       FROM services
       WHERE is_active = 1 AND id IN (${placeholders})
       ORDER BY sort_order, id`,
      serviceIds
    );
    if (services.length !== serviceIds.length) throw new OrderError('One or more services are not available');
  }
  return {
    provisional: true,
    order_number: orderNumber,
    work_orders: suffixesFor(services).map((suffix, index) => ({
      external_id: `${orderNumber}-${suffix}`,
      service_id: services[index].id,
      service_name: services[index].name,
      department: services[index].department_name,
    })),
  };
}

function routingStatusLabel(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'open') return 'Active';
  if (value === 'in-progress') return 'In Production';
  if (value === 'completed' || value === 'complete') return 'Complete';
  if (value === 'on-hold') return 'On Hold';
  return status || null;
}

function specificationLines(items, notes) {
  return (items || []).map((item) => {
    const dynamic = item.fields || [];
    const covered = new Set(dynamic.map((field) => LEGACY_SPEC_COVER[field.key] || field.label));
    const legacy = [
      { label: 'Size', value: item.size || '—' },
      { label: 'Quantity', value: item.quantity || '—' },
      { label: 'Media', value: item.media || '—' },
      { label: 'Color', value: item.color || '—' },
      { label: 'Binding / Finish', value: item.binding_finish || '—' },
      { label: 'Mounting', value: item.mount_label || yesNoLabel(item.mount) },
      { label: 'Lamination', value: item.laminate_label || yesNoLabel(item.laminate) },
      { label: 'Finishing', value: item.finishing || 'None' },
    ].filter((field) => !covered.has(field.label));
    return {
      title: item.description,
      line_number: item.line_number,
      fields: [
        ...dynamic.map((field) => ({ label: field.label, value: field.display || '—' })),
        ...legacy,
        { label: 'Special Instructions', value: notes || '—' },
      ],
    };
  });
}

function customerHistory(entry) {
  return {
    id: entry.id,
    department: entry.department,
    status: entry.status,
    event_time: entry.event_time,
  };
}

function staffHistory(entry) {
  const notes = entry.notes || null;
  return {
    ...entry,
    notes,
    manual: typeof notes === 'string' && notes.startsWith('Manual move'),
  };
}

function presentWorkOrderActivity(row) {
  let detail = {};
  if (row.detail) {
    try {
      const parsed = JSON.parse(row.detail);
      detail = parsed && typeof parsed === 'object' ? parsed : { message: String(row.detail) };
    } catch (err) {
      detail = { message: String(row.detail) };
    }
  }
  return {
    id: row.id,
    action: row.action,
    summary: detail.message || row.action,
    manual: Boolean(detail.manual),
    note: detail.note || null,
    actor_name: row.actor_name || 'System',
    created_at: row.created_at,
  };
}

async function loadWorkOrderContext(row, viewer) {
  const lineItems = await allOn(
    db,
    `SELECT id, line_number, description, size, quantity, media, color, binding_finish,
            finishing, mount, laminate, field_values, service_id, work_order_id
     FROM order_line_items
     WHERE work_order_id = ?
     ORDER BY line_number, id`,
    [row.id]
  );
  const fieldDefs = await definitionsFor(lineItems.map((item) => item.service_id));
  const publicItems = lineItems.map((item) => publicLineItem(item, fieldDefs.get(item.service_id)));
  const files = await allOn(
    db,
    `SELECT id, line_item_id, work_order_id, original_name, mime_type, size_bytes, uploaded_at
     FROM order_files
     WHERE work_order_id = ? OR (order_id = ? AND work_order_id IS NULL)
     ORDER BY uploaded_at, id`,
    [row.id, row.order_id || null]
  );
  const history = await allOn(
    db,
    `SELECT id, department, status, event_time, scanned_by, notes
     FROM production_history
     WHERE work_order_id = ?
     ORDER BY event_time, id`,
    [row.id]
  );
  return {
    ...row,
    originals_source: row.originals_source || null,
    originals_source_label: originalsLabel(row.originals_source),
    originals_pickup: row.originals_source === 'Send a vehicle to pick up originals',
    address_line1: row.address_line1 || null,
    address_line2: row.address_line2 || null,
    city: row.city || null,
    state: row.state || null,
    zip: row.zip || null,
    payment_method: row.payment_method || null,
    payment_method_label: paymentLabel(row.payment_method),
    return_to: row.return_to || null,
    return_to_label: returnLabel(row.return_to),
    bill_to: billToPresent(row),
    line_items: publicItems,
    files: files.map(publicFile),
    production_history: viewer && viewer.role === 'customer' ? history.map(customerHistory) : history.map(staffHistory),
    activity: viewer && viewer.role === 'customer' ? [] : (await allOn(
      db,
      `SELECT a.id, a.action, a.detail, a.created_at,
              COALESCE(NULLIF(trim(u.display_name), ''), NULLIF(trim(u.username), ''), 'System') AS actor_name
       FROM activity_log a
       LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.entity_type = 'work_order' AND a.entity_id = ?
       ORDER BY a.id DESC
       LIMIT 20`,
      [row.id]
    )).map(presentWorkOrderActivity),
    routing: {
      department: row.department || null,
      current_status: row.status || null,
      current_status_label: routingStatusLabel(row.status),
      next_department: row.next_department || null,
    },
    specification_lines: specificationLines(publicItems, row.notes),
  };
}

async function listBillTos(user, query) {
  let customerId;
  if (user.role === 'customer') {
    customerId = Number(user.userId || user.id);
  } else {
    customerId = parsePositive((query || {}).customer_id);
    if (!customerId) throw new OrderError('customer_id is required');
    const customer = await getOn(
      db,
      `SELECT id FROM users WHERE id = ? AND role = 'customer' AND COALESCE(is_active, 1) = 1`,
      [customerId]
    );
    if (!customer) throw new OrderError('customer_id must be an existing customer', 404);
  }
  const params = [customerId];
  let locationSql = '';
  if (user.role !== 'customer') {
    const access = await shopLocations.loadAccess(Number(user.userId || user.id));
    const pred = shopLocations.predicate('location_id', access);
    if (pred.sql) {
      locationSql = ` AND ${pred.sql}`;
      params.push(...pred.params);
    }
  }
  const rows = await allOn(
    db,
    `SELECT bill_to_name, bill_to_phone, bill_to_email, bill_to_company,
            bill_to_address_line1, bill_to_address_line2, bill_to_city, bill_to_state, bill_to_zip,
            MAX(id) AS id
     FROM orders
     WHERE customer_id = ?
       AND (
         IFNULL(trim(bill_to_name), '') != ''
         OR IFNULL(trim(bill_to_phone), '') != ''
         OR IFNULL(trim(bill_to_email), '') != ''
         OR IFNULL(trim(bill_to_company), '') != ''
         OR IFNULL(trim(bill_to_address_line1), '') != ''
       )${locationSql}
     GROUP BY bill_to_name, bill_to_phone, bill_to_email, bill_to_company,
              bill_to_address_line1, bill_to_address_line2, bill_to_city, bill_to_state, bill_to_zip
     ORDER BY id DESC
     LIMIT 20`,
    params
  );
  return {
    bill_tos: rows.map((row) => ({ id: row.id, ...billToPresent(row) })),
  };
}

async function transferOrder(user, rawId, body) {
  if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
    throw new OrderError('Forbidden', 403);
  }
  const orderId = parsePositive(rawId);
  if (!orderId) throw new OrderError('id must be a positive integer');
  const existing = await loadOrderRecord(orderId, user);
  if (!existing) throw new OrderError('Order not found', 404);
  const source = body || {};
  const target = await shopLocations.resolveLocationId(
    { get: (sql, params) => getOn(db, sql, params) },
    source.location_id,
    { required: true, activeOnly: true }
  );
  if (target.error) throw new OrderError(target.error, 400);
  if (Number(existing.location_id) === Number(target.value)) {
    throw new OrderError('That order is already at this location', 409);
  }
  await withTransaction(async (tx) => {
    await tx.run(
      `UPDATE orders SET location_id = ?, updated_at = datetime('now') WHERE id = ?`,
      [target.value, existing.id]
    );
    await tx.run(
      `UPDATE work_orders SET location_id = ?, updated_at = datetime('now') WHERE order_id = ?`,
      [target.value, existing.id]
    );
    await tx.run(
      `UPDATE notifications SET location_id = ?
       WHERE order_id = ?
          OR work_order_id IN (SELECT id FROM work_orders WHERE order_id = ?)`,
      [target.value, existing.id, existing.id]
    );
    await tx.run(
      `UPDATE inbound_emails SET location_id = ?, updated_at = datetime('now') WHERE order_id = ?`,
      [target.value, existing.id]
    );
    await tx.run(
      `UPDATE quote_requests SET location_id = ?, updated_at = datetime('now') WHERE converted_order_id = ?`,
      [target.value, existing.id]
    );
    await activityLog.recordOn(tx, Number(user.userId || user.id), 'order.transferred', 'order', existing.id, {
      order_number: existing.order_number,
      from_location_id: existing.location_id || null,
      to_location_id: target.value,
      from_location: existing.location_name || null,
      to_location: target.name,
      message: `Transferred order ${existing.order_number} to ${target.name}`,
    });
  });
  const access = await shopLocations.loadAccess(Number(user.userId || user.id));
  if (!shopLocations.matches(access, target.value)) {
    return {
      transferred: true,
      order_id: existing.id,
      order_number: existing.order_number,
      location_id: target.value,
      location_name: target.name,
    };
  }
  const record = await loadOrderRecord(orderId, user);
  return presentOrder(record);
}

const ORDER_STATUS_READY = 'Ready for Pickup';
const ORDER_STATUS_OPEN = 'In Production';

function canonicalOrderStatus(value) {
  if (value == null || String(value).trim() === '') return { error: 'status is required' };
  const text = String(value).trim().toLowerCase();
  if (text === 'in production') return { value: ORDER_STATUS_OPEN };
  if (text === 'ready for pickup') return { value: ORDER_STATUS_READY };
  return { error: 'status must be In Production or Ready for Pickup' };
}

function storedOrderStatus(value) {
  return String(value || '').trim().toLowerCase() === 'ready for pickup'
    ? ORDER_STATUS_READY
    : ORDER_STATUS_OPEN;
}

async function setOrderStatus(user, id, body) {
  if (!user || !['admin', 'manager', 'operator'].includes(user.role)) {
    throw new OrderError('Only staff can change an order status', 403);
  }
  const parsed = canonicalOrderStatus(body && body.status);
  if (parsed.error) throw new OrderError(parsed.error);
  const orderId = parsePositive(id);
  if (!orderId) throw new OrderError('id must be a positive integer');
  const visible = await loadOrderRecord(orderId, user);
  if (!visible) throw new OrderError('Order not found', 404);

  const outcome = await withTransaction(async (tx) => {
      const existing = await tx.get(
        `SELECT id, status, order_number, pickup_ready_generation FROM orders WHERE id = ?`,
        [orderId]
      );
      if (!existing) throw new OrderError('Order not found', 404);
      const current = storedOrderStatus(existing.status);
      if (current === parsed.value) {
        return { changed: false, entering: false, generation: existing.pickup_ready_generation || 0 };
      }
      const entering = parsed.value === ORDER_STATUS_READY;
      if (entering) {
        await tx.run(
          `UPDATE orders
           SET status = ?,
               pickup_ready_generation = COALESCE(pickup_ready_generation, 0) + 1,
               pickup_notified_generation = COALESCE(pickup_ready_generation, 0) + 1,
               pickup_email_sent_at = NULL,
               pickup_sms_sent_at = NULL,
               pickup_email_status = NULL,
               pickup_sms_status = NULL,
               updated_at = datetime('now')
           WHERE id = ?`,
          [ORDER_STATUS_READY, orderId]
        );
      } else {
        await tx.run(
          `UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`,
          [ORDER_STATUS_OPEN, orderId]
        );
      }
      await activityLog.recordOn(
        tx,
        Number(user.userId || user.id),
        entering ? 'order.ready_for_pickup' : 'order.status_updated',
        'order',
        orderId,
        {
          order_number: existing.order_number,
          status: parsed.value,
          message: entering
            ? `Marked order ${existing.order_number} ready for pickup`
            : `Updated order ${existing.order_number} to ${parsed.value}`,
        }
      );
      const row = await tx.get(`SELECT pickup_ready_generation FROM orders WHERE id = ?`, [orderId]);
      return {
        changed: true,
        entering,
        generation: row ? row.pickup_ready_generation : 0,
      };
    });

  let notice = null;
  if (outcome.entering) {
    try {
      notice = await pickupNotify.deliver(orderId, outcome.generation);
    } catch (err) {
      console.error('PICKUP NOTIFY ERROR:', err && err.message ? err.message : 'failed');
      notice = {
        email: { status: 'failed', sent_at: null },
        sms: { status: 'failed', sent_at: null },
      };
    }
  } else if (!outcome.changed && parsed.value === ORDER_STATUS_READY) {
    notice = { skipped: true, reason: 'already_notified' };
  }

  const record = await loadOrderRecord(orderId, user);
  const presented = presentOrder(record);
  presented.pickup_notice = notice;
  return presented;
}

module.exports = {
  OrderError,
  CUSTOMER_FORBIDDEN_FIELDS,
  FINISHING_OPTIONS,
  ORIGINALS_SOURCES,
  ORIGINALS_UNSPECIFIED,
  originalsLabel,
  withTransaction,
  createOrder,
  transferOrder,
  setOrderStatus,
  listOrders,
  listBillTos,
  getOrder,
  orderOptions,
  previewOrder,
  loadWorkOrderContext,
  presentOrder,
  formatOrderNumber,
  suffixForIndex,
};
