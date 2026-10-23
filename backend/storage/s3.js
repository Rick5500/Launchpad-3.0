const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');
const { createRemoteClient } = require('./s3Remote');

const DOWN = 'File storage is unavailable. The storage folder cannot be reached, so uploads are paused.';
let testClient = null;

function flagOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function readConfig(env) {
  const source = env || process.env;
  const bucket = String(source.S3_BUCKET || '').trim();
  const accessKeyId = String(source.S3_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = source.S3_SECRET_ACCESS_KEY == null ? '' : String(source.S3_SECRET_ACCESS_KEY);
  const region = String(source.S3_REGION || '').trim() || 'us-east-1';
  const endpoint = String(source.S3_ENDPOINT || '').trim();
  const prefixRaw = source.S3_PREFIX == null ? null : String(source.S3_PREFIX);
  const prefix = (prefixRaw == null ? 'launchpad' : prefixRaw).replace(/^\/+|\/+$/g, '');
  const forceRaw = source.S3_FORCE_PATH_STYLE;
  const forcePathStyle = forceRaw == null || String(forceRaw).trim() === ''
    ? Boolean(endpoint)
    : flagOn(forceRaw);
  if (!bucket || !accessKeyId || !secretAccessKey) {
    const error = new Error(
      'S3 storage is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY. FILE_STORAGE_DRIVER stays local until FILE_STORAGE_DRIVER=s3.'
    );
    error.status = 400;
    error.code = 'STORAGE_DRIVER';
    return { error };
  }
  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
    endpoint,
    prefix,
    forcePathStyle,
  };
}

function setTestClient(client) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('S3 test client is only available when NODE_ENV=test');
  }
  testClient = client || null;
}

function createMemoryClient() {
  const objects = new Map();
  let bucketUp = true;
  return {
    objects,
    setBucketUp(value) { bucketUp = Boolean(value); },
    headBucket() { return bucketUp; },
    put(key, body) {
      if (!bucketUp) {
        const error = new Error('bucket unavailable');
        error.code = 'ES3';
        throw error;
      }
      objects.set(key, Buffer.from(body));
    },
    get(key) {
      if (!objects.has(key)) return null;
      return Buffer.from(objects.get(key));
    },
    head(key) {
      if (!objects.has(key)) return null;
      return { size: objects.get(key).length };
    },
    del(key) { objects.delete(key); },
    copy(source, dest) {
      if (!objects.has(source)) {
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      }
      objects.set(dest, Buffer.from(objects.get(source)));
    },
    list(prefix) {
      const keys = [];
      for (const [key, body] of objects) {
        if (!prefix || key.startsWith(prefix)) keys.push({ key, size: body.length });
      }
      return keys;
    },
  };
}

function pathApi(value) {
  const text = String(value || '');
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('//')) return path.win32;
  return path.posix;
}

function resolveRoot(explicit) {
  if (explicit) return explicit;
  const configured = process.env.UPLOAD_DIR && String(process.env.UPLOAD_DIR).trim();
  const raw = configured || path.join('..', 'data', 'uploads');
  return path.resolve(path.join(__dirname, '..'), raw);
}

function notFound(message) {
  const error = new Error(message || 'not found');
  error.code = 'ENOENT';
  return error;
}

function createS3Driver(options) {
  const client = options.client;
  const bucket = options.bucket;
  const prefix = String(options.prefix || '').replace(/^\/+|\/+$/g, '');
  const primaryRoot = resolveRoot(options.root);
  const api = pathApi(primaryRoot);
  let bucketCheckedAt = 0;
  let bucketUp = false;

  function bucketReady() {
    const now = Date.now();
    if (bucketCheckedAt && now - bucketCheckedAt < 10000) return bucketUp;
    try {
      bucketUp = Boolean(client.headBucket());
    } catch (err) {
      bucketUp = false;
    }
    bucketCheckedAt = now;
    return bucketUp;
  }

  function relativeToRoot(fullPath) {
    const normalized = api.normalize(String(fullPath));
    const root = api.normalize(primaryRoot);
    const rel = api.relative(root, normalized);
    if (rel == null || rel.startsWith('..') || api.isAbsolute(rel)) return null;
    return rel;
  }

  function keyFor(fullPath) {
    const rel = relativeToRoot(fullPath);
    const parts = [];
    if (rel) parts.push(...String(rel).split(/[/\\]+/).filter(Boolean));
    else {
      const name = api.basename(api.normalize(String(fullPath)));
      const dir = api.dirname(api.normalize(String(fullPath)));
      const hash = crypto.createHash('sha256').update(String(dir)).digest('hex').slice(0, 16);
      parts.push('roots', hash, name);
    }
    if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
      const error = new Error('invalid storage key');
      error.code = 'EINVAL';
      throw error;
    }
    return [prefix, ...parts].filter(Boolean).join('/');
  }

  function dirPrefix(root) {
    const sample = keyFor(api.join(root, 'placeholder'));
    const slash = sample.lastIndexOf('/');
    return slash === -1 ? '' : sample.slice(0, slash + 1);
  }

  function markerFile(root) {
    return api.join(root, '.launchpad-storage');
  }

  function fileStat(size) {
    return {
      size,
      isFile() { return true; },
      isDirectory() { return false; },
    };
  }

  const driver = {
    id: 's3',
    bucket,
    prefix,
    label: 'S3-compatible object storage',

    locationLabel() {
      return prefix ? `s3://${bucket}/${prefix}` : `s3://${bucket}`;
    },

    status(root, expectedMarkerId) {
      if (!bucketReady()) {
        return { reachable: false, free_bytes: null, error: DOWN };
      }
      if (expectedMarkerId !== undefined) {
        const marker = driver.readMarkerSync(root);
        if (!expectedMarkerId || marker !== expectedMarkerId) {
          return { reachable: false, free_bytes: null, error: DOWN };
        }
      }
      return { reachable: true, free_bytes: null, error: null };
    },

    ensureSync() {
      if (!bucketReady()) {
        const error = new Error(DOWN);
        error.code = 'ES3';
        throw error;
      }
    },

    async checkNewFolder() {
      driver.probeSync(primaryRoot);
    },

    probeSync(root) {
      const probe = api.join(root, `.launchpad-write-test-${crypto.randomBytes(8).toString('hex')}`);
      const payload = Buffer.from(`launchpad ${Date.now()}`);
      const key = keyFor(probe);
      client.put(key, payload);
      const read = client.get(key);
      client.del(key);
      if (!read || !read.equals(payload)) {
        const error = new Error('read-back mismatch');
        error.code = 'EREADBACK';
        throw error;
      }
    },

    readMarkerSync(root) {
      const body = client.get(keyFor(markerFile(root)));
      if (!body || body.length > 256) return null;
      const text = body.toString('utf8').trim();
      if (!/^[a-f0-9]{32}$/.test(text)) return null;
      return text;
    },

    writeMarkerSync(root, id) {
      if (!/^[a-f0-9]{32}$/.test(String(id || ''))) {
        const error = new Error('marker id is invalid');
        error.code = 'EINVAL';
        throw error;
      }
      client.put(keyFor(markerFile(root)), Buffer.from(`${id}\n`));
    },

    hashFileSync(fullPath) {
      const body = client.get(keyFor(fullPath));
      if (!body) throw notFound();
      return crypto.createHash('sha256').update(body).digest('hex');
    },

    statSync(fullPath) {
      const head = client.head(keyFor(fullPath));
      if (!head) throw notFound();
      return fileStat(head.size);
    },

    existsSync(fullPath) {
      return Boolean(client.head(keyFor(fullPath)));
    },

    directoryExistsSync() {
      return bucketReady();
    },

    listNamesSync(root) {
      const prefixKey = dirPrefix(root);
      const names = [];
      for (const item of client.list(prefixKey)) {
        const rest = String(item.key || '').slice(prefixKey.length);
        if (!rest || rest.includes('/')) continue;
        names.push(rest);
      }
      return names;
    },

    writeFileSync(fullPath, data) {
      client.put(keyFor(fullPath), Buffer.from(data));
    },

    copyFileSync(source, dest) {
      client.copy(keyFor(source), keyFor(dest));
    },

    renameSync(source, dest) {
      client.copy(keyFor(source), keyFor(dest));
      client.del(keyFor(source));
    },

    unlinkSync(fullPath) {
      const key = keyFor(fullPath);
      if (!client.head(key)) throw notFound();
      client.del(key);
    },

    createReadStream(fullPath) {
      try {
        const body = client.get(keyFor(fullPath));
        if (!body) {
          const stream = new Readable({ read() {} });
          process.nextTick(() => stream.emit('error', notFound()));
          return stream;
        }
        return Readable.from(body);
      } catch (err) {
        const stream = new Readable({ read() {} });
        process.nextTick(() => stream.emit('error', err));
        return stream;
      }
    },
  };

  return driver;
}

function createS3DriverFromEnv() {
  const config = readConfig(process.env);
  if (config.error) return { driver: null, error: config.error };
  if (testClient) {
    if (process.env.NODE_ENV !== 'test') {
      const error = new Error('S3 test client is only available when NODE_ENV=test');
      error.status = 500;
      error.code = 'STORAGE_DRIVER';
      return { driver: null, error };
    }
    return { driver: createS3Driver({ ...config, client: testClient }), error: null };
  }
  return { driver: createS3Driver({ ...config, client: createRemoteClient(config) }), error: null };
}

module.exports = {
  readConfig,
  setTestClient,
  createMemoryClient,
  createS3Driver,
  createS3DriverFromEnv,
};
