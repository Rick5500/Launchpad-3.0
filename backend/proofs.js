const path = require('path');
const activityLog = require('./activityLog');
const { get, all, withTransaction } = require('./dbAsync');
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
const shopLocations = require('./shopLocations');
const systemSettings = require('./systemSettings');

const STAFF = new Set(['admin', 'manager', 'operator']);
const HELD = new Set(['awaiting', 'changes_requested']);

const STATUS_LABELS = Object.freeze({
  awaiting: 'Awaiting proof approval',
  changes_requested: 'Changes requested',
  approved: 'Approved',
});

const PROOF_SELECT = `
  SELECT p.id, p.order_id, p.work_order_id, p.customer_id, p.version, p.status, p.message,
         p.created_at, p.decided_at, p.decision_comment, p.created_by, p.decided_by,
         wo.external_id AS work_order_number,
         o.order_number, o.customer_id AS order_customer_id, o.email AS order_email,
         o.location_id AS order_location_id,
         COALESCE(NULLIF(trim(sender.display_name), ''), NULLIF(trim(sender.username), '')) AS sender_name,
         COALESCE(NULLIF(trim(decider.display_name), ''), NULLIF(trim(decider.username), '')) AS decided_by_name,
         COALESCE(NULLIF(trim(customer.display_name), ''), NULLIF(trim(customer.username), '')) AS customer_name
  FROM proofs p
  JOIN orders o ON o.id = p.order_id
  LEFT JOIN work_orders wo ON wo.id = p.work_order_id
  LEFT JOIN users sender ON sender.id = p.created_by
  LEFT JOIN users decider ON decider.id = p.decided_by
  LEFT JOIN users customer ON customer.id = o.customer_id
`;

function actorId(user) {
  return Number(user.userId || user.id);
}

function isStaff(user) {
  return Boolean(user) && STAFF.has(user.role);
}

function isProofHeld(status) {
  return HELD.has(String(status || '').trim());
}

function statusLabel(status) {
  if (!status) return null;
  return STATUS_LABELS[status] || status;
}

function actorLabel(user) {
  const name = user && (user.display_name || user.username);
  const text = String(name || '').trim();
  return text || 'Customer';
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

function parseProofId(value) {
  const id = parseOptionalId(value, 'id');
  if (!id) throw httpError(400, 'id must be a positive integer');
  return id;
}

function publicFile(row) {
  return {
    id: row.id,
    original_name: row.original_name,
    mime_type: row.mime_type || null,
    size_bytes: row.size_bytes,
  };
}

function publicProof(row, files) {
  return {
    id: row.id,
    order_id: row.order_id,
    work_order_id: row.work_order_id || null,
    work_order_number: row.work_order_number || null,
    order_number: row.order_number || null,
    version: row.version,
    version_label: `v${row.version}`,
    status: row.status,
    status_label: statusLabel(row.status),
    message: row.message || null,
    created_at: row.created_at,
    sender_name: row.sender_name || null,
    decided_at: row.decided_at || null,
    decided_by_name: row.decided_by_name || null,
    decision_comment: row.decision_comment || null,
    files: (files || []).map(publicFile),
  };
}

async function filesFor(proofIds) {
  if (!proofIds.length) return new Map();
  const rows = await all(
    `SELECT id, proof_id, original_name, mime_type, size_bytes
     FROM proof_files
     WHERE proof_id IN (${proofIds.map(() => '?').join(', ')})
     ORDER BY id`,
    proofIds
  );
  const grouped = new Map();
  for (const row of rows) {
    const list = grouped.get(row.proof_id) || [];
    list.push(row);
    grouped.set(row.proof_id, list);
  }
  return grouped;
}

async function presentRows(rows) {
  const grouped = await filesFor(rows.map((row) => row.id));
  return rows.map((row) => publicProof(row, grouped.get(row.id) || []));
}

async function loadOrder(orderId) {
  const order = await get(
    `SELECT id, customer_id, order_number, email, company, location_id
     FROM orders WHERE id = ?`,
    [orderId]
  );
  if (!order) throw httpError(404, 'Order not found');
  return order;
}

async function assertOrderAccess(user, order) {
  if (isStaff(user)) {
    const access = await shopLocations.loadAccess(actorId(user));
    shopLocations.assertVisible(access, order.location_id, 'Order not found');
    return;
  }
  if (user.role === 'customer' && Number(order.customer_id) === actorId(user)) return;
  throw httpError(404, 'Order not found');
}

async function loadProofRow(id) {
  return get(`${PROOF_SELECT} WHERE p.id = ?`, [id]);
}

async function assertProofAccess(user, proof) {
  if (!proof) throw httpError(404, 'Proof not found');
  if (isStaff(user)) {
    const access = await shopLocations.loadAccess(actorId(user));
    shopLocations.assertVisible(access, proof.order_location_id, 'Proof not found');
    return;
  }
  if (user.role === 'customer' && Number(proof.order_customer_id) === actorId(user)) return;
  throw httpError(404, 'Proof not found');
}

function assertFiles(files) {
  if (!files || !files.length) throw httpError(400, 'Choose a file to upload');
  for (const file of files) {
    if (!file || !file.size) throw httpError(400, 'Empty files are not allowed');
    const storedName = path.basename(file.filename || '');
    if (!safeStoredPath(storedName)) throw httpError(400, 'This file type is not allowed');
  }
}

async function workOrdersFor(tx, orderId, workOrderId) {
  if (workOrderId) {
    const row = await tx.get(
      'SELECT id, order_id, external_id, department, status FROM work_orders WHERE id = ?',
      [workOrderId]
    );
    return row ? [row] : [];
  }
  return tx.all(
    'SELECT id, order_id, external_id, department, status FROM work_orders WHERE order_id = ? ORDER BY id',
    [orderId]
  );
}

async function latestCoveringStatuses(tx, workOrderId, orderId) {
  const job = await tx.get(
    `SELECT status
     FROM proofs
     WHERE work_order_id = ?
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    [workOrderId]
  );
  const orderWide = await tx.get(
    `SELECT status
     FROM proofs
     WHERE order_id = ? AND work_order_id IS NULL
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    [orderId || 0]
  );
  return [job, orderWide].filter(Boolean).map((row) => row.status);
}

function combinedProofStatus(statuses) {
  if (!statuses.length) return null;
  if (statuses.includes('awaiting')) return 'awaiting';
  if (statuses.includes('changes_requested')) return 'changes_requested';
  if (statuses.every((status) => status === 'approved')) return 'approved';
  return null;
}

// A job is covered by its own proof series and by proofs sent for the whole order.
// The latest version of each series counts. Any awaiting or changes-requested
// series holds the job. It is approved only when every series is approved.
async function governingStatus(tx, workOrderId, orderId) {
  return combinedProofStatus(await latestCoveringStatuses(tx, workOrderId, orderId));
}

async function applyProofStatus(tx, workOrder) {
  const status = await governingStatus(tx, workOrder.id, workOrder.order_id);
  await tx.run(
    `UPDATE work_orders SET proof_status = ?, updated_at = datetime('now') WHERE id = ?`,
    [status, workOrder.id]
  );
  return status;
}

async function releaseOpenJobs(tx, workOrders, user) {
  const released = [];
  for (const workOrder of workOrders) {
    const status = await applyProofStatus(tx, workOrder);
    if (status !== 'approved') continue;
    const updated = await tx.run(
      `UPDATE work_orders
       SET status = 'in-progress', updated_at = datetime('now')
       WHERE id = ? AND status = 'open'`,
      [workOrder.id]
    );
    if (!updated || updated.changes !== 1) continue;
    await tx.run(
      `INSERT INTO production_history (work_order_id, department, status, scanned_by, user_id, notes)
       VALUES (?, ?, 'in-progress', ?, ?, 'Proof approved')`,
      [workOrder.id, workOrder.department || 'Production', actorLabel(user), actorId(user)]
    );
    await activityLog.recordOn(tx, actorId(user), 'work_order.proof_released', 'work_order', workOrder.id, {
      external_id: workOrder.external_id || null,
      message: 'Proof approved and moved to In Production',
    });
    released.push(workOrder.id);
  }
  return released;
}

function isUniqueError(err) {
  return Boolean(err) && /UNIQUE/i.test(String(err.message || ''));
}

async function recordProofActivity(tx, user, action, proof, message, extra) {
  const detail = {
    proof_id: proof.id,
    version: proof.version,
    order_number: proof.order_number || null,
    work_order_id: proof.work_order_id || null,
    external_id: proof.work_order_number || null,
    message,
    ...extra,
  };
  await activityLog.recordOn(tx, actorId(user), action, 'order', proof.order_id, detail);
  if (proof.work_order_id) {
    await activityLog.recordOn(tx, actorId(user), action, 'work_order', proof.work_order_id, detail);
  }
}

async function listForUser(user, orderId) {
  const order = await loadOrder(orderId);
  await assertOrderAccess(user, order);
  const proofs = await presentRows(await all(
    `${PROOF_SELECT} WHERE p.order_id = ? ORDER BY p.created_at, p.id`,
    [order.id]
  ));
  const workOrders = await all(
    `SELECT wo.id, wo.external_id, wo.proof_status, s.name AS service_name
     FROM work_orders wo
     LEFT JOIN services s ON s.id = wo.service_id
     WHERE wo.order_id = ?
     ORDER BY wo.external_id`,
    [order.id]
  );
  const body = {
    proofs,
    timezone: getRules().timezone,
    work_orders: workOrders.map((row) => ({
      id: row.id,
      external_id: row.external_id,
      service_name: row.service_name || null,
      proof_status: row.proof_status || null,
      proof_status_label: statusLabel(row.proof_status),
    })),
  };
  if (isStaff(user)) {
    body.mail = {
      configured: mailer.isConfigured(),
      default_send: await systemSettings.emailCustomersOnProof(),
      to: order.email || '',
      public_url_set: Boolean(mailer.publicAppUrl()),
    };
  }
  return body;
}

async function listPending(user) {
  const params = [];
  let customerClause = '';
  if (!isStaff(user)) {
    if (user.role !== 'customer') throw httpError(403, 'Forbidden');
    customerClause = ' AND o.customer_id = ?';
    params.push(actorId(user));
  } else {
    const access = await shopLocations.loadAccess(actorId(user));
    const locked = shopLocations.predicate('o.location_id', access);
    if (locked.sql) {
      customerClause = ` AND ${locked.sql}`;
      params.push(...locked.params);
    }
  }
  const rows = await all(
    `${PROOF_SELECT}
     WHERE p.status = 'awaiting'${customerClause}
     ORDER BY p.created_at DESC, p.id DESC`,
    params
  );
  return {
    proofs: await presentRows(rows),
    timezone: getRules().timezone,
  };
}

async function presentForWorkOrder(workOrderId, orderId) {
  const row = await get('SELECT id, proof_status FROM work_orders WHERE id = ?', [workOrderId]);
  const proofs = await presentRows(await all(
    `${PROOF_SELECT}
     WHERE p.work_order_id = ? OR (p.order_id = ? AND p.work_order_id IS NULL)
     ORDER BY p.created_at, p.id`,
    [workOrderId, orderId || 0]
  ));
  const status = row ? row.proof_status || null : null;
  return {
    proof_status: status,
    proof_status_label: statusLabel(status),
    proofs,
  };
}

function notifyReady(item) {
  return new Promise((resolve) => {
    notifications.notifyProofReady(item, (err) => {
      if (err) console.error('PROOF NOTIFICATION ERROR:', err.message || err);
      resolve();
    });
  });
}

function notifyDecision(item) {
  return new Promise((resolve) => {
    notifications.notifyProofDecision(item, (err) => {
      if (err) console.error('PROOF NOTIFICATION ERROR:', err.message || err);
      resolve();
    });
  });
}

async function loadLetterheadSafe(locationId) {
  try {
    return await shopLocations.letterheadForLocationId(locationId);
  } catch (err) {
    console.error('LETTERHEAD ERROR:', err.message || err);
    return { name: '', address: '', address_lines: [], phone: '' };
  }
}

async function logEmail(user, order, kind, recipient, ok, extra) {
  await activityLog.record(actorId(user), ok ? `${kind}_sent` : `${kind}_failed`, 'order', order.id, {
    order_number: order.order_number,
    recipient: recipient.address,
    message: ok
      ? `Email sent to ${recipient.address} for order ${order.order_number}`
      : `Email to ${recipient.address} failed for order ${order.order_number}`,
    ...extra,
  }).catch((err) => console.error('PROOF EMAIL LOG ERROR:', err.message || err));
}

async function sendProof(user, orderId, body, files) {
  if (!isStaff(user)) throw httpError(403, 'Forbidden');
  assertFiles(files);
  const order = await loadOrder(orderId);
  const source = body || {};
  const message = parseText(source.message, 'message', { required: true, max: 2000, allowNewlines: true });
  if (message.error) throw httpError(400, message.error);
  const workOrderId = parseOptionalId(source.work_order_id, 'work_order_id');
  let workOrder = null;
  if (workOrderId) {
    workOrder = await get(
      'SELECT id, external_id, order_id, department, status FROM work_orders WHERE id = ? AND order_id = ?',
      [workOrderId, order.id]
    );
    if (!workOrder) throw httpError(400, 'work_order_id is not on this order');
  }
  const defaultSend = await systemSettings.emailCustomersOnProof();
  const wantsEmail = parseSendEmail(source.send_email, defaultSend);
  let toAddress = null;
  let cc = [];
  if (wantsEmail) {
    if (source.email_to != null && String(source.email_to).trim() !== '') {
      const parsed = mailer.parseAddressList(source.email_to, { max: 1, field: 'email_to' });
      if (parsed.error) throw httpError(400, parsed.error);
      if (parsed.value.length !== 1) throw httpError(400, 'email_to must be one address');
      toAddress = parsed.value[0];
    } else {
      const parsed = mailer.parseAddressList(order.email, { max: 1, field: 'email_to' });
      if (parsed.error || parsed.value.length !== 1) {
        throw httpError(400, 'The order has no valid contact email. Enter one before sending.');
      }
      toAddress = parsed.value[0];
    }
    if (source.email_cc != null && String(source.email_cc).trim() !== '') {
      const parsed = mailer.parseAddressList(source.email_cc, { max: 5, field: 'email_cc' });
      if (parsed.error) throw httpError(400, parsed.error);
      cc = parsed.value.filter((address) => address.toLowerCase() !== toAddress.toLowerCase());
    }
  }

  const configured = mailer.isConfigured();
  let emailPlan = 'skipped';
  if (wantsEmail && !configured) emailPlan = 'not_configured';
  if (wantsEmail && configured) {
    const slot = mailer.reserveEmail(actorId(user));
    emailPlan = slot.allowed ? 'pending' : 'rate_limited';
  }

  const names = files.map((file) => sanitizeOriginalName(file.originalname));
  let proofId;
  let version;
  const saved = await withTransaction(async (tx) => {
      const scopeId = workOrder ? workOrder.id : 0;
      const latest = await tx.get(
        `SELECT id, version, status
         FROM proofs
         WHERE order_id = ? AND IFNULL(work_order_id, 0) = ?
         ORDER BY version DESC, id DESC
         LIMIT 1`,
        [order.id, scopeId]
      );
      if (latest && latest.status === 'awaiting') {
        throw httpError(409, 'A proof is already awaiting approval');
      }
      const nextVersion = latest ? latest.version + 1 : 1;
      let inserted;
      try {
        inserted = await tx.run(
          `INSERT INTO proofs (
            order_id, work_order_id, customer_id, version, status, message, created_by
          ) VALUES (?,?,?,?, 'awaiting', ?, ?)`,
          [
            order.id,
            workOrder ? workOrder.id : null,
            order.customer_id,
            nextVersion,
            message.value,
            actorId(user),
          ]
        );
      } catch (err) {
        if (isUniqueError(err)) throw httpError(409, 'A proof version was just saved. Refresh and try again.');
        throw err;
      }
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const storedName = path.basename(file.filename);
        await tx.run(
          `INSERT INTO proof_files (proof_id, original_name, stored_name, mime_type, size_bytes, storage_root)
           VALUES (?,?,?,?,?,?)`,
          [
            inserted.lastID,
            names[index],
            storedName,
            contentTypeFor(storedName),
            file.size,
            storageRootOfUpload(file),
          ]
        );
      }
      const proof = {
        id: inserted.lastID,
        order_id: order.id,
        order_number: order.order_number,
        work_order_id: workOrder ? workOrder.id : null,
        work_order_number: workOrder ? workOrder.external_id : null,
        version: nextVersion,
      };
      await recordProofActivity(
        tx,
        user,
        'proof.sent',
        proof,
        `Sent proof v${nextVersion} on order ${order.order_number}`,
        { file_names: names }
      );
      const targets = await workOrdersFor(tx, order.id, workOrder ? workOrder.id : null);
      for (const target of targets) await applyProofStatus(tx, target);
      return { id: inserted.lastID, version: nextVersion };
    });
  proofId = saved.id;
  version = saved.version;

  const title = `New proof for order ${order.order_number}`;
  let email = { status: emailPlan === 'pending' ? 'skipped' : emailPlan, recipients: [] };
  try {
    await notifyReady({
      orderId: order.id,
      orderNumber: order.order_number,
      customerId: order.customer_id,
      workOrderId: workOrder ? workOrder.id : null,
      proofId,
      locationId: order.location_id,
      title,
      body: `Proof v${version} is ready to review. ${message.value}`,
    });
    if (emailPlan === 'pending') {
      const letterhead = await loadLetterheadSafe(order.location_id);
      const rendered = mailer.renderProofEmail({
        letterhead,
        orderNumber: order.order_number,
        version,
        message: message.value,
        fileNames: names,
        workOrderNumber: workOrder ? workOrder.external_id : null,
        link: mailer.orderProofLink(order.id),
      });
      const result = await mailer.deliver({
        to: toAddress,
        cc,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      email = { status: result.status, recipients: result.recipients };
      const preview = mailer.previewFrom(result.captured);
      if (preview) email.preview = preview;
      for (const recipient of result.recipients) {
        await logEmail(user, order, 'proof.email', recipient, recipient.status === 'sent', {
          proof_id: proofId,
          version,
        });
      }
    }
  } catch (err) {
    err.filesCommitted = true;
    throw err;
  }

  const row = await loadProofRow(proofId);
  const presented = (await presentRows([row]))[0];
  return { proof: presented, email };
}

async function staffRecipients() {
  const rows = await all(
    `SELECT email FROM users
     WHERE role IN ('admin', 'manager', 'operator')
       AND COALESCE(is_active, 1) = 1
       AND email IS NOT NULL
       AND trim(email) != ''
     ORDER BY id`
  );
  const addresses = [];
  const seen = new Set();
  for (const row of rows) {
    const parsed = mailer.parseAddressList(row.email, { max: 1, field: 'email' });
    if (parsed.error || parsed.value.length !== 1) continue;
    const address = parsed.value[0];
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
    if (addresses.length >= 6) break;
  }
  return addresses;
}

async function emailStaffChanges(user, proof, comment) {
  if (!mailer.isConfigured()) return { status: 'not_configured', recipients: [] };
  const slot = mailer.reserveEmail(actorId(user));
  if (!slot.allowed) return { status: 'rate_limited', recipients: [] };
  const addresses = await staffRecipients();
  if (!addresses.length) return { status: 'no_recipients', recipients: [] };
  const letterhead = await loadLetterheadSafe(proof.order_location_id);
  const rendered = mailer.renderProofChangesEmail({
    letterhead,
    orderNumber: proof.order_number,
    version: proof.version,
    comment,
    customerName: proof.customer_name || actorLabel(user),
    workOrderNumber: proof.work_order_number,
    link: mailer.proofReviewLink(proof.order_id, proof.work_order_id),
  });
  const result = await mailer.deliver({
    to: addresses[0],
    cc: addresses.slice(1),
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
  const email = { status: result.status, recipients: result.recipients };
  const preview = mailer.previewFrom(result.captured);
  if (preview) email.preview = preview;
  const order = { id: proof.order_id, order_number: proof.order_number };
  for (const recipient of result.recipients) {
    await logEmail(user, order, 'proof.staff_email', recipient, recipient.status === 'sent', {
      proof_id: proof.id,
      version: proof.version,
    });
  }
  return email;
}

async function decide(user, rawId, decision, comment) {
  if (!user || user.role !== 'customer') {
    throw httpError(403, 'Only the customer on this order can decide a proof');
  }
  const id = parseProofId(rawId);
  const visible = await loadProofRow(id);
  await assertProofAccess(user, visible);
  let note = null;
  if (decision === 'changes_requested') {
    const parsed = parseText(comment, 'comment', { required: true, max: 2000, allowNewlines: true });
    if (parsed.error) throw httpError(400, parsed.error);
    note = parsed.value;
  }
  const outcome = await withTransaction(async (tx) => {
    const proof = await tx.get(`${PROOF_SELECT} WHERE p.id = ?`, [id]);
    if (!proof || Number(proof.order_customer_id) !== actorId(user)) throw httpError(404, 'Proof not found');
    if (proof.status !== 'awaiting') throw httpError(409, 'This proof version already has a decision');
    const updated = await tx.run(
      `UPDATE proofs
       SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_comment = ?
       WHERE id = ? AND status = 'awaiting'`,
      [decision, actorId(user), note, id]
    );
    if (!updated.changes) throw httpError(409, 'This proof version already has a decision');
    const action = decision === 'approved' ? 'proof.approved' : 'proof.changes_requested';
    const message = decision === 'approved'
      ? `Approved proof v${proof.version}`
      : `Requested changes on proof v${proof.version}`;
    await recordProofActivity(tx, user, action, proof, message, { comment: note });
    const targets = await workOrdersFor(tx, proof.order_id, proof.work_order_id);
    const released = decision === 'approved'
      ? await releaseOpenJobs(tx, targets, user)
      : await (async () => {
        for (const target of targets) await applyProofStatus(tx, target);
        return [];
      })();
    return {
      orderId: proof.order_id,
      orderNumber: proof.order_number,
      workOrderId: proof.work_order_id,
      workOrderNumber: proof.work_order_number,
      version: proof.version,
      customerName: proof.customer_name,
      released,
    };
  });

  const approved = decision === 'approved';
  const title = approved
    ? `Proof approved for order ${outcome.orderNumber}`
    : `Changes requested for order ${outcome.orderNumber}`;
  const where = outcome.workOrderNumber ? ` on ${outcome.workOrderNumber}` : '';
  const body = approved
    ? `Proof v${outcome.version}${where} was approved.`
    : `Proof v${outcome.version}${where}: ${note}`;
  await notifyDecision({
    proofId: id,
    status: decision,
    orderId: outcome.orderId,
    orderNumber: outcome.orderNumber,
    workOrderId: outcome.workOrderId,
    title,
    body,
  });

  let email = null;
  if (!approved) {
    try {
      email = await emailStaffChanges(user, {
        id,
        order_id: outcome.orderId,
        order_number: outcome.orderNumber,
        work_order_id: outcome.workOrderId,
        work_order_number: outcome.workOrderNumber,
        version: outcome.version,
        customer_name: outcome.customerName,
      }, note);
    } catch (err) {
      console.error('PROOF STAFF EMAIL ERROR:', err.message || err);
      email = { status: 'failed', recipients: [] };
    }
  }

  const row = await loadProofRow(id);
  return {
    proof: (await presentRows([row]))[0],
    released_work_order_ids: outcome.released,
    email,
  };
}

async function approve(user, id) {
  return decide(user, id, 'approved', null);
}

async function requestChanges(user, id, body) {
  const source = body || {};
  return decide(user, id, 'changes_requested', source.comment);
}

async function prepareFile(user, rawId) {
  const id = parseProofId(rawId);
  const file = await get(
    `SELECT pf.id, pf.original_name, pf.stored_name, pf.storage_root, pf.proof_id,
            p.order_id, o.customer_id AS order_customer_id, o.location_id AS order_location_id
     FROM proof_files pf
     JOIN proofs p ON p.id = pf.proof_id
     JOIN orders o ON o.id = p.order_id
     WHERE pf.id = ?`,
    [id]
  );
  if (!file) throw httpError(404, 'File not found');
  if (isStaff(user)) {
    const access = await shopLocations.loadAccess(actorId(user));
    shopLocations.assertVisible(access, file.order_location_id, 'File not found');
  } else if (!isStaff(user)) {
    if (!user || user.role !== 'customer' || Number(file.order_customer_id) !== actorId(user)) {
      throw httpError(404, 'File not found');
    }
  }
  const opened = openStored(file.stored_name, file.storage_root);
  if (!opened) throw httpError(404, 'File not found');
  return {
    fullPath: opened.fullPath,
    size: opened.size,
    downloadName: sanitizeOriginalName(file.original_name),
    contentType: contentTypeFor(file.stored_name),
  };
}

module.exports = {
  STATUS_LABELS,
  isProofHeld,
  statusLabel,
  listForUser,
  listPending,
  presentForWorkOrder,
  sendProof,
  approve,
  requestChanges,
  prepareFile,
};
