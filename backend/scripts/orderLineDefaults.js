/**
 * Fills payment_method and per-service field_values for older verify payloads.
 * Select values are copied only when they are still an active option.
 * Size is copied as text only for Signs & Graphics.
 */
const {
  SMALL_FORMAT_BINDING,
  SMALL_FORMAT_PAPER,
  SMALL_FORMAT_PRODUCTS,
  SMALL_FORMAT_SIZES,
} = require('../smallFormatCatalog');

const serviceNames = new Map();

const LARGE_SIZE = ['Full Size', 'Half Size', 'See Note'];
const LARGE_PROCESS = ['Black & White', 'Color Line'];
const LARGE_MEDIA = ['Bond', 'Vellum', 'Vellum Erase', 'Mylar', 'Mylar Reversed', 'See Note'];
const LARGE_BINDING = ['None', 'Staple', 'Screw Post', 'See Note'];
const SMALL_PROCESS = ['Black & White', 'Color'];
const SIGNS_FINISHING = ['None', 'Grommets', 'Easel', 'Cut/Trim', 'Velcro', 'Print Hanger', 'Framing', 'Contour Cut', 'Routed Shape', 'See Notes'];
const SIGNS_MOUNT = ['No', '3/16 Foam Core', '3/16 Gator Board', '1/2 Gator Board', '1/8 Sintra', '1/4 Sintra', '1/2 Sintra', 'Corplast', 'See Notes'];
const SIGNS_LAMINATE = ['No', 'Gloss', 'Matt', 'Dry Erase', 'Lexan', 'See Notes'];

function setServiceNames(services) {
  serviceNames.clear();
  if (!services) return;
  if (Array.isArray(services)) {
    for (const service of services) {
      if (service && service.id && service.name) serviceNames.set(Number(service.id), service.name);
    }
    return;
  }
  for (const [name, service] of Object.entries(services)) {
    if (service && service.id) serviceNames.set(Number(service.id), service.name || name);
  }
}

function rememberService(id, name) {
  if (id && name) serviceNames.set(Number(id), name);
}

function allowed(value, options) {
  return typeof value === 'string' && options.includes(value) ? value : null;
}

function leadingQuantity(value) {
  const match = /^(\d+)/.exec(String(value == null ? '' : value).trim());
  if (!match) return 1;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function quantityText(item) {
  if (item.quantity == null || String(item.quantity).trim() === '') return '1';
  return String(item.quantity).trim().slice(0, 40);
}

function textSize(item) {
  const size = item.size == null ? '' : String(item.size).trim();
  if (!size || /[\u0000-\u001F]/.test(size)) return 'Custom';
  return size.slice(0, 80);
}

function defaultsFor(name, item) {
  const qty = quantityText(item);
  const count = leadingQuantity(item.quantity);
  if (name === 'Large Format') {
    return {
      originals: '1',
      sets: qty,
      size: allowed(item.size, LARGE_SIZE) || 'Full Size',
      process: allowed(item.color, LARGE_PROCESS) || 'Black & White',
      media: allowed(item.media, LARGE_MEDIA) || 'Bond',
      binding: allowed(item.binding_finish, LARGE_BINDING) || 'Staple',
    };
  }
  if (name === 'Small Format') {
    return {
      product: SMALL_FORMAT_PRODUCTS[0],
      originals: '1',
      copies: qty,
      size: allowed(item.size, SMALL_FORMAT_SIZES) || '8.5x11',
      process: allowed(item.color, SMALL_PROCESS) || 'Black & White',
      sides: '1/0 black one side',
      media: allowed(item.media, SMALL_FORMAT_PAPER) || '20# Bond',
      binding: allowed(item.binding_finish, SMALL_FORMAT_BINDING) || 'None',
      proof: 'None',
    };
  }
  if (name === 'Signs & Graphics') {
    return {
      product_type: 'Banners',
      equipment: 'Flatbed',
      material: 'Coroplast',
      size: textSize(item),
      qty: count,
      ink: 'Indoor',
      mount: allowed(item.mount, SIGNS_MOUNT) || 'No',
      laminate: allowed(item.laminate, SIGNS_LAMINATE) || 'No',
      finishing: allowed(item.finishing, SIGNS_FINISHING) || 'None',
    };
  }
  if (name === 'Scanning') {
    return {
      qty: count,
      size: 'Wide Format',
      process: 'Black & White',
      save_as: 'PDF',
      save_to: 'None',
    };
  }
  if (name === 'Planroom') {
    return {
      type: 'New',
      date: '2026-10-16',
      name: 'Plan set',
    };
  }
  if (name === 'Archive File Request') {
    return {
      add_retrieve: 'Retrieve',
      save_as: 'PDF',
      save_to: 'None',
      sheets: 'All',
    };
  }
  if (name === 'Ship To (3rd Party)') {
    return {
      qty: count,
      via: 'Accent Truck',
      contact_name: 'Receiving',
      contact_phone: '919-555-0100',
      contact_email: 'ship@example.com',
      company_name: 'Ship Co',
      addr1: '9 Dock Street',
      city: 'Raleigh',
      state: 'NC',
      zip: '27601',
    };
  }
  return null;
}

function fillOrderLines(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const next = { ...body };
  if (next.payment_method == null || String(next.payment_method).trim() === '') {
    next.payment_method = 'Accent Account';
  }
  if (!Array.isArray(next.line_items)) return next;
  const ids = Array.isArray(next.service_ids) ? next.service_ids : [];
  const sole = ids.length === 1 ? Number(ids[0]) : null;
  next.line_items = next.line_items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    if (item.field_values && typeof item.field_values === 'object') return item;
    const serviceId = item.service_id != null && item.service_id !== '' ? Number(item.service_id) : sole;
    const name = serviceNames.get(serviceId);
    if (!name) return item;
    const values = defaultsFor(name, item);
    if (!values) return item;
    return { ...item, field_values: values };
  });
  return next;
}

module.exports = {
  setServiceNames,
  rememberService,
  fillOrderLines,
};
