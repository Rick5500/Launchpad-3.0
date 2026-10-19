const activityLog = require('./activityLog');
const { get, all, withTransaction } = require('./dbAsync');
const { httpError } = require('./httpError');
const { parseText, parseInteger } = require('./fields');
const { getRules } = require('./deliveryRules');
const { setDueSoonHoursOverride } = require('./runtimeSettings');
const { maxUploadMb, maxFilesPerRequest } = require('./fileStore');
const { maxUnattachedUploads } = require('./uploadMaintenance');
const {
  DEFAULT_NAME,
  DEFAULT_ADDRESS,
  DEFAULT_PHONE,
  letterheadFromMap,
  loadLetterhead,
} = require('./shopProfile');

const LETTERHEAD_KEYS = ['company_name', 'company_address', 'company_phone'];
const SIGNUP_KEY = 'customer_self_signup_enabled';

function signupEnabledFromValue(value) {
  if (value == null || String(value).trim() === '') return true;
  const text = String(value).trim().toLowerCase();
  if (text === '0' || text === 'false' || text === 'off' || text === 'no') return false;
  return true;
}

function parseSignupFlag(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return { value: '1' };
  if (value === false || value === 0 || value === '0' || value === 'false') return { value: '0' };
  return { error: 'customer_self_signup_enabled must be true or false' };
}

function environmentDueSoonHours() {
  const raw = process.env.DUE_SOON_HOURS;
  if (raw == null || String(raw).trim() === '') return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return parsed;
}

function orphanHours() {
  const parsed = Number(process.env.UPLOAD_ORPHAN_HOURS);
  if (!Number.isFinite(parsed) || parsed <= 0) return 24;
  return parsed;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function parsePhone(value) {
  const parsed = parseText(value, 'company_phone', { required: true, max: 40 });
  if (parsed.error) return parsed;
  if (!/^[0-9+().\-\s]+$/.test(parsed.value)) return { error: 'company_phone contains invalid characters' };
  const digits = parsed.value.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return { error: 'company_phone must contain 7 to 15 digits' };
  return parsed;
}

function parseDueSoon(value) {
  if (value == null || value === '') return { value: null };
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 168) {
    return { error: 'due_soon_hours must be a number from 0 to 168' };
  }
  return { value: Math.round(parsed * 100) / 100 };
}

function parseBackup(value) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'last_backup_at must be YYYY-MM-DD or YYYY-MM-DD HH:MM:SS' };
  const text = value.trim();
  if (!text) return { value: null };
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!match) return { error: 'last_backup_at must be YYYY-MM-DD or YYYY-MM-DD HH:MM:SS' };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] == null ? 0 : Number(match[4]);
  const minute = match[5] == null ? 0 : Number(match[5]);
  const second = match[6] == null ? 0 : Number(match[6]);
  if (year < 2000 || year > 2100 || hour > 23 || minute > 59 || second > 59) {
    return { error: 'last_backup_at is out of range' };
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return { error: 'last_backup_at is invalid' };
  }
  return { value: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}` };
}

async function readMap() {
  const rows = await all('SELECT key, value FROM system_settings');
  const map = {};
  for (const row of rows) map[row.key] = row.value;
  return map;
}

function present(map) {
  const rules = getRules();
  const window = rules.deliveryHours;
  const willCallHours = rules.willCallHours;
  const letterhead = letterheadFromMap(map);
  const storedDue = map.due_soon_hours == null || String(map.due_soon_hours).trim() === ''
    ? null
    : Number(map.due_soon_hours);
  const environmentDue = environmentDueSoonHours();
  const timezoneConfigured = process.env.DELIVERY_TIMEZONE == null || String(process.env.DELIVERY_TIMEZONE).trim() === ''
    ? null
    : String(process.env.DELIVERY_TIMEZONE).trim();
  return {
    letterhead: {
      company_name: letterhead.name,
      company_address: letterhead.address,
      company_phone: letterhead.phone,
      address_lines: letterhead.address_lines,
      defaults: {
        company_name: DEFAULT_NAME,
        company_address: DEFAULT_ADDRESS,
        company_phone: DEFAULT_PHONE,
      },
    },
    due_soon_hours: {
      value: storedDue == null || Number.isNaN(storedDue) ? environmentDue : storedDue,
      environment_value: environmentDue,
      source: storedDue == null || Number.isNaN(storedDue) ? 'environment' : 'settings',
      editable: true,
    },
    last_backup_at: map.last_backup_at == null || String(map.last_backup_at).trim() === ''
      ? null
      : String(map.last_backup_at),
    customer_self_signup_enabled: signupEnabledFromValue(map[SIGNUP_KEY]),
    read_only: {
      delivery_timezone: rules.timezone,
      delivery_timezone_configured: timezoneConfigured,
      will_call_cutoff: rules.willCallCutoff.label,
      carrier_cutoff: rules.carrierCutoff.label,
      will_call_window_start: willCallHours.start,
      will_call_window_end: willCallHours.end,
      delivery_window_start: window.start,
      delivery_window_end: window.end,
      delivery_slot_minutes: window.incrementMinutes,
      max_upload_mb: maxUploadMb(),
      max_upload_files: maxFilesPerRequest(),
      max_unattached_uploads: maxUnattachedUploads(),
      upload_orphan_hours: orphanHours(),
    },
  };
}

async function getSettings() {
  return present(await readMap());
}

function hasOwn(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

async function updateSettings(actorId, body) {
  const source = body || {};
  const allowed = new Set([...LETTERHEAD_KEYS, 'due_soon_hours', 'last_backup_at', SIGNUP_KEY]);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length) throw httpError(400, `Unknown setting: ${unknown[0]}`);

  const current = await readMap();
  const changes = [];

  if (hasOwn(source, 'company_name')) {
    const parsed = parseText(source.company_name, 'company_name', { required: true, max: 120 });
    if (parsed.error) throw httpError(400, parsed.error);
    changes.push(['company_name', parsed.value]);
  }
  if (hasOwn(source, 'company_address')) {
    const parsed = parseText(source.company_address, 'company_address', { required: true, max: 400, allowNewlines: true });
    if (parsed.error) throw httpError(400, parsed.error);
    changes.push(['company_address', parsed.value.replace(/\r\n/g, '\n')]);
  }
  if (hasOwn(source, 'company_phone')) {
    const parsed = parsePhone(source.company_phone);
    if (parsed.error) throw httpError(400, parsed.error);
    changes.push(['company_phone', parsed.value]);
  }
  if (hasOwn(source, 'due_soon_hours')) {
    const parsed = parseDueSoon(source.due_soon_hours);
    if (parsed.error) throw httpError(400, parsed.error);
    changes.push(['due_soon_hours', parsed.value == null ? null : String(parsed.value)]);
  }
  if (hasOwn(source, 'last_backup_at')) {
    const parsed = parseBackup(source.last_backup_at);
    if (parsed.error) throw httpError(400, parsed.error);
    changes.push(['last_backup_at', parsed.value]);
  }
  if (hasOwn(source, SIGNUP_KEY)) {
    const parsed = parseSignupFlag(source[SIGNUP_KEY]);
    if (parsed.error) throw httpError(400, parsed.error);
    changes.push([SIGNUP_KEY, parsed.value]);
  }
  if (!changes.length) throw httpError(400, 'No settings to update');

  await withTransaction(async (tx) => {
    for (const [key, value] of changes) {
      if (value == null) {
        await tx.run('DELETE FROM system_settings WHERE key = ?', [key]);
      } else {
        await tx.run(
          `INSERT INTO system_settings (key, value, updated_at) VALUES (?,?,datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
          [key, value]
        );
      }
    }
    await activityLog.recordOn(tx, actorId, 'settings.updated', 'system_settings', null, {
      keys: changes.map(([key]) => key),
      message: `Updated ${changes.map(([key]) => key).join(', ')}`,
      previous: Object.fromEntries(changes.map(([key]) => [key, current[key] == null ? null : current[key]])),
    });
  });

  if (changes.some(([key]) => key === 'due_soon_hours')) {
    const next = changes.find(([key]) => key === 'due_soon_hours')[1];
    setDueSoonHoursOverride(next == null ? null : Number(next));
  }
  return getSettings();
}

async function loadRuntimeCache() {
  try {
    const row = await get(`SELECT value FROM system_settings WHERE key = 'due_soon_hours'`);
    if (!row || row.value == null || String(row.value).trim() === '') {
      setDueSoonHoursOverride(null);
      return;
    }
    const parsed = Number(row.value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setDueSoonHoursOverride(null);
      return;
    }
    setDueSoonHoursOverride(parsed);
  } catch (err) {
    setDueSoonHoursOverride(null);
    if (/no such table/i.test(String(err.message || ''))) return;
    throw err;
  }
}

async function customerSelfSignupEnabled() {
  const row = await get('SELECT value FROM system_settings WHERE key = ?', [SIGNUP_KEY]);
  if (!row) return true;
  return signupEnabledFromValue(row.value);
}

module.exports = {
  SIGNUP_KEY,
  getSettings,
  updateSettings,
  loadRuntimeCache,
  loadLetterhead,
  customerSelfSignupEnabled,
  signupEnabledFromValue,
};
