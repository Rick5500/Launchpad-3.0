const activityLog = require('./activityLog');
const { get, all, withTransaction } = require('./dbAsync');
const { httpError } = require('./httpError');
const { parseText, parseBool, parseInteger } = require('./fields');

const FIELD_TYPES = new Set(['text', 'select', 'multiselect', 'number', 'checkbox', 'textarea']);
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const RESERVED_KEYS = new Set([
  '__proto__',
  'constructor',
  'hasownproperty',
  'prototype',
  'tostring',
  'valueof',
]);
const SHIP_TO_SERVICE_NAME = 'Ship To (3rd Party)';
const ACTIVITY_MESSAGE_MAX = 400;
const STATE_PATTERN = /^[A-Za-z][A-Za-z .'-]{0,39}$/;
const ZIP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{1,19}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{0,39}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const PAYMENT_METHODS = Object.freeze([
  'Accent Account',
  'Cash',
  'Check',
  'AMEX',
  'Master Card',
  'Visa',
  'Discover',
]);
const PAYMENT_UNSPECIFIED = 'Not specified';
const RETURN_TO_ME = 'To Me';
const RETURN_SEE_SHIP = 'See ShipTo';
const RETURN_UNSPECIFIED = 'Not specified';

function textField(key, label, sort, required = true) {
  return { key, label, type: 'text', required, sort_order: sort, options: null };
}

function areaField(key, label, sort) {
  return { key, label, type: 'textarea', required: false, sort_order: sort, options: null };
}

function selectField(key, label, sort, options, required = true) {
  return { key, label, type: 'select', required, sort_order: sort, options };
}

function numberField(key, label, sort, required = true) {
  return { key, label, type: 'number', required, sort_order: sort, options: null };
}

function checkField(key, label, sort) {
  return { key, label, type: 'checkbox', required: false, sort_order: sort, options: null };
}

function multiField(key, label, sort, options, required = false) {
  return { key, label, type: 'multiselect', required, sort_order: sort, options };
}

const {
  SMALL_FORMAT_BINDING,
  SMALL_FORMAT_COLOR_MODES,
  SMALL_FORMAT_FINISHING,
  SMALL_FORMAT_FOLDING,
  SMALL_FORMAT_PAPER,
  SMALL_FORMAT_PREVIOUS,
  SMALL_FORMAT_PRODUCTS,
  SMALL_FORMAT_PROOFS,
  SMALL_FORMAT_SIDES,
  SMALL_FORMAT_SIZES,
} = require('./smallFormatCatalog');

const SEED = [
  {
    service: 'Large Format',
    fields: [
      textField('originals', 'Originals', 10),
      textField('sets', 'Sets', 20),
      selectField('size', 'Size', 30, ['Full Size', 'Half Size', 'See Note']),
      selectField('process', 'Process', 40, ['Black & White', 'Color Line']),
      selectField('media', 'Media', 50, ['Bond', 'Vellum', 'Vellum Erase', 'Mylar', 'Mylar Reversed', 'See Note']),
      selectField('binding', 'Binding', 60, ['None', 'Staple', 'Screw Post', 'See Note']),
      areaField('note', 'Note', 70),
    ],
  },
  {
    service: 'Small Format',
    fields: [
      selectField('product', 'Product', 5, SMALL_FORMAT_PRODUCTS),
      textField('originals', 'Originals', 10),
      textField('copies', 'Copies', 20),
      selectField('size', 'Finished Size', 30, SMALL_FORMAT_SIZES),
      selectField('process', 'Process', 40, SMALL_FORMAT_COLOR_MODES),
      selectField('sides', 'Sides/Color', 50, SMALL_FORMAT_SIDES),
      selectField('media', 'Paper Stock', 60, SMALL_FORMAT_PAPER),
      selectField('binding', 'Binding', 70, SMALL_FORMAT_BINDING),
      selectField('folding', 'Folding', 72, SMALL_FORMAT_FOLDING, false),
      multiField('finishing', 'Finishing', 74, SMALL_FORMAT_FINISHING),
      selectField('proof', 'Proof', 76, SMALL_FORMAT_PROOFS, false),
      areaField('notes', 'Notes', 80),
    ],
  },
  {
    service: 'Signs & Graphics',
    fields: [
      selectField('product_type', 'Product Type', 10, [
        'Yard Signs', 'Banners', 'Posters', 'Window Graphics', 'Vehicle Graphics', 'Wall Graphics', 'Displays', 'Custom',
      ]),
      selectField('equipment', 'Equipment', 20, [
        'Flatbed', 'CNC Router', 'Large Format Roll Printer', 'Vinyl Cutter', 'Laminator', 'Mounting Press',
      ]),
      selectField('material', 'Material', 30, [
        'Coroplast', 'Foam Core', 'Gator Board', 'Sintra / PVC', 'Aluminum', 'ACM / Dibond', 'Acrylic',
        'Vinyl (adhesive)', 'Banner', 'Window Perf', 'Fabric', 'Magnetic',
      ]),
      textField('size', 'Size', 40),
      numberField('qty', 'Qty', 50),
      selectField('ink', 'Ink', 60, ['Indoor', 'Outdoor']),
      selectField('mount', 'Mount', 70, [
        'No', '3/16 Foam Core', '3/16 Gator Board', '1/2 Gator Board', '1/8 Sintra', '1/4 Sintra', '1/2 Sintra', 'Corplast', 'See Notes',
      ]),
      selectField('laminate', 'Laminate', 80, ['No', 'Gloss', 'Matt', 'Dry Erase', 'Lexan', 'See Notes']),
      selectField('finishing', 'Finishing', 90, [
        'None', 'Grommets', 'Easel', 'Cut/Trim', 'Velcro', 'Print Hanger', 'Framing', 'Contour Cut', 'Routed Shape', 'See Notes',
      ]),
      areaField('notes', 'Notes', 100),
    ],
  },
  {
    service: 'Scanning',
    fields: [
      numberField('qty', 'Qty', 10),
      selectField('size', 'Size', 20, ['Wide Format', 'Small Format']),
      selectField('process', 'Process', 30, ['Black & White', 'Color', 'Mixed']),
      selectField('save_as', 'Save As', 40, ['PDF', 'Tiff']),
      checkField('index_name_file', 'Index/Name File', 50),
      selectField('save_to', 'Save To', 60, ['None', 'FTP', 'Email', 'CD-R', 'DVD', 'Planroom']),
      areaField('notes', 'Notes', 70),
    ],
  },
  {
    service: 'Planroom',
    fields: [
      selectField('type', 'Type', 10, ['New', 'Update']),
      textField('date', 'Date', 20),
      textField('name', 'Name', 30),
      areaField('notes', 'Notes', 40),
    ],
  },
  {
    service: 'Archive File Request',
    fields: [
      selectField('add_retrieve', 'Add/Retrieve', 10, ['Add', 'Retrieve']),
      selectField('save_as', 'Save As', 20, ['PDF', 'Tiff']),
      selectField('save_to', 'Save To', 30, ['None', 'FTP', 'Email', 'CD-R', 'DVD']),
      selectField('sheets', 'Sheets', 40, ['All', 'See Notes']),
      areaField('notes', 'Notes', 50),
    ],
  },
  {
    service: 'Ship To (3rd Party)',
    fields: [
      numberField('qty', 'Qty', 10),
      selectField('via', 'Via', 20, ['Accent Truck', 'Ground', '1 day', '2 day', 'Pickup at Accent']),
      textField('acct_number', 'Acct #', 30, false),
      textField('contact_name', 'Contact Name', 40),
      textField('contact_phone', 'Contact Phone', 50),
      textField('contact_email', 'Contact Email', 60),
      textField('company_name', 'Company Name', 70),
      textField('addr1', 'Addr 1', 80),
      textField('addr2', 'Addr 2', 90, false),
      textField('city', 'City', 100),
      textField('state', 'State', 110),
      textField('zip', 'Zip', 120),
      areaField('notes', 'Notes', 130),
    ],
  },
];

function seedFieldCount() {
  return SEED.reduce((count, group) => count + group.fields.length, 0);
}

function optionsToJson(options) {
  if (!options || !options.length) return null;
  return JSON.stringify(options.map((value) => ({ value, active: true })));
}

function parseStoredOptions(raw) {
  if (raw == null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => {
      if (typeof entry === 'string') return { value: entry, active: true };
      if (!entry || typeof entry !== 'object') return null;
      const value = entry.value == null ? '' : String(entry.value);
      return { value, active: entry.active !== false && entry.active !== 0 };
    }).filter((entry) => entry && entry.value);
  } catch (err) {
    return [];
  }
}

function presentField(row, includeInactiveOptions) {
  const options = parseStoredOptions(row.options_json);
  const visible = includeInactiveOptions ? options : options.filter((option) => option.active);
  return {
    id: row.id,
    service_id: row.service_id,
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required !== 0,
    sort_order: row.sort_order || 0,
    is_active: row.is_active !== 0,
    options: includeInactiveOptions ? visible : visible.map((option) => option.value),
  };
}

function readFieldValues(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    return {};
  }
}

function calendarOk(year, month, day) {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function textLimit(field) {
  if (field.type === 'textarea') return 2000;
  if (field.key === 'date') return 10;
  if (field.key === 'state') return 40;
  if (field.key === 'zip') return 20;
  if (field.key === 'acct_number') return 40;
  if (field.key === 'city') return 80;
  if (field.key === 'addr1' || field.key === 'addr2') return 120;
  if (field.key.endsWith('_phone')) return 40;
  if (field.key.endsWith('_email')) return 160;
  return 160;
}

function parseOneField(field, raw, label) {
  if (field.type === 'checkbox') {
    if (raw == null || raw === '') {
      if (field.required) return { error: `${label} is required` };
      return { value: false, keep: true };
    }
    const parsed = parseBool(raw, label, null);
    if (parsed.error) return parsed;
    if (field.required && parsed.value !== 1) return { error: `${label} is required` };
    return { value: parsed.value === 1, keep: true };
  }
  if (field.type === 'number') {
    if (raw == null || raw === '') {
      if (field.required) return { error: `${label} is required` };
      return { omit: true };
    }
    const parsed = parseInteger(raw, label, {
      min: field.required ? 1 : 0,
      max: 1000000,
      required: true,
    });
    if (parsed.error) return parsed;
    return { value: parsed.value, keep: true };
  }
  if (field.type === 'select') {
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
      const fallback = proofDefault(field);
      if (fallback) return { value: fallback, keep: true };
      if (field.required) return { error: `${label} is required` };
      return { omit: true };
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') return { error: `${label} is invalid` };
    const text = String(raw).trim();
    const options = parseStoredOptions(field.options_json).filter((option) => option.active);
    const match = options.find((option) => option.value === text);
    if (!match) {
      const names = options.map((option) => option.value);
      return { error: names.length ? `${label} must be one of ${names.join(', ')}` : `${label} is invalid` };
    }
    return { value: match.value, keep: true };
  }
  if (field.type === 'multiselect') {
    if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
      if (field.required) return { error: `${label} is required` };
      return { omit: true };
    }
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length > 40) return { error: `${label} has too many selections` };
    const options = parseStoredOptions(field.options_json).filter((option) => option.active);
    const names = options.map((option) => option.value);
    const chosen = [];
    const seen = new Set();
    for (const entry of list) {
      if (typeof entry !== 'string' && typeof entry !== 'number') return { error: `${label} is invalid` };
      const text = String(entry).trim();
      const match = options.find((option) => option.value === text);
      if (!match) {
        return { error: names.length ? `${label} must be one of ${names.join(', ')}` : `${label} is invalid` };
      }
      const token = match.value.toLowerCase();
      if (seen.has(token)) return { error: `${label} option ${match.value} is duplicated` };
      seen.add(token);
      chosen.push(match.value);
    }
    return { value: chosen, keep: true };
  }
  const parsed = parseText(raw, label, {
    required: Boolean(field.required),
    max: textLimit(field),
    allowNewlines: field.type === 'textarea',
  });
  if (parsed.error) return parsed;
  if (parsed.value == null) return { omit: true };
  if (field.key === 'date') {
    const match = DATE_PATTERN.exec(parsed.value);
    if (!match) return { error: `${label} must be YYYY-MM-DD` };
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!calendarOk(year, month, day) || year < 2000 || year > 2100) return { error: `${label} is invalid` };
  }
  if (field.key.endsWith('_email') && !EMAIL_PATTERN.test(parsed.value)) return { error: `${label} is invalid` };
  if (field.key.endsWith('_phone') && !/\d/.test(parsed.value)) return { error: `${label} is invalid` };
  if (field.key === 'state' && !STATE_PATTERN.test(parsed.value)) return { error: `${label} is invalid` };
  if (field.key === 'zip' && !ZIP_PATTERN.test(parsed.value)) return { error: `${label} is invalid` };
  if (field.key === 'acct_number' && !ACCOUNT_PATTERN.test(parsed.value)) {
    return { error: `${label} may contain only letters, digits, spaces, and dashes` };
  }
  return { value: parsed.value, keep: true };
}

function ownValue(raw, key) {
  if (!raw || !Object.prototype.hasOwnProperty.call(raw, key)) return undefined;
  return raw[key];
}

function validateLineFields(definitions, raw, lineLabel) {
  const active = (definitions || []).filter((row) => row.is_active !== 0);
  if (raw == null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${lineLabel} field_values must be an object` };
  }
  const byKey = new Map(active.map((row) => [row.key, row]));
  for (const key of Object.keys(raw)) {
    if (!KEY_PATTERN.test(key) || RESERVED_KEYS.has(String(key).toLowerCase()) || !byKey.has(key)) {
      return { error: `${lineLabel} field ${key} is not used by this service` };
    }
  }
  const values = {};
  for (const field of active) {
    const parsed = parseOneField(field, ownValue(raw, field.key), `${lineLabel} ${field.label}`);
    if (parsed.error) return parsed;
    if (parsed.omit) continue;
    values[field.key] = parsed.value;
  }
  const encoded = JSON.stringify(values);
  if (encoded.length > 12000) return { error: `${lineLabel} has too many field values` };
  return { value: values };
}

function displayOf(field, value) {
  if (field && field.type === 'checkbox') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value.filter((item) => item != null && String(item).trim() !== '').join(', ');
  }
  if (value == null || value === '') return '';
  return String(value);
}

function displayFieldList(definitions, values) {
  const source = values || {};
  const ordered = [...(definitions || [])].sort((left, right) => {
    const sort = (left.sort_order || 0) - (right.sort_order || 0);
    if (sort !== 0) return sort;
    return (left.id || 0) - (right.id || 0);
  });
  const seen = new Set();
  const fields = [];
  for (const field of ordered) {
    if (!Object.prototype.hasOwnProperty.call(source, field.key)) continue;
    seen.add(field.key);
    fields.push({
      key: field.key,
      label: field.label,
      type: field.type,
      value: source[field.key],
      display: displayOf(field, source[field.key]),
    });
  }
  for (const key of Object.keys(source)) {
    if (seen.has(key)) continue;
    fields.push({
      key,
      label: key,
      type: 'text',
      value: source[key],
      display: source[key] == null ? '' : String(source[key]),
    });
  }
  return fields;
}

function describeLine(definitions, values, explicit) {
  if (explicit) return explicit;
  const parts = [];
  for (const field of displayFieldList(definitions, values)) {
    if (!field.display || field.display === 'No') continue;
    parts.push(`${field.label}: ${field.display}`);
  }
  const text = parts.join(' · ').slice(0, 200);
  return text || 'Line item';
}

function mirrorLegacy(values, legacy) {
  const next = { ...legacy };
  if (Object.prototype.hasOwnProperty.call(values, 'size')) next.size = String(values.size);
  if (values.sets != null) next.quantity = String(values.sets);
  else if (values.copies != null) next.quantity = String(values.copies);
  else if (values.qty != null) next.quantity = String(values.qty);
  else if (values.quantity != null) next.quantity = String(values.quantity);
  if (values.media != null) next.media = String(values.media);
  else if (values.material != null) next.media = String(values.material);
  if (values.process != null) next.color = String(values.process);
  else if (values.ink != null) next.color = String(values.ink);
  if (values.binding != null) next.bindingFinish = String(values.binding);
  if (Object.prototype.hasOwnProperty.call(values, 'finishing')) {
    if (Array.isArray(values.finishing)) {
      next.finishing = values.finishing.length ? values.finishing.join(', ') : null;
    } else {
      next.finishing = values.finishing === 'None' ? null : String(values.finishing);
    }
  }
  if (values.mount != null) next.mount = String(values.mount).trim().toLowerCase() === 'no' ? 0 : 1;
  if (values.laminate != null) next.laminate = String(values.laminate).trim().toLowerCase() === 'no' ? 0 : 1;
  return next;
}

function methodFromVia(via) {
  const key = String(via || '').trim().toLowerCase();
  if (key === 'pickup at accent') return 'Will Call';
  if (key === 'accent truck') return 'Accent Truck';
  if (key === 'ground' || key === '1 day' || key === '2 day') return 'UPS';
  return null;
}

function usesOptions(type) {
  return type === 'select' || type === 'multiselect';
}

function proofDefault(field) {
  if (!field || field.key !== 'proof') return null;
  const options = parseStoredOptions(field.options_json).filter((option) => option.active);
  const none = options.find((option) => option.value === 'None');
  if (none) return none.value;
  const digital = options.find((option) => /digital/i.test(option.value));
  return digital ? digital.value : null;
}

function sameActiveList(stored, expected) {
  if (stored.length !== expected.length) return false;
  for (let index = 0; index < stored.length; index += 1) {
    if (!stored[index].active || stored[index].value !== expected[index]) return false;
  }
  return true;
}

function reconcileSelectOptions(stored, previous, next) {
  if (sameActiveList(stored, next)) return { options: null, replaced: false };
  const untouched = stored.length === 0 || sameActiveList(stored, previous);
  if (untouched) {
    return {
      options: next.map((value) => ({ value, active: true })),
      replaced: true,
    };
  }
  const seen = new Set(stored.map((option) => String(option.value || '').trim().toLowerCase()));
  const merged = stored.map((option) => ({ value: option.value, active: option.active }));
  let added = false;
  for (const value of next) {
    const token = String(value || '').trim().toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    merged.push({ value, active: true });
    added = true;
  }
  if (!added) return { options: null, replaced: false };
  return { options: merged, replaced: false };
}

async function upgradeExistingField(run, existing, field, previous) {
  if (!usesOptions(field.type) || !usesOptions(existing.type)) return;
  const stored = parseStoredOptions(existing.options_json);
  const result = reconcileSelectOptions(stored, previous.options || [], field.options || []);
  const sets = [];
  const params = [];
  if (result.options) {
    sets.push('options_json = ?');
    params.push(JSON.stringify(result.options));
  }
  if (result.replaced && previous.label && existing.label === previous.label && existing.label !== field.label) {
    sets.push('label = ?');
    params.push(field.label);
  }
  if (result.replaced && existing.type !== field.type) {
    sets.push('type = ?');
    params.push(field.type);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  params.push(existing.id);
  await run(`UPDATE service_fields SET ${sets.join(', ')} WHERE id = ?`, params);
}

async function seedServiceFields(run, getRow) {
  for (const group of SEED) {
    const service = await getRow('SELECT id FROM services WHERE name = ?', [group.service]);
    if (!service) continue;
    const previousByKey = group.service === 'Small Format' ? SMALL_FORMAT_PREVIOUS : null;
    for (const field of group.fields) {
      const existing = await getRow(
        'SELECT id, label, type, options_json FROM service_fields WHERE service_id = ? AND key = ?',
        [service.id, field.key]
      );
      if (!existing) {
        await run(
          `INSERT INTO service_fields (
             service_id, key, label, type, options_json, required, sort_order, is_active, updated_at
           ) VALUES (?,?,?,?,?,?,?,1,datetime('now'))`,
          [
            service.id,
            field.key,
            field.label,
            field.type,
            optionsToJson(field.options),
            field.required ? 1 : 0,
            field.sort_order,
          ]
        );
        continue;
      }
      const previous = previousByKey && previousByKey[field.key];
      if (previous) await upgradeExistingField(run, existing, field, previous);
    }
  }
}

function normalizeOption(entry, index, label) {
  let value = entry;
  let active = true;
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    value = entry.value;
    if (entry.active == null) active = true;
    else {
      const parsed = parseBool(entry.active, `${label} option ${index + 1} active`, null);
      if (parsed.error) return parsed;
      active = parsed.value === 1;
    }
  }
  const text = parseText(value, `${label} option ${index + 1}`, { required: true, max: 80 });
  if (text.error) return text;
  return { value: { value: text.value, active } };
}

function parseFieldPayload(body) {
  const source = body || {};
  if (!Array.isArray(source.fields)) return { error: 'fields must be an array' };
  if (source.fields.length > 40) return { error: 'Too many fields' };
  const fields = [];
  const keys = new Set();
  for (let index = 0; index < source.fields.length; index += 1) {
    const row = source.fields[index];
    const prefix = `field ${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { error: `${prefix} is invalid` };
    const key = parseText(row.key, `${prefix} key`, { required: true, max: 32 });
    if (key.error) return key;
    if (RESERVED_KEYS.has(key.value.toLowerCase())) return { error: `${prefix} key is reserved` };
    if (!KEY_PATTERN.test(key.value)) return { error: `${prefix} key must be lowercase letters, digits, and underscores` };
    if (keys.has(key.value)) return { error: `${prefix} key is duplicated` };
    keys.add(key.value);
    const label = parseText(row.label, `${prefix} label`, { required: true, max: 80 });
    if (label.error) return label;
    const type = parseText(row.type, `${prefix} type`, { required: true, max: 20 });
    if (type.error) return type;
    if (!FIELD_TYPES.has(type.value)) return { error: `${prefix} type must be text, select, multiselect, number, checkbox, or textarea` };
    const required = parseBool(row.required, `${prefix} required`, false);
    if (required.error) return required;
    const active = parseBool(row.is_active == null ? row.active : row.is_active, `${prefix} active`, true);
    if (active.error) return active;
    const sort = parseInteger(row.sort_order, `${prefix} sort_order`, { min: 0, max: 10000, allowNull: true });
    if (sort.error) return sort;
    let options = [];
    if (usesOptions(type.value)) {
      if (!Array.isArray(row.options) || row.options.length === 0) return { error: `${prefix} options are required` };
      if (row.options.length > 60) return { error: `${prefix} has too many options` };
      const seen = new Set();
      for (let optionIndex = 0; optionIndex < row.options.length; optionIndex += 1) {
        const option = normalizeOption(row.options[optionIndex], optionIndex, prefix);
        if (option.error) return option;
        const token = option.value.value.toLowerCase();
        if (seen.has(token)) return { error: `${prefix} option ${option.value.value} is duplicated` };
        seen.add(token);
        options.push(option.value);
      }
      if (!options.some((option) => option.active)) return { error: `${prefix} needs an active option` };
    } else if (row.options != null && row.options !== '' && !(Array.isArray(row.options) && row.options.length === 0)) {
      return { error: `${prefix} options are only used by select or multiselect fields` };
    }
    fields.push({
      key: key.value,
      label: label.value,
      type: type.value,
      required: required.value === 1,
      isActive: active.value === 1,
      sortOrder: sort.value == null ? index * 10 : sort.value,
      options,
    });
  }
  return { value: fields };
}

async function listServiceFields(serviceId, includeInactive) {
  const rows = await all(
    `SELECT id, service_id, key, label, type, options_json, required, sort_order, is_active
     FROM service_fields
     WHERE service_id = ? ${includeInactive ? '' : 'AND is_active = 1'}
     ORDER BY sort_order, id`,
    [serviceId]
  );
  return rows.map((row) => presentField(row, includeInactive));
}

function activeOptionNames(options) {
  return (options || []).filter((option) => option && option.active !== false && option.active !== 0).map((option) => option.value);
}

function clipText(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function unmappedViaOptions(fields) {
  const via = (fields || []).find((field) => field.key === 'via' && field.type === 'select' && field.isActive);
  if (!via) return [];
  return via.options.filter((option) => option.active && !methodFromVia(option.value)).map((option) => option.value);
}

function fieldChangeSummary(serviceName, beforeRows, afterFields) {
  const before = new Map((beforeRows || []).map((row) => [row.key, row]));
  const afterKeys = new Set(afterFields.map((field) => field.key));
  const added = [];
  const removed = [];
  const changed = [];
  for (const field of afterFields) {
    const previous = before.get(field.key);
    if (!previous) {
      if (field.isActive) added.push(field.key);
      continue;
    }
    const notes = [];
    const wasActive = previous.is_active !== 0;
    if (wasActive && !field.isActive) removed.push(field.key);
    else if (!wasActive && field.isActive) notes.push('activated');
    if (previous.label !== field.label) notes.push(`label "${previous.label}" to "${field.label}"`);
    if (previous.type !== field.type) notes.push(`type ${previous.type} to ${field.type}`);
    if ((previous.required !== 0) !== field.required) notes.push(field.required ? 'required' : 'optional');
    if (usesOptions(field.type) || usesOptions(previous.type)) {
      const oldNames = activeOptionNames(parseStoredOptions(previous.options_json));
      const newNames = usesOptions(field.type) ? activeOptionNames(field.options) : [];
      const addedOptions = newNames.filter((name) => !oldNames.includes(name));
      const removedOptions = oldNames.filter((name) => !newNames.includes(name));
      if (addedOptions.length) notes.push(`added options ${addedOptions.slice(0, 8).join(', ')}`);
      if (removedOptions.length) notes.push(`removed options ${removedOptions.slice(0, 8).join(', ')}`);
    }
    if (notes.length) changed.push(`${field.key}: ${notes.join('; ')}`);
  }
  for (const row of beforeRows || []) {
    if (afterKeys.has(row.key) || row.is_active === 0) continue;
    removed.push(row.key);
  }
  const parts = [];
  if (added.length) parts.push(`Added ${added.slice(0, 12).join(', ')}`);
  if (removed.length) parts.push(`Removed ${removed.slice(0, 12).join(', ')}`);
  if (changed.length) parts.push(`Changed ${changed.slice(0, 8).join('. ')}`);
  const summary = parts.length
    ? `Updated line item fields for ${serviceName}. ${parts.join('. ')}`
    : `Updated line item fields for ${serviceName}`;
  return {
    added: added.slice(0, 12),
    removed: removed.slice(0, 12),
    changed: changed.slice(0, 8),
    message: clipText(summary, ACTIVITY_MESSAGE_MAX),
  };
}

async function replaceServiceFields(actorId, serviceId, body) {
  const parsedId = parseInteger(serviceId, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
  if (parsedId.error || !parsedId.value) throw httpError(400, 'id must be a positive integer');
  const parsed = parseFieldPayload(body);
  if (parsed.error) throw httpError(400, parsed.error);
  const service = await get('SELECT id, name FROM services WHERE id = ?', [parsedId.value]);
  if (!service) throw httpError(404, 'Service not found');
  if (service.name === SHIP_TO_SERVICE_NAME) {
    const unmapped = unmappedViaOptions(parsed.value);
    if (unmapped.length) {
      throw httpError(400, `Ship To Via ${unmapped.join(', ')} does not map to a delivery method. Use Pickup at Accent, Accent Truck, Ground, 1 day, or 2 day.`);
    }
  }
  await withTransaction(async (tx) => {
    const existing = await tx.all(
      'SELECT id, key, label, type, options_json, required, is_active FROM service_fields WHERE service_id = ?',
      [service.id]
    );
    const byKey = new Map(existing.map((row) => [row.key, row]));
    const seen = new Set();
    for (const field of parsed.value) {
      seen.add(field.key);
      const optionsJson = usesOptions(field.type) ? JSON.stringify(field.options) : null;
      const current = byKey.get(field.key);
      if (current) {
        await tx.run(
          `UPDATE service_fields
           SET label = ?, type = ?, options_json = ?, required = ?, sort_order = ?, is_active = ?, updated_at = datetime('now')
           WHERE id = ?`,
          [field.label, field.type, optionsJson, field.required ? 1 : 0, field.sortOrder, field.isActive ? 1 : 0, current.id]
        );
      } else {
        await tx.run(
          `INSERT INTO service_fields (
             service_id, key, label, type, options_json, required, sort_order, is_active, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
          [service.id, field.key, field.label, field.type, optionsJson, field.required ? 1 : 0, field.sortOrder, field.isActive ? 1 : 0]
        );
      }
    }
    for (const row of existing) {
      if (seen.has(row.key)) continue;
      await tx.run(
        `UPDATE service_fields SET is_active = 0, updated_at = datetime('now') WHERE id = ?`,
        [row.id]
      );
    }
    const summary = fieldChangeSummary(service.name, existing, parsed.value);
    await activityLog.recordOn(tx, actorId, 'service.fields_updated', 'service', service.id, {
      name: service.name,
      added: summary.added,
      removed: summary.removed,
      changed: summary.changed,
      message: summary.message,
    });
  });
  return {
    service_id: service.id,
    fields: await listServiceFields(service.id, true),
  };
}

module.exports = {
  SEED,
  seedFieldCount,
  PAYMENT_METHODS,
  PAYMENT_UNSPECIFIED,
  RETURN_TO_ME,
  RETURN_SEE_SHIP,
  RETURN_UNSPECIFIED,
  seedServiceFields,
  presentField,
  readFieldValues,
  validateLineFields,
  displayFieldList,
  describeLine,
  mirrorLegacy,
  methodFromVia,
  listServiceFields,
  replaceServiceFields,
  parseFieldPayload,
};
