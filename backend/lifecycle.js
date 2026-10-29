// Tracks in-flight mail and the current poller tick so a shutdown can wait
// for them, then exit. New poller ticks check isDraining and do not start.

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

function beginDrain() {
  draining = true;
  if (httpServer) {
    try {
      httpServer.close(() => {});
      if (typeof httpServer.closeIdleConnections === 'function') httpServer.closeIdleConnections();
    } catch (err) {
      console.error('DRAIN ERROR:', err && err.message ? err.message : 'failed');
    }
  }
}

function install(onDrain) {
  if (installed) return;
  installed = true;
  const handler = (signal) => {
    if (draining) return;
    console.log(`DRAIN: ${signal}; stopping new work`);
    beginDrain();
    const force = setTimeout(() => {
      console.log('DRAIN: timeout; unfinished mail stays queued');
      process.exit(0);
    }, drainTimeoutMs());
    if (typeof force.ref === 'function') force.ref();
    Promise.resolve()
      .then(() => (typeof onDrain === 'function' ? onDrain() : null))
      .catch((err) => {
        console.error('DRAIN ERROR:', err && err.message ? err.message : 'failed');
      })
      .finally(() => {
        clearTimeout(force);
        console.log('DRAIN: in-flight work finished');
        process.exit(0);
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
  beginDrain,
  install,
};
