const fs = require('fs');
const { parentPort } = require('worker_threads');

let client = null;
let bucket = '';

function fail(err) {
  const status = err && err.$metadata ? err.$metadata.httpStatusCode : 0;
  const name = err && (err.name || err.Code || err.code) ? (err.name || err.Code || err.code) : '';
  const missing = status === 404 || name === 'NotFound' || name === 'NoSuchKey' || name === 'NotFound';
  const error = new Error(err && err.message ? err.message : 'S3 request failed');
  error.code = missing ? 'ENOENT' : (name || 'ES3');
  throw error;
}

function buildClient(config) {
  const { S3Client } = require('@aws-sdk/client-s3');
  bucket = config.bucket;
  const options = {
    region: config.region || 'us-east-1',
    forcePathStyle: Boolean(config.forcePathStyle),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };
  if (config.endpoint) options.endpoint = config.endpoint;
  client = new S3Client(options);
}

async function bodyBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function encodeCopySource(sourceKey) {
  return `${encodeURIComponent(bucket)}/${String(sourceKey).split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

async function handle(op, payload, body) {
  if (op === 'ping') return { meta: { pong: true } };
  if (!client) {
    const error = new Error('S3 client is not configured');
    error.code = 'ES3';
    throw error;
  }
  const {
    HeadBucketCommand,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    CopyObjectCommand,
    ListObjectsV2Command,
  } = require('@aws-sdk/client-s3');

  if (op === 'headBucket') {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return { meta: { okBucket: true } };
    } catch (err) {
      if (err && err.$metadata && err.$metadata.httpStatusCode === 404) return { meta: { okBucket: false } };
      try {
        await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
        return { meta: { okBucket: true } };
      } catch (listErr) {
        return { meta: { okBucket: false } };
      }
    }
  }

  if (op === 'put') {
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: payload.key, Body: body || Buffer.alloc(0) }));
      return { meta: {} };
    } catch (err) {
      fail(err);
    }
  }

  if (op === 'get') {
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: payload.key }));
      return { meta: {}, body: await bodyBuffer(result.Body) };
    } catch (err) {
      if (err && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)) {
        return { meta: { missing: true } };
      }
      fail(err);
    }
  }

  if (op === 'head') {
    try {
      const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: payload.key }));
      return { meta: { size: Number(result.ContentLength) || 0 } };
    } catch (err) {
      if (err && (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404)) {
        return { meta: { missing: true } };
      }
      fail(err);
    }
  }

  if (op === 'del') {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: payload.key }));
      return { meta: {} };
    } catch (err) {
      fail(err);
    }
  }

  if (op === 'copy') {
    try {
      await client.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: payload.dest,
        CopySource: encodeCopySource(payload.source),
      }));
      return { meta: {} };
    } catch (err) {
      fail(err);
    }
  }

  if (op === 'list') {
    const keys = [];
    let token = undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: payload.prefix || '',
        ContinuationToken: token,
        MaxKeys: 1000,
      }));
      for (const item of result.Contents || []) {
        keys.push({ key: item.Key, size: Number(item.Size) || 0 });
      }
      if (!result.IsTruncated) break;
      token = result.NextContinuationToken;
      if (!token) break;
    }
    return { meta: { keys } };
  }

  const error = new Error(`Unknown S3 operation ${op}`);
  error.code = 'ES3';
  throw error;
}

parentPort.on('message', async (msg) => {
  const slot = new Int32Array(msg.sab);
  try {
    if (msg.config) buildClient(msg.config);
    const metaIn = JSON.parse(fs.readFileSync(msg.metaPath, 'utf8'));
    const body = msg.bodyPath ? fs.readFileSync(msg.bodyPath) : null;
    const result = await handle(metaIn.op, metaIn.payload || {}, body);
    if (result.body) fs.writeFileSync(msg.outPath, result.body);
    fs.writeFileSync(`${msg.outPath}.json`, JSON.stringify({
      ok: true,
      hasBody: Boolean(result.body),
      ...result.meta,
    }));
    Atomics.store(slot, 0, 1);
  } catch (err) {
    try {
      fs.writeFileSync(`${msg.outPath}.json`, JSON.stringify({
        ok: false,
        message: err && err.message ? err.message : 'S3 request failed',
        code: err && err.code ? err.code : 'ES3',
      }));
    } catch (writeErr) { /* the caller times out if the result cannot be written */ }
    Atomics.store(slot, 0, 2);
  }
  Atomics.notify(slot, 0);
});
