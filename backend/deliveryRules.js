const { DELIVERY_STATUSES } = require('./statuses');
const { getDueSoonHoursOverride } = require('./runtimeSettings');

const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_WILL_CALL_CUTOFF = '15:00';
const DEFAULT_CARRIER_CUTOFF = '14:00';
const DEFAULT_DUE_SOON_HOURS = 1;
const DEFAULT_SLOT_MINUTES = 15;

// Customer-requested times. Will Call pickup is 8:00 AM–5:00 PM.
// Every other method (Accent Truck, UPS, and legacy carriers) is 9:00 AM–4:00 PM.
const DEFAULT_WILL_CALL_WINDOW_START = '08:00';
const DEFAULT_WILL_CALL_WINDOW_END = '17:00';
const DEFAULT_DELIVERY_WINDOW_START = '09:00';
const DEFAULT_DELIVERY_WINDOW_END = '16:00';
const UPS_ACCOUNT_MAX = 30;

// Same-day cutoffs stay 15:00 (will call) and 14:00 (other methods). Both sit inside
// the new windows, so an order ready before the cutoff is still due that day at the
// cutoff. The windows only limit the times a customer may request. Overdue and
// due-soon still compare the stored due timestamp with now.
const ACTIVE_DELIVERY_METHODS = Object.freeze([
  Object.freeze({ name: 'Accent Truck', willCall: false, sortOrder: 1 }),
  Object.freeze({ name: 'Will Call', willCall: true, sortOrder: 2 }),
  Object.freeze({ name: 'UPS', willCall: false, sortOrder: 3 }),
]);

const RETIRED_DELIVERY_METHODS = Object.freeze([
  Object.freeze({ name: 'Customer Pickup', willCall: true }),
  Object.freeze({ name: 'FedEx', willCall: false }),
  Object.freeze({ name: 'Common Carrier', willCall: false }),
]);

const BUSINESS_DAYS = Object.freeze(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);

let warnedInvalidTimezone = false;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatNaive(year, month, day, hour, minute, second) {
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function parseCutoff(value, fallbackLabel) {
  const candidates = [value, fallbackLabel, DEFAULT_WILL_CALL_CUTOFF];
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(candidate).trim());
    if (!match) continue;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) continue;
    return {
      hour,
      minute,
      label: `${pad(hour)}:${pad(minute)}`,
    };
  }
  return { hour: 15, minute: 0, label: DEFAULT_WILL_CALL_CUTOFF };
}

function parseDueSoonHours(value) {
  if (value == null || value === '') return DEFAULT_DUE_SOON_HOURS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DUE_SOON_HOURS;
  return parsed;
}

function resolveTimeZone(value) {
  const requested = String(value || '').trim();
  const timeZone = requested || DEFAULT_TIMEZONE;
  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch (err) {
    if (!warnedInvalidTimezone) {
      warnedInvalidTimezone = true;
      console.error(`Invalid DELIVERY_TIMEZONE "${timeZone}", using ${DEFAULT_TIMEZONE}`);
    }
    return DEFAULT_TIMEZONE;
  }
}

function methodKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function retiredDeliveryMethod(name) {
  const key = methodKey(name);
  if (!key) return null;
  return RETIRED_DELIVERY_METHODS.find((method) => methodKey(method.name) === key) || null;
}

function retiredDeliveryMessage(name) {
  const retired = retiredDeliveryMethod(name);
  if (!retired) return 'delivery_method is not available';
  if (retired.willCall) return `${retired.name} is no longer available. Choose Will Call.`;
  return `${retired.name} is no longer available.`;
}

function isUpsMethod(name) {
  return methodKey(name) === 'ups';
}

// Customer Pickup keeps its stored label. Hours and the will-call cutoff follow Will Call.
function usesWillCallHours(name, willCallFlag) {
  const key = methodKey(name);
  if (key === 'will call' || key === 'customer pickup') return true;
  return willCallFlag === true || willCallFlag === 1 || willCallFlag === '1' || willCallFlag === 'true';
}

function parseUpsAccountNumber(value) {
  if (value == null) return { value: null };
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { error: 'ups_account_number is invalid' };
  }
  const text = String(value).trim();
  if (!text) return { value: null };
  if (text.length > UPS_ACCOUNT_MAX) {
    return { error: `ups_account_number must be ${UPS_ACCOUNT_MAX} characters or fewer` };
  }
  if (!/^[A-Za-z0-9 -]+$/.test(text)) {
    return { error: 'ups_account_number may contain only letters, digits, spaces, and dashes' };
  }
  return { value: text };
}

function buildWindow(startEnv, startDefault, endEnv, endDefault) {
  const start = parseCutoff(startEnv, startDefault);
  const end = parseCutoff(endEnv, endDefault);
  const parsedIncrement = Number(process.env.DELIVERY_SLOT_MINUTES);
  const incrementMinutes = Number.isInteger(parsedIncrement) && parsedIncrement >= 1 && parsedIncrement <= 120
    ? parsedIncrement
    : DEFAULT_SLOT_MINUTES;
  const slots = [];
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  if (endMinutes >= startMinutes) {
    for (let minute = startMinutes; minute <= endMinutes; minute += incrementMinutes) {
      slots.push(`${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`);
    }
  }
  return {
    start: start.label,
    end: end.label,
    incrementMinutes,
    slots,
  };
}

function willCallWindow() {
  return buildWindow(
    process.env.WILL_CALL_WINDOW_START,
    DEFAULT_WILL_CALL_WINDOW_START,
    process.env.WILL_CALL_WINDOW_END,
    DEFAULT_WILL_CALL_WINDOW_END
  );
}

function deliveryWindow() {
  return buildWindow(
    process.env.DELIVERY_WINDOW_START,
    DEFAULT_DELIVERY_WINDOW_START,
    process.env.DELIVERY_WINDOW_END,
    DEFAULT_DELIVERY_WINDOW_END
  );
}

function getRules() {
  return {
    timezone: resolveTimeZone(process.env.DELIVERY_TIMEZONE),
    willCallCutoff: parseCutoff(process.env.WILL_CALL_CUTOFF, DEFAULT_WILL_CALL_CUTOFF),
    carrierCutoff: parseCutoff(process.env.CARRIER_CUTOFF, DEFAULT_CARRIER_CUTOFF),
    dueSoonHours: getDueSoonHoursOverride() == null
      ? parseDueSoonHours(process.env.DUE_SOON_HOURS)
      : getDueSoonHoursOverride(),
    businessDays: BUSINESS_DAYS,
    statuses: DELIVERY_STATUSES,
    willCallHours: willCallWindow(),
    deliveryHours: deliveryWindow(),
  };
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

function isBusinessWeekday(weekdayShort) {
  return weekdayShort !== 'Sat' && weekdayShort !== 'Sun';
}

function calendarPartsValid(parts) {
  if (parts.month < 1 || parts.month > 12) return false;
  if (parts.hour < 0 || parts.hour > 23) return false;
  if (parts.minute < 0 || parts.minute > 59) return false;
  if (parts.second < 0 || parts.second > 59) return false;
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return probe.getUTCFullYear() === parts.year
    && probe.getUTCMonth() === parts.month - 1
    && probe.getUTCDate() === parts.day;
}

function nextBusinessDate(year, month, day) {
  const cursor = new Date(Date.UTC(year, month - 1, day));
  do {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return {
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate(),
  };
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedTimeToUtc(parts, timeZone) {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let utc = wall;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const adjusted = wall - timeZoneOffsetMs(new Date(utc), timeZone);
    if (adjusted === utc) return new Date(utc);
    utc = adjusted;
  }
  return new Date(utc);
}

function parseNaiveDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || '').trim());
  if (!match) return null;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
  };
  if (!calendarPartsValid(parts)) return null;
  return parts;
}

// Due times are wall-clock values in the configured delivery timezone.
// A timestamp that includes a zone (for example a trailing Z) is converted
// into that timezone. A naive value is stored as entered.
function normalizeDueTime(value) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { error: 'due_time is invalid' };
  }
  const text = String(value).trim();
  if (!text || text.length > 40) return { error: 'due_time is invalid' };

  const naive = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(text);
  const hasZone = /[zZ]$/.test(text) || /[+-]\d{2}:\d{2}$/.test(text);
  if (naive && !hasZone) {
    const clock = naive[2] || '00:00:00';
    const withSeconds = clock.length === 5 ? `${clock}:00` : clock;
    const parts = parseNaiveDateTime(`${naive[1]} ${withSeconds}`);
    if (!parts) return { error: 'due_time is invalid' };
    return { value: formatNaive(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second) };
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf())) return { error: 'due_time is invalid' };
  const rules = getRules();
  const parts = zonedParts(parsed, rules.timezone);
  return { value: formatNaive(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second) };
}

function suggestDueTime(willCall, readyAt = new Date(), rules = getRules()) {
  const cutoff = willCall ? rules.willCallCutoff : rules.carrierCutoff;
  const ready = zonedParts(readyAt, rules.timezone);
  const readyMinutes = ready.hour * 60 + ready.minute;
  const cutoffMinutes = cutoff.hour * 60 + cutoff.minute;
  const readyBeforeCutoff = isBusinessWeekday(ready.weekday) && readyMinutes < cutoffMinutes;

  let year = ready.year;
  let month = ready.month;
  let day = ready.day;
  if (!readyBeforeCutoff) {
    const next = nextBusinessDate(year, month, day);
    year = next.year;
    month = next.month;
    day = next.day;
  }

  return {
    dueTime: formatNaive(year, month, day, cutoff.hour, cutoff.minute, 0),
    readyBeforeCutoff,
    sameDay: readyBeforeCutoff,
    cutoff: cutoff.label,
  };
}

function classifyDelivery(delivery, now = new Date(), rules = getRules()) {
  const status = String(delivery.status || '').trim().toLowerCase();
  const complete = status === 'complete';
  if (!delivery.due_time) {
    return {
      overdue: false,
      due_today: false,
      due_soon: false,
      timing: complete ? 'complete' : 'unscheduled',
    };
  }

  const dueParts = parseNaiveDateTime(delivery.due_time);
  if (!dueParts) {
    return {
      overdue: false,
      due_today: false,
      due_soon: false,
      timing: complete ? 'complete' : 'unscheduled',
    };
  }

  const dueInstant = zonedTimeToUtc(dueParts, rules.timezone);
  const nowParts = zonedParts(now, rules.timezone);
  const sameDay = dueParts.year === nowParts.year
    && dueParts.month === nowParts.month
    && dueParts.day === nowParts.day;

  if (complete) {
    return {
      overdue: false,
      due_today: sameDay,
      due_soon: false,
      timing: 'complete',
    };
  }

  const overdue = dueInstant.getTime() < now.getTime();
  const soonLimit = now.getTime() + rules.dueSoonHours * 60 * 60 * 1000;
  const dueSoon = !overdue && dueInstant.getTime() <= soonLimit;

  let timing = 'upcoming';
  if (overdue) timing = 'overdue';
  else if (sameDay) timing = 'due_today';
  else if (dueSoon) timing = 'due_soon';

  return {
    overdue,
    due_today: sameDay,
    due_soon: dueSoon,
    timing,
  };
}

function clockLabel(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!match) return String(hhmm || '');
  const hour24 = Number(match[1]);
  const minute = match[2];
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${minute} ${suffix}`;
}

function orderWindow(willCall = false) {
  return willCall ? willCallWindow() : deliveryWindow();
}

function windowSummary(window, kind) {
  const hours = `${clockLabel(window.start)} - ${clockLabel(window.end)} (${window.incrementMinutes} minute increments)`;
  if (kind === 'will_call') return `Will Call pickup ${hours}.`;
  return `Delivery orders ${hours}.`;
}

function orderWindowSummary(window = deliveryWindow()) {
  return windowSummary(window, 'delivery');
}

function hoursLabel(window) {
  return `${clockLabel(window.start)} - ${clockLabel(window.end)} (${window.incrementMinutes} min increments)`;
}

function businessToday(now = new Date()) {
  const rules = getRules();
  const parts = zonedParts(now, rules.timezone);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    weekday: parts.weekday,
    key: `${parts.year}${pad(parts.month)}${pad(parts.day)}`,
    iso: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
  };
}

// Customer-selected order due times use the method window (Will Call 8:00 AM–5:00 PM,
// other methods 9:00 AM–4:00 PM, 15 minute increments, Monday–Friday). The value is
// stored with the same wall-clock normalization as other delivery due times.
function validateOrderDue(dueDate, dueTime, now = new Date(), options = {}) {
  const date = String(dueDate || '').trim();
  const time = String(dueTime || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'due_date must be YYYY-MM-DD' };

  const parts = parseNaiveDateTime(`${date} 00:00:00`);
  if (!parts) return { error: 'due_date is invalid' };

  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return { error: 'due_date must be a weekday (Monday through Friday)' };
  }

  const today = businessToday(now);
  if (date < today.iso) return { error: 'due_date cannot be before today' };
  const latest = Date.UTC(today.year + 2, today.month - 1, today.day);
  const selected = Date.UTC(parts.year, parts.month - 1, parts.day);
  if (selected > latest) return { error: 'due_date is too far in the future' };

  const willCall = Boolean(options.willCall);
  const window = willCall ? willCallWindow() : deliveryWindow();
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || !window.slots.includes(`${match[1]}:${match[2]}`)) {
    const kind = willCall ? 'Will Call' : 'delivery';
    return {
      error: `due_time must be a ${window.incrementMinutes} minute increment between ${clockLabel(window.start)} and ${clockLabel(window.end)} for ${kind}`,
    };
  }

  const normalized = normalizeDueTime(`${date} ${match[1]}:${match[2]}:00`);
  if (normalized.error) return { error: normalized.error };
  return {
    value: {
      dueDate: date,
      dueTime: `${match[1]}:${match[2]}`,
      dueDateTime: normalized.value,
    },
  };
}

function rulesSummary(rules) {
  const willCallHours = rules.willCallHours || willCallWindow();
  const deliveryHours = rules.deliveryHours || deliveryWindow();
  return [
    `Will Call pickup hours are ${clockLabel(willCallHours.start)} through ${clockLabel(willCallHours.end)}.`,
    `Delivery hours are ${clockLabel(deliveryHours.start)} through ${clockLabel(deliveryHours.end)}.`,
    `Will-call orders ready before ${rules.willCallCutoff.label} on a business day are due that day at the cutoff.`,
    'Ready at or after the cutoff, or on Saturday or Sunday, are due the next business day at the cutoff.',
    `Other deliveries use the same rule with a ${rules.carrierCutoff.label} cutoff.`,
    'Those cutoffs sit inside the pickup and delivery hours, so same-day cutoff behavior is unchanged.',
    'Business days are Monday through Friday. Holidays are not skipped.',
    `Times are wall-clock in ${rules.timezone}.`,
    `A delivery that is not complete is overdue after its stored due time, due today on that calendar day, and due soon within ${rules.dueSoonHours} ${rules.dueSoonHours === 1 ? 'hour' : 'hours'}.`,
    'Completed deliveries are not marked overdue. A stored time outside the current window, including older orders, is still classified from that timestamp.',
    'Delivery status values are pending, scheduled, out-for-delivery, and complete.',
    `Customer order due times are weekdays in ${deliveryHours.incrementMinutes} minute increments, inside the window for the chosen method.`,
    'Customer Pickup is no longer offered. Existing Customer Pickup orders keep that label and use Will Call hours.',
    'FedEx and Common Carrier are no longer offered. Existing orders keep those labels.',
  ].join(' ');
}

function presentWindow(window, kind) {
  return {
    start: window.start,
    end: window.end,
    incrementMinutes: window.incrementMinutes,
    slots: window.slots.slice(),
    summary: windowSummary(window, kind),
    label: hoursLabel(window),
  };
}

function publicRulesView(now = new Date()) {
  const rules = getRules();
  const willCall = suggestDueTime(true, now, rules);
  const carrier = suggestDueTime(false, now, rules);
  const deliveryHours = rules.deliveryHours;
  return {
    rules: {
      timezone: rules.timezone,
      willCallCutoff: rules.willCallCutoff.label,
      carrierCutoff: rules.carrierCutoff.label,
      dueSoonHours: rules.dueSoonHours,
      businessDays: rules.businessDays.slice(),
      statuses: rules.statuses.slice(),
      summary: rulesSummary(rules),
      orderWindow: presentWindow(deliveryHours, 'delivery'),
      windows: {
        willCall: presentWindow(rules.willCallHours, 'will_call'),
        delivery: presentWindow(deliveryHours, 'delivery'),
      },
    },
    computed: {
      evaluatedAt: now.toISOString(),
      willCall: {
        cutoff: willCall.cutoff,
        readyBeforeCutoff: willCall.readyBeforeCutoff,
        sameDay: willCall.sameDay,
        suggestedDueTime: willCall.dueTime,
      },
      carrier: {
        cutoff: carrier.cutoff,
        readyBeforeCutoff: carrier.readyBeforeCutoff,
        sameDay: carrier.sameDay,
        suggestedDueTime: carrier.dueTime,
      },
    },
  };
}

module.exports = {
  DELIVERY_STATUSES,
  ACTIVE_DELIVERY_METHODS,
  RETIRED_DELIVERY_METHODS,
  UPS_ACCOUNT_MAX,
  getRules,
  normalizeDueTime,
  suggestDueTime,
  classifyDelivery,
  publicRulesView,
  businessToday,
  orderWindow,
  willCallWindow,
  deliveryWindow,
  orderWindowSummary,
  windowSummary,
  hoursLabel,
  validateOrderDue,
  clockLabel,
  zonedParts,
  zonedTimeToUtc,
  methodKey,
  retiredDeliveryMethod,
  retiredDeliveryMessage,
  isUpsMethod,
  usesWillCallHours,
  parseUpsAccountNumber,
};
