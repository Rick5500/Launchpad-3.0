const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { httpError } = require('./httpError');
const { getStorageDriver } = require('./storage/localFolder');

const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff', 'webp', 'bmp', 'dwg', 'zip', 'plt',
]);

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
  bmp: 'image/bmp',
  dwg: 'application/octet-stream',
  zip: 'application/zip',
  plt: 'application/octet-stream',
};

const STORAGE_DOWN_MESSAGE = 'File storage is unavailable. The storage folder cannot be reached, so uploads are paused.';
const ABSOLUTE_PATH_MESSAGE = 'Storage folder must be an absolute path. Relative paths are not allowed. Use a full local path, a mapped drive such as Z:\\launchpad, or a network share such as \\\\server\\share\\launchpad.';
const CODE_FOLDER_MESSAGE = 'Storage folder cannot be inside the application code folders (backend or frontend).';
const NOT_WRITABLE_MESSAGE = 'Storage folder is not reachable or is not writable. Launchpad must be able to write, read, and delete a test file there.';

let configuredRoot = null;

function storageDown(cause) {
  const error = httpError(503, STORAGE_DOWN_MESSAGE);
  error.code = 'STORAGE_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

function activeDriver() {
  const found = getStorageDriver();
  if (found.error) throw storageDown(found.error);
  return found.driver;
}

function isWinStyle(value) {
  const text = String(value || '');
  return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('//');
}

function pathApi(root) {
  return isWinStyle(root) ? path.win32 : path.posix;
}

function stripTrailing(value, style) {
  if (style === 'win32') {
    if (/^[A-Za-z]:\\$/.test(value)) return value;
    return value.replace(/\\+$/, '');
  }
  if (value === '/') return value;
  return value.replace(/\/+$/, '');
}

function codeRoots() {
  return [
    path.resolve(__dirname),
    path.resolve(__dirname, '..', 'frontend'),
  ];
}

function insideDirectory(root, candidate) {
  const api = isWinStyle(candidate) ? path.win32 : path.posix;
  if (isWinStyle(candidate) !== isWinStyle(root)) return false;
  const from = stripTrailing(api.normalize(root), isWinStyle(root) ? 'win32' : 'posix');
  const to = stripTrailing(api.normalize(candidate), isWinStyle(candidate) ? 'win32' : 'posix');
  const rel = api.relative(from, to);
  if (rel === '') return true;
  if (!rel || rel.startsWith('..') || api.isAbsolute(rel)) return false;
  return true;
}

function insideCode(candidate) {
  return codeRoots().some((root) => insideDirectory(root, candidate));
}

function resolvesInsideCode(candidate) {
  if (isWinStyle(candidate) && process.platform !== 'win32') return false;
  const api = pathApi(candidate);
  let current = candidate;
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const real = fs.realpathSync(current);
      const suffix = api.relative(current, candidate);
      const resolved = suffix ? api.resolve(real, suffix) : real;
      return insideCode(resolved);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return false;
      const parent = api.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
  return false;
}

function parseStoragePath(input) {
  if (input == null) return { error: 'Storage folder is required' };
  if (typeof input !== 'string') return { error: ABSOLUTE_PATH_MESSAGE };
  const text = input.trim();
  if (!text) return { error: 'Storage folder is required' };
  if (text.length > 1024) return { error: 'Storage folder is too long' };
  if (/[\0\r\n]/.test(text)) return { error: 'Storage folder contains invalid characters' };

  if (text.startsWith('\\\\') || text.startsWith('//')) {
    const parts = text.replace(/^[/\\]+/, '').split(/[/\\]+/).filter(Boolean);
    if (parts.length < 2) {
      return { error: 'A network share must include the server and the share, for example \\\\server\\share\\launchpad.' };
    }
    const normalized = stripTrailing(path.win32.normalize(`\\\\${parts.join('\\')}`), 'win32');
    if (!normalized.startsWith('\\\\')) return { error: ABSOLUTE_PATH_MESSAGE };
    return { path: normalized, style: 'win32' };
  }

  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(text);
  if (drive) {
    const normalized = stripTrailing(
      path.win32.normalize(`${drive[1].toUpperCase()}:\\${drive[2]}`),
      'win32'
    );
    if (!/^[A-Za-z]:\\/.test(normalized)) return { error: ABSOLUTE_PATH_MESSAGE };
    if (/^[A-Za-z]:\\$/.test(normalized)) {
      return { error: 'Storage folder must name a folder, not the root of a drive.' };
    }
    return { path: normalized, style: 'win32' };
  }

  if (text.startsWith('/')) {
    const normalized = stripTrailing(path.posix.normalize(text), 'posix');
    if (!normalized.startsWith('/')) return { error: ABSOLUTE_PATH_MESSAGE };
    if (normalized === '/') return { error: 'Storage folder must name a folder, not the root of a drive.' };
    return { path: normalized, style: 'posix' };
  }

  return { error: ABSOLUTE_PATH_MESSAGE };
}

function canonicalRoot(value) {
  const parsed = parseStoragePath(value);
  if (parsed.error) return null;
  return parsed.path;
}

function legacyRoot() {
  const configured = process.env.UPLOAD_DIR && String(process.env.UPLOAD_DIR).trim();
  const raw = configured || path.join('..', 'data', 'uploads');
  return path.resolve(__dirname, raw);
}

function defaultRoot() {
  return path.resolve(__dirname, path.join('..', 'data', 'uploads'));
}

function environmentRoot() {
  const configured = process.env.UPLOAD_DIR && String(process.env.UPLOAD_DIR).trim();
  if (!configured) return null;
  return path.resolve(__dirname, configured);
}

function uploadDir() {
  if (configuredRoot) return configuredRoot;
  return legacyRoot();
}

function setConfiguredRoot(value) {
  if (value == null || String(value).trim() === '') {
    configuredRoot = null;
    return;
  }
  const canonical = canonicalRoot(String(value).trim());
  if (!canonical || insideCode(canonical)) {
    console.error('FILE STORAGE SETTING ERROR: stored folder is not an absolute path outside the application code');
    configuredRoot = null;
    return;
  }
  configuredRoot = canonical;
}

function rootsEqual(left, right) {
  const a = canonicalRoot(left);
  const b = canonicalRoot(right);
  if (!a || !b) return false;
  if (isWinStyle(a) || isWinStyle(b)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function rootForStored(storageRoot) {
  if (storageRoot === undefined) return uploadDir();
  if (storageRoot == null || String(storageRoot).trim() === '') return legacyRoot();
  return canonicalRoot(String(storageRoot).trim());
}

function extensionOf(filename) {
  const base = path.basename(String(filename || ''));
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  if (!match) return '';
  return match[1].toLowerCase();
}

function safeStoredPath(storedName, storageRoot) {
  const root = rootForStored(storageRoot);
  if (!root) return null;
  const api = pathApi(root);
  const name = api.basename(String(storedName || ''));
  if (!/^[a-f0-9]{32}\.[a-z0-9]{1,8}$/.test(name)) return null;
  if (name !== String(storedName || '')) return null;
  if (!ALLOWED_EXTENSIONS.has(extensionOf(name))) return null;
  const full = api.join(root, name);
  const relative = api.relative(root, full);
  if (!relative || relative.startsWith('..') || api.isAbsolute(relative)) return null;
  if (api.basename(full) !== name) return null;
  return full;
}

function maxUploadMb() {
  const parsed = Number(process.env.MAX_UPLOAD_MB);
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return parsed;
}

function maxUploadBytes() {
  return Math.max(1, Math.round(maxUploadMb() * 1024 * 1024));
}

function maxFilesPerRequest() {
  const parsed = Number(process.env.MAX_UPLOAD_FILES);
  if (!Number.isInteger(parsed) || parsed < 1) return 20;
  return Math.min(parsed, 50);
}

function sanitizeOriginalName(filename) {
  const base = path.basename(String(filename || 'file')).replace(/\0/g, '');
  const cleaned = base
    .replace(/[^\w.\- ()]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/_+/g, '_')
    .slice(0, 180);
  return cleaned || 'file';
}

function contentTypeFor(storedName) {
  return CONTENT_TYPES[extensionOf(storedName)] || 'application/octet-stream';
}

function ensureUploadDir() {
  const root = uploadDir();
  try {
    const driver = activeDriver();
    driver.ensureSync(root);
    const status = driver.status(root);
    if (!status.reachable) return { ok: false, path: root, error: status.error || STORAGE_DOWN_MESSAGE };
    return { ok: true, path: root };
  } catch (err) {
    if (err && err.status === 503) return { ok: false, path: root, error: err.publicMessage || err.message };
    return { ok: false, path: root, error: STORAGE_DOWN_MESSAGE };
  }
}

function storageRootOfUpload(file) {
  const full = file && file.path ? path.resolve(String(file.path)) : '';
  if (full) {
    const dir = path.dirname(full);
    if (dir && dir !== '.') return dir;
  }
  return uploadDir();
}

function openStored(storedName, storageRoot) {
  const full = safeStoredPath(storedName, storageRoot);
  if (!full) return null;
  try {
    const stat = activeDriver().statSync(full);
    if (!stat || !stat.isFile()) return null;
    return { fullPath: full, size: stat.size };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw storageDown(err);
  }
}

function createStoredReadStream(fullPath) {
  return activeDriver().createReadStream(fullPath);
}

function removeStored(storedName, storageRoot) {
  const full = safeStoredPath(storedName, storageRoot);
  if (!full) return 'invalid';
  try {
    activeDriver().unlinkSync(full);
    return 'removed';
  } catch (err) {
    if (err.code === 'ENOENT') return 'missing';
    console.error('FILE CLEANUP ERROR:', err.message);
    return 'unavailable';
  }
}

function removeUploaded(files) {
  for (const file of files || []) {
    if (!file || !file.path) continue;
    try {
      fs.unlinkSync(file.path);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('FILE CLEANUP ERROR:', err.message);
    }
  }
}

function writeNewFile(ext, buffer) {
  if (!ALLOWED_EXTENSIONS.has(ext)) throw httpError(400, 'This file type is not allowed');
  const ready = ensureUploadDir();
  if (!ready.ok) throw storageDown();
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  const full = safeStoredPath(storedName, ready.path);
  if (!full) throw httpError(400, 'This file type is not allowed');
  try {
    activeDriver().writeFileSync(full, buffer);
  } catch (err) {
    throw storageDown(err);
  }
  return { storedName, storageRoot: ready.path, size: buffer.length };
}

function copyToCurrentRoot(storedName, storageRoot) {
  const source = safeStoredPath(storedName, storageRoot);
  if (!source) return null;
  const ext = extensionOf(storedName);
  if (!ALLOWED_EXTENSIONS.has(ext)) return null;
  let sourceStat;
  try {
    sourceStat = activeDriver().statSync(source);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw storageDown(err);
  }
  if (!sourceStat.isFile()) return null;
  const ready = ensureUploadDir();
  if (!ready.ok) throw storageDown();
  const stored = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  const dest = safeStoredPath(stored, ready.path);
  if (!dest) return null;
  try {
    activeDriver().copyFileSync(source, dest);
    const copied = activeDriver().statSync(dest);
    if (!copied.isFile() || copied.size !== sourceStat.size) {
      try { activeDriver().unlinkSync(dest); } catch (cleanupErr) { /* leave the failed copy out of the record */ }
      return null;
    }
    return { storedName: stored, storageRoot: ready.path, size: copied.size };
  } catch (err) {
    try { activeDriver().unlinkSync(dest); } catch (cleanupErr) { /* copy never finished */ }
    throw storageDown(err);
  }
}

function inspectStored(fullPath, recordSize) {
  try {
    const stat = activeDriver().statSync(fullPath);
    if (!stat || !stat.isFile()) return { ok: false, missing: true };
    if (recordSize != null && Number.isFinite(recordSize) && stat.size !== recordSize) {
      return { ok: false, mismatch: true, size: stat.size };
    }
    return { ok: true, size: stat.size };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, unavailable: true };
  }
}

function copyVerified(sourcePath, targetPath, expectedSize) {
  const api = pathApi(targetPath);
  const tmp = api.join(api.dirname(targetPath), `.${api.basename(targetPath)}.moving-${crypto.randomBytes(6).toString('hex')}`);
  const driver = activeDriver();
  try {
    driver.copyFileSync(sourcePath, tmp);
    const copied = driver.statSync(tmp);
    const source = driver.statSync(sourcePath);
    if (!copied.isFile() || copied.size !== source.size || (expectedSize != null && copied.size !== expectedSize)) {
      const error = new Error('size mismatch');
      error.code = 'ESIZE';
      throw error;
    }
    driver.renameSync(tmp, targetPath);
    const finalStat = driver.statSync(targetPath);
    if (!finalStat.isFile() || finalStat.size !== source.size) {
      const error = new Error('size mismatch');
      error.code = 'ESIZE';
      throw error;
    }
    return finalStat.size;
  } catch (err) {
    try { driver.unlinkSync(tmp); } catch (cleanupErr) { /* temp copy is removed when it is still there */ }
    throw err;
  }
}

async function validateStoragePath(input) {
  const parsed = parseStoragePath(input);
  if (parsed.error) return parsed;
  if (insideCode(parsed.path) || resolvesInsideCode(parsed.path)) {
    return { error: CODE_FOLDER_MESSAGE };
  }
  const found = getStorageDriver();
  if (found.error) return { error: found.error.message };
  try {
    found.driver.ensureSync(parsed.path);
    if (resolvesInsideCode(parsed.path)) return { error: CODE_FOLDER_MESSAGE };
    found.driver.probeSync(parsed.path);
    const status = found.driver.status(parsed.path);
    if (!status.reachable) return { error: status.error || NOT_WRITABLE_MESSAGE };
  } catch (err) {
    if (err && (err.code === 'ENOTDIR' || err.code === 'EEXIST')) {
      return { error: 'Storage folder is not a directory.' };
    }
    return { error: NOT_WRITABLE_MESSAGE };
  }
  return { path: parsed.path, style: parsed.style };
}

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : (value >= 10 ? 1 : 2);
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function describeStorage() {
  const found = getStorageDriver();
  const root = uploadDir();
  const source = configuredRoot
    ? 'settings'
    : (environmentRoot() ? 'environment' : 'default');
  if (found.error) {
    return {
      driver: null,
      driver_label: null,
      path: root,
      free_bytes: null,
      free_label: null,
      reachable: false,
      warning: found.error.message,
      source,
      environment_path: environmentRoot(),
      default_path: defaultRoot(),
    };
  }
  let status;
  try {
    status = found.driver.status(root);
  } catch (err) {
    status = { reachable: false, free_bytes: null, error: STORAGE_DOWN_MESSAGE };
  }
  return {
    driver: found.driver.id,
    driver_label: found.driver.label,
    path: root,
    free_bytes: status.reachable ? status.free_bytes : null,
    free_label: status.reachable ? formatBytes(status.free_bytes) : null,
    reachable: Boolean(status.reachable),
    warning: status.reachable ? null : (status.error || STORAGE_DOWN_MESSAGE),
    source,
    environment_path: environmentRoot(),
    default_path: defaultRoot(),
  };
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const ready = ensureUploadDir();
    if (!ready.ok) {
      const error = new Error(ready.error || STORAGE_DOWN_MESSAGE);
      error.status = 503;
      error.code = 'STORAGE_UNAVAILABLE';
      return cb(error);
    }
    return cb(null, ready.path);
  },
  filename(req, file, cb) {
    const ext = extensionOf(file.originalname);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error('Allowed file types are pdf, images, dwg, zip, and plt'));
    }
    cb(null, `${crypto.randomBytes(16).toString('hex')}.${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const ext = extensionOf(file.originalname);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error('Allowed file types are pdf, images, dwg, zip, and plt'));
  }
  const mime = String(file.mimetype || '').toLowerCase();
  if (/text\/html|application\/(javascript|x-msdownload|x-httpd-php|x-sh|xhtml)/.test(mime)) {
    return cb(new Error('This file type is not allowed'));
  }
  cb(null, true);
}

function uploadMiddleware() {
  const limit = maxFilesPerRequest();
  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: maxUploadBytes(),
      files: limit,
    },
  }).array('files', limit);
}

function uploadErrorStatus(err) {
  if (err && (err.status === 503 || err.code === 'STORAGE_UNAVAILABLE')) return 503;
  if (err && err.code === 'LIMIT_FILE_SIZE') return 413;
  return 400;
}

function uploadErrorMessage(err) {
  if (!err) return null;
  if (err.status === 503 || err.code === 'STORAGE_UNAVAILABLE') {
    return err.publicMessage || err.message || STORAGE_DOWN_MESSAGE;
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return `File exceeds the ${maxUploadMb()} MB limit`;
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return `You can upload up to ${maxFilesPerRequest()} files at a time`;
  }
  return err.message || 'Upload failed';
}

module.exports = {
  ALLOWED_EXTENSIONS,
  STORAGE_DOWN_MESSAGE,
  ABSOLUTE_PATH_MESSAGE,
  CODE_FOLDER_MESSAGE,
  NOT_WRITABLE_MESSAGE,
  uploadDir,
  legacyRoot,
  defaultRoot,
  environmentRoot,
  rootsEqual,
  setConfiguredRoot,
  parseStoragePath,
  validateStoragePath,
  describeStorage,
  maxUploadMb,
  maxUploadBytes,
  maxFilesPerRequest,
  extensionOf,
  sanitizeOriginalName,
  safeStoredPath,
  contentTypeFor,
  ensureUploadDir,
  storageRootOfUpload,
  openStored,
  createStoredReadStream,
  removeStored,
  removeUploaded,
  writeNewFile,
  copyToCurrentRoot,
  inspectStored,
  copyVerified,
  uploadMiddleware,
  uploadErrorStatus,
  uploadErrorMessage,
  getStorageDriver,
  formatBytes,
};
