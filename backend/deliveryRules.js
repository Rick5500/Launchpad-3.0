const { DELIVERY_STATUSES } = require('./statuses');

const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_WILL_CALL_CUTOFF = '15:00';
const DEFAULT_CARRIER_CUTOFF = '14:00';
const DEFAULT_DUE_SOON_HOURS = 1;

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

function getRules() {
  return {
    timezone: resolveTimeZone(process.env.DELIVERY_TIMEZONE),
    willCallCutoff: parseCutoff(process.env.WILL_CALL_CUTOFF, DEFAULT_WILL_CALL_CUTOFF),
    carrierCutoff: parseCutoff(process.env.CARRIER_CUTOFF, DEFAULT_CARRIER_CUTOFF),
    dueSoonHours: parseDueSoonHours(process.env.DUE_SOON_HOURS),
    businessDays: BUSINESS_DAYS,
    statuses: DELIVERY_STATUSES,
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

function rulesSummary(rules) {
  return [
    `Will-call orders ready before ${rules.willCallCutoff.label} on a business day are due that day at the cutoff.`,
    'Ready at or after the cutoff, or on Saturday or Sunday, are due the next business day at the cutoff.',
    `Carrier deliveries use the same rule with a ${rules.carrierCutoff.label} cutoff.`,
    'Business days are Monday through Friday. Holidays are not skipped.',
    `Times are wall-clock in ${rules.timezone}.`,
    `A delivery that is not complete is overdue after its due time, due today on that calendar day, and due soon within ${rules.dueSoonHours} ${rules.dueSoonHours === 1 ? 'hour' : 'hours'}.`,
    'Completed deliveries are not marked overdue.',
    'Delivery status values are pending, scheduled, out-for-delivery, and complete.',
  ].join(' ');
}

function publicRulesView(now = new Date()) {
  const rules = getRules();
  const willCall = suggestDueTime(true, now, rules);
  const carrier = suggestDueTime(false, now, rules);
  return {
    rules: {
      timezone: rules.timezone,
      willCallCutoff: rules.willCallCutoff.label,
      carrierCutoff: rules.carrierCutoff.label,
      dueSoonHours: rules.dueSoonHours,
      businessDays: rules.businessDays.slice(),
      statuses: rules.statuses.slice(),
      summary: rulesSummary(rules),
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
  getRules,
  normalizeDueTime,
  suggestDueTime,
  classifyDelivery,
  publicRulesView,
};
