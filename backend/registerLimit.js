const { createFixedWindowLimiter } = require('./rateLimit');

const HOUR_MS = 60 * 60 * 1000;

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const windowMs = positiveInt('REGISTER_RATE_WINDOW_MS', HOUR_MS);
// Successful registrations and honeypot hits. Validation and duplicate errors do not count.
const successMax = positiveInt('REGISTER_RATE_IP_MAX', 5);
// Every registration request, so a scanner cannot retry forever by sending invalid bodies.
const attemptMax = positiveInt('REGISTER_RATE_IP_ATTEMPT_MAX', 30);
const globalMax = positiveInt('REGISTER_RATE_GLOBAL_MAX', 200);

const attempts = createFixedWindowLimiter({ windowMs, max: attemptMax });
const globalLimit = createFixedWindowLimiter({ windowMs, max: globalMax });

// committed = finished successes and honeypot hits. pending = reserved slots
// whose account has not been created yet. Both count toward the success cap.
const slots = new Map();

function slot(key, now) {
  let entry = slots.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { committed: 0, pending: 0, resetAt: now + windowMs };
    slots.set(key, entry);
  }
  return entry;
}

function reserve(key) {
  const now = Date.now();
  const entry = slot(key, now);
  if (entry.committed + entry.pending >= successMax) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
  entry.pending += 1;
  return { allowed: true };
}

function release(ip) {
  const entry = slots.get(ip || 'unknown');
  if (!entry || entry.resetAt <= Date.now() || entry.pending < 1) return;
  entry.pending -= 1;
}

function commit(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const current = slots.get(key);
  if (!current || current.resetAt <= now) {
    slots.set(key, { committed: 1, pending: 0, resetAt: now + windowMs });
    return;
  }
  if (current.pending > 0) current.pending -= 1;
  current.committed += 1;
}

function checkAttempt(ip) {
  const key = ip || 'unknown';
  const attempt = attempts.check(key);
  if (!attempt.allowed) return attempt;
  const overall = globalLimit.check('global');
  if (!overall.allowed) return overall;
  return reserve(key);
}

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of slots) {
    if (!entry.resetAt || entry.resetAt <= now) slots.delete(key);
  }
}

const timer = setInterval(cleanup, Math.max(windowMs, 60 * 1000));
if (typeof timer.unref === 'function') timer.unref();

module.exports = {
  checkAttempt,
  commit,
  release,
};
