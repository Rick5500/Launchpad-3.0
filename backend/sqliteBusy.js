const BUSY_TIMEOUT_MS = 8000;
const BUSY_ATTEMPTS = 8;

function isBusyError(err) {
  if (!err) return false;
  return err.code === 'SQLITE_BUSY'
    || err.code === 'SQLITE_LOCKED'
    || err.errno === 5
    || err.errno === 6;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return Math.min(40 * (2 ** attempt), 500);
}

module.exports = {
  BUSY_TIMEOUT_MS,
  BUSY_ATTEMPTS,
  isBusyError,
  delay,
  backoffMs,
};
