const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { databaseFile, flagOn } = require('./runtimeConfig');

const NAME_RE = /^launchpad-(\d{8})-(\d{6})\.db$/;
const CHECK_MS = 15 * 60 * 1000;
let timer = null;
let running = false;

function backupEnabled() {
  return flagOn(process.env.BACKUP_ENABLED);
}

function retentionCount() {
  const parsed = Number(process.env.BACKUP_RETENTION_DAYS);
  if (!Number.isInteger(parsed) || parsed < 1) return 14;
  return Math.min(parsed, 3650);
}

function backupHour() {
  const parsed = Number(process.env.BACKUP_HOUR);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) return 2;
  return parsed;
}

function timeZone() {
  const zone = String(process.env.DELIVERY_TIMEZONE || 'UTC').trim() || 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
    return zone;
  } catch (err) {
    return 'UTC';
  }
}

function wallStamp(date, zone) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone || timeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    compact: `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`,
    stored: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function backupDue(now, lastStored, hour, zone) {
  const current = wallStamp(now, zone);
  if (current.hour < hour) return false;
  if (!lastStored) return true;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(lastStored).trim());
  if (!match) return true;
  return match[1] !== current.date;
}

function selectExpired(names, keep) {
  const matched = (names || []).filter((name) => NAME_RE.test(String(name))).sort();
  const limit = Number.isInteger(keep) && keep > 0 ? keep : 14;
  if (matched.length <= limit) return [];
  return matched.slice(0, matched.length - limit);
}

function backupDatabase(source, destFile) {
  return new Promise((resolve, reject) => {
    let backup;
    try {
      backup = source.backup(destFile);
    } catch (err) {
      reject(err);
      return;
    }
    if (!backup || typeof backup.step !== 'function') {
      reject(new Error('SQLite online backup is not available'));
      return;
    }
    const finish = (err) => {
      if (typeof backup.finish !== 'function') {
        if (err) reject(err);
        else resolve();
        return;
      }
      backup.finish((finishErr) => {
        if (err || finishErr) reject(err || finishErr);
        else resolve();
      });
    };
    const pump = () => {
      backup.step(64, (err) => {
        if (err) return finish(err);
        if (backup.remaining === 0) return finish();
        setImmediate(pump);
      });
    };
    pump();
  });
}

function readLastBackup(database) {
  return new Promise((resolve, reject) => {
    database.get(
      `SELECT value FROM system_settings WHERE key = 'last_backup_at'`,
      (err, row) => {
        if (err) reject(err);
        else resolve(row && row.value ? String(row.value) : '');
      }
    );
  });
}

function settingsColumns(database) {
  return new Promise((resolve, reject) => {
    database.all('PRAGMA table_info(system_settings)', (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function localBackupDirectory(database, overrideDir) {
  if (overrideDir) return overrideDir;
  const fromEnv = process.env.BACKUP_DIR == null ? '' : String(process.env.BACKUP_DIR).trim();
  if (fromEnv) return path.resolve(fromEnv);
  const named = database && typeof database.filename === 'string' && database.filename
    ? database.filename
    : databaseFile();
  return path.join(path.dirname(path.resolve(named)), 'backups');
}

async function recordBackupTimestamp(database, stamp) {
  const columns = await settingsColumns(database);
  const hasUpdated = columns.some((row) => row.name === 'updated_at');
  const sql = hasUpdated
    ? `INSERT INTO system_settings (key, value, updated_at) VALUES ('last_backup_at', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    : `INSERT INTO system_settings (key, value) VALUES ('last_backup_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  return new Promise((resolve, reject) => {
    database.run(sql, [stamp], (err) => (err ? reject(err) : resolve()));
  });
}

function s3Selected() {
  return String(process.env.FILE_STORAGE_DRIVER || '').trim().toLowerCase() === 's3';
}

async function runBackup(options = {}) {
  const database = options.db || require('./db');
  const zone = options.timeZone || timeZone();
  const stamp = wallStamp(options.now || new Date(), zone);
  const filename = `launchpad-${stamp.compact}.db`;
  const keep = options.keep == null ? retentionCount() : options.keep;
  const useS3 = options.destination ? options.destination === 's3' : s3Selected();
  const fileStore = require('./fileStore');
  const root = options.root || fileStore.uploadDir();

  if (useS3) {
    const { getStorageDriver } = require('./storage/localFolder');
    const found = options.driver ? { driver: options.driver, error: null } : getStorageDriver('s3');
    if (found.error || !found.driver) {
      throw found.error || new Error('S3 storage is not configured, so the backup was not written');
    }
    const tmp = path.join(os.tmpdir(), `lp-backup-${crypto.randomBytes(6).toString('hex')}.db`);
    try {
      await backupDatabase(database, tmp);
      const backupDir = path.join(root, 'backups');
      await found.driver.uploadStream(path.join(backupDir, filename), fs.createReadStream(tmp));
      const names = await found.driver.listNames(backupDir);
      for (const old of selectExpired(names, keep)) {
        try { await found.driver.unlink(path.join(backupDir, old)); } catch (err) {
          if (!err || err.code !== 'ENOENT') throw err;
        }
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch (err) { /* temp backup is removed when it is still there */ }
    }
  } else {
    const backupDir = localBackupDirectory(database, options.backupDir);
    fs.mkdirSync(backupDir, { recursive: true });
    if (!fs.statSync(backupDir).isDirectory()) {
      throw new Error('Backup folder is not a directory');
    }
    const dest = path.join(backupDir, filename);
    await backupDatabase(database, dest);
    const names = fs.readdirSync(backupDir);
    for (const old of selectExpired(names, keep)) {
      fs.unlinkSync(path.join(backupDir, old));
    }
  }

  await recordBackupTimestamp(database, stamp.stored);
  return { filename, stored: stamp.stored, destination: useS3 ? 's3' : 'dir' };
}

async function runScheduled() {
  if (!backupEnabled()) return { skipped: true, reason: 'disabled' };
  const database = require('./db');
  const last = await readLastBackup(database).catch(() => '');
  if (!backupDue(new Date(), last, backupHour(), timeZone())) return { skipped: true, reason: 'not-due' };
  const result = await runBackup({ db: database });
  console.log(`SQLite backup written (${result.destination}): ${result.filename}`);
  return result;
}

function start() {
  if (!backupEnabled()) return null;
  if (timer) return timer;
  const tick = () => {
    if (running) return;
    running = true;
    runScheduled()
      .catch((err) => console.error('BACKUP ERROR:', err && err.message ? err.message : err))
      .finally(() => { running = false; });
  };
  timer = setInterval(tick, CHECK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const kick = setTimeout(tick, 15000);
  if (typeof kick.unref === 'function') kick.unref();
  return timer;
}

module.exports = {
  backupEnabled,
  retentionCount,
  backupHour,
  timeZone,
  wallStamp,
  backupDue,
  selectExpired,
  backupDatabase,
  readLastBackup,
  localBackupDirectory,
  recordBackupTimestamp,
  runBackup,
  runScheduled,
  start,
};
