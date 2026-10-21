const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { httpError } = require('./httpError');
const { MARKER_FILE, getStorageDriver } = require('./storage/localFolder');

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
const NOT_WRITABLE_MESSAGE = 'Storage folder is not reachable or is not writable. Ignition must be able to write, read, and delete a test file there.';
const VIRTUAL_PATH_MESSAGE = 'Storage folder cannot be inside /proc, /sys, or /dev.';
const DEVICE_PATH_MESSAGE = 'Storage folder cannot use a Windows device path (\\\\?\\ or \\\\.\\).';
const ADMIN_SHARE_MESSAGE = 'Storage folder cannot be a Windows admin share such as \\\\server\\C$.';
const WINDOWS_DIR_MESSAGE = 'Storage folder cannot be inside the Windows directory.';
const PARENT_MISSING_MESSAGE = 'The parent folder does not exist, so the storage folder was not created.';
const TMP_CAUTION = 'This folder is under /tmp and can disappear when the computer restarts.';
const REPO_CAUTION = 'This folder is inside the Ignition project. Prefer a folder outside the repository.';

let configuredRoot = null;
let markerByRoot = new Map();
let knownRootKeys = new Set();

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

function isVirtualPosix(value) {
  const normalized = stripTrailing(path.posix.normalize(String(value || '')), 'posix');
  if (!normalized.startsWith('/')) return false;
  return ['/proc', '/sys', '/dev'].some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function isWindowsDirectory(value) {
  return /^[A-Za-z]:\\windows(?:\\|$)/i.test(String(value || ''));
}

function isDevicePath(value) {
  return /^[/\\]{2}\?[\\/]/.test(value) || /^[/\\]{2}\.[\\/]/.test(value);
}

function isAdminShare(share) {
  return /^[A-Za-z]\$$/i.test(String(share || ''));
}

function resolvesInsideCode(candidate) {
  return resolvesInside(candidate, insideCode);
}

function resolvesInsideVirtual(candidate) {
  if (isWinStyle(candidate) && process.platform !== 'win32') return false;
  return resolvesInside(candidate, isVirtualPosix);
}

function resolvesInside(candidate, matches) {
  if (isWinStyle(candidate) && process.platform !== 'win32') return false;
  const api = pathApi(candidate);
  let current = candidate;
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const real = fs.realpathSync(current);
      const suffix = api.relative(current, candidate);
      const resolved = suffix ? api.resolve(real, suffix) : real;
      return matches(resolved);
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
  if (isDevicePath(text)) return { error: DEVICE_PATH_MESSAGE };

  if (text.startsWith('\\\\') || text.startsWith('//')) {
    const parts = text.replace(/^[/\\]+/, '').split(/[/\\]+/).filter(Boolean);
    if (parts.length < 2) {
      return { error: 'A network share must include the server and the share, for example \\\\server\\share\\launchpad.' };
    }
    if (isAdminShare(parts[1])) return { error: ADMIN_SHARE_MESSAGE };
    const normalized = stripTrailing(path.win32.normalize(`\\\\${parts.join('\\')}`), 'win32');
    if (!normalized.startsWith('\\\\')) return { error: ABSOLUTE_PATH_MESSAGE };
    if (isDevicePath(normalized)) return { error: DEVICE_PATH_MESSAGE };
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
    if (isWindowsDirectory(normalized)) return { error: WINDOWS_DIR_MESSAGE };
    return { path: normalized, style: 'win32' };
  }

  if (text.startsWith('/')) {
    const normalized = stripTrailing(path.posix.normalize(text), 'posix');
    if (!normalized.startsWith('/')) return { error: ABSOLUTE_PATH_MESSAGE };
    if (normalized === '/') return { error: 'Storage folder must name a folder, not the root of a drive.' };
    if (isVirtualPosix(normalized)) return { error: VIRTUAL_PATH_MESSAGE };
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

function markerKey(root) {
  const canonical = canonicalRoot(root) || String(root || '');
  if (isWinStyle(canonical)) return canonical.toLowerCase();
  return canonical;
}

function setMarkerMap(map) {
  markerByRoot = new Map();
  if (!map || typeof map !== 'object') return;
  for (const [rawPath, id] of Object.entries(map)) {
    const canonical = canonicalRoot(rawPath);
    if (!canonical || typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) continue;
    markerByRoot.set(markerKey(canonical), id);
  }
}

function rememberMarker(root, id) {
  const canonical = canonicalRoot(root);
  if (!canonical || !/^[a-f0-9]{32}$/.test(String(id || ''))) return null;
  markerByRoot.set(markerKey(canonical), id);
  return canonical;
}

function markerIdFor(root) {
  if (!root) return null;
  return markerByRoot.get(markerKey(root)) || null;
}

function setKnownRoots(paths) {
  knownRootKeys = new Set();
  for (const raw of paths || []) rememberKnownRoot(raw);
}

function rememberKnownRoot(root) {
  const canonical = canonicalRoot(root);
  if (!canonical) return null;
  knownRootKeys.add(markerKey(canonical));
  return canonical;
}

function isKnownRoot(root) {
  const canonical = canonicalRoot(root);
  if (!canonical) return false;
  if (rootsEqual(canonical, uploadDir())) return true;
  if (rootsEqual(canonical, legacyRoot())) return true;
  if (rootsEqual(canonical, defaultRoot())) return true;
  const env = environmentRoot();
  if (env && rootsEqual(canonical, env)) return true;
  return knownRootKeys.has(markerKey(canonical));
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
  const canonical = canonicalRoot(String(storageRoot).trim());
  if (!canonical || !isKnownRoot(canonical)) return null;
  return canonical;
}

function directoryHoldsFiles(root) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    return false;
  }
  return names.some((name) => {
    if (!name || name === MARKER_FILE || name.startsWith('.')) return false;
    try {
      return fs.statSync(pathApi(root).join(root, name)).isFile();
    } catch (err) {
      return false;
    }
  });
}

function canPlantOriginalMarker(root) {
  const isDefault = rootsEqual(root, defaultRoot());
  const env = environmentRoot();
  const isEnv = Boolean(env && rootsEqual(root, env));
  if (!isDefault && !isEnv) return false;
  let stat;
  try {
    stat = fs.statSync(root);
  } catch (err) {
    return false;
  }
  if (!stat.isDirectory()) return false;
  // The directory is already there. UPLOAD_DIR is marked even when it is
  // empty, because that folder is the one this process was given. A missing
  // UPLOAD_DIR is not created here. The shipped default is created separately,
  // once, before this runs.
  if (isDefault) return true;
  if (directoryHoldsFiles(root)) return true;
  return isEnv;
}

function createDefaultFolderOnce() {
  // A saved folder is never created here. A custom UPLOAD_DIR is never
  // created here. The example env file sets UPLOAD_DIR to the shipped
  // default, and that path is the default.
  if (configuredRoot) return false;
  const env = environmentRoot();
  if (env && !rootsEqual(env, defaultRoot())) return false;
  const root = defaultRoot();
  if (!rootsEqual(uploadDir(), root)) return false;
  if (markerIdFor(root)) return false;
  try {
    const stat = fs.statSync(root);
    if (stat.isDirectory()) return false;
    return false;
  } catch (err) {
    if (err.code !== 'ENOENT') return false;
  }
  try {
    const parent = path.dirname(root);
    if (!parent || parent === root) return false;
    // A fresh clone has no data/ directory. Only this fixed default may
    // create that parent. ensureSync still refuses to create a missing parent.
    fs.mkdirSync(parent, { recursive: true });
    activeDriver().ensureSync(root);
    return true;
  } catch (err) {
    return false;
  }
}

function plantOriginalMarker() {
  const root = uploadDir();
  if (markerIdFor(root)) {
    rememberKnownRoot(root);
    return null;
  }
  if (!canPlantOriginalMarker(root)) return null;
  const id = crypto.randomBytes(16).toString('hex');
  try {
    activeDriver().writeMarkerSync(root, id);
  } catch (err) {
    return null;
  }
  rememberMarker(root, id);
  rememberKnownRoot(root);
  return { path: root, markerId: id };
}

function writeStorageMarker(root, id) {
  activeDriver().writeMarkerSync(root, id);
  rememberMarker(root, id);
  rememberKnownRoot(root);
}

function pathCaution(candidate) {
  const notes = [];
  if (candidate && !isWinStyle(candidate)) {
    const normalized = stripTrailing(path.posix.normalize(candidate), 'posix');
    const tmpRoots = new Set(['/tmp']);
    const osTmp = os.tmpdir();
    if (osTmp && osTmp.startsWith('/')) {
      tmpRoots.add(stripTrailing(path.posix.normalize(osTmp), 'posix'));
    }
    const underTmp = [...tmpRoots].some((root) => normalized === root || normalized.startsWith(`${root}/`));
    if (underTmp) notes.push(TMP_CAUTION);
  }
  const repo = path.resolve(__dirname, '..');
  const shippedDefault = candidate && rootsEqual(candidate, defaultRoot());
  if (!shippedDefault && candidate && (insideDirectory(repo, candidate) || resolvesInside(candidate, (resolved) => insideDirectory(repo, resolved)))) {
    notes.push(REPO_CAUTION);
  }
  return notes.length ? notes.join(' ') : null;
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

function storageStatus(root) {
  // First use of the implicit folder plants its marker in this process.
  // A folder that already has an id is never given a new one.
  if (root && rootsEqual(root, uploadDir()) && !markerIdFor(root)) plantOriginalMarker();
  const id = markerIdFor(root);
  const requireMarker = Boolean(id) || rootsEqual(root, uploadDir());
  try {
    return activeDriver().status(root, requireMarker ? (id || '') : undefined);
  } catch (err) {
    return { reachable: false, free_bytes: null, error: STORAGE_DOWN_MESSAGE };
  }
}

function ensureUploadDir() {
  const root = uploadDir();
  try {
    const status = storageStatus(root);
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

function directoryExists(root) {
  try {
    return fs.statSync(root).isDirectory();
  } catch (err) {
    return false;
  }
}

function openStored(storedName, storageRoot) {
  const root = rootForStored(storageRoot);
  if (!root) return null;
  const full = safeStoredPath(storedName, storageRoot);
  if (!full) return null;
  const status = storageStatus(root);
  if (!status.reachable || !directoryExists(root)) throw storageDown();
  try {
    const stat = activeDriver().statSync(full);
    if (!stat || !stat.isFile()) return null;
    return { fullPath: full, size: stat.size };
  } catch (err) {
    // A missing file inside a folder we can still use is not found.
    // A missing folder, or a path that is no longer a directory, is storage down.
    if ((err.code === 'ENOENT' || err.code === 'ENOTDIR') && directoryExists(root)) return null;
    throw storageDown(err);
  }
}

function finishStoredDownload(res, err, root) {
  if (!err || err.code === 'ECONNABORTED') return;
  if (res.headersSent) return;
  const missing = err.status === 404 || err.statusCode === 404 || err.code === 'ENOENT' || err.code === 'ENOTDIR';
  if (missing) {
    if (!root || !directoryExists(root)) {
      return res.status(503).json({ error: STORAGE_DOWN_MESSAGE });
    }
    return res.status(404).json({ error: 'File not found' });
  }
  console.error('DOWNLOAD ERROR:', err);
  return res.status(500).json({ error: 'Failed to download file' });
}

function createStoredReadStream(fullPath) {
  return activeDriver().createReadStream(fullPath);
}

function removeStored(storedName, storageRoot) {
  const root = rootForStored(storageRoot);
  if (!root) return 'invalid';
  const full = safeStoredPath(storedName, storageRoot);
  if (!full) return 'invalid';
  const status = storageStatus(root);
  if (!status.reachable) return 'unavailable';
  try {
    activeDriver().unlinkSync(full);
    return 'removed';
  } catch (err) {
    if (err.code === 'ENOENT') return 'missing';
    console.error('FILE CLEANUP ERROR:', err.message);
    return 'unavailable';
  }
}

function removeMovingTemps(root) {
  if (!root) return;
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    return;
  }
  const api = pathApi(root);
  for (const name of names) {
    if (!/^\..+\.moving-[a-f0-9]+$/i.test(name)) continue;
    try {
      activeDriver().unlinkSync(api.join(root, name));
    } catch (err) {
      if (!err || err.code !== 'ENOENT') console.error('FILE STORAGE MOVE CLEANUP ERROR:', err && err.message ? err.message : err);
    }
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
  const sourceRoot = rootForStored(storageRoot);
  if (!sourceRoot) return null;
  const sourceStatus = storageStatus(sourceRoot);
  if (!sourceStatus.reachable) throw storageDown();
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
    if (activeDriver().hashFileSync(source) !== activeDriver().hashFileSync(dest)) {
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
  const root = pathApi(fullPath).dirname(fullPath);
  const status = storageStatus(root);
  if (!status.reachable) return { ok: false, unavailable: true };
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

function filesMatch(sourcePath, targetPath) {
  const driver = activeDriver();
  const source = driver.statSync(sourcePath);
  const target = driver.statSync(targetPath);
  if (!source.isFile() || !target.isFile() || source.size !== target.size) return false;
  return driver.hashFileSync(sourcePath) === driver.hashFileSync(targetPath);
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
    if (driver.hashFileSync(sourcePath) !== driver.hashFileSync(tmp)) {
      const error = new Error('checksum mismatch');
      error.code = 'ECHECKSUM';
      throw error;
    }
    driver.renameSync(tmp, targetPath);
    const finalStat = driver.statSync(targetPath);
    if (!finalStat.isFile() || finalStat.size !== source.size) {
      const error = new Error('size mismatch');
      error.code = 'ESIZE';
      throw error;
    }
    if (driver.hashFileSync(sourcePath) !== driver.hashFileSync(targetPath)) {
      const error = new Error('checksum mismatch');
      error.code = 'ECHECKSUM';
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
  if (insideCode(parsed.path) || resolvesInsideCode(parsed.path)) return { error: CODE_FOLDER_MESSAGE };
  if (resolvesInsideVirtual(parsed.path)) return { error: VIRTUAL_PATH_MESSAGE };
  const found = getStorageDriver();
  if (found.error) return { error: found.error.message };
  try {
    await found.driver.checkNewFolder(parsed.path);
    if (resolvesInsideCode(parsed.path)) return { error: CODE_FOLDER_MESSAGE };
    if (resolvesInsideVirtual(parsed.path)) return { error: VIRTUAL_PATH_MESSAGE };
    const status = found.driver.status(parsed.path);
    if (!status.reachable) return { error: status.error || NOT_WRITABLE_MESSAGE };
  } catch (err) {
    if (err && err.code === 'ETIMEDOUT') {
      return { error: 'Storage folder check timed out. The folder could not be confirmed as writable.' };
    }
    if (err && (err.code === 'ENOTDIR' || err.code === 'EEXIST')) {
      return { error: 'Storage folder is not a directory.' };
    }
    if (err && err.reason === 'parent') return { error: PARENT_MISSING_MESSAGE };
    return { error: NOT_WRITABLE_MESSAGE };
  }
  return { path: parsed.path, style: parsed.style, caution: pathCaution(parsed.path) };
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
  const caution = pathCaution(root);
  if (found.error) {
    return {
      driver: null,
      driver_label: null,
      path: root,
      free_bytes: null,
      free_label: null,
      reachable: false,
      warning: found.error.message,
      caution,
      source,
      environment_path: environmentRoot(),
      default_path: defaultRoot(),
    };
  }
  const status = storageStatus(root);
  return {
    driver: found.driver.id,
    driver_label: found.driver.label,
    path: root,
    free_bytes: status.reachable ? status.free_bytes : null,
    free_label: status.reachable ? formatBytes(status.free_bytes) : null,
    reachable: Boolean(status.reachable),
    warning: status.reachable ? null : (status.error || STORAGE_DOWN_MESSAGE),
    caution,
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
  MARKER_FILE,
  STORAGE_DOWN_MESSAGE,
  ABSOLUTE_PATH_MESSAGE,
  CODE_FOLDER_MESSAGE,
  NOT_WRITABLE_MESSAGE,
  VIRTUAL_PATH_MESSAGE,
  DEVICE_PATH_MESSAGE,
  ADMIN_SHARE_MESSAGE,
  WINDOWS_DIR_MESSAGE,
  PARENT_MISSING_MESSAGE,
  uploadDir,
  legacyRoot,
  defaultRoot,
  environmentRoot,
  rootsEqual,
  setConfiguredRoot,
  setMarkerMap,
  setKnownRoots,
  rememberMarker,
  rememberKnownRoot,
  markerIdFor,
  plantOriginalMarker,
  createDefaultFolderOnce,
  writeStorageMarker,
  removeMovingTemps,
  isKnownRoot,
  parseStoragePath,
  validateStoragePath,
  describeStorage,
  pathCaution,
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
  finishStoredDownload,
  createStoredReadStream,
  removeStored,
  removeUploaded,
  writeNewFile,
  copyToCurrentRoot,
  inspectStored,
  filesMatch,
  copyVerified,
  rootForStored,
  uploadMiddleware,
  uploadErrorStatus,
  uploadErrorMessage,
  getStorageDriver,
  formatBytes,
};
