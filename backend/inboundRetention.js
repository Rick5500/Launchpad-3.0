// Non-converted inbound mail and its attachments expire. Files copied onto an
// order stay with that order. The cleanup runs once a day.

const { all, get, run } = require('./dbAsync');
const { removeStored } = require('./fileStore');
const lifecycle = require('./lifecycle');

const DEFAULT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
let timer = null;
let started = false;

function retentionDaysFrom(value) {
  if (value == null || String(value).trim() === '') return DEFAULT_DAYS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_DAYS;
  return Math.min(parsed, 3650);
}

async function retentionDays() {
  const row = await get(
    `SELECT value FROM system_settings WHERE key = 'inbound_email_retention_days'`
  );
  return retentionDaysFrom(row && row.value);
}

function attachmentCapBytes() {
  const parsed = Number(process.env.INBOUND_ATTACHMENT_CAP_BYTES);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1024 * 1024 * 1024;
  return Math.floor(parsed);
}

function warnRatio() {
  const parsed = Number(process.env.INBOUND_ATTACHMENT_CAP_WARN_RATIO);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) return 0.9;
  return parsed;
}

async function usedAttachmentBytes() {
  const row = await get(
    `SELECT COALESCE(SUM(size_bytes), 0) AS total
     FROM inbound_email_attachments
     WHERE stored_name IS NOT NULL AND skipped_reason IS NULL`
  );
  return row ? Number(row.total) || 0 : 0;
}

async function cleanupExpired() {
  const days = await retentionDays();
  const rows = await all(
    `SELECT a.id, a.stored_name, a.storage_root, a.inbound_email_id
     FROM inbound_email_attachments a
     JOIN inbound_emails e ON e.id = a.inbound_email_id
     WHERE e.status != 'converted'
       AND e.order_id IS NULL
       AND datetime(replace(substr(COALESCE(e.received_at, e.created_at), 1, 19), 'T', ' '))
           <= datetime('now', ?)`,
    [`-${days} days`]
  );
  let removed = 0;
  for (const row of rows) {
    if (row.stored_name) await Promise.resolve(removeStored(row.stored_name, row.storage_root));
    await run('DELETE FROM inbound_email_attachments WHERE id = ?', [row.id]);
    removed += 1;
  }
  const emails = await run(
    `DELETE FROM inbound_emails
     WHERE status != 'converted'
       AND order_id IS NULL
       AND datetime(replace(substr(COALESCE(received_at, created_at), 1, 19), 'T', ' '))
           <= datetime('now', ?)`,
    [`-${days} days`]
  );
  return { attachments: removed, emails: emails.changes || 0, retention_days: days };
}

function start() {
  if (started) return;
  started = true;
  const runOnce = () => lifecycle.trackTick(() => cleanupExpired().catch((err) => {
    console.error('INBOUND RETENTION ERROR:', err && err.message ? err.message : 'failed');
  }));
  timer = setInterval(runOnce, DAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  runOnce();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  DEFAULT_DAYS,
  retentionDaysFrom,
  retentionDays,
  attachmentCapBytes,
  warnRatio,
  usedAttachmentBytes,
  cleanupExpired,
  start,
  stop,
};
