const graphMail = require('./graphMail');
const inboundEmail = require('./inboundEmail');
const { inboundEmailPollingEnabled } = require('./systemSettings');

const MAX_BACKOFF_MS = 30 * 60 * 1000;
let timer = null;
let started = false;
let failures = 0;
let nextAt = 0;

function backoffDelay(failureCount, seconds) {
  const base = Math.max(1, Number(seconds) || graphMail.pollSeconds()) * 1000;
  const shift = Math.min(Math.max(0, failureCount), 5);
  return Math.min(base * (2 ** shift), MAX_BACKOFF_MS);
}

async function runScheduledPoll() {
  if (!graphMail.isConfigured()) return { skipped: 'not_configured' };
  if (Date.now() < nextAt) return { skipped: 'backoff' };
  let enabled = true;
  try {
    enabled = await inboundEmailPollingEnabled();
  } catch (err) {
    console.error('INBOUND MAIL ERROR:', inboundEmail.safeErrorText(err));
    return { skipped: 'settings' };
  }
  if (!enabled) return { skipped: 'disabled' };
  try {
    const result = await inboundEmail.syncOnce();
    failures = 0;
    nextAt = 0;
    return result;
  } catch (err) {
    failures += 1;
    nextAt = Date.now() + backoffDelay(failures, graphMail.pollSeconds());
    const message = await inboundEmail.recordSyncError(err);
    console.error('INBOUND MAIL ERROR:', err.status || '', message);
    return { error: true };
  }
}

function start() {
  if (started) return;
  started = true;
  if (!graphMail.isConfigured()) {
    console.log('Inbound email polling is off because Microsoft 365 is not configured');
    return;
  }
  const seconds = graphMail.pollSeconds();
  timer = setInterval(() => {
    runScheduledPoll().catch((err) => {
      console.error('INBOUND MAIL ERROR:', inboundEmail.safeErrorText(err));
    });
  }, seconds * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  runScheduledPoll().catch((err) => {
    console.error('INBOUND MAIL ERROR:', inboundEmail.safeErrorText(err));
  });
}

module.exports = {
  start,
  runScheduledPoll,
  backoffDelay,
};
