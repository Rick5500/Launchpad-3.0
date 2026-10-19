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

const successes = createFixedWindowLimiter({ windowMs, max: successMax });
const attempts = createFixedWindowLimiter({ windowMs, max: attemptMax });
const globalLimit = createFixedWindowLimiter({ windowMs, max: globalMax });

function checkAttempt(ip) {
  const key = ip || 'unknown';
  const attempt = attempts.check(key);
  if (!attempt.allowed) return attempt;
  const overall = globalLimit.check('global');
  if (!overall.allowed) return overall;
  return successes.peek(key);
}

function recordLimited(ip) {
  return successes.check(ip || 'unknown');
}

module.exports = {
  checkAttempt,
  recordLimited,
};
