// Work that must not delay an HTTP response. Jobs wait until every
// createOrder call that is already in progress has returned, then run one
// at a time. That keeps SMTP and the extra writes off the request, and
// keeps them from crowding out the orders still being saved.
// Errors are logged and do not reject the request that already returned.

const pending = new Set();
const tasks = [];
let busy = 0;
let draining = false;

function holdSideEffects() {
  busy += 1;
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    busy -= 1;
    if (busy === 0) kick();
  };
}

function afterResponse(label, task) {
  let resolveJob;
  const job = new Promise((resolve) => {
    resolveJob = resolve;
  });
  pending.add(job);
  tasks.push(async () => {
    try {
      await task();
    } catch (err) {
      const message = err && err.message ? err.message : 'failed';
      console.error(`${label}:`, message);
    } finally {
      pending.delete(job);
      resolveJob();
    }
  });
  kick();
  return job;
}

function kick() {
  if (draining || busy > 0 || tasks.length === 0) return;
  draining = true;
  setImmediate(runNext);
}

function runNext() {
  if (busy > 0) {
    draining = false;
    return;
  }
  const next = tasks.shift();
  if (!next) {
    draining = false;
    return;
  }
  Promise.resolve()
    .then(next)
    .then(() => {
      setImmediate(runNext);
    });
}

function whenSettled() {
  if (pending.size === 0) return Promise.resolve();
  return Promise.all(Array.from(pending)).then(() => whenSettled());
}

module.exports = {
  afterResponse,
  holdSideEffects,
  whenSettled,
};
