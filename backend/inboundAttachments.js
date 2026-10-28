// Inbound attachment fetch, quarantine, and the admin exception path.
// New bytes are quarantined until a scanner verdict is clean. Placeholders are
// not files. The unscanned-file exception is off unless
// ALLOW_UNSCANNED_ATTACHMENT_EXCEPTION is explicitly true.

const crypto = require('crypto');
const activityLog = require('./activityLog');
const { get, all, run } = require('./dbAsync');
const fileMagic = require('./fileMagic');
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
} = require('./fileStore');
const graphMail = require('./graphMail');
const { httpError } = require('./httpError');
const inboundAlerts = require('./inboundAlerts');
const inboundRetention = require('./inboundRetention');
const virusScan = require('./virusScan');

const ISOLATED_WARNING = 'This file was not cleared by the virus scanner. Download it only to open it on an isolated machine.';
const RELEASABLE = new Set(['quarantined', 'error', 'inconclusive', 'encrypted']);
const FETCH_BACKOFF_MAX_MS = 30 * 60 * 1000;

function exceptionEnabled() {
  const value = String(process.env.ALLOW_UNSCANNED_ATTACHMENT_EXCEPTION || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function fetchMaxAgeMs() {
  const hours = Number(process.env.INBOUND_ATTACHMENT_FETCH_MAX_HOURS);
  const chosen = Number.isFinite(hours) && hours > 0 ? hours : 72;
  return chosen * 60 * 60 * 1000;
}

function backoffMs(attempts) {
  const shift = Math.min(Math.max(0, Number(attempts) || 0), 8);
  return Math.min(60 * 1000 * (2 ** shift), FETCH_BACKOFF_MAX_MS);
}

function sqliteNowPlus(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `+${seconds} seconds`;
}

function presentAttachment(row) {
  const fetchState = row.fetch_state || (row.skipped_reason ? 'skipped' : (row.stored_name ? 'fetched' : 'pending'));
  const scanStatus = row.scan_status || null;
  const clean = scanStatus === 'clean';
  const exception = scanStatus === 'exception';
  return {
    id: row.id,
    original_name: row.original_name,
    mime_type: row.mime_type || null,
    size_bytes: row.size_bytes || 0,
    skipped_reason: row.skipped_reason || null,
    stored: Boolean(row.stored_name) && fetchState === 'fetched',
    fetch_state: fetchState,
    scan_status: scanStatus,
    placeholder: fetchState === 'pending',
    quarantined: fetchState === 'fetched' && !clean,
    clean,
    encrypted: scanStatus === 'encrypted' || Number(row.content_encrypted) === 1,
    exception,
    release_warning: exception ? ISOLATED_WARNING : null,
    unscanned_exception_enabled: exceptionEnabled(),
  };
}

async function insertSkipped(emailId, attachment, reason) {
  const graphId = attachment && attachment.id ? String(attachment.id).slice(0, 200) : null;
  const name = sanitizeOriginalName(attachment && attachment.name ? attachment.name : 'attachment');
  const existing = graphId
    ? await get(
      `SELECT id FROM inbound_email_attachments WHERE inbound_email_id = ? AND graph_attachment_id = ?`,
      [emailId, graphId]
    )
    : null;
  if (existing) {
    await run(
      `UPDATE inbound_email_attachments
       SET fetch_state = 'skipped', skipped_reason = ?, scan_status = NULL, updated_at = datetime('now')
       WHERE id = ? AND fetch_state IN ('pending', 'failed')`,
      [reason, existing.id]
    );
    return;
  }
  await run(
    `INSERT INTO inbound_email_attachments (
      inbound_email_id, graph_attachment_id, original_name, mime_type, size_bytes,
      skipped_reason, fetch_state, created_at
    ) VALUES (?,?,?,?,?,?, 'skipped', datetime('now'))`,
    [
      emailId,
      graphId,
      name,
      attachment && attachment.contentType ? String(attachment.contentType).slice(0, 200) : null,
      Number(attachment && attachment.size) || 0,
      reason,
    ]
  );
}

async function markPending(emailId, attachment) {
  const graphId = attachment && attachment.id ? String(attachment.id).slice(0, 200) : null;
  const name = sanitizeOriginalName(attachment && attachment.name ? attachment.name : 'attachment');
  const existing = graphId
    ? await get(
      `SELECT id, fetch_state, fetch_attempts, created_at FROM inbound_email_attachments
       WHERE inbound_email_id = ? AND graph_attachment_id = ?`,
      [emailId, graphId]
    )
    : null;
  if (existing && (existing.fetch_state === 'fetched' || existing.fetch_state === 'skipped')) return;
  const attempts = existing ? Number(existing.fetch_attempts || 0) + 1 : 1;
  const created = existing && existing.created_at ? new Date(String(existing.created_at).replace(' ', 'T') + 'Z') : new Date();
  const ageMs = Date.now() - (Number.isNaN(created.getTime()) ? Date.now() : created.getTime());
  const expired = ageMs > fetchMaxAgeMs() || attempts > 24;
  const state = expired ? 'failed' : 'pending';
  if (existing) {
    await run(
      `UPDATE inbound_email_attachments
       SET fetch_state = ?, fetch_attempts = ?, next_fetch_at = datetime('now', ?),
           skipped_reason = ?, scan_status = NULL, updated_at = datetime('now')
       WHERE id = ?`,
      [
        state,
        attempts,
        sqliteNowPlus(backoffMs(attempts)),
        state === 'failed' ? 'The attachment did not arrive before the retry limit' : null,
        existing.id,
      ]
    );
    return;
  }
  await run(
    `INSERT INTO inbound_email_attachments (
      inbound_email_id, graph_attachment_id, original_name, mime_type, size_bytes,
      fetch_state, fetch_attempts, next_fetch_at, created_at
    ) VALUES (?,?,?,?,?, 'pending', 1, datetime('now', ?), datetime('now'))`,
    [
      emailId,
      graphId,
      name,
      attachment && attachment.contentType ? String(attachment.contentType).slice(0, 200) : null,
      Number(attachment && attachment.size) || 0,
      sqliteNowPlus(backoffMs(1)),
    ]
  );
}

function isPlaceholder(attachment, bytes) {
  if (!attachment || attachment.isInline) return false;
  const odata = String(attachment['@odata.type'] || '').toLowerCase();
  if (odata && !odata.includes('fileattachment')) return false;
  if (bytes && bytes.length) return false;
  const ext = extensionOf(attachment.name);
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;
  const declared = Number(attachment.size) || 0;
  if (declared > maxUploadBytes()) return false;
  return true;
}

async function enforceCap(extraBytes) {
  const cap = inboundRetention.attachmentCapBytes();
  const used = await inboundRetention.usedAttachmentBytes();
  if (used + extraBytes > cap) {
    inboundAlerts.noteStoragePressure(
      `Inbound attachment storage is at ${used} bytes of the ${cap} byte cap. A new file was not saved.`
    );
    return { ok: false, reason: 'Attachment storage is full' };
  }
  if (used + extraBytes >= cap * inboundRetention.warnRatio()) {
    inboundAlerts.noteStoragePressure(
      `Inbound attachment storage is at ${used + extraBytes} bytes of the ${cap} byte cap.`
    );
  }
  return { ok: true };
}

async function applyVerdict(id, verdict, encrypted) {
  let status = 'quarantined';
  if (verdict.verdict === 'infected') status = 'infected';
  else if (encrypted || verdict.verdict === 'encrypted') status = 'encrypted';
  else if (verdict.verdict === 'clean') status = 'clean';
  else if (verdict.verdict === 'inconclusive') status = 'inconclusive';
  else status = 'error';
  if (status === 'clean') inboundAlerts.noteScanSuccess();
  else if (status === 'error' || status === 'inconclusive') inboundAlerts.noteScanFailure(verdict.detail || status);
  await run(
    `UPDATE inbound_email_attachments
     SET scan_status = ?, scan_detail = ?, scanned_at = datetime('now'),
         content_encrypted = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [status, verdict.detail || null, encrypted || status === 'encrypted' ? 1 : 0, id]
  );
  return status;
}

async function storeBytes(emailId, attachment, bytes) {
  const graphId = attachment && attachment.id ? String(attachment.id).slice(0, 200) : null;
  const ext = extensionOf(attachment && attachment.name);
  const checked = fileMagic.checkAllowed(ext, bytes);
  if (!checked.ok) {
    await insertSkipped(emailId, attachment, checked.reason);
    return;
  }
  const room = await enforceCap(bytes.length);
  if (!room.ok) {
    await insertSkipped(emailId, attachment, room.reason);
    return;
  }
  const existing = graphId
    ? await get(
      `SELECT id, fetch_state, stored_name, storage_root FROM inbound_email_attachments
       WHERE inbound_email_id = ? AND graph_attachment_id = ?`,
      [emailId, graphId]
    )
    : null;
  if (existing && existing.fetch_state === 'fetched' && existing.stored_name) return;
  const written = writeNewFile(ext, bytes);
  let rowId = existing && existing.id;
  if (existing) {
    if (existing.stored_name) removeStored(existing.stored_name, existing.storage_root);
    await run(
      `UPDATE inbound_email_attachments
       SET original_name = ?, stored_name = ?, mime_type = ?, size_bytes = ?, storage_root = ?,
           skipped_reason = NULL, fetch_state = 'fetched', scan_status = 'quarantined',
           content_encrypted = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        sanitizeOriginalName(attachment.name),
        written.storedName,
        contentTypeFor(written.storedName),
        written.size,
        written.storageRoot,
        checked.encrypted ? 1 : 0,
        existing.id,
      ]
    );
  } else {
    const inserted = await run(
      `INSERT INTO inbound_email_attachments (
        inbound_email_id, graph_attachment_id, original_name, stored_name, mime_type,
        size_bytes, storage_root, fetch_state, scan_status, content_encrypted, created_at
      ) VALUES (?,?,?,?,?,?,?, 'fetched', 'quarantined', ?, datetime('now'))`,
      [
        emailId,
        graphId,
        sanitizeOriginalName(attachment.name),
        written.storedName,
        contentTypeFor(written.storedName),
        written.size,
        written.storageRoot,
        checked.encrypted ? 1 : 0,
      ]
    );
    rowId = inserted.lastID;
  }
  const verdict = await virusScan.scanBuffer(bytes);
  await applyVerdict(rowId, verdict, checked.encrypted);
}

async function storeAttachment(emailId, attachment) {
  const graphId = attachment && attachment.id ? String(attachment.id).slice(0, 200) : null;
  if (graphId) {
    const existing = await get(
      `SELECT id, fetch_state FROM inbound_email_attachments
       WHERE inbound_email_id = ? AND graph_attachment_id = ?`,
      [emailId, graphId]
    );
    if (existing && (existing.fetch_state === 'fetched' || existing.fetch_state === 'skipped')) return;
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
  const mime = String((attachment && attachment.contentType) || '').toLowerCase();
  if (/text\/html|application\/(javascript|x-msdownload|x-httpd-php|x-sh|xhtml)/.test(mime)) {
    await insertSkipped(emailId, attachment, 'This file type is not allowed');
    return;
  }
  const declared = Number(attachment && attachment.size) || 0;
  if (declared > maxUploadBytes()) {
    await insertSkipped(emailId, attachment, `File exceeds the ${maxUploadMb()} MB limit`);
    return;
  }
  const bytes = attachment && attachment.contentBytes
    ? Buffer.from(String(attachment.contentBytes), 'base64')
    : Buffer.alloc(0);
  if (isPlaceholder(attachment, bytes)) {
    await markPending(emailId, attachment);
    return;
  }
  if (!bytes.length) {
    await insertSkipped(emailId, attachment, 'Empty files are not allowed');
    return;
  }
  if (bytes.length > maxUploadBytes()) {
    await insertSkipped(emailId, attachment, `File exceeds the ${maxUploadMb()} MB limit`);
    return;
  }
  await storeBytes(emailId, attachment, bytes);
}

async function loadGraphAttachment(messageId, attachment, token) {
  if (attachment && attachment.contentBytes) return attachment;
  if (!attachment || !attachment.id || !token) return attachment;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  return graphMail.fetchJson(
    `${graphMail.attachmentsUrl(messageId)}/${encodeURIComponent(attachment.id)}`,
    { headers }
  );
}

function safeErrorText(err) {
  return String((err && (err.publicMessage || err.message)) || 'attachment failed').slice(0, 300);
}

async function refreshAttachments(emailId, message, token) {
  if (!message || !message.hasAttachments || !message.id) return;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  let page;
  try {
    page = await graphMail.fetchJson(graphMail.attachmentsUrl(message.id), { headers });
  } catch (err) {
    console.error('INBOUND ATTACHMENT ERROR:', safeErrorText(err));
    const pending = await all(
      `SELECT id FROM inbound_email_attachments
       WHERE inbound_email_id = ? AND fetch_state = 'pending'
         AND (next_fetch_at IS NULL OR datetime(next_fetch_at) <= datetime('now'))`,
      [emailId]
    );
    for (const row of pending) {
      await run(
        `UPDATE inbound_email_attachments
         SET fetch_attempts = COALESCE(fetch_attempts, 0) + 1,
             next_fetch_at = datetime('now', ?),
             fetch_state = CASE WHEN COALESCE(fetch_attempts, 0) + 1 > 24 THEN 'failed' ELSE 'pending' END,
             updated_at = datetime('now')
         WHERE id = ?`,
        [sqliteNowPlus(backoffMs(3)), row.id]
      );
    }
    return;
  }
  for (const item of page.value || []) {
    try {
      const attachment = await loadGraphAttachment(message.id, item, token);
      await storeAttachment(emailId, attachment);
    } catch (err) {
      console.error('INBOUND ATTACHMENT ERROR:', safeErrorText(err));
      await markPending(emailId, item);
    }
  }
}

async function attachmentDownload(user, emailId, attachmentId) {
  const file = await get(
    `SELECT id, original_name, stored_name, storage_root, skipped_reason, fetch_state, scan_status
     FROM inbound_email_attachments
     WHERE id = ? AND inbound_email_id = ?`,
    [attachmentId, emailId]
  );
  if (!file || file.skipped_reason || !file.stored_name || file.fetch_state === 'pending') return null;
  const clean = file.scan_status === 'clean';
  const exception = file.scan_status === 'exception';
  if (!clean && !(exception && user && user.role === 'admin')) {
    throw httpError(403, clean ? 'File not found' : 'This attachment is still quarantined');
  }
  const opened = openStored(file.stored_name, file.storage_root);
  if (!opened) return null;
  return {
    path: opened.fullPath,
    name: sanitizeOriginalName(file.original_name),
    contentType: contentTypeFor(file.stored_name),
    disposition: 'attachment',
    warning: exception ? ISOLATED_WARNING : null,
  };
}

async function assertConvertible(emailId, attachmentIds) {
  const rows = await all(
    `SELECT id, fetch_state, scan_status, skipped_reason, stored_name, original_name
     FROM inbound_email_attachments
     WHERE inbound_email_id = ?
     ORDER BY id`,
    [emailId]
  );
  if (rows.some((row) => row.fetch_state === 'pending')) {
    throw httpError(409, 'An attachment is still pending and this email cannot be converted yet');
  }
    const chosen = attachmentIds
    ? rows.filter((row) => attachmentIds.includes(row.id))
    : rows.filter((row) => row.stored_name && !row.skipped_reason && row.fetch_state === 'fetched' && row.scan_status === 'clean');
  for (const row of chosen) {
    if (row.fetch_state !== 'fetched' || !row.stored_name || row.skipped_reason) {
      throw httpError(400, 'Only fetched attachments can be added to the order');
    }
    if (row.scan_status !== 'clean') {
      throw httpError(409, 'A quarantined attachment cannot be added to the order');
    }
  }
  return chosen;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function releaseAttachment(user, emailId, attachmentId, body) {
  if (!exceptionEnabled()) {
    throw httpError(403, 'Releasing an unscanned attachment is turned off');
  }
  if (!user || user.role !== 'admin') throw httpError(403, 'Only an admin can release a quarantined attachment');
  const source = body || {};
  if (source.exception !== true) {
    throw httpError(400, 'exception must be true to release a quarantined attachment');
  }
  const reason = String(source.reason || '').trim();
  if (reason.length < 8 || reason.length > 500) {
    throw httpError(400, 'A written reason of at least 8 characters is required');
  }
  const file = await get(
    `SELECT id, scan_status, fetch_state, stored_name, skipped_reason
     FROM inbound_email_attachments
     WHERE id = ? AND inbound_email_id = ?`,
    [attachmentId, emailId]
  );
  if (!file || !file.stored_name || file.skipped_reason || file.fetch_state !== 'fetched') {
    throw httpError(404, 'Attachment not found');
  }
  if (file.scan_status === 'clean') throw httpError(409, 'This attachment is already clear');
  if (file.scan_status === 'infected') throw httpError(403, 'An infected attachment cannot be released');
  if (!RELEASABLE.has(file.scan_status) && file.scan_status !== 'exception') {
    throw httpError(409, 'This attachment cannot be released');
  }
  const userId = Number(user.userId || user.id);
  const token = source.confirm_token ? String(source.confirm_token) : '';
  if (!token) {
    const issued = crypto.randomBytes(24).toString('hex');
    await run(
      `INSERT INTO inbound_attachment_releases (
        token_hash, attachment_id, user_id, reason, expires_at, created_at
      ) VALUES (?, ?, ?, ?, datetime('now', '+10 minutes'), datetime('now'))`,
      [hashToken(issued), file.id, userId, reason]
    );
    await activityLog.record(userId, 'inbound_attachment.release_requested', 'inbound_email_attachment', file.id, {
      inbound_email_id: emailId,
      message: 'An admin requested an exception to download an unscanned attachment',
      reason,
    });
    return {
      confirmation_required: true,
      confirm_token: issued,
      warning: ISOLATED_WARNING,
    };
  }
  const challenge = await get(
    `SELECT id, reason, user_id FROM inbound_attachment_releases
     WHERE token_hash = ? AND attachment_id = ? AND used_at IS NULL
       AND datetime(expires_at) >= datetime('now')`,
    [hashToken(token), file.id]
  );
  if (!challenge || Number(challenge.user_id) !== userId || challenge.reason !== reason) {
    throw httpError(400, 'The second confirmation does not match this release');
  }
  await run(
    `UPDATE inbound_email_attachments
     SET scan_status = 'exception', released_by = ?, released_at = datetime('now'),
         release_reason = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [userId, reason, file.id]
  );
  await run(`UPDATE inbound_attachment_releases SET used_at = datetime('now') WHERE id = ?`, [challenge.id]);
  await activityLog.record(userId, 'inbound_attachment.released', 'inbound_email_attachment', file.id, {
    inbound_email_id: emailId,
    message: 'An admin released a quarantined attachment for download on an isolated machine',
    reason,
    warning: ISOLATED_WARNING,
  });
  return {
    released: true,
    scan_status: 'exception',
    warning: ISOLATED_WARNING,
    download_only: true,
  };
}

module.exports = {
  ISOLATED_WARNING,
  exceptionEnabled,
  presentAttachment,
  storeAttachment,
  refreshAttachments,
  attachmentDownload,
  assertConvertible,
  releaseAttachment,
};
