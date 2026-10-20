const crypto = require('crypto');
const activityLog = require('./activityLog');
const { get, all, run, withTransaction } = require('./dbAsync');
const { getRules } = require('./deliveryRules');
const { parseText } = require('./fields');
const {
  sanitizeOriginalName,
  safeStoredPath,
  contentTypeFor,
  storageRootOfUpload,
  openStored,
} = require('./fileStore');
const { httpError } = require('./httpError');
const mailer = require('./mailer');
const notifications = require('./notifications');
const systemSettings = require('./systemSettings');

const STAFF = new Set(['admin', 'manager', 'operator']);

function actorId(user) {
  return Number(user.userId || user.id);
}

function isStaff(user) {
  return Boolean(user) && STAFF.has(user.role);
}

function parseSendEmail(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw httpError(400, 'send_email must be true or false');
}

function parseOptionalId(value, field) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^[1-9]\d*$/.test(text)) throw httpError(400, `${field} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw httpError(400, `${field} must be a positive integer`);
  return parsed;
}

function publicFile(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    work_order_id: row.work_order_id || null,
    work_order_number: row.work_order_number || null,
    original_name: row.original_name,
    mime_type: row.mime_type || null,
    size_bytes: row.size_bytes,
    message: row.message || null,
    batch_id: row.batch_id || null,
    transfer_id: row.transfer_id || null,
    created_at: row.created_at,
    sender_name: row.sender_name || null,
    customer_downloaded_at: row.customer_downloaded_at || null,
    downloaded_by_customer: Boolean(row.customer_downloaded_at),
    replaces_id: row.replaces_id || null,
  };
}

const FILE_SELECT = `
  SELECT f.id, f.order_id, f.work_order_id, f.original_name, f.mime_type, f.size_bytes,
         f.message, f.batch_id, f.created_at, f.customer_downloaded_at, f.replaces_id,
         f.deleted_at, f.stored_name, f.storage_root, f.customer_id, f.transfer_id,
         wo.external_id AS work_order_number,
         COALESCE(NULLIF(trim(u.display_name), ''), NULLIF(trim(u.username), '')) AS sender_name,
         o.customer_id AS order_customer_id, o.order_number, o.email AS order_email
  FROM shared_files f
  LEFT JOIN orders o ON o.id = f.order_id
  LEFT JOIN work_orders wo ON wo.id = f.work_order_id
  LEFT JOIN users u ON u.id = f.uploaded_by
`;

async function loadOrder(orderId) {
  const order = await get(
    `SELECT id, customer_id, order_number, email, company
     FROM orders WHERE id = ?`,
    [orderId]
  );
  if (!order) throw httpError(404, 'Order not found');
  return order;
}

function assertOrderAccess(user, order) {
  if (isStaff(user)) return;
  if (user.role === 'customer' && Number(order.customer_id) === actorId(user)) return;
  throw httpError(404, 'Order not found');
}

async function listForUser(user, orderId, workOrderQuery) {
  const order = await loadOrder(orderId);
  assertOrderAccess(user, order);
  const workOrderId = parseOptionalId(workOrderQuery, 'work_order_id');
  if (workOrderId) {
    const workOrder = await get(
      'SELECT id, external_id FROM work_orders WHERE id = ? AND order_id = ?',
      [workOrderId, order.id]
    );
    if (!workOrder) throw httpError(400, 'work_order_id is not on this order');
  }
  const params = [order.id];
  let filter = '';
  if (workOrderId) {
    filter = ' AND (f.work_order_id IS NULL OR f.work_order_id = ?)';
    params.push(workOrderId);
  }
  const files = await all(
    `${FILE_SELECT}
     WHERE f.order_id = ? AND f.deleted_at IS NULL${filter}
     ORDER BY f.created_at, f.id`,
    params
  );
  const workOrders = await all(
    `SELECT wo.id, wo.external_id, s.name AS service_name
     FROM work_orders wo
     LEFT JOIN services s ON s.id = wo.service_id
     WHERE wo.order_id = ?
     ORDER BY wo.external_id`,
    [order.id]
  );
  const body = {
    files: files.map(publicFile),
    timezone: getRules().timezone,
    work_orders: workOrders.map((row) => ({
      id: row.id,
      external_id: row.external_id,
      service_name: row.service_name || null,
    })),
  };
  if (isStaff(user)) {
    body.mail = {
      configured: mailer.isConfigured(),
      default_send: await systemSettings.emailCustomersOnFileShare(),
      to: order.email || '',
      public_url_set: Boolean(mailer.publicAppUrl()),
    };
  }
  return body;
}

function assertFiles(files) {
  if (!files || !files.length) throw httpError(400, 'Choose a file to upload');
  for (const file of files) {
    if (!file || !file.size) throw httpError(400, 'Empty files are not allowed');
    const storedName = require('path').basename(file.filename || '');
    if (!safeStoredPath(storedName)) throw httpError(400, 'This file type is not allowed');
  }
}

function resolveRecipients(source, wantsEmail, fallbackEmail, missingMessage) {
  if (!wantsEmail) return { toAddress: null, cc: [] };
  let toAddress = null;
  if (source.email_to != null && String(source.email_to).trim() !== '') {
    const parsed = mailer.parseAddressList(source.email_to, { max: 1, field: 'email_to' });
    if (parsed.error) throw httpError(400, parsed.error);
    if (parsed.value.length !== 1) throw httpError(400, 'email_to must be one address');
    toAddress = parsed.value[0];
  } else {
    const parsed = mailer.parseAddressList(fallbackEmail, { max: 1, field: 'email_to' });
    if (parsed.error || parsed.value.length !== 1) {
      throw httpError(400, missingMessage);
    }
    toAddress = parsed.value[0];
  }
  let cc = [];
  if (source.email_cc != null && String(source.email_cc).trim() !== '') {
    const parsed = mailer.parseAddressList(source.email_cc, { max: 5, field: 'email_cc' });
    if (parsed.error) throw httpError(400, parsed.error);
    cc = parsed.value.filter((address) => address.toLowerCase() !== toAddress.toLowerCase());
  }
  return { toAddress, cc };
}

async function emailPlanFor(user, wantsEmail) {
  if (!wantsEmail) return 'skipped';
  if (!mailer.isConfigured()) return 'not_configured';
  const slot = mailer.reserveEmail(actorId(user));
  return slot.allowed ? 'pending' : 'rate_limited';
}

async function sendPlannedEmail({ user, emailPlan, toAddress, cc, rendered, log }) {
  if (emailPlan !== 'pending') {
    return { status: emailPlan, recipients: [] };
  }
  const result = await mailer.deliver({
    to: toAddress,
    cc,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
  const email = {
    status: result.status,
    recipients: result.recipients,
  };
  const preview = mailer.previewFrom(result.captured);
  if (preview) email.preview = preview;
  for (const recipient of result.recipients) {
    const ok = recipient.status === 'sent';
    await activityLog.record(
      actorId(user),
      ok ? 'shared_file.email_sent' : 'shared_file.email_failed',
      log.entityType,
      log.entityId,
      {
        ...log.detail,
        recipient: recipient.address,
        message: ok ? log.sent(recipient.address) : log.failed(recipient.address),
      }
    ).catch((err) => console.error('FILE SHARE EMAIL LOG ERROR:', err.message || err));
  }
  return email;
}

function fileOwnerId(file) {
  return Number(file.customer_id || file.order_customer_id);
}

async function shareFiles(user, orderId, body, files) {
  assertFiles(files);
  const order = await loadOrder(orderId);
  if (!isStaff(user)) throw httpError(403, 'Forbidden');
  const source = body || {};
  const message = parseText(source.message, 'message', { max: 2000, allowNewlines: true });
  if (message.error) throw httpError(400, message.error);
  const workOrderId = parseOptionalId(source.work_order_id, 'work_order_id');
  let workOrder = null;
  if (workOrderId) {
    workOrder = await get(
      'SELECT id, external_id FROM work_orders WHERE id = ? AND order_id = ?',
      [workOrderId, order.id]
    );
    if (!workOrder) throw httpError(400, 'work_order_id is not on this order');
  }
  const defaultSend = await systemSettings.emailCustomersOnFileShare();
  const wantsEmail = parseSendEmail(source.send_email, defaultSend);
  const { toAddress, cc } = resolveRecipients(
    source,
    wantsEmail,
    order.email,
    'The order has no valid contact email. Enter one before sending.'
  );
  const emailPlan = await emailPlanFor(user, wantsEmail);

  const batchId = crypto.randomBytes(8).toString('hex');
  const note = message.value;
  const names = files.map((file) => sanitizeOriginalName(file.originalname));
  const saved = await withTransaction(async (tx) => {
    const transfer = await tx.run(
      `INSERT INTO file_transfers (
        customer_id, order_id, work_order_id, subject, message, uploaded_by
      ) VALUES (?,?,?,?,?,?)`,
      [
        order.customer_id,
        order.id,
        workOrder ? workOrder.id : null,
        null,
        note,
        actorId(user),
      ]
    );
    const ids = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const storedName = require('path').basename(file.filename);
      const inserted = await tx.run(
        `INSERT INTO shared_files (
          order_id, work_order_id, customer_id, uploaded_by, original_name, stored_name,
          mime_type, size_bytes, message, batch_id, transfer_id, storage_root
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          order.id,
          workOrder ? workOrder.id : null,
          order.customer_id,
          actorId(user),
          names[index],
          storedName,
          contentTypeFor(storedName),
          file.size,
          note,
          batchId,
          transfer.lastID,
          storageRootOfUpload(file),
        ]
      );
      ids.push(inserted.lastID);
    }
    const detail = {
      order_number: order.order_number,
      work_order_id: workOrder ? workOrder.id : null,
      external_id: workOrder ? workOrder.external_id : null,
      file_names: names,
      file_ids: ids,
      batch_id: batchId,
      note,
      email_status: emailPlan === 'pending' ? 'pending' : emailPlan,
      message: `Shared ${names.length} file${names.length === 1 ? '' : 's'} on order ${order.order_number}`,
    };
    detail.transfer_id = transfer.lastID;
    await activityLog.recordOn(tx, actorId(user), 'shared_file.sent', 'order', order.id, detail);
    if (workOrder) {
      await activityLog.recordOn(tx, actorId(user), 'shared_file.sent', 'work_order', workOrder.id, detail);
    }
    return { ids, transferId: transfer.lastID };
  });

  const title = `New files for order ${order.order_number}`;
  let email = { status: emailPlan === 'pending' ? 'skipped' : emailPlan, recipients: [] };
  try {
    await new Promise((resolve) => {
      notifications.notifyFilesShared({
        orderId: order.id,
        orderNumber: order.order_number,
        customerId: order.customer_id,
        workOrderId: workOrder ? workOrder.id : null,
        batchId,
        transferId: saved.transferId,
        title,
        body: note || `${saved.ids.length} file${saved.ids.length === 1 ? '' : 's'} ready to download.`,
      }, (err) => {
        if (err) console.error('FILE SHARE NOTIFICATION ERROR:', err.message || err);
        resolve();
      });
    });

    if (emailPlan === 'pending') {
      const letterhead = await loadLetterheadSafe();
      const rendered = mailer.renderShareEmail({
        letterhead,
        orderNumber: order.order_number,
        message: note,
        fileNames: names,
        link: mailer.orderFilesLink(order.id),
      });
      const result = await mailer.deliver({
        to: toAddress,
        cc,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      email = {
        status: result.status,
        recipients: result.recipients,
      };
      const preview = mailer.previewFrom(result.captured);
      if (preview) email.preview = preview;
      for (const recipient of result.recipients) {
        const ok = recipient.status === 'sent';
        await activityLog.record(
          actorId(user),
          ok ? 'shared_file.email_sent' : 'shared_file.email_failed',
          'order',
          order.id,
          {
            order_number: order.order_number,
            recipient: recipient.address,
            batch_id: batchId,
            message: ok
              ? `Email sent to ${recipient.address} for order ${order.order_number}`
              : `Email to ${recipient.address} failed for order ${order.order_number}`,
          }
        ).catch((err) => console.error('FILE SHARE EMAIL LOG ERROR:', err.message || err));
      }
    }
  } catch (err) {
    err.filesCommitted = true;
    throw err;
  }

  const rows = await all(
    `${FILE_SELECT} WHERE f.id IN (${saved.ids.map(() => '?').join(', ')}) ORDER BY f.id`,
    saved.ids
  );
  return {
    files: rows.map(publicFile),
    email,
  };
}

async function loadLetterheadSafe() {
  try {
    return await require('./shopProfile').loadLetterhead();
  } catch (err) {
    console.error('LETTERHEAD ERROR:', err.message || err);
    return { name: '', address: '', address_lines: [], phone: '' };
  }
}

async function loadVisible(user, id) {
  const file = await get(`${FILE_SELECT} WHERE f.id = ?`, [id]);
  if (!file || file.deleted_at) throw httpError(404, 'File not found');
  if (isStaff(user)) return file;
  if (user.role === 'customer' && fileOwnerId(file) === actorId(user)) return file;
  throw httpError(404, 'File not found');
}

async function prepareDownload(user, id) {
  const file = await loadVisible(user, id);
  const opened = openStored(file.stored_name, file.storage_root);
  if (!opened) throw httpError(404, 'File not found');
  if (user.role === 'customer') {
    await run(
      `UPDATE shared_files
       SET customer_downloaded_at = COALESCE(customer_downloaded_at, datetime('now'))
       WHERE id = ?`,
      [file.id]
    );
    const onOrder = Boolean(file.order_id);
    activityLog.record(
      actorId(user),
      'shared_file.downloaded',
      onOrder ? 'order' : 'file_transfer',
      onOrder ? file.order_id : file.transfer_id,
      {
        order_number: file.order_number || null,
        transfer_id: file.transfer_id || null,
        file_id: file.id,
        file_name: file.original_name,
        message: `Customer downloaded ${file.original_name}`,
      }
    ).catch((err) => console.error('FILE DOWNLOAD LOG ERROR:', err.message || err));
  }
  return {
    fullPath: opened.fullPath,
    downloadName: sanitizeOriginalName(file.original_name),
    contentType: contentTypeFor(file.stored_name),
  };
}

async function removeFile(user, id) {
  if (!isStaff(user)) throw httpError(403, 'Forbidden');
  const file = await get(`${FILE_SELECT} WHERE f.id = ?`, [id]);
  if (!file || file.deleted_at) throw httpError(404, 'File not found');
  await withTransaction(async (tx) => {
    const updated = await tx.run(
      `UPDATE shared_files
       SET deleted_at = datetime('now'), deleted_by = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [actorId(user), file.id]
    );
    if (!updated.changes) throw httpError(404, 'File not found');
    const detail = {
      order_number: file.order_number || null,
      transfer_id: file.transfer_id || null,
      file_id: file.id,
      file_name: file.original_name,
      work_order_id: file.work_order_id || null,
      message: file.order_number
        ? `Removed ${file.original_name} from order ${file.order_number}`
        : `Removed ${file.original_name} from the customer's files`,
    };
    if (file.order_id) {
      await activityLog.recordOn(tx, actorId(user), 'shared_file.deleted', 'order', file.order_id, detail);
    } else if (file.transfer_id) {
      await activityLog.recordOn(tx, actorId(user), 'shared_file.deleted', 'file_transfer', file.transfer_id, detail);
    }
    if (file.work_order_id) {
      await activityLog.recordOn(tx, actorId(user), 'shared_file.deleted', 'work_order', file.work_order_id, detail);
    }
  });
  return { ok: true, id: file.id };
}

async function replaceFile(user, id, body, files) {
  if (!isStaff(user)) throw httpError(403, 'Forbidden');
  if (!files || files.length !== 1) throw httpError(400, 'Choose one file to replace');
  assertFiles(files);
  const existing = await get(`${FILE_SELECT} WHERE f.id = ?`, [id]);
  if (!existing || existing.deleted_at) throw httpError(404, 'File not found');
  const source = body || {};
  let note = existing.message || null;
  if (Object.prototype.hasOwnProperty.call(source, 'message') && source.message != null && String(source.message).trim() !== '') {
    const parsed = parseText(source.message, 'message', { max: 2000, allowNewlines: true });
    if (parsed.error) throw httpError(400, parsed.error);
    note = parsed.value;
  }
  const file = files[0];
  const storedName = require('path').basename(file.filename);
  const original = sanitizeOriginalName(file.originalname);
  const batchId = crypto.randomBytes(8).toString('hex');
  const insertedId = await withTransaction(async (tx) => {
    const inserted = await tx.run(
      `INSERT INTO shared_files (
        order_id, work_order_id, customer_id, uploaded_by, original_name, stored_name,
        mime_type, size_bytes, message, batch_id, replaces_id, transfer_id, storage_root
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        existing.order_id || null,
        existing.work_order_id || null,
        existing.customer_id || existing.order_customer_id || null,
        actorId(user),
        original,
        storedName,
        contentTypeFor(storedName),
        file.size,
        note,
        batchId,
        existing.id,
        existing.transfer_id || null,
        storageRootOfUpload(file),
      ]
    );
    const updated = await tx.run(
      `UPDATE shared_files
       SET deleted_at = datetime('now'), deleted_by = ?, replaced_by_id = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [actorId(user), inserted.lastID, existing.id]
    );
    if (!updated.changes) throw httpError(404, 'File not found');
    const detail = {
      order_number: existing.order_number || null,
      transfer_id: existing.transfer_id || null,
      file_id: inserted.lastID,
      replaced_id: existing.id,
      file_name: original,
      previous_name: existing.original_name,
      message: `Replaced ${existing.original_name} with ${original}`,
    };
    if (existing.order_id) {
      await activityLog.recordOn(tx, actorId(user), 'shared_file.replaced', 'order', existing.order_id, detail);
    } else if (existing.transfer_id) {
      await activityLog.recordOn(tx, actorId(user), 'shared_file.replaced', 'file_transfer', existing.transfer_id, detail);
    }
    if (existing.work_order_id) {
      await activityLog.recordOn(tx, actorId(user), 'shared_file.replaced', 'work_order', existing.work_order_id, detail);
    }
    return inserted.lastID;
  });
  try {
    const row = await get(`${FILE_SELECT} WHERE f.id = ?`, [insertedId]);
    return { file: publicFile(row) };
  } catch (err) {
    err.filesCommitted = true;
    throw err;
  }
}

const TRANSFER_SELECT = `
  SELECT t.id, t.customer_id, t.order_id, t.work_order_id, t.subject, t.message, t.created_at,
         COALESCE(NULLIF(trim(c.display_name), ''), NULLIF(trim(c.company), ''), NULLIF(trim(c.username), '')) AS customer_name,
         c.email AS customer_email,
         o.order_number,
         COALESCE(NULLIF(trim(u.display_name), ''), NULLIF(trim(u.username), '')) AS sender_name
  FROM file_transfers t
  JOIN users c ON c.id = t.customer_id
  LEFT JOIN orders o ON o.id = t.order_id
  LEFT JOIN users u ON u.id = t.uploaded_by
`;

function activeTransferExists() {
  return `EXISTS (
    SELECT 1 FROM shared_files f
    WHERE f.transfer_id = t.id AND f.deleted_at IS NULL
  )`;
}

function parseLimit(value) {
  if (value == null || String(value).trim() === '') return 50;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw httpError(400, 'limit must be an integer from 1 to 100');
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw httpError(400, 'limit must be an integer from 1 to 100');
  }
  return parsed;
}

function parseOffset(value) {
  if (value == null || String(value).trim() === '') return 0;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw httpError(400, 'offset must be an integer of 0 or greater');
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw httpError(400, 'offset must be an integer of 0 or greater');
  }
  return parsed;
}

function downloadRollup(files) {
  const stamps = files.map((file) => file.customer_downloaded_at).filter(Boolean).sort();
  if (!stamps.length) {
    return { downloaded_by_customer: false, customer_downloaded_at: null };
  }
  return { downloaded_by_customer: true, customer_downloaded_at: stamps[0] };
}

function presentTransfer(row, files, user) {
  const rollup = downloadRollup(files);
  const body = {
    id: row.id,
    customer_id: row.customer_id,
    customer_name: row.customer_name || null,
    order_id: row.order_id || null,
    order_number: row.order_number || null,
    work_order_id: row.work_order_id || null,
    subject: row.subject || null,
    message: row.message || null,
    created_at: row.created_at,
    sender_name: row.sender_name || null,
    downloaded_by_customer: rollup.downloaded_by_customer,
    customer_downloaded_at: rollup.customer_downloaded_at,
    files: files.map(publicFile),
  };
  if (isStaff(user)) body.customer_email = row.customer_email || '';
  return body;
}

async function filesForTransfers(ids) {
  if (!ids.length) return [];
  return all(
    `${FILE_SELECT}
     WHERE f.transfer_id IN (${ids.map(() => '?').join(', ')}) AND f.deleted_at IS NULL
     ORDER BY f.id`,
    ids
  );
}

async function mailStatusForStaff(user) {
  if (!isStaff(user)) return null;
  return {
    configured: mailer.isConfigured(),
    default_send: await systemSettings.emailCustomersOnFileShare(),
    public_url_set: Boolean(mailer.publicAppUrl()),
  };
}

async function listTransfers(user, query) {
  const source = query || {};
  const limit = parseLimit(source.limit);
  const offset = parseOffset(source.offset);
  const params = [];
  const where = [activeTransferExists()];
  if (user.role === 'customer') {
    where.push('t.customer_id = ?');
    params.push(actorId(user));
  } else if (!isStaff(user)) {
    throw httpError(403, 'Forbidden');
  } else if (source.customer_id != null && String(source.customer_id).trim() !== '') {
    where.push('t.customer_id = ?');
    params.push(parseOptionalId(source.customer_id, 'customer_id'));
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const totalRow = await get(`SELECT COUNT(*) AS total FROM file_transfers t ${whereSql}`, params);
  const rows = await all(
    `${TRANSFER_SELECT} ${whereSql} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const files = await filesForTransfers(rows.map((row) => row.id));
  const byTransfer = new Map();
  for (const file of files) {
    if (!byTransfer.has(file.transfer_id)) byTransfer.set(file.transfer_id, []);
    byTransfer.get(file.transfer_id).push(file);
  }
  const body = {
    transfers: rows.map((row) => presentTransfer(row, byTransfer.get(row.id) || [], user)),
    total: totalRow ? totalRow.total : 0,
    limit,
    offset,
    timezone: getRules().timezone,
  };
  const mail = await mailStatusForStaff(user);
  if (mail) body.mail = mail;
  return body;
}

async function getTransfer(user, id) {
  const row = await get(`${TRANSFER_SELECT} WHERE t.id = ?`, [id]);
  if (!row) throw httpError(404, 'File transfer not found');
  if (!isStaff(user) && !(user.role === 'customer' && Number(row.customer_id) === actorId(user))) {
    throw httpError(404, 'File transfer not found');
  }
  const files = await all(
    `${FILE_SELECT} WHERE f.transfer_id = ? AND f.deleted_at IS NULL ORDER BY f.id`,
    [id]
  );
  if (!files.length) throw httpError(404, 'File transfer not found');
  return {
    transfer: presentTransfer(row, files, user),
    timezone: getRules().timezone,
  };
}

async function loadCustomerAccount(customerId) {
  const customer = await get(
    `SELECT id, role, email, display_name, company, username, COALESCE(is_active, 1) AS is_active
     FROM users WHERE id = ?`,
    [customerId]
  );
  if (!customer || customer.role !== 'customer' || Number(customer.is_active) === 0) {
    throw httpError(400, 'Choose an active customer account');
  }
  return customer;
}

async function createTransfer(user, body, files) {
  if (!isStaff(user)) throw httpError(403, 'Forbidden');
  assertFiles(files);
  const source = body || {};
  const customerId = parseOptionalId(source.customer_id, 'customer_id');
  if (!customerId) throw httpError(400, 'customer_id is required');
  const customer = await loadCustomerAccount(customerId);
  const subject = parseText(source.subject, 'subject', { max: 180 });
  if (subject.error) throw httpError(400, subject.error);
  const message = parseText(source.message, 'message', { max: 2000, allowNewlines: true });
  if (message.error) throw httpError(400, message.error);
  const defaultSend = await systemSettings.emailCustomersOnFileShare();
  const wantsEmail = parseSendEmail(source.send_email, defaultSend);
  const { toAddress, cc } = resolveRecipients(
    source,
    wantsEmail,
    customer.email,
    'This customer has no valid email. Enter one before sending.'
  );
  const emailPlan = await emailPlanFor(user, wantsEmail);
  const batchId = crypto.randomBytes(8).toString('hex');
  const note = message.value;
  const names = files.map((file) => sanitizeOriginalName(file.originalname));
  const saved = await withTransaction(async (tx) => {
    const transfer = await tx.run(
      `INSERT INTO file_transfers (
        customer_id, order_id, work_order_id, subject, message, uploaded_by
      ) VALUES (?,?,?,?,?,?)`,
      [customer.id, null, null, subject.value, note, actorId(user)]
    );
    const ids = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const storedName = require('path').basename(file.filename);
      const inserted = await tx.run(
        `INSERT INTO shared_files (
          order_id, work_order_id, customer_id, uploaded_by, original_name, stored_name,
          mime_type, size_bytes, message, batch_id, transfer_id, storage_root
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          null,
          null,
          customer.id,
          actorId(user),
          names[index],
          storedName,
          contentTypeFor(storedName),
          file.size,
          note,
          batchId,
          transfer.lastID,
          storageRootOfUpload(file),
        ]
      );
      ids.push(inserted.lastID);
    }
    await activityLog.recordOn(tx, actorId(user), 'shared_file.sent', 'file_transfer', transfer.lastID, {
      customer_id: customer.id,
      subject: subject.value,
      file_names: names,
      file_ids: ids,
      batch_id: batchId,
      note,
      email_status: emailPlan === 'pending' ? 'pending' : emailPlan,
      message: `Sent ${names.length} file${names.length === 1 ? '' : 's'} to ${customer.display_name || customer.username}`,
    });
    return { ids, transferId: transfer.lastID };
  });

  let email = { status: emailPlan === 'pending' ? 'skipped' : emailPlan, recipients: [] };
  try {
    await new Promise((resolve) => {
      notifications.notifyFilesShared({
        transferId: saved.transferId,
        customerId: customer.id,
        batchId,
        title: subject.value || 'New files from Accent',
        body: note || `${saved.ids.length} file${saved.ids.length === 1 ? '' : 's'} ready to download.`,
      }, (err) => {
        if (err) console.error('FILE TRANSFER NOTIFICATION ERROR:', err.message || err);
        resolve();
      });
    });
    if (emailPlan === 'pending') {
      const letterhead = await loadLetterheadSafe();
      const rendered = mailer.renderTransferEmail({
        letterhead,
        subject: subject.value,
        message: note,
        fileNames: names,
        link: mailer.transferFilesLink(saved.transferId),
      });
      email = await sendPlannedEmail({
        user,
        emailPlan,
        toAddress,
        cc,
        rendered,
        log: {
          entityType: 'file_transfer',
          entityId: saved.transferId,
          detail: { transfer_id: saved.transferId, batch_id: batchId, customer_id: customer.id },
          sent: (address) => `Email sent to ${address}`,
          failed: (address) => `Email to ${address} failed`,
        },
      });
    }
  } catch (err) {
    err.filesCommitted = true;
    throw err;
  }

  const loaded = await getTransfer(user, saved.transferId);
  return { transfer: loaded.transfer, email };
}

module.exports = {
  listForUser,
  shareFiles,
  prepareDownload,
  removeFile,
  replaceFile,
  listTransfers,
  getTransfer,
  createTransfer,
};
