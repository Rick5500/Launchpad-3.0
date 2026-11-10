// Friendly dates for customer emails. Naive values (YYYY-MM-DD and HH:MM)
// are the shop wall clock and are already in DELIVERY_TIMEZONE. An instant
// with a zone is converted into that timezone. Stored values are not rewritten.

const { getRules } = require('./deliveryRules');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shopTimeZone() {
  return getRules().timezone;
}

function calendarValid(year, month, day) {
  if (year < 2000 || year > 2100) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function calendarLabel(year, month, day) {
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday}, ${MONTHS[month - 1]} ${day}`;
}

function clockLabel(hour, minute) {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  let hour12 = hour % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function wallClock(year, month, day, hour, minute, hasTime) {
  const label = calendarLabel(year, month, day);
  if (!hasTime) return label;
  return `${label}, ${clockLabel(hour, minute)}`;
}

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] == null ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute };
}

function formatInstant(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h12',
    }).formatToParts(date);
  } catch (err) {
    return null;
  }
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const weekday = String(map.weekday || '').replace(/\./g, '');
  const month = String(map.month || '').replace(/\./g, '');
  const day = String(map.day || '').replace(/\D/g, '');
  const hour = String(map.hour || '').replace(/\D/g, '');
  const minute = String(map.minute || '').replace(/\D/g, '');
  const period = String(map.dayPeriod || '').replace(/\./g, '').toUpperCase();
  if (!weekday || !month || !day || !hour || minute === '' || (period !== 'AM' && period !== 'PM')) return null;
  return `${weekday}, ${month} ${Number(day)}, ${Number(hour)}:${minute.padStart(2, '0')} ${period}`;
}

function formatCustomerWhen(dateValue, timeValue) {
  const dateText = dateValue == null ? '' : String(dateValue).trim();
  const timeText = timeValue == null ? '' : String(timeValue).trim();
  if (!dateText && !timeText) return '';
  const original = [dateText, timeText].filter(Boolean).join(' ');

  if (!timeText && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateText)) {
    const zoned = formatInstant(dateText, shopTimeZone());
    if (zoned) return zoned;
  }

  const day = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(dateText);
  if (!day) return original;
  const year = Number(day[1]);
  const month = Number(day[2]);
  const date = Number(day[3]);
  if (!calendarValid(year, month, date)) return original;

  const explicit = parseClock(timeText);
  if (explicit) return wallClock(year, month, date, explicit.hour, explicit.minute, true);
  if (timeText) return original;

  const rest = String(day[4] || '').trim();
  if (!rest) return wallClock(year, month, date, 0, 0, false);
  const embedded = /^[T ](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(rest);
  if (!embedded) return original;
  const clock = parseClock(`${embedded[1]}:${embedded[2]}`);
  if (!clock) return original;
  return wallClock(year, month, date, clock.hour, clock.minute, true);
}

module.exports = {
  formatCustomerWhen,
  shopTimeZone,
};
