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

const EASTERN_ZONES = new Set([
  'America/New_York',
  'America/Detroit',
  'America/Indiana/Indianapolis',
  'America/Kentucky/Louisville',
  'America/Toronto',
  'US/Eastern',
  'EST5EDT',
]);

export function timezoneLabel(timeZone) {
  const zone = String(timeZone || '').trim();
  if (!zone) return '';
  if (EASTERN_ZONES.has(zone)) return 'Eastern';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((item) => item.type === 'timeZoneName');
    return part ? part.value : zone;
  } catch (err) {
    return zone;
  }
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
