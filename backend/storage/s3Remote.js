const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

let worker = null;
let workerReady = false;
let configSent = false;

function timeoutMs() {
  const parsed = Number(process.env.S3_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 1000) return 60000;
  return Math.min(parsed, 120000);
}

function resetWorker() {
  if (worker) {
    try { worker.terminate(); } catch (err) { /* the next call starts a new worker */ }
  }
  worker = null;
  workerReady = false;
  configSent = false;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 's3Worker.js'));
  worker.unref();
  worker.on('error', (err) => {
    console.error('S3 WORKER ERROR:', err && err.message ? err.message : err);
  });
  worker.on('exit', () => {
    worker = null;
    workerReady = false;
    configSent = false;
  });
  workerReady = true;
  return worker;
}

function publicConfig(config) {
  if (!config) return null;
  return {
    region: config.region,
    endpoint: config.endpoint || '',
    forcePathStyle: Boolean(config.forcePathStyle),
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
}

function syncCall(op, payload, config, body) {
  const active = ensureWorker();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-s3-'));
  const slotBuffer = new SharedArrayBuffer(4);
  const slot = new Int32Array(slotBuffer);
  Atomics.store(slot, 0, 0);
  try {
    const bodyPath = path.join(dir, 'body');
    const outPath = path.join(dir, 'out');
    const metaPath = path.join(dir, 'meta.json');
    if (body) fs.writeFileSync(bodyPath, body);
    fs.writeFileSync(metaPath, JSON.stringify({ op, payload: payload || {} }));
    const sendConfig = op !== 'ping' && !configSent ? publicConfig(config) : null;
    if (sendConfig) configSent = true;
    active.postMessage({
      metaPath,
      bodyPath: body ? bodyPath : null,
      outPath,
      sab: slotBuffer,
      config: sendConfig,
    });
    Atomics.wait(slot, 0, 0, timeoutMs());
    const state = Atomics.load(slot, 0);
    if (state === 0) {
      resetWorker();
      const error = new Error('S3 request timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    const metaFile = `${outPath}.json`;
    if (!fs.existsSync(metaFile)) {
      const error = new Error('S3 worker returned no result');
      error.code = 'ES3';
      throw error;
    }
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (!meta.ok) {
      const error = new Error(meta.message || 'S3 request failed');
      error.code = meta.code || 'ES3';
      throw error;
    }
    const outBody = meta.hasBody && fs.existsSync(outPath) ? fs.readFileSync(outPath) : null;
    return { meta, body: outBody };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createRemoteClient(config) {
  return {
    headBucket() {
      const result = syncCall('headBucket', {}, config);
      return Boolean(result.meta.okBucket);
    },
    put(key, body) {
      syncCall('put', { key }, config, Buffer.from(body));
    },
    get(key) {
      try {
        const result = syncCall('get', { key }, config);
        if (result.meta.missing) return null;
        return result.body || Buffer.alloc(0);
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    head(key) {
      try {
        const result = syncCall('head', { key }, config);
        if (result.meta.missing) return null;
        return { size: Number(result.meta.size) || 0 };
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    del(key) {
      syncCall('del', { key }, config);
    },
    copy(source, dest) {
      syncCall('copy', { source, dest }, config);
    },
    list(prefix) {
      const result = syncCall('list', { prefix }, config);
      return Array.isArray(result.meta.keys) ? result.meta.keys : [];
    },
  };
}

function closeRemote() {
  resetWorker();
}

module.exports = {
  syncCall,
  createRemoteClient,
  closeRemote,
};
