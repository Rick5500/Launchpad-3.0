const activityLog = require('./activityLog');
const { matchSender, parseDraft } = require('./emailDraft');
const graphMail = require('./graphMail');
const { htmlToText, plainText, singleLine, subjectLine } = require('./htmlText');
const { httpError } = require('./httpError');
const { all, get, run } = require('./dbAsync');
const {
  ALLOWED_EXTENSIONS,
  contentTypeFor,
  extensionOf,
  maxUploadBytes,
  maxUploadMb,
  sanitizeOriginalName,
  openStored,
  removeStored,
  writeNewFile,
  copyToCurrentRoot,
} = require('./fileStore');
const { createOrder } = require('./orderService');
const shopLocations = require('./shopLocations');

const STATUSES = new Set(['new', 'converted', 'dismissed', 'converting']);
const LIST_STATUSES = new Set(['new', 'converted', 'dismissed']);

function safeErrorText(err) {
  const message = String((err && (err.publicMessage || err.message)) || 'Mailbox request failed');
  return message
    .replace(/client_secret=[^&\s]+/gi, 'client_secret=(redacted)')
    .replace(/https?:\/\/\S+/g, '[url]')
    .slice(0, 500);
}

async function readState() {
  await run(
    `INSERT INTO inbound_mail_state (id)
     SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM inbound_mail_state WHERE id = 1)`
  );
  return get('SELECT * FROM inbound_mail_state WHERE id = 1');
}

async function recoverStaleConversions() {
  await run(
    `UPDATE inbound_emails
     SET status = 'new', updated_at = datetime('now')
     WHERE status = 'converting'
       AND datetime(updated_at) <= datetime('now', '-2 minutes')`
  );
}

async function loadCustomers() {
  return all(
    `SELECT id, username, display_name, company, contact_name, phone, email,
            address_line1, address_line2, city, state, zip
     FROM users
     WHERE role = 'customer' AND COALESCE(is_active, 1) = 1`
  );
}

function suggestionFrom(row, customers) {
  let extracted = {};
  try {
    extracted = row.suggestion_json ? JSON.parse(row.suggestion_json) : {};
  } catch (err) {
    extracted = {};
  }
  const matched = matchSender(customers, row.from_address);
  const customer = matched.customer;
  return {
    customer_id: customer ? customer.id : null,
    match: matched.match,
    candidate_ids: matched.candidates.map((item) => item.id),
    company: customer ? (customer.company || customer.display_name || '') : '',
    contact_name: customer ? (customer.contact_name || '') : '',
    phone: customer ? (customer.phone || '') : '',
    email: customer ? (customer.email || row.from_address || '') : (row.from_address || ''),
    address_line1: customer ? (customer.address_line1 || '') : '',
    address_line2: customer ? (customer.address_line2 || '') : '',
    city: customer ? (customer.city || '') : '',
    state: customer ? (customer.state || '') : '',
    zip: customer ? (customer.zip || '') : '',
    po_number: extracted.po_number || '',
    due_date: extracted.due_date || '',
    quantity: extracted.quantity || '',
    job_description: extracted.job_description || '',
    project_name: extracted.project_name || '',
    notes: extracted.notes || '',
  };
}

function presentAttachment(row) {
  return {
    id: row.id,
    original_name: row.original_name,
    mime_type: row.mime_type || null,
    size_bytes: row.size_bytes || 0,
    skipped_reason: row.skipped_reason || null,
    stored: Boolean(row.stored_name),
  };
}

function presentSummary(row, customers) {
  const suggestion = suggestionFrom(row, customers);
  return {
    id: row.id,
    from_address: row.from_address || '',
    from_name: row.from_name || '',
    subject: row.subject || '',
    received_at: row.received_at || null,
    status: row.status,
    location_id: row.location_id || null,
    location_name: row.location_name || null,
    order_id: row.order_id || null,
    order_number: row.order_number || null,
    matched_customer_id: suggestion.customer_id,
    matched_customer_name: suggestion.company || null,
    suggestion: {
      customer_id: suggestion.customer_id,
      match: suggestion.match,
      candidate_ids: suggestion.candidate_ids,
      po_number: suggestion.po_number,
      due_date: suggestion.due_date,
      quantity: suggestion.quantity,
      project_name: suggestion.project_name,
    },
  };
}

async function attachmentsFor(emailId) {
  return all(
    `SELECT id, original_name, mime_type, size_bytes, skipped_reason, stored_name
     FROM inbound_email_attachments
     WHERE inbound_email_id = ?
     ORDER BY id`,
    [emailId]
  );
}

async function presentDetail(row, customers) {
  const summary = presentSummary(row, customers);
  const suggestion = suggestionFrom(row, customers);
  const attachments = await attachmentsFor(row.id);
  return {
    ...summary,
    body_text: row.body_text || '',
    suggestion,
    attachments: attachments.map(presentAttachment),
  };
}

function parseLimit(value) {
  if (value == null || value === '') return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw httpError(400, 'limit must be an integer from 1 to 100');
  }
  return parsed;
}

function parseOffset(value) {
  if (value == null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw httpError(400, 'offset must be a positive integer or zero');
  return parsed;
}

function parseId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw httpError(400, 'id must be a positive integer');
  return parsed;
}

async function assertEmailVisible(user, row) {
  if (!user || !row) return;
  const access = await shopLocations.loadAccess(user.userId || user.id);
  shopLocations.assertVisible(access, row.location_id, 'Email not found');
}

async function listEmails(query, user) {
  const source = query || {};
  const limit = parseLimit(source.limit);
  const offset = parseOffset(source.offset);
  const params = [];
  const clauses = [];
  if (source.status != null && String(source.status).trim() !== '' && String(source.status).trim() !== 'all') {
    const status = String(source.status).trim().toLowerCase();
    if (!LIST_STATUSES.has(status)) throw httpError(400, 'status must be new, converted, dismissed, or all');
    clauses.push('e.status = ?');
    params.push(status);
  }
  if (user) {
    const access = await shopLocations.loadAccess(user.userId || user.id);
    const pred = shopLocations.predicate('e.location_id', access);
    if (pred.sql) {
      clauses.push(pred.sql);
      params.push(...pred.params);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const totalRow = await get(`SELECT COUNT(*) AS count FROM inbound_emails e ${where}`, params);
  const rows = await all(
    `SELECT e.*, o.order_number, l.name AS location_name
     FROM inbound_emails e
     LEFT JOIN orders o ON o.id = e.order_id
     LEFT JOIN locations l ON l.id = e.location_id
     ${where}
     ORDER BY e.received_at DESC, e.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const customers = await loadCustomers();
  return {
    emails: rows.map((row) => presentSummary(row, customers)),
    total: totalRow ? totalRow.count : 0,
    limit,
    offset,
  };
}

async function getEmail(id, user) {
  const emailId = parseId(id);
  const row = await get(
    `SELECT e.*, o.order_number, l.name AS location_name
     FROM inbound_emails e
     LEFT JOIN orders o ON o.id = e.order_id
     LEFT JOIN locations l ON l.id = e.location_id
     WHERE e.id = ?`,
    [emailId]
  );
  if (!row) return null;
  if (user) await assertEmailVisible(user, row);
  return presentDetail(row, await loadCustomers());
}

function messageBody(message) {
  const body = message && message.body ? message.body : {};
  const contentType = String(body.contentType || '').toLowerCase();
  const content = body.content != null ? body.content : (message && message.bodyPreview) || '';
  if (contentType === 'text') return plainText(content);
  return htmlToText(content);
}

async function insertSkipped(emailId, attachment, reason) {
  const name = sanitizeOriginalName(attachment && attachment.name ? attachment.name : 'attachment');
  await run(
    `INSERT OR IGNORE INTO inbound_email_attachments (
      inbound_email_id, graph_attachment_id, original_name, mime_type, size_bytes, skipped_reason
    ) VALUES (?,?,?,?,?,?)`,
    [
      emailId,
      attachment && attachment.id ? String(attachment.id).slice(0, 200) : null,
      name,
      attachment && attachment.contentType ? String(attachment.contentType).slice(0, 200) : null,
      Number(attachment && attachment.size) || 0,
      reason,
    ]
  );
}

async function storeAttachment(emailId, attachment) {
  const graphId = attachment && attachment.id ? String(attachment.id).slice(0, 200) : null;
  if (graphId) {
    const existing = await get(
      `SELECT id FROM inbound_email_attachments
       WHERE inbound_email_id = ? AND graph_attachment_id = ?`,
      [emailId, graphId]
    );
    if (existing) return;
  }
  const odata = String(attachment && attachment['@odata.type'] || '').toLowerCase();
  if (attachment && attachment.isInline) {
    await insertSkipped(emailId, attachment, 'Inline attachments are skipped');
    return;
  }
  if (odata && !odata.includes('fileattachment')) {
    await insertSkipped(emailId, attachment, 'Only file attachments are saved');
    return;
  }
  const ext = extensionOf(attachment && attachment.name);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    await insertSkipped(emailId, attachment, 'Allowed file types are pdf, images, dwg, zip, and plt');
    return;
  }
  const mime = String(attachment.contentType || '').toLowerCase();
  if (/text\/html|application\/(javascript|x-msdownload|x-httpd-php|x-sh|xhtml)/.test(mime)) {
    await insertSkipped(emailId, attachment, 'This file type is not allowed');
    return;
  }
  const declared = Number(attachment.size) || 0;
  if (declared > maxUploadBytes()) {
    await insertSkipped(emailId, attachment, `File exceeds the ${maxUploadMb()} MB limit`);
    return;
  }
  const bytes = attachment.contentBytes ? Buffer.from(String(attachment.contentBytes), 'base64') : Buffer.alloc(0);
  if (!bytes.length) {
    await insertSkipped(emailId, attachment, 'Empty files are not allowed');
    return;
  }
  if (bytes.length > maxUploadBytes()) {
    await insertSkipped(emailId, attachment, `File exceeds the ${maxUploadMb()} MB limit`);
    return;
  }
  const written = writeNewFile(ext, bytes);
  await run(
    `INSERT OR IGNORE INTO inbound_email_attachments (
      inbound_email_id, graph_attachment_id, original_name, stored_name, mime_type, size_bytes, storage_root
    ) VALUES (?,?,?,?,?,?,?)`,
    [
      emailId,
      graphId,
      sanitizeOriginalName(attachment.name),
      written.storedName,
      contentTypeFor(written.storedName),
      written.size,
      written.storageRoot,
    ]
  );
}

async function downloadAttachments(emailId, message, token) {
  if (!message || !message.hasAttachments || !message.id) return;
  const count = await get(
    'SELECT COUNT(*) AS count FROM inbound_email_attachments WHERE inbound_email_id = ?',
    [emailId]
  );
  if (count && count.count > 0) return;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  const page = await graphMail.fetchJson(graphMail.attachmentsUrl(message.id), { headers });
  for (const item of page.value || []) {
    let attachment = item;
    try {
      const ext = extensionOf(attachment && attachment.name);
      const declared = Number(attachment && attachment.size) || 0;
      const needsBytes = attachment && !attachment.contentBytes && attachment.id
        && !attachment.isInline
        && ALLOWED_EXTENSIONS.has(ext)
        && declared <= maxUploadBytes();
      if (needsBytes) {
        attachment = await graphMail.fetchJson(
          `${graphMail.attachmentsUrl(message.id)}/${encodeURIComponent(attachment.id)}`,
          { headers }
        );
      }
      await storeAttachment(emailId, attachment);
    } catch (err) {
      console.error('INBOUND ATTACHMENT ERROR:', err.status || '', safeErrorText(err));
      await insertSkipped(emailId, attachment, 'The attachment could not be saved').catch(() => {});
    }
  }
}

async function ingestMessage(message, token) {
  if (!message || !message.id || message['@removed']) return { skipped: true };
  const graphId = String(message.id).slice(0, 400);
  const from = message.from && message.from.emailAddress ? message.from.emailAddress : {};
  const subject = subjectLine(message.subject || '');
  const bodyText = messageBody(message);
  const draft = parseDraft(subject, bodyText);
  const received = message.receivedDateTime ? String(message.receivedDateTime).slice(0, 40) : null;
  const locationId = await shopLocations.defaultLocationId();
  const inserted = await run(
    `INSERT OR IGNORE INTO inbound_emails (
      graph_message_id, mailbox, from_address, from_name, subject, received_at,
      body_text, status, suggestion_json, location_id, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,'new',?,?,datetime('now'),datetime('now'))`,
    [
      graphId,
      graphMail.mailbox(),
      singleLine(from.address || '').slice(0, 320),
      singleLine(from.name || '').slice(0, 200),
      subject,
      received,
      bodyText,
      JSON.stringify(draft),
      locationId,
    ]
  );
  const row = await get('SELECT id FROM inbound_emails WHERE graph_message_id = ?', [graphId]);
  if (!row) return { skipped: true };
  try {
    await downloadAttachments(row.id, message, token);
  } catch (err) {
    console.error('INBOUND ATTACHMENT ERROR:', err.status || '', safeErrorText(err));
  }
  return inserted.changes ? { created: true, id: row.id } : { duplicate: true, id: row.id };
}

let inflight = null;

async function doSync() {
  if (!graphMail.isConfigured()) throw httpError(400, 'Microsoft 365 mailbox is not configured');
  await recoverStaleConversions();
  const state = await readState();
  const token = await graphMail.getToken();
  let url = state.delta_link || graphMail.initialDeltaUrl(state.watermark);
  const startedFromSavedDelta = Boolean(state.delta_link);
  let usedSavedDelta = startedFromSavedDelta;
  let resumeLink = state.delta_link || null;
  let watermark = state.watermark || null;
  let imported = 0;
  let duplicates = 0;
  let pages = 0;
  const pageCap = 25;
  while (url && pages < pageCap) {
    pages += 1;
    let page;
    try {
      page = await graphMail.fetchJson(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          Prefer: 'odata.maxpagesize=50',
        },
      });
    } catch (err) {
      if (err.status === 410 && usedSavedDelta) {
        usedSavedDelta = false;
        resumeLink = null;
        url = graphMail.initialDeltaUrl(watermark);
        continue;
      }
      throw err;
    }
    for (const message of page.value || []) {
      const result = await ingestMessage(message, token);
      if (result.created) imported += 1;
      else if (result.duplicate) duplicates += 1;
      const received = message && message.receivedDateTime ? String(message.receivedDateTime) : '';
      if (received && (!watermark || received > watermark)) watermark = received;
    }
    if (page['@odata.nextLink']) {
      url = page['@odata.nextLink'];
      resumeLink = url;
      usedSavedDelta = false;
    } else {
      if (page['@odata.deltaLink']) resumeLink = page['@odata.deltaLink'];
      url = null;
    }
  }
  await run(
    `UPDATE inbound_mail_state
     SET delta_link = ?, watermark = ?, last_attempt_at = datetime('now'),
         last_success_at = datetime('now'), last_status = 'ok', last_error = NULL,
         last_imported = ?
     WHERE id = 1`,
    [resumeLink, watermark, imported]
  );
  return { imported, duplicates, last_status: 'ok' };
}

function syncOnce() {
  if (inflight) return inflight;
  inflight = doSync().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function recordSyncError(err) {
  const message = safeErrorText(err);
  try {
    await readState();
    await run(
      `UPDATE inbound_mail_state
       SET last_attempt_at = datetime('now'), last_status = 'error', last_error = ?
       WHERE id = 1`,
      [message]
    );
  } catch (writeErr) {
    console.error('INBOUND MAIL STATUS ERROR:', safeErrorText(writeErr));
  }
  return message;
}

async function syncStatus(user) {
  const state = await readState().catch(() => null);
  const config = graphMail.publicConfig();
  const admin = user && user.role === 'admin';
  const error = state && state.last_error ? state.last_error : null;
  return {
    ...config,
    polling_enabled: true,
    last_attempt_at: state ? state.last_attempt_at || null : null,
    last_success_at: state ? state.last_success_at || null : null,
    last_status: state ? state.last_status || null : null,
    last_imported: state && state.last_imported != null ? state.last_imported : null,
    last_error: error ? (admin ? error : 'The last mailbox check failed') : null,
  };
}

async function attachmentDownload(user, emailId, attachmentId) {
  const email = await loadRow(parseId(emailId));
  if (!email) return null;
  await assertEmailVisible(user, email);
  const file = await get(
    `SELECT id, original_name, stored_name, storage_root, skipped_reason
     FROM inbound_email_attachments
     WHERE id = ? AND inbound_email_id = ?`,
    [parseId(attachmentId), parseId(emailId)]
  );
  if (!file || file.skipped_reason || !file.stored_name) return null;
  const opened = openStored(file.stored_name, file.storage_root);
  if (!opened) return null;
  return {
    path: opened.fullPath,
    name: sanitizeOriginalName(file.original_name),
    contentType: contentTypeFor(file.stored_name),
  };
}

function parseAttachmentIds(body) {
  if (!body || body.attachment_ids == null) return null;
  if (!Array.isArray(body.attachment_ids)) throw httpError(400, 'attachment_ids must be an array');
  return body.attachment_ids.map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw httpError(400, 'attachment_ids must be positive integers');
    }
    return parsed;
  });
}

function removeStoredCopy(storedName, storageRoot) {
  removeStored(storedName, storageRoot);
}

async function discardMaterialized(created) {
  for (const item of created || []) {
    const removed = await run(
      'DELETE FROM order_files WHERE id = ? AND order_id IS NULL',
      [item.orderFileId]
    );
    await run(
      'UPDATE inbound_email_attachments SET order_file_id = NULL WHERE id = ? AND order_file_id = ?',
      [item.attachmentId, item.orderFileId]
    );
    if (removed.changes) removeStoredCopy(item.storedName, item.storageRoot);
  }
}

function copyStoredFile(storedName, storageRoot) {
  return copyToCurrentRoot(storedName, storageRoot);
}

async function materializeAttachments(user, emailId, customerId, attachmentIds) {
  const rows = await all(
    `SELECT id, original_name, stored_name, storage_root, mime_type, size_bytes, order_file_id
     FROM inbound_email_attachments
     WHERE inbound_email_id = ? AND stored_name IS NOT NULL AND skipped_reason IS NULL
     ORDER BY id`,
    [emailId]
  );
  const chosen = attachmentIds
    ? rows.filter((row) => attachmentIds.includes(row.id))
    : rows;
  const ids = [];
  const created = [];
  const userId = Number(user.userId || user.id);
  try {
    for (const row of chosen) {
      if (row.order_file_id) {
        const existing = await get(
          'SELECT id, stored_name, storage_root, order_id FROM order_files WHERE id = ?',
          [row.order_file_id]
        );
        const reusable = existing
          && !existing.order_id
          && existing.stored_name
          && existing.stored_name !== row.stored_name
          && openStored(existing.stored_name, existing.storage_root);
        if (reusable) {
          await run(
            'UPDATE order_files SET customer_id = ?, uploaded_by = ? WHERE id = ? AND order_id IS NULL',
            [customerId, userId, existing.id]
          );
          ids.push(existing.id);
          created.push({
            orderFileId: existing.id,
            attachmentId: row.id,
            storedName: existing.stored_name,
            storageRoot: existing.storage_root,
          });
          continue;
        }
        if (existing && !existing.order_id) {
          await run('DELETE FROM order_files WHERE id = ? AND order_id IS NULL', [existing.id]);
          if (existing.stored_name && existing.stored_name !== row.stored_name) {
            removeStoredCopy(existing.stored_name, existing.storage_root);
          }
        }
        await run(
          'UPDATE inbound_email_attachments SET order_file_id = NULL WHERE id = ?',
          [row.id]
        );
      }
      const copied = copyStoredFile(row.stored_name, row.storage_root);
      if (!copied) continue;
      try {
        const inserted = await run(
          `INSERT INTO order_files (
            customer_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, storage_root
          ) VALUES (?,?,?,?,?,?,?)`,
          [
            customerId,
            userId,
            row.original_name,
            copied.storedName,
            row.mime_type || contentTypeFor(row.stored_name),
            copied.size,
            copied.storageRoot,
          ]
        );
        await run(
          'UPDATE inbound_email_attachments SET order_file_id = ? WHERE id = ?',
          [inserted.lastID, row.id]
        );
        created.push({
          orderFileId: inserted.lastID,
          attachmentId: row.id,
          storedName: copied.storedName,
          storageRoot: copied.storageRoot,
        });
        ids.push(inserted.lastID);
      } catch (err) {
        removeStoredCopy(copied.storedName, copied.storageRoot);
        throw err;
      }
    }
    return { ids, created };
  } catch (err) {
    await discardMaterialized(created);
    throw err;
  }
}

async function loadRow(id) {
  return get(
    `SELECT e.*, o.order_number
     FROM inbound_emails e
     LEFT JOIN orders o ON o.id = e.order_id
     WHERE e.id = ?`,
    [id]
  );
}

function alreadyConverted(row) {
  const error = httpError(409, row.order_number
    ? `This email was already converted to order ${row.order_number}`
    : 'This email was already converted');
  error.orderId = row.order_id || null;
  error.orderNumber = row.order_number || null;
  return error;
}

async function waitForRow(id) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const row = await loadRow(id);
    if (!row || row.status !== 'converting') return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return loadRow(id);
}

async function convertEmail(user, id, body) {
  const emailId = parseId(id);
  await recoverStaleConversions();
  const claim = await run(
    `UPDATE inbound_emails
     SET status = 'converting', updated_at = datetime('now')
     WHERE id = ? AND status = 'new'`,
    [emailId]
  );
  if (!claim.changes) {
    const row = await waitForRow(emailId);
    if (!row) throw httpError(404, 'Email not found');
    await assertEmailVisible(user, row);
    if (row.status === 'converted') throw alreadyConverted(row);
    if (row.status === 'dismissed') throw httpError(409, 'This email was dismissed');
    throw httpError(409, 'This email is already being converted');
  }

  const claimed = await loadRow(emailId);
  try {
    await assertEmailVisible(user, claimed);
  } catch (err) {
    await run(
      `UPDATE inbound_emails SET status = 'new', updated_at = datetime('now') WHERE id = ? AND status = 'converting'`,
      [emailId]
    );
    throw err;
  }

  let created = null;
  let materialized = [];
  try {
    const payload = { ...(body || {}) };
    if (payload.location_id == null || String(payload.location_id).trim() === '') {
      payload.location_id = claimed && claimed.location_id ? claimed.location_id : null;
    }
    const customerId = Number(payload.customer_id);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      throw httpError(400, 'customer_id must be an existing customer');
    }
    const customer = await get(
      'SELECT id, role, is_active FROM users WHERE id = ?',
      [customerId]
    );
    if (!customer || customer.role !== 'customer' || customer.is_active === 0) {
      throw httpError(400, 'customer_id must be an existing customer');
    }
    const attachmentIds = parseAttachmentIds(payload);
    delete payload.attachment_ids;
    const materializedResult = await materializeAttachments(user, emailId, customerId, attachmentIds);
    materialized = materializedResult.created;
    const merged = [...(Array.isArray(payload.file_ids) ? payload.file_ids : []), ...materializedResult.ids];
    payload.file_ids = [...new Set(merged)];
    created = await createOrder(user, payload);
    const orderId = created && created.order ? created.order.id : null;
    const updated = await run(
      `UPDATE inbound_emails
       SET status = 'converted', order_id = ?, converted_by = ?, converted_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ? AND status = 'converting'`,
      [orderId, Number(user.userId || user.id), emailId]
    );
    if (!updated.changes) throw httpError(409, 'This email was already converted');
    await activityLog.record(Number(user.userId || user.id), 'inbound_email.converted', 'inbound_email', emailId, {
      order_id: orderId,
      order_number: created.order_number || null,
      message: `Converted an inbound email to order ${created.order_number || orderId}`,
    }).catch((err) => {
      console.error('INBOUND MAIL ACTIVITY ERROR:', safeErrorText(err));
    });
    return created;
  } catch (err) {
    if (!created) {
      await discardMaterialized(materialized).catch((cleanupErr) => {
        console.error('INBOUND FILE CLEANUP ERROR:', safeErrorText(cleanupErr));
      });
      await run(
        `UPDATE inbound_emails
         SET status = 'new', updated_at = datetime('now')
         WHERE id = ? AND status = 'converting'`,
        [emailId]
      ).catch(() => {});
    }
    throw err;
  }
}

async function dismissEmail(user, id) {
  const emailId = parseId(id);
  const existing = await loadRow(emailId);
  if (!existing) throw httpError(404, 'Email not found');
  await assertEmailVisible(user, existing);
  if (existing.status === 'dismissed') return presentDetail(existing, await loadCustomers());
  if (existing.status === 'converted') throw alreadyConverted(existing);
  const updated = await run(
    `UPDATE inbound_emails
     SET status = 'dismissed', dismissed_by = ?, dismissed_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND status = 'new'`,
    [Number(user.userId || user.id), emailId]
  );
  if (!updated.changes) {
    const row = await loadRow(emailId);
    if (row && row.status === 'dismissed') return presentDetail(row, await loadCustomers());
    if (row && row.status === 'converted') throw alreadyConverted(row);
    throw httpError(409, 'This email is already being converted');
  }
  await activityLog.record(Number(user.userId || user.id), 'inbound_email.dismissed', 'inbound_email', emailId, {
    message: 'Dismissed an inbound email',
  }).catch((err) => {
    console.error('INBOUND MAIL ACTIVITY ERROR:', safeErrorText(err));
  });
  const row = await loadRow(emailId);
  return presentDetail(row, await loadCustomers());
}

module.exports = {
  STATUSES,
  listEmails,
  getEmail,
  syncOnce,
  syncStatus,
  recordSyncError,
  safeErrorText,
  attachmentDownload,
  convertEmail,
  dismissEmail,
  readState,
};
