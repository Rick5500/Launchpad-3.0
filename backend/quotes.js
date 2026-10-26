// Customer quote requests. Customers create and decide their own requests.
// Managers and admins quote them and turn an accepted quote into an order
// through the normal order form. Operators receive HTTP 403.

const activityLog = require('./activityLog');
const { all, get, withTransaction } = require('./dbAsync');
const { businessToday } = require('./deliveryRules');
const { parseInteger, parseLimit, parseOffset, parseText } = require('./fields');
const { httpError } = require('./httpError');
const mailer = require('./mailer');
const notifications = require('./notifications');
const { loadLetterhead } = require('./shopProfile');
const shopLocations = require('./shopLocations');

const STATUSES = ['New', 'Quoted', 'Accepted', 'Declined'];
const MAX_FILES = 20;
const MAX_LINES = 20;
const LIST_LIMIT = 50;
const LIST_MAX = 100;

const QUOTE_SQL = `
  SELECT q.*,
         COALESCE(NULLIF(trim(u.display_name), ''), NULLIF(trim(u.username), '')) AS customer_name,
         u.company AS customer_company,
         u.email AS customer_email,
         u.contact_name AS customer_contact_name,
         u.phone AS customer_phone,
         u.address_line1 AS customer_address_line1,
         u.address_line2 AS customer_address_line2,
         u.city AS customer_city,
         u.state AS customer_state,
         u.zip AS customer_zip,
         u.display_name AS customer_display_name,
         o.order_number,
         loc.name AS location_name,
         loc.address AS location_address,
         loc.phone AS location_phone
  FROM quote_requests q
  LEFT JOIN users u ON u.id = q.customer_id
  LEFT JOIN orders o ON o.id = q.converted_order_id
  LEFT JOIN locations loc ON loc.id = q.location_id
`;

function actorId(user) {
  return Number(user.userId || user.id);
}

function isCustomer(user) {
  return Boolean(user) && user.role === 'customer';
}

function isQuoteStaff(user) {
  return Boolean(user) && (user.role === 'admin' || user.role === 'manager');
}

function assertReader(user) {
  if (isCustomer(user) || isQuoteStaff(user)) return;
  throw httpError(403, 'Forbidden');
}

function failText(value, field, max, options = {}) {
  const parsed = parseText(value, field, { max, ...options });
  if (parsed.error) throw httpError(400, parsed.error);
  return parsed.value;
}

function parseDate(value, field, required) {
  const text = failText(value, field, 10, { required });
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(400, `${field} must be a date`);
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw httpError(400, `${field} must be a date`);
  }
  return text;
}

function parseMoney(value, field, required) {
  if (value == null || String(value).trim() === '') {
    if (required) throw httpError(400, `${field} is required`);
    return null;
  }
  const text = String(value).trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) throw httpError(400, `${field} must be a dollar amount`);
  return Number(text).toFixed(2);
}

function parseStatusFilter(value) {
  if (value == null || String(value).trim() === '' || String(value).trim().toLowerCase() === 'all') return null;
  const match = STATUSES.find((status) => status.toLowerCase() === String(value).trim().toLowerCase());
  if (!match) throw httpError(400, 'status must be New, Quoted, Accepted, or Declined');
  return match;
}

function parseRequestId(value) {
  const parsed = parseInteger(value, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
  if (parsed.error || !parsed.value) throw httpError(400, parsed.error || 'id must be a positive integer');
  return parsed.value;
}

function parseFileIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw httpError(400, 'file_ids must be an array');
  if (value.length > MAX_FILES) throw httpError(400, `A quote request can include at most ${MAX_FILES} files`);
  const ids = value.map((item) => {
    const parsed = parseInteger(item, 'file_ids', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
    if (parsed.error || !parsed.value) throw httpError(400, 'file_ids must be positive integers');
    return parsed.value;
  });
  if (new Set(ids).size !== ids.length) throw httpError(400, 'A file can only be attached once');
  return ids;
}

function parseLineItems(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw httpError(400, 'line_items must be an array');
  if (value.length > MAX_LINES) throw httpError(400, `A quote can include at most ${MAX_LINES} line items`);
  const lines = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw httpError(400, 'Each line item must be an object');
    }
    const code = failText(item.code, 'code', 40);
    const unit = failText(item.unit, 'unit', 40);
    const quantity = failText(item.quantity, 'quantity', 40);
    const description = failText(item.description, 'description', 200);
    const price = parseMoney(item.price, 'price', false);
    if (!code && !unit && !quantity && !description && !price) continue;
    lines.push({ code, unit, quantity, description, price });
  }
  return lines;
}

function moneyLabel(value) {
  if (value == null || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function presentLine(row) {
  return {
    id: row.id,
    line_number: row.line_number,
    code: row.code || '',
    unit: row.unit || '',
    quantity: row.quantity || '',
    description: row.description || '',
    price: row.price || null,
  };
}

function presentFile(row) {
  return {
    id: row.id,
    original_name: row.original_name,
    mime_type: row.mime_type || null,
    size_bytes: row.size_bytes,
    uploaded_at: row.uploaded_at,
  };
}

function presentQuote(row, extras = {}) {
  const quote = {
    id: row.id,
    customer_id: row.customer_id,
    customer_name: row.customer_name || null,
    customer_company: row.customer_company || null,
    project_name: row.project_name,
    description: row.description || '',
    quantity: row.quantity || '',
    size: row.size || '',
    material: row.material || '',
    finishing: row.finishing || '',
    needed_by: row.needed_by || null,
    status: row.status,
    decline_reason: row.decline_reason || null,
    price: row.price || null,
    price_label: moneyLabel(row.price),
    quote_notes: row.quote_notes || '',
    valid_until: row.valid_until || null,
    quote_version: row.quote_version || 0,
    quoted_at: row.quoted_at || null,
    decided_at: row.decided_at || null,
    converted_order_id: row.converted_order_id || null,
    order_number: row.order_number || null,
    location_id: row.location_id == null ? null : row.location_id,
    location_name: row.location_name || null,
    location_address: row.location_address || null,
    location_phone: row.location_phone || null,
    created_at: row.created_at,
    updated_at: row.updated_at || null,
  };
  if (extras.files) {
    quote.files = extras.files.map((file) => {
      const next = { ...file };
      delete next.order_id;
      return next;
    });
  }
  if (extras.line_items) quote.line_items = extras.line_items;
  if (extras.file_count != null) quote.file_count = extras.file_count;
  if (isQuoteStaff(extras.viewer)) quote.customer_email = row.customer_email || null;
  return quote;
}

async function lineItemsFor(ids) {
  if (!ids.length) return new Map();
  const rows = await all(
    `SELECT id, quote_request_id, line_number, code, unit, quantity, description, price
     FROM quote_line_items
     WHERE quote_request_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY line_number, id`,
    ids
  );
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.quote_request_id)) grouped.set(row.quote_request_id, []);
    grouped.get(row.quote_request_id).push(presentLine(row));
  }
  return grouped;
}

async function filesFor(id) {
  const rows = await all(
    `SELECT id, original_name, mime_type, size_bytes, uploaded_at, order_id
     FROM order_files
     WHERE quote_request_id = ?
     ORDER BY uploaded_at, id`,
    [id]
  );
  return rows.map((row) => ({ ...presentFile(row), order_id: row.order_id || null }));
}

async function loadQuote(id, user) {
  const params = [id];
  let customerClause = '';
  if (isCustomer(user)) {
    customerClause = ' AND q.customer_id = ?';
    params.push(actorId(user));
  }
  const row = await get(`${QUOTE_SQL} WHERE q.id = ?${customerClause}`, params);
  if (!row || isCustomer(user)) return row;
  const access = await shopLocations.loadAccess(actorId(user));
  if (!shopLocations.matches(access, row.location_id)) return null;
  return row;
}

async function scope(user, query) {
  if (isCustomer(user)) return { sql: ' AND q.customer_id = ?', params: [actorId(user)] };
  const access = await shopLocations.loadAccess(actorId(user));
  const locked = shopLocations.predicate('q.location_id', access);
  if (locked.sql) return { sql: ` AND ${locked.sql}`, params: locked.params };
  const raw = query && query.location_id;
  if (raw == null || String(raw).trim() === '' || String(raw).trim().toLowerCase() === 'all') {
    return { sql: '', params: [] };
  }
  const chosen = await shopLocations.resolveLocationId({ get }, raw, { required: true, activeOnly: false });
  if (chosen.error) throw httpError(400, chosen.error);
  return { sql: ' AND q.location_id = ?', params: [chosen.value] };
}

async function newCount(user) {
  const visible = await scope(user);
  const row = await get(
    `SELECT COUNT(*) AS count FROM quote_requests q WHERE q.status = 'New'${visible.sql}`,
    visible.params
  );
  return row ? row.count : 0;
}

async function summary(user) {
  assertReader(user);
  if (!isQuoteStaff(user)) throw httpError(403, 'Forbidden');
  return { new_count: await newCount(user) };
}

async function listQuotes(user, query) {
  assertReader(user);
  const source = query || {};
  const status = parseStatusFilter(source.status);
  const limit = parseLimit(source.limit, LIST_LIMIT, LIST_MAX);
  if (limit.error) throw httpError(400, limit.error);
  const offset = parseOffset(source.offset);
  if (offset.error) throw httpError(400, offset.error);
  const visible = await scope(user, source);
  const params = [...visible.params];
  let statusClause = '';
  if (status) {
    statusClause = ' AND q.status = ?';
    params.push(status);
  }
  const where = `WHERE 1 = 1${visible.sql}${statusClause}`;
  const totalRow = await get(`SELECT COUNT(*) AS count FROM quote_requests q ${where}`, params);
  const rows = await all(
    `${QUOTE_SQL} ${where} ORDER BY q.created_at DESC, q.id DESC LIMIT ? OFFSET ?`,
    [...params, limit.value, offset.value]
  );
  const lines = await lineItemsFor(rows.map((row) => row.id));
  let fileCounts = new Map();
  if (rows.length) {
    const counts = await all(
      `SELECT quote_request_id, COUNT(*) AS count
       FROM order_files
       WHERE quote_request_id IN (${rows.map(() => '?').join(', ')})
       GROUP BY quote_request_id`,
      rows.map((row) => row.id)
    );
    fileCounts = new Map(counts.map((row) => [row.quote_request_id, row.count]));
  }
  return {
    quotes: rows.map((row) => presentQuote(row, {
      viewer: user,
      line_items: lines.get(row.id) || [],
      file_count: fileCounts.get(row.id) || 0,
    })),
    total: totalRow ? totalRow.count : 0,
    new_count: await newCount(user),
    status,
    limit: limit.value,
    offset: offset.value,
  };
}

async function getQuote(user, rawId) {
  assertReader(user);
  const id = parseRequestId(rawId);
  const row = await loadQuote(id, user);
  if (!row) throw httpError(404, 'Quote request not found');
  const [files, lines] = await Promise.all([
    filesFor(id),
    lineItemsFor([id]),
  ]);
  return presentQuote(row, {
    viewer: user,
    files,
    line_items: lines.get(id) || [],
    file_count: files.length,
  });
}

async function createQuote(user, body) {
  if (!isCustomer(user)) throw httpError(403, 'Only a customer can request a quote');
  const source = body || {};
  if (typeof source !== 'object' || Array.isArray(source)) throw httpError(400, 'Request body must be an object');
  const projectName = failText(source.project_name, 'project_name', 160, { required: true });
  const description = failText(source.description, 'description', 4000, { required: true, allowNewlines: true });
  const quantity = failText(source.quantity, 'quantity', 40, { required: true });
  const size = failText(source.size, 'size', 120);
  const material = failText(source.material, 'material', 160);
  const finishing = failText(source.finishing, 'finishing', 2000, { allowNewlines: true });
  const neededBy = parseDate(source.needed_by, 'needed_by', true);
  const fileIds = parseFileIds(source.file_ids);
  const customerId = actorId(user);

  const id = await withTransaction(async (tx) => {
    if (fileIds.length) {
      const files = await tx.all(
        `SELECT id, order_id, customer_id, quote_request_id
         FROM order_files
         WHERE id IN (${fileIds.map(() => '?').join(', ')})`,
        fileIds
      );
      if (files.length !== fileIds.length) throw httpError(404, 'One or more files could not be found');
      for (const file of files) {
        if (Number(file.customer_id) !== customerId) throw httpError(404, 'One or more files could not be found');
        if (file.order_id) throw httpError(400, 'A file is already attached to an order');
        if (file.quote_request_id) throw httpError(400, 'A file is already attached to a quote request');
      }
    }
    const location = await shopLocations.resolveOrderLocation(tx, user, source.location_id, customerId);
    const inserted = await tx.run(
      `INSERT INTO quote_requests (
        customer_id, location_id, project_name, description, quantity, size, material, finishing, needed_by,
        status, created_by, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?, 'New', ?, datetime('now'))`,
      [customerId, location.value, projectName, description, quantity, size, material, finishing, neededBy, customerId]
    );
    for (const fileId of fileIds) {
      const updated = await tx.run(
        `UPDATE order_files
         SET quote_request_id = ?
         WHERE id = ? AND customer_id = ? AND order_id IS NULL AND quote_request_id IS NULL`,
        [inserted.lastID, fileId, customerId]
      );
      if (!updated.changes) throw httpError(400, 'A file is already attached');
    }
    await activityLog.recordOn(tx, customerId, 'quote_request.created', 'quote_request', inserted.lastID, {
      project_name: projectName,
      message: `Created quote request for ${projectName}`,
    });
    return inserted.lastID;
  });
  const quote = await getQuote(user, id);
  const customerLabel = quote.customer_name || 'a customer';
  try {
    await notify(notifications.notifyQuoteRequested, {
      quoteRequestId: id,
      locationId: quote.location_id,
      title: `New quote request from ${customerLabel}: ${quote.project_name}`,
      body: quote.needed_by ? `Needed by ${quote.needed_by}.` : '',
      dedupeKey: `quote_requested:${id}`,
    });
  } catch (err) {
    console.error('QUOTE REQUEST NOTIFICATION ERROR:', err);
  }
  try {
    await emailNewQuoteRequest(user, quote);
  } catch (err) {
    console.error('QUOTE REQUEST EMAIL ERROR:', err);
  }
  return quote;
}

function notify(fn, item) {
  return new Promise((resolve, reject) => {
    fn(item, (err, created) => (err ? reject(err) : resolve(created || [])));
  });
}

async function inAppEventEnabled(eventKey) {
  const row = await get(
    `SELECT enabled FROM notification_settings WHERE event_key = ? AND channel = 'in_app'`,
    [eventKey]
  );
  if (!row) return true;
  return Number(row.enabled) !== 0;
}

async function quoteStaffEmails(locationId) {
  const params = [];
  let locationSql = '';
  if (locationId != null) {
    locationSql = ` AND (role = 'admin' OR location_id IS NULL OR location_id = ?)`;
    params.push(locationId);
  }
  const rows = await all(
    `SELECT email FROM users
     WHERE role IN ('admin', 'manager')
       AND COALESCE(is_active, 1) = 1
       AND email IS NOT NULL
       AND trim(email) != ''
       ${locationSql}
     ORDER BY id`,
    params
  );
  const addresses = [];
  const seen = new Set();
  for (const row of rows) {
    const parsed = mailer.parseAddressList(row.email, { max: 1, field: 'email' });
    if (parsed.error || !parsed.value || parsed.value.length !== 1) continue;
    const address = parsed.value[0];
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
  }
  return addresses;
}

async function emailNewQuoteRequest(user, quote) {
  if (!mailer.isConfigured()) return { status: 'not_configured', recipients: [] };
  if (!(await inAppEventEnabled('quote_requested'))) return { status: 'disabled', recipients: [] };
  const addresses = await quoteStaffEmails(quote && quote.location_id);
  if (!addresses.length) return { status: 'no_recipients', recipients: [] };
  const slot = mailer.reserveEmail(actorId(user));
  if (!slot.allowed) return { status: 'rate_limited', recipients: [] };
  let letterhead;
  try {
    letterhead = shopLocations.overlayLetterhead(await loadLetterhead(), {
      name: quote.location_name,
      address: quote.location_address,
      phone: quote.location_phone,
    });
  } catch (err) {
    console.error('LETTERHEAD ERROR:', err.message || err);
    letterhead = { name: '', address_lines: [], phone: '' };
  }
  const rendered = mailer.renderQuoteRequestEmail({
    letterhead,
    customerName: quote.customer_name,
    projectName: quote.project_name,
    neededBy: quote.needed_by,
    link: mailer.staffQuoteLink(quote.id),
  });
  const result = await mailer.deliver({
    to: addresses[0],
    cc: addresses.slice(1),
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
  if (result.status === 'sent' || result.status === 'failed') {
    try {
      await activityLog.record(
        actorId(user),
        result.status === 'sent' ? 'quote_request.staff_emailed' : 'quote_request.staff_email_failed',
        'quote_request',
        quote.id,
        {
          project_name: quote.project_name,
          recipients: addresses,
          subject: rendered.subject,
          message: result.status === 'sent'
            ? `Emailed managers about the quote request for ${quote.project_name}`
            : `Could not email managers about the quote request for ${quote.project_name}`,
        }
      );
    } catch (err) {
      console.error('QUOTE REQUEST EMAIL LOG ERROR:', err);
    }
  }
  return { status: result.status, recipients: result.recipients };
}

async function emailQuote(user, quote, version) {
  if (!mailer.isConfigured()) return { status: 'not_configured', recipients: [] };
  const parsed = mailer.parseAddressList(quote.customer_email, { max: 1, field: 'email' });
  if (parsed.error || !parsed.value || parsed.value.length !== 1) {
    return { status: 'no_recipient', recipients: [] };
  }
  const slot = mailer.reserveEmail(actorId(user));
  if (!slot.allowed) return { status: 'rate_limited', recipients: [] };
  let letterhead;
  try {
    letterhead = shopLocations.overlayLetterhead(await loadLetterhead(), {
      name: quote.location_name,
      address: quote.location_address,
      phone: quote.location_phone,
    });
  } catch (err) {
    console.error('LETTERHEAD ERROR:', err.message || err);
    letterhead = { name: '', address_lines: [], phone: '' };
  }
  const rendered = mailer.renderQuoteEmail({
    letterhead,
    projectName: quote.project_name,
    price: quote.price_label || moneyLabel(quote.price),
    notes: quote.quote_notes,
    validUntil: quote.valid_until,
    lineItems: quote.line_items || [],
    link: mailer.quoteLink(quote.id),
  });
  const result = await mailer.deliver({
    to: parsed.value[0],
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
  const email = { status: result.status, recipients: result.recipients };
  const preview = mailer.previewFrom(result.captured);
  if (preview) email.preview = preview;
  if (result.status === 'sent' || result.status === 'failed') {
    try {
      await activityLog.record(
        actorId(user),
        result.status === 'sent' ? 'quote_request.emailed' : 'quote_request.email_failed',
        'quote_request',
        quote.id,
        {
          project_name: quote.project_name,
          version,
          recipient: parsed.value[0],
          message: result.status === 'sent'
            ? `Emailed the quote for ${quote.project_name}`
            : `Could not email the quote for ${quote.project_name}`,
        }
      );
    } catch (err) {
      console.error('QUOTE EMAIL LOG ERROR:', err);
    }
  }
  return email;
}

async function sendQuote(user, rawId, body) {
  if (!isQuoteStaff(user)) throw httpError(403, 'Forbidden');
  const id = parseRequestId(rawId);
  const source = body || {};
  if (typeof source !== 'object' || Array.isArray(source)) throw httpError(400, 'Request body must be an object');
  const price = parseMoney(source.price, 'price', true);
  const notes = failText(source.notes != null ? source.notes : source.quote_notes, 'notes', 4000, { allowNewlines: true });
  const validUntil = parseDate(source.valid_until, 'valid_until', false);
  const lines = parseLineItems(source.line_items);

  const saved = await withTransaction(async (tx) => {
    const quote = await tx.get('SELECT * FROM quote_requests WHERE id = ?', [id]);
    if (!quote) throw httpError(404, 'Quote request not found');
    if (quote.converted_order_id) throw httpError(409, 'This quote was already converted to an order');
    const version = Number(quote.quote_version || 0) + 1;
    const updated = await tx.run(
      `UPDATE quote_requests
       SET status = 'Quoted',
           price = ?,
           quote_notes = ?,
           valid_until = ?,
           quote_version = ?,
           quoted_by = ?,
           quoted_at = datetime('now'),
           decided_at = NULL,
           decline_reason = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND converted_order_id IS NULL`,
      [price, notes, validUntil, version, actorId(user), id]
    );
    if (!updated.changes) throw httpError(409, 'This quote was already converted to an order');
    if (lines) {
      await tx.run('DELETE FROM quote_line_items WHERE quote_request_id = ?', [id]);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        await tx.run(
          `INSERT INTO quote_line_items (quote_request_id, line_number, code, unit, quantity, description, price)
           VALUES (?,?,?,?,?,?,?)`,
          [id, index + 1, line.code, line.unit, line.quantity, line.description, line.price]
        );
      }
    }
    await activityLog.recordOn(tx, actorId(user), 'quote_request.quoted', 'quote_request', id, {
      project_name: quote.project_name,
      price,
      version,
      message: version > 1
        ? `Revised the quote for ${quote.project_name}`
        : `Sent a quote for ${quote.project_name}`,
    });
    return { version, projectName: quote.project_name };
  });

  const quote = await getQuote(user, id);
  try {
    await notify(notifications.notifyQuoteReady, {
      quoteRequestId: id,
      customerId: quote.customer_id,
      locationId: quote.location_id,
      title: `Quote ready for ${saved.projectName}`,
      body: [quote.price_label, quote.valid_until ? `Valid until ${quote.valid_until}` : '']
        .filter(Boolean)
        .join('. '),
      dedupeKey: `quote_ready:${id}:v${saved.version}`,
    });
  } catch (err) {
    console.error('QUOTE NOTIFICATION ERROR:', err);
  }
  let email = { status: 'not_configured', recipients: [] };
  try {
    email = await emailQuote(user, quote, saved.version);
  } catch (err) {
    console.error('QUOTE EMAIL ERROR:', err);
    email = { status: 'failed', recipients: [] };
  }
  return { quote, email };
}

async function decide(user, rawId, decision, body) {
  if (!isCustomer(user)) throw httpError(403, 'Only the customer can accept or decline a quote');
  const id = parseRequestId(rawId);
  const accept = decision === 'accept';
  const source = body || {};
  const reason = accept
    ? null
    : failText(source.reason, 'reason', 1000, { allowNewlines: true });
  const saved = await withTransaction(async (tx) => {
    const quote = await tx.get(
      'SELECT * FROM quote_requests WHERE id = ? AND customer_id = ?',
      [id, actorId(user)]
    );
    if (!quote) throw httpError(404, 'Quote request not found');
    if (quote.converted_order_id) throw httpError(409, 'This quote was already converted to an order');
    if (quote.status !== 'Quoted') throw httpError(409, 'A quote can be accepted or declined after it is sent');
    const status = accept ? 'Accepted' : 'Declined';
    const updated = await tx.run(
      `UPDATE quote_requests
       SET status = ?,
           decline_reason = ?,
           decided_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ? AND customer_id = ? AND status = 'Quoted' AND converted_order_id IS NULL`,
      [status, reason, id, actorId(user)]
    );
    if (!updated.changes) throw httpError(409, 'A quote can be accepted or declined after it is sent');
    await activityLog.recordOn(
      tx,
      actorId(user),
      accept ? 'quote_request.accepted' : 'quote_request.declined',
      'quote_request',
      id,
      {
        project_name: quote.project_name,
        reason: reason || null,
        message: accept
          ? `Accepted the quote for ${quote.project_name}`
          : `Declined the quote for ${quote.project_name}`,
      }
    );
    return {
      projectName: quote.project_name,
      price: quote.price,
      version: quote.quote_version || 1,
      customerName: null,
    };
  });
  const quote = await getQuote(user, id);
  if (accept) {
    try {
      await notify(notifications.notifyQuoteAccepted, {
        quoteRequestId: id,
        locationId: quote.location_id,
        title: `Quote accepted for ${saved.projectName}`,
        body: `${quote.customer_name || 'A customer'} accepted the quote${quote.price_label ? ` (${quote.price_label})` : ''}.`,
        dedupeKey: `quote_accepted:${id}:v${saved.version}`,
      });
    } catch (err) {
      console.error('QUOTE ACCEPT NOTIFICATION ERROR:', err);
    }
  } else {
    const reasonText = String(reason || '').trim();
    const who = quote.customer_name || 'A customer';
    try {
      await notify(notifications.notifyQuoteDeclined, {
        quoteRequestId: id,
        locationId: quote.location_id,
        title: `Quote declined for ${saved.projectName}`,
        body: reasonText
          ? `${who} declined the quote. Reason: ${reasonText}`
          : `${who} declined the quote.`,
        dedupeKey: `quote_declined:${id}:v${saved.version}`,
      });
    } catch (err) {
      console.error('QUOTE DECLINE NOTIFICATION ERROR:', err);
    }
  }
  return quote;
}

function suggestedDueDate(neededBy) {
  if (!neededBy) return null;
  const [year, month, day] = neededBy.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  const today = businessToday().iso;
  if (neededBy < today) return null;
  return neededBy;
}

function clip(value, max) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function draftNotes(quote, lines) {
  const parts = [
    `From quote request #${quote.id}: ${quote.project_name}`,
    quote.quantity ? `Quantity: ${quote.quantity}` : '',
    quote.size ? `Size: ${quote.size}` : '',
    quote.material ? `Material / stock: ${quote.material}` : '',
    quote.finishing ? `Finishing: ${quote.finishing}` : '',
    quote.needed_by ? `Needed by: ${quote.needed_by}` : '',
    quote.description ? `Specs:\n${quote.description}` : '',
    quote.price ? `Quoted price: ${moneyLabel(quote.price)}` : '',
    quote.valid_until ? `Quote valid until: ${quote.valid_until}` : '',
    quote.quote_notes ? `Quote notes:\n${quote.quote_notes}` : '',
  ];
  if (lines.length) {
    parts.push('Quote lines:');
    for (const line of lines) {
      parts.push([line.code, line.unit, line.quantity, line.description, line.price ? moneyLabel(line.price) : '']
        .filter(Boolean)
        .join(' · '));
    }
  }
  return clip(parts.filter(Boolean).join('\n'), 2000);
}

async function orderDraft(user, rawId) {
  if (!isQuoteStaff(user)) throw httpError(403, 'Forbidden');
  const id = parseRequestId(rawId);
  const quote = await loadQuote(id, user);
  if (!quote) throw httpError(404, 'Quote request not found');
  if (quote.converted_order_id) {
    throw httpError(409, `This quote was already converted to order ${quote.order_number || quote.converted_order_id}`);
  }
  if (quote.status !== 'Accepted') throw httpError(409, 'Accept the quote before converting it to an order');
  const [files, lines] = await Promise.all([filesFor(id), lineItemsFor([id])]);
  const unattached = files.filter((file) => !file.order_id).map((file) => {
    const next = { ...file };
    delete next.order_id;
    return next;
  });
  return {
    quote_request_id: quote.id,
    customer_id: quote.customer_id,
    company: quote.customer_company || quote.customer_display_name || '',
    contact_name: quote.customer_contact_name || quote.customer_name || '',
    phone: quote.customer_phone || '',
    email: quote.customer_email || '',
    address_line1: quote.customer_address_line1 || '',
    address_line2: quote.customer_address_line2 || '',
    city: quote.customer_city || '',
    state: quote.customer_state || '',
    zip: quote.customer_zip || '',
    project_name: quote.project_name,
    notes: draftNotes(quote, lines.get(id) || []),
    due_date: suggestedDueDate(quote.needed_by),
    needed_by: quote.needed_by || null,
    files: unattached,
    originals_source: unattached.length ? 'Files attached below' : null,
  };
}

async function attachConversion(tx, user, rawId, orderId, customerId) {
  if (!isQuoteStaff(user)) throw httpError(403, 'Only a manager or admin can convert a quote to an order');
  const id = parseRequestId(rawId);
  const quote = await tx.get(
    'SELECT id, customer_id, status, project_name, converted_order_id FROM quote_requests WHERE id = ?',
    [id]
  );
  if (!quote) throw httpError(404, 'Quote request not found');
  if (Number(quote.customer_id) !== Number(customerId)) {
    throw httpError(400, 'Quote request is for a different customer');
  }
  if (quote.converted_order_id) throw httpError(409, 'This quote was already converted to an order');
  if (quote.status !== 'Accepted') throw httpError(400, 'Only an accepted quote can be converted to an order');
  const updated = await tx.run(
    `UPDATE quote_requests
     SET converted_order_id = ?, updated_at = datetime('now')
     WHERE id = ? AND status = 'Accepted' AND converted_order_id IS NULL`,
    [orderId, id]
  );
  if (!updated.changes) throw httpError(409, 'This quote was already converted to an order');
  await activityLog.recordOn(tx, actorId(user), 'quote_request.converted', 'quote_request', id, {
    project_name: quote.project_name,
    order_id: orderId,
    message: `Converted quote request ${id} to an order`,
  });
}

module.exports = {
  summary,
  listQuotes,
  getQuote,
  createQuote,
  sendQuote,
  decide,
  orderDraft,
  attachConversion,
  moneyLabel,
};
