function createFixedWindowLimiter({ windowMs, max }) {
  const buckets = new Map();

  function check(key) {
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }
    if (entry.count >= max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    }
    entry.count += 1;
    return { allowed: true, remaining: max - entry.count };
  }

  function cleanup() {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (!entry.resetAt || entry.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }

  const timer = setInterval(cleanup, Math.max(windowMs, 60 * 1000));
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return { check };
}

module.exports = { createFixedWindowLimiter };
