function controlPattern(allowNewlines) {
  return allowNewlines ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/ : /[\u0000-\u001F]/;
}

function parseText(value, field, options = {}) {
  const required = Boolean(options.required);
  const max = options.max == null ? 120 : options.max;
  const allowNewlines = Boolean(options.allowNewlines);
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    if (required) return { error: `${field} is required` };
    return { value: null };
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { error: `${field} must be a string` };
  }
  const text = String(value).trim();
  if (!text) {
    if (required) return { error: `${field} is required` };
    return { value: null };
  }
  if (text.length > max) return { error: `${field} must be ${max} characters or fewer` };
  if (controlPattern(allowNewlines).test(text)) return { error: `${field} contains invalid characters` };
  return { value: text };
}

function parseBool(value, field, fallback) {
  if (value == null || value === '') {
    if (fallback == null) return { error: `${field} is required` };
    return { value: fallback ? 1 : 0 };
  }
  if (value === true || value === 1 || value === '1' || value === 'true') return { value: 1 };
  if (value === false || value === 0 || value === '0' || value === 'false') return { value: 0 };
  return { error: `${field} must be true or false` };
}

function parseInteger(value, field, options = {}) {
  const min = options.min == null ? 0 : options.min;
  const max = options.max == null ? 100000 : options.max;
  const allowNull = Boolean(options.allowNull);
  if (value == null || value === '') {
    if (allowNull || !options.required) return { value: null };
    return { error: `${field} is required` };
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { error: `${field} must be an integer from ${min} to ${max}` };
  }
  return { value: parsed };
}

function parseEmail(value, required) {
  const parsed = parseText(value, 'email', { required, max: 160 });
  if (parsed.error || parsed.value == null) return parsed;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.value)) return { error: 'email is invalid' };
  return parsed;
}

function parseLimit(value, fallback, max) {
  if (value == null || value === '') return { value: fallback };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    return { error: `limit must be an integer from 1 to ${max}` };
  }
  return { value: parsed };
}

function parseOffset(value) {
  if (value == null || value === '') return { value: 0 };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return { error: 'offset must be an integer of 0 or greater' };
  return { value: parsed };
}

function parseDirection(value) {
  if (value == null || value === '') return { value: 'desc' };
  const direction = String(value).trim().toLowerCase();
  if (direction !== 'asc' && direction !== 'desc') return { error: 'dir must be asc or desc' };
  return { value: direction };
}

function parseSort(value, allowed, fallback) {
  if (value == null || value === '') return { value: fallback };
  const sort = String(value).trim();
  if (!Object.prototype.hasOwnProperty.call(allowed, sort)) {
    return { error: `sort must be one of ${Object.keys(allowed).join(', ')}` };
  }
  return { value: sort };
}

const STATE_PATTERN = /^[A-Za-z][A-Za-z .'-]{0,39}$/;
const ZIP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{1,19}$/;

function parsePostalAddress(body, required) {
  const source = body || {};
  const line1 = parseText(source.address_line1, 'address_line1', { required, max: 120 });
  if (line1.error) return line1;
  const line2 = parseText(source.address_line2, 'address_line2', { max: 120 });
  if (line2.error) return line2;
  const city = parseText(source.city, 'city', { required, max: 80 });
  if (city.error) return city;
  const state = parseText(source.state, 'state', { required, max: 40 });
  if (state.error) return state;
  if (state.value && !STATE_PATTERN.test(state.value)) return { error: 'state is invalid' };
  const zip = parseText(source.zip, 'zip', { required, max: 20 });
  if (zip.error) return zip;
  if (zip.value && !ZIP_PATTERN.test(zip.value)) return { error: 'zip is invalid' };
  return {
    value: {
      addressLine1: line1.value,
      addressLine2: line2.value,
      city: city.value,
      state: state.value,
      zip: zip.value,
    },
  };
}

function likePattern(value) {
  const escaped = String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

function calendarOk(year, month, day) {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function parseDateBound(value, bound) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: `${bound} is invalid` };
  const text = value.trim();
  if (!text || text.length > 40) return { error: `${bound} is invalid` };
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!match) return { error: `${bound} is invalid` };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] == null ? (bound === 'to' ? 23 : 0) : Number(match[4]);
  const minute = match[5] == null ? (bound === 'to' ? 59 : 0) : Number(match[5]);
  const second = match[6] == null ? (bound === 'to' ? 59 : 0) : Number(match[6]);
  if (!calendarOk(year, month, day) || hour > 23 || minute > 59 || second > 59 || year < 2000 || year > 2100) {
    return { error: `${bound} is invalid` };
  }
  const pad = (part) => String(part).padStart(2, '0');
  return { value: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}` };
}

module.exports = {
  parseText,
  parseBool,
  parseInteger,
  parseEmail,
  parseLimit,
  parseOffset,
  parseDirection,
  parseSort,
  likePattern,
  parseDateBound,
  parsePostalAddress,
};
