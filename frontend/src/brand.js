export const brand = {
  navy: '#0A2F6E',
  navyDark: '#071E4A',
  orange: '#F58220',
  orangeDark: '#D86A0A',
  page: '#F4F7FB',
  card: '#FFFFFF',
  border: '#E2E8F0',
  text: '#1B2838',
  muted: '#5E6A78',
  green: '#2E9E4F',
  greenDark: '#237A3D',
  danger: '#C62828',
};

function wallClockToUtc(timeZone, wall) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(wall || '').trim());
  if (!match) return null;
  const desiredUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    match[4] != null ? Number(match[4]) : 12,
    match[5] != null ? Number(match[5]) : 0,
    match[6] != null ? Number(match[6]) : 0
  );
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let guess = desiredUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(format.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second)
    );
    const delta = asUtc - desiredUtc;
    if (delta === 0) return new Date(guess);
    guess -= delta;
  }
  return new Date(guess);
}

export function timezoneLabel(timeZone, wallClock) {
  const zone = String(timeZone || '').trim();
  if (!zone) return '';
  let instant = wallClock ? wallClockToUtc(zone, wallClock) : new Date();
  if (!instant || Number.isNaN(instant.valueOf())) instant = new Date();
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(instant)
      .find((item) => item.type === 'timeZoneName');
    return part && part.value ? part.value : zone;
  } catch (err) {
    return zone;
  }
}

export function formatShopStamp(value, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value || '').trim());
  if (!match) return '';
  const utc = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0)
  ));
  if (Number.isNaN(utc.valueOf())) return '';
  const zone = timeZone || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).format(utc);
  } catch (err) {
    return '';
  }
}

export function formatLocalTimestamp(value) {
  if (value == null || value === '') return '';
  const text = String(value).trim();
  let date;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    date = new Date(`${text.replace(' ', 'T')}Z`);
  } else {
    date = new Date(text);
  }
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatClockLabel(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!match) return hhmm || '';
  const hour24 = Number(match[1]);
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${match[2]} ${suffix}`;
}

export function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
