const crypto = require('crypto');
const path = require('path');
const { Readable, Transform } = require('stream');

const DOWN = 'File storage is unavailable. The storage folder cannot be reached, so uploads are paused.';
const BUCKET_TTL_MS = 10000;
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

function isByteStream(body) {
  return Boolean(body) && typeof body.pipe === 'function' && !Buffer.isBuffer(body);
}

async function readBody(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Follows every continuation token. A repeated token stops the loop so a
// broken service cannot spin, and there is no page limit.
async function listAllPages(listPage) {
  const keys = [];
  let token;
  const seen = new Set();
  for (;;) {
    const page = await listPage(token);
    for (const item of page && page.keys ? page.keys : []) keys.push(item);
    if (!page || !page.truncated) break;
    const next = page.token ? String(page.token) : '';
    if (!next || seen.has(next)) break;
    seen.add(next);
    token = next;
  }
  return keys;
}

function createMemoryClient() {
  const objects = new Map();
  let bucketUp = true;
  let headBucketCalls = 0;
  let lastPutWasStream = false;
  const client = {
    objects,
    get headBucketCalls() { return headBucketCalls; },
    get lastPutWasStream() { return lastPutWasStream; },
    setBucketUp(value) { bucketUp = Boolean(value); },
    async headBucket() {
      headBucketCalls += 1;
      return bucketUp;
    },
    async put(key, body) {
      return client.putStream(key, body);
    },
    async putStream(key, body) {
      if (!bucketUp) {
        const error = new Error('bucket unavailable');
        error.code = 'ES3';
        throw error;
      }
      lastPutWasStream = isByteStream(body);
      objects.set(key, await readBody(body));
    },
    async get(key) {
      if (!objects.has(key)) return null;
      return Buffer.from(objects.get(key));
    },
    async getStream(key) {
      if (!objects.has(key)) return null;
      return Readable.from(Buffer.from(objects.get(key)));
    },
    async head(key) {
      if (!objects.has(key)) return null;
      return { size: objects.get(key).length };
    },
    async del(key) { objects.delete(key); },
    async copy(source, dest) {
      if (!objects.has(source)) {
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      }
      objects.set(dest, Buffer.from(objects.get(source)));
    },
    async list(prefix) {
      const keys = [];
      for (const [key, body] of objects) {
        if (!prefix || key.startsWith(prefix)) keys.push({ key, size: body.length });
      }
      return keys;
    },
  };
  return client;
}

function missingObject(err) {
  const status = err && err.$metadata ? err.$metadata.httpStatusCode : 0;
  const name = err && (err.name || err.Code || err.code) ? (err.name || err.Code || err.code) : '';
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

function encodeCopySource(bucket, sourceKey) {
  return `${encodeURIComponent(bucket)}/${String(sourceKey).split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

function createAwsClient(config) {
  const {
    S3Client,
    HeadBucketCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    CopyObjectCommand,
    ListObjectsV2Command,
  } = require('@aws-sdk/client-s3');
  const { Upload } = require('@aws-sdk/lib-storage');
  const options = {
    region: config.region || 'us-east-1',
    forcePathStyle: Boolean(config.forcePathStyle),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };
  if (config.endpoint) options.endpoint = config.endpoint;
  const s3 = new S3Client(options);
  const bucket = config.bucket;

  return {
    async headBucket() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        return true;
      } catch (err) {
        if (err && err.$metadata && err.$metadata.httpStatusCode === 404) return false;
        try {
          await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
          return true;
        } catch (listErr) {
          return false;
        }
      }
    },
    async put(key, body) {
      return this.putStream(key, body);
    },
    async putStream(key, body) {
      const upload = new Upload({
        client: s3,
        params: { Bucket: bucket, Key: key, Body: body },
      });
      await upload.done();
    },
    async get(key) {
      try {
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!result.Body) return Buffer.alloc(0);
        if (typeof result.Body.transformToByteArray === 'function') {
          return Buffer.from(await result.Body.transformToByteArray());
        }
        return readBody(result.Body);
      } catch (err) {
        if (missingObject(err)) return null;
        throw err;
      }
    },
    async getStream(key) {
      try {
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!result.Body) return Readable.from([]);
        if (typeof result.Body.pipe === 'function') return result.Body;
        return Readable.from(result.Body);
      } catch (err) {
        if (missingObject(err)) return null;
        throw err;
      }
    },
    async head(key) {
      try {
        const result = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: Number(result.ContentLength) || 0 };
      } catch (err) {
        if (missingObject(err)) return null;
        throw err;
      }
    },
    async del(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async copy(source, dest) {
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: dest,
        CopySource: encodeCopySource(bucket, source),
      }));
    },
    async list(prefix) {
      return listAllPages(async (token) => {
        const result = await s3.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix || '',
          ContinuationToken: token,
          MaxKeys: 1000,
        }));
        return {
          keys: (result.Contents || []).map((item) => ({ key: item.Key, size: Number(item.Size) || 0 })),
          truncated: Boolean(result.IsTruncated),
          token: result.NextContinuationToken || '',
        };
      });
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

  async function bucketReady() {
    const now = Date.now();
    if (bucketCheckedAt && now - bucketCheckedAt < BUCKET_TTL_MS) return bucketUp;
    try {
      bucketUp = Boolean(await client.headBucket());
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
    async: true,
    bucket,
    prefix,
    label: 'S3-compatible object storage',

    locationLabel() {
      return prefix ? `s3://${bucket}/${prefix}` : `s3://${bucket}`;
    },

    async status(root, expectedMarkerId) {
      if (!await bucketReady()) {
        return { reachable: false, free_bytes: null, error: DOWN };
      }
      if (expectedMarkerId !== undefined) {
        const marker = await driver.readMarker(root);
        if (!expectedMarkerId || marker !== expectedMarkerId) {
          return { reachable: false, free_bytes: null, error: DOWN };
        }
      }
      return { reachable: true, free_bytes: null, error: null };
    },

    async ensure() {
      if (!await bucketReady()) {
        const error = new Error(DOWN);
        error.code = 'ES3';
        throw error;
      }
    },

    async checkNewFolder() {
      await driver.probe(primaryRoot);
    },

    async probe(root) {
      const probe = api.join(root, `.launchpad-write-test-${crypto.randomBytes(8).toString('hex')}`);
      const payload = Buffer.from(`launchpad ${Date.now()}`);
      const key = keyFor(probe);
      await client.put(key, payload);
      const read = await client.get(key);
      await client.del(key);
      if (!read || !read.equals(payload)) {
        const error = new Error('read-back mismatch');
        error.code = 'EREADBACK';
        throw error;
      }
    },

    async readMarker(root) {
      const body = await client.get(keyFor(markerFile(root)));
      if (!body || body.length > 256) return null;
      const text = body.toString('utf8').trim();
      if (!/^[a-f0-9]{32}$/.test(text)) return null;
      return text;
    },

    async writeMarker(root, id) {
      if (!/^[a-f0-9]{32}$/.test(String(id || ''))) {
        const error = new Error('marker id is invalid');
        error.code = 'EINVAL';
        throw error;
      }
      await client.put(keyFor(markerFile(root)), Buffer.from(`${id}\n`));
    },

    async hashFile(fullPath) {
      const stream = await client.getStream(keyFor(fullPath));
      if (!stream) throw notFound();
      const hash = crypto.createHash('sha256');
      for await (const chunk of stream) hash.update(chunk);
      return hash.digest('hex');
    },

    async stat(fullPath) {
      const head = await client.head(keyFor(fullPath));
      if (!head) throw notFound();
      return fileStat(head.size);
    },

    async exists(fullPath) {
      return Boolean(await client.head(keyFor(fullPath)));
    },

    async directoryExists() {
      return bucketReady();
    },

    async listNames(root) {
      const prefixKey = dirPrefix(root);
      const names = [];
      for (const item of await client.list(prefixKey)) {
        const rest = String(item.key || '').slice(prefixKey.length);
        if (!rest || rest.includes('/')) continue;
        names.push(rest);
      }
      return names;
    },

    async writeFile(fullPath, data) {
      const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
      await client.put(keyFor(fullPath), body);
    },

    async uploadStream(fullPath, stream) {
      let size = 0;
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          callback(null, chunk);
        },
      });
      stream.on('error', (err) => counter.destroy(err));
      stream.pipe(counter);
      await client.putStream(keyFor(fullPath), counter);
      return { size };
    },

    async copyFile(source, dest) {
      await client.copy(keyFor(source), keyFor(dest));
    },

    async rename(source, dest) {
      await client.copy(keyFor(source), keyFor(dest));
      await client.del(keyFor(source));
    },

    async unlink(fullPath) {
      const key = keyFor(fullPath);
      if (!await client.head(key)) throw notFound();
      await client.del(key);
    },

    async createReadStream(fullPath) {
      try {
        const body = await client.getStream(keyFor(fullPath));
        if (!body) {
          const stream = new Readable({ read() {} });
          process.nextTick(() => stream.emit('error', notFound()));
          return stream;
        }
        return body;
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
  return { driver: createS3Driver({ ...config, client: createAwsClient(config) }), error: null };
}

module.exports = {
  readConfig,
  setTestClient,
  createMemoryClient,
  createS3Driver,
  createS3DriverFromEnv,
  listAllPages,
};
