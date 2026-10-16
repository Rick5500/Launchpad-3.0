const db = require('./db');
const { getOrder } = require('./orderService');
const { orderWindow } = require('./deliveryRules');
const { code128Svg } = require('./barcodeSvg');

const SCAN_INSTRUCTIONS = [
  'Scan this barcode at each department.',
  'Do NOT scan until work is ready to move.',
  'Keep work order with the job at all times.',
];

// Letterhead from the owner's work order mockup. Phase 4 can move this into system settings.
const SHOP = {
  name: 'Accent Imaging, Inc.',
  address_lines: ['8121 Brownleigh Drive', 'Raleigh, NC 27617'],
  phone: '919-782-3332',
};

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
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

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clockLabel(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!match) return String(hhmm || '');
  const hour24 = Number(match[1]);
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${match[2]} ${suffix}`;
}

function deliveryWindowLabel() {
  const window = orderWindow();
  return `${clockLabel(window.start)} - ${clockLabel(window.end)} (${window.incrementMinutes} min increments)`;
}

function utcNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function routingStatusLabel(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'open') return 'Active';
  if (value === 'in-progress') return 'In Progress';
  if (value === 'completed' || value === 'complete') return 'Complete';
  if (value === 'on-hold') return 'On Hold';
  return status || '';
}

function historyStatusLabel(status) {
  const value = String(status || '').trim();
  const lower = value.toLowerCase();
  if (lower === 'submitted') return 'Submitted';
  if (lower === 'open') return 'Open';
  if (lower === 'in-progress') return 'In Progress';
  if (lower === 'completed' || lower === 'complete') return 'Complete';
  if (lower === 'on-hold') return 'On Hold';
  return value;
}

function presentHistory(rows, viewer) {
  return rows.map((row) => {
    const entry = {
      id: row.id,
      department: row.department,
      status: row.status,
      status_label: historyStatusLabel(row.status),
      event_time: row.event_time,
    };
    if (viewer && viewer.role === 'customer') return entry;
    return {
      ...entry,
      scanned_by: row.scanned_by || null,
      notes: row.notes || null,
    };
  });
}

function textOrEmpty(value) {
  if (value == null) return '';
  return String(value);
}

function barcodeValueFor(row) {
  const external = textOrEmpty(row.external_id).trim();
  return external || String(row.id);
}

function uniqueParts(parts) {
  const seen = new Set();
  const result = [];
  for (const part of parts) {
    const text = textOrEmpty(part).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

async function loadDelivery(orderId, workOrderId) {
  if (orderId) {
    const byOrder = await get(
      `SELECT will_call, due_time, carrier, status
       FROM deliveries
       WHERE order_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [orderId]
    );
    if (byOrder) return byOrder;
  }
  return get(
    `SELECT will_call, due_time, carrier, status
     FROM deliveries
     WHERE work_order_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [workOrderId]
  );
}

async function buildSheet(workOrderId, viewer) {
  const params = [workOrderId];
  let customerClause = '';
  if (viewer && viewer.role === 'customer') {
    customerClause = ' AND wo.customer_id = ?';
    params.push(Number(viewer.userId || viewer.id));
  }

  const row = await get(
    `SELECT
       wo.id,
       wo.external_id,
       wo.description,
       wo.quantity,
       wo.status,
       wo.department,
       wo.due_date,
       wo.notes,
       wo.order_id,
       wo.service_id,
       wo.next_department,
       wo.specifications,
       wo.created_at,
       s.name AS service_name,
       ps.name AS stage_name,
       o.order_number,
       o.company AS order_company,
       o.contact_name AS order_contact_name,
       o.phone AS order_phone,
       o.email AS order_email,
       o.po_number,
       o.project_number,
       o.project_name,
       o.notes AS order_notes,
       o.delivery_method,
       o.ship_to,
       o.attention,
       o.due_date AS order_due_date,
       o.due_time AS order_due_time,
       o.created_at AS order_created_at,
       u.display_name AS customer_name,
       u.company AS customer_company,
       u.contact_name AS customer_contact_name,
       u.phone AS customer_phone,
       u.email AS customer_email
     FROM work_orders wo
     LEFT JOIN services s ON s.id = wo.service_id
     LEFT JOIN production_stages ps ON ps.id = wo.stage_id
     LEFT JOIN orders o ON o.id = wo.order_id
     LEFT JOIN users u ON u.id = wo.customer_id
     WHERE wo.id = ?${customerClause}`,
    params
  );
  if (!row) return null;

  const lineItems = await all(
    `SELECT id, line_number, description, size, quantity, media, color, binding_finish,
            finishing, mount, laminate
     FROM order_line_items
     WHERE work_order_id = ?
     ORDER BY line_number, id`,
    [row.id]
  );
  const files = await all(
    `SELECT id, original_name, size_bytes, uploaded_at
     FROM order_files
     WHERE work_order_id = ? OR (order_id = ? AND work_order_id IS NULL)
     ORDER BY uploaded_at, id`,
    [row.id, row.order_id]
  );
  const history = await all(
    `SELECT id, department, status, event_time, scanned_by, notes
     FROM production_history
     WHERE work_order_id = ?
     ORDER BY event_time, id`,
    [row.id]
  );
  const delivery = await loadDelivery(row.order_id, row.id);
  const barcodeValue = barcodeValueFor(row);
  const specialInstructions = textOrEmpty(row.notes).trim() || textOrEmpty(row.order_notes).trim();
  const process = uniqueParts([row.service_name, row.stage_name, row.department]).join(' · ');

  return {
    id: row.id,
    external_id: row.external_id || null,
    barcode_value: barcodeValue,
    barcode_svg: code128Svg(barcodeValue),
    order_id: row.order_id || null,
    order_number: row.order_number || null,
    description: row.description || null,
    submitted_at: row.order_created_at || row.created_at || null,
    due_date: row.order_due_date || (row.due_date ? String(row.due_date).slice(0, 10) : null),
    due_time: row.order_due_time || null,
    contact: {
      company: row.order_company || row.customer_company || row.customer_name || '',
      contact_name: row.order_contact_name || row.customer_contact_name || row.customer_name || '',
      phone: row.order_phone || row.customer_phone || '',
      email: row.order_email || row.customer_email || '',
    },
    project: {
      po_number: row.po_number || '',
      project_number: row.project_number || '',
      project_name: row.project_name || '',
      notes: row.order_notes || '',
    },
    delivery: {
      method: row.delivery_method || (delivery && delivery.carrier) || '',
      will_call: Boolean(delivery && delivery.will_call),
      ship_to: row.ship_to || '',
      attention: row.attention || '',
    },
    service_name: row.service_name || null,
    stage_name: row.stage_name || null,
    process: process || null,
    quantity: row.quantity,
    line_items: lineItems.map((item) => ({
      id: item.id,
      line_number: item.line_number,
      description: item.description,
      size: item.size || '',
      quantity: item.quantity || '',
      media: item.media || '',
      color: item.color || '',
      binding_finish: item.binding_finish || '',
      finishing: item.finishing || '',
      mount: Boolean(item.mount),
      laminate: Boolean(item.laminate),
    })),
    special_instructions: specialInstructions,
    specifications: lineItems.length ? null : (row.specifications || ''),
    files: files.map((file) => ({
      id: file.id,
      original_name: file.original_name,
      size_bytes: file.size_bytes,
      uploaded_at: file.uploaded_at,
    })),
    routing: {
      department: row.department || '',
      current_status: row.status || '',
      current_status_label: routingStatusLabel(row.status),
      next_department: row.next_department || '',
    },
    production_history: presentHistory(history, viewer),
  };
}

function envelope(kind, orderId, orderNumber, sheets, viewer) {
  return {
    kind,
    order_id: orderId || null,
    order_number: orderNumber || null,
    shop: {
      name: SHOP.name,
      address_lines: SHOP.address_lines.slice(),
      phone: SHOP.phone,
    },
    scan_instructions: SCAN_INSTRUCTIONS.slice(),
    delivery_window_label: deliveryWindowLabel(),
    generated_at: utcNow(),
    staff_history: !viewer || viewer.role !== 'customer',
    work_orders: sheets,
  };
}

async function printForWorkOrder(viewer, rawId) {
  const id = parsePositive(rawId);
  if (!id) throw httpError(400, 'id must be a positive integer');
  const sheet = await buildSheet(id, viewer);
  if (!sheet) return null;
  return envelope('work_order', sheet.order_id, sheet.order_number, [sheet], viewer);
}

async function printForOrder(viewer, rawId) {
  const order = await getOrder(viewer, rawId);
  if (!order) return null;
  const sheets = [];
  for (const workOrder of order.work_orders) {
    const sheet = await buildSheet(workOrder.id, viewer);
    if (sheet) sheets.push(sheet);
  }
  return envelope('order', order.id, order.order_number, sheets, viewer);
}

module.exports = {
  SCAN_INSTRUCTIONS,
  SHOP,
  printForWorkOrder,
  printForOrder,
};
