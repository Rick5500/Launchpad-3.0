// Tracks in-flight mail and the current poller tick so a shutdown can wait
// for them, then exit. New poller ticks check isDraining and do not start.
// server.close is awaited so requests already being handled can finish inside
// the drain bound. A forced timeout exits non-zero and leaves unfinished
// mail queued for the next start.

const inflight = new Set();
let draining = false;
let httpServer = null;
let installed = false;

function drainTimeoutMs() {
  const parsed = Number(process.env.DRAIN_TIMEOUT_MS);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 120000) return 20000;
  return parsed;
}

function isDraining() {
  return draining;
}

function track(work) {
  const promise = Promise.resolve().then(work).finally(() => {
    inflight.delete(promise);
  });
  inflight.add(promise);
  return promise;
}

function trackTick(work) {
  if (draining) return Promise.resolve();
  return track(work);
}

function whenIdle() {
  if (inflight.size === 0) return Promise.resolve();
  return Promise.all(Array.from(inflight)).then(() => whenIdle());
}

function attach(server) {
  httpServer = server;
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function install(onDrain) {
  if (installed) return;
  installed = true;
  const handler = (signal) => {
    if (draining) return;
    draining = true;
    console.log(`DRAIN: ${signal}; stopping new work`);
    if (httpServer && typeof httpServer.closeIdleConnections === 'function') {
      try {
        httpServer.closeIdleConnections();
      } catch (err) {
        console.error('DRAIN ERROR:', err && err.message ? err.message : 'failed');
      }
    }
    let finished = false;
    const finish = (code, message) => {
      if (finished) return;
      finished = true;
      clearTimeout(force);
      if (message) console.log(message);
      process.exit(code);
    };
    const force = setTimeout(() => {
      finished = true;
      if (httpServer && typeof httpServer.closeAllConnections === 'function') {
        try { httpServer.closeAllConnections(); } catch (err) { /* exiting */ }
      }
      process.exit(1);
    }, drainTimeoutMs());
    if (typeof force.ref === 'function') force.ref();
    const closed = closeServer(httpServer);
    Promise.resolve()
      .then(() => (typeof onDrain === 'function' ? onDrain() : null))
      .then(() => closed)
      .then(() => finish(0, 'DRAIN: in-flight work finished'))
      .catch((err) => {
        console.error('DRAIN ERROR:', err && err.message ? err.message : 'failed');
        finish(1, 'DRAIN: failed');
      });
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

module.exports = {
  drainTimeoutMs,
  isDraining,
  track,
  trackTick,
  whenIdle,
  attach,
  install,
};
