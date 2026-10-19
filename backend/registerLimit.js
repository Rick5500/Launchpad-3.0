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
const ipMax = positiveInt('REGISTER_RATE_IP_MAX', 5);
const globalMax = positiveInt('REGISTER_RATE_GLOBAL_MAX', 50);

const perIp = createFixedWindowLimiter({ windowMs, max: ipMax });
const globalLimit = createFixedWindowLimiter({ windowMs, max: globalMax });

function check(ip) {
  const ipResult = perIp.check(ip || 'unknown');
  if (!ipResult.allowed) return ipResult;
  return globalLimit.check('global');
}

module.exports = {
  check,
};
