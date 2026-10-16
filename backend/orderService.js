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

function requiredText(value, field, max) {
  if (value == null || (typeof value !== 'string' && typeof value !== 'number')) {
    throw new OrderError(`${field} is required`);
  }
  const text = String(value).trim();
  if (!text) throw new OrderError(`${field} is required`);
  if (text.length > max) throw new OrderError(`${field} must be ${max} characters or fewer`);
  return text;
}

function optionalText(value, field, max) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new OrderError(`${field} is invalid`);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new OrderError(`${field} must be ${max} characters or fewer`);
  return text;
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

function specificationText(items, notes) {
  const blocks = (items || []).map((item, index) => {
    const title = items.length > 1 ? `Item ${index + 1}: ${item.description}` : item.description;
    return [
      title,
      `Size: ${item.size || '—'}`,
      `Quantity: ${item.quantity || '—'}`,
      `Media: ${item.media || '—'}`,
      `Color: ${item.color || '—'}`,
      `Binding / Finish: ${item.binding_finish || '—'}`,
      `Mounting: ${yesNoLabel(item.mount)}`,
      `Lamination: ${yesNoLabel(item.laminate)}`,
      `Finishing: ${item.finishing || 'None'}`,
    ].join('\n');
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
    return {
      lineNumber: index + 1,
      serviceId,
      description: requiredText(item.description, `line item ${index + 1} description`, 200),
      size: optionalText(item.size, `line item ${index + 1} size`, 40),
      quantity: optionalText(item.quantity, `line item ${index + 1} quantity`, 40),
      media: optionalText(item.media, `line item ${index + 1} media`, 80),
      color: optionalText(item.color, `line item ${index + 1} color`, 80),
      bindingFinish: optionalText(item.binding_finish, `line item ${index + 1} binding/finish`, 80),
      finishing: optionalText(item.finishing, `line item ${index + 1} finishing`, 80),
      mount: parseYesNo(item.mount, `line item ${index + 1} mount`),
      laminate: parseYesNo(item.laminate, `line item ${index + 1} laminate`),
      fileIds,
    };
  });
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

function confirmationPayload() {
  return {
    email_sent: false,
    email_status: 'disabled',
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

function publicLineItem(row) {
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
  };
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
    `SELECT o.*, u.username AS customer_username, u.display_name AS customer_display_name
     FROM orders o
     LEFT JOIN users u ON u.id = o.customer_id
     WHERE o.id = ?${customerClause}`,
    params
  );
  if (!order) return null;

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
    delivery_method: order.delivery_method,
    ups_account_number: order.ups_account_number || null,
    delivery_hours: deliveryHoursFor(order.delivery_method, delivery && delivery.will_call),
    ship_to: order.ship_to,
    attention: order.attention,
    due_date: order.due_date,
    due_time: order.due_time,
    created_by: order.created_by,
    created_at: order.created_at,
    updated_at: order.updated_at,
    line_items: lineItems.map(publicLineItem),
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
    confirmation: confirmationPayload(),
  };
}

async function createOrder(user, body, now = new Date()) {
  const payload = body || {};
  assertCustomerFields(user, payload);
  const customerId = customerIdFor(user, payload);
  const company = requiredText(payload.company, 'company', 160);
  const contactName = requiredText(payload.contact_name, 'contact_name', 160);
  const phone = requiredPhone(payload.phone);
  const email = requiredEmail(payload.email);
  const poNumber = optionalText(payload.po_number, 'po_number', 80);
  const projectNumber = optionalText(payload.project_number, 'project_number', 80);
  const projectName = optionalText(payload.project_name, 'project_name', 160);
  const notes = optionalText(payload.notes, 'notes', 2000);
  const shipTo = optionalText(payload.ship_to, 'ship_to', 500);
  const attention = optionalText(payload.attention, 'attention', 160);
  const deliveryMethodName = requiredText(payload.delivery_method, 'delivery_method', 120);
  if (retiredDeliveryMethod(deliveryMethodName)) {
    throw new OrderError(retiredDeliveryMessage(deliveryMethodName));
  }
  const upsAccount = parseUpsAccountNumber(payload.ups_account_number);
  if (upsAccount.error) throw new OrderError(upsAccount.error);
  const serviceIds = parseServiceIds(payload);
  const lineItems = parseLineItems(payload, serviceIds);
  const topLevelFileIds = parseTopLevelFileIds(payload);
  const fileIds = collectFileIds(lineItems, topLevelFileIds);

  const orderId = await withTransaction(async (tx) => {
    const customer = await tx.get(
      'SELECT id, role, is_active FROM users WHERE id = ?',
      [customerId]
    );
    if (!customer || customer.role !== 'customer' || customer.is_active === 0) {
      throw new OrderError('customer_id must be an existing customer', 400);
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

    if (fileIds.length) {
      const filePlaceholders = fileIds.map(() => '?').join(', ');
      const files = await tx.all(
        `SELECT id, order_id, customer_id, uploaded_by
         FROM order_files
         WHERE id IN (${filePlaceholders})`,
        fileIds
      );
      if (files.length !== fileIds.length) throw new OrderError('One or more files could not be found', 404);
      for (const file of files) {
        if (file.order_id) throw new OrderError('A file is already attached to an order');
        const staff = user.role === 'admin' || user.role === 'operator';
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

    const orderNumber = await allocateOrderNumber(tx, now);
    const inserted = await tx.run(
      `INSERT INTO orders (
        order_number, customer_id, company, contact_name, phone, email,
        po_number, project_number, project_name, notes, delivery_method,
        ups_account_number, ship_to, attention, due_date, due_time, created_by, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
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
        shipTo,
        attention,
        due.value.dueDate,
        due.value.dueTime,
        Number(user.userId || user.id),
      ]
    );
    const newOrderId = inserted.lastID;

    const lineItemIds = [];
    for (const item of lineItems) {
      const result = await tx.run(
        `INSERT INTO order_line_items (
          order_id, service_id, line_number, description, size, quantity, media, color,
          binding_finish, finishing, mount, laminate
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          requires_approval, approval_status, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
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
      })]
    );

    return newOrderId;
  });

  const record = await loadOrderRecord(orderId, user);
  return presentOrder(record);
}

async function listOrders(user, query) {
  const limit = parseListLimit(query.limit);
  const offset = parseListOffset(query.offset);
  const params = [];
  let where = '';
  if (user.role === 'customer') {
    where = 'WHERE o.customer_id = ?';
    params.push(Number(user.userId || user.id));
  }
  const totalRow = await getOn(db, `SELECT COUNT(*) AS count FROM orders o ${where}`, params);
  const orders = await allOn(
    db,
    `SELECT o.id, o.order_number, o.customer_id, o.company, o.contact_name, o.phone, o.email,
            o.po_number, o.project_number, o.project_name, o.delivery_method, o.ups_account_number,
            o.due_date, o.due_time, o.created_at, u.display_name AS customer_display_name
     FROM orders o
     LEFT JOIN users u ON u.id = o.customer_id
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
  return {
    services: services.map((service) => ({
      ...service,
      requires_approval: Boolean(service.requires_approval),
    })),
    delivery_methods: selectable.map((method) => ({
      ...method,
      will_call: Boolean(method.will_call),
    })),
    due_window: presentDueWindow(deliveryHours, 'delivery'),
    due_windows: {
      will_call: presentDueWindow(willCallHours, 'will_call'),
      delivery: presentDueWindow(deliveryHours, 'delivery'),
    },
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
  if (value === 'in-progress') return 'In Progress';
  if (value === 'completed' || value === 'complete') return 'Complete';
  if (value === 'on-hold') return 'On Hold';
  return status || null;
}

function specificationLines(items, notes) {
  return (items || []).map((item) => ({
    title: item.description,
    line_number: item.line_number,
    fields: [
      { label: 'Size', value: item.size || '—' },
      { label: 'Quantity', value: item.quantity || '—' },
      { label: 'Media', value: item.media || '—' },
      { label: 'Color', value: item.color || '—' },
      { label: 'Binding / Finish', value: item.binding_finish || '—' },
      { label: 'Mounting', value: yesNoLabel(item.mount) },
      { label: 'Lamination', value: yesNoLabel(item.laminate) },
      { label: 'Finishing', value: item.finishing || 'None' },
      { label: 'Special Instructions', value: notes || '—' },
    ],
  }));
}

function customerHistory(entry) {
  return {
    id: entry.id,
    department: entry.department,
    status: entry.status,
    event_time: entry.event_time,
  };
}

async function loadWorkOrderContext(row, viewer) {
  const lineItems = await allOn(
    db,
    `SELECT id, line_number, description, size, quantity, media, color, binding_finish,
            finishing, mount, laminate, service_id, work_order_id
     FROM order_line_items
     WHERE work_order_id = ?
     ORDER BY line_number, id`,
    [row.id]
  );
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
    line_items: lineItems.map((item) => ({
      ...publicLineItem(item),
      mount: Boolean(item.mount),
      laminate: Boolean(item.laminate),
    })),
    files: files.map(publicFile),
    production_history: viewer && viewer.role === 'customer' ? history.map(customerHistory) : history,
    routing: {
      department: row.department || null,
      current_status: row.status || null,
      current_status_label: routingStatusLabel(row.status),
      next_department: row.next_department || null,
    },
    specification_lines: specificationLines(lineItems, row.notes),
  };
}

module.exports = {
  OrderError,
  CUSTOMER_FORBIDDEN_FIELDS,
  withTransaction,
  createOrder,
  listOrders,
  getOrder,
  orderOptions,
  previewOrder,
  loadWorkOrderContext,
  presentOrder,
  formatOrderNumber,
  suffixForIndex,
};
