// Admin bell plus an activity-log line when mailbox polling, virus scanning,
// or attachment storage keeps failing. Notices are deduped per day.

const activityLog = require('./activityLog');
const notifications = require('./notifications');

const THRESHOLD = 3;
let pollFailures = 0;
let scanFailures = 0;

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function raise(kind, title, body) {
  const dedupeKey = `inbound_mail_alert:${kind}:${dayKey()}`;
  notifications.notifyInboundMailAlert({ title, body, dedupeKey }, (err) => {
    if (err) console.error('INBOUND ALERT ERROR:', err && err.message ? err.message : 'failed');
  });
  activityLog.record(null, 'inbound_mail.alert', 'inbound_mail', null, {
    kind,
    message: body,
  }).catch((err) => {
    console.error('INBOUND ALERT LOG ERROR:', err && err.message ? err.message : 'failed');
  });
  console.error('INBOUND MAIL ALERT:', body);
}

function notePollSuccess() {
  pollFailures = 0;
}

function notePollFailure(message) {
  pollFailures += 1;
  if (pollFailures < THRESHOLD) return pollFailures;
  raise('poll', 'Orders mailbox check is failing', String(message || 'The orders mailbox check failed repeatedly').slice(0, 500));
  return pollFailures;
}

function noteScanSuccess() {
  scanFailures = 0;
}

function noteScanFailure(message) {
  scanFailures += 1;
  if (scanFailures < THRESHOLD) return scanFailures;
  raise('scan', 'Attachment scanning is failing', String(message || 'The virus scanner failed repeatedly').slice(0, 500));
  return scanFailures;
}

function noteStoragePressure(message) {
  raise('storage', 'Attachment storage is nearly full', String(message || 'Inbound attachment storage is near its cap').slice(0, 500));
}

function noteAttachmentGaveUp(message) {
  raise('attachment_fetch', 'An email attachment was not delivered', String(message || 'A pending attachment passed the retry limit').slice(0, 500));
}

function failureCounts() {
  return { pollFailures, scanFailures };
}

function resetCounts() {
  pollFailures = 0;
  scanFailures = 0;
}

module.exports = {
  THRESHOLD,
  notePollSuccess,
  notePollFailure,
  noteScanSuccess,
  noteScanFailure,
  noteStoragePressure,
  noteAttachmentGaveUp,
  failureCounts,
  resetCounts,
};
