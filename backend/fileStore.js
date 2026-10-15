const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

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

function uploadDir() {
  const configured = process.env.UPLOAD_DIR && String(process.env.UPLOAD_DIR).trim();
  const raw = configured || path.join('..', 'data', 'uploads');
  return path.resolve(__dirname, raw);
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

function extensionOf(filename) {
  const base = path.basename(String(filename || ''));
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  if (!match) return '';
  return match[1].toLowerCase();
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

function safeStoredPath(storedName) {
  const name = path.basename(String(storedName || ''));
  if (!/^[a-f0-9]{32}\.[a-z0-9]{1,8}$/.test(name)) return null;
  if (!ALLOWED_EXTENSIONS.has(extensionOf(name))) return null;
  const root = path.resolve(uploadDir());
  const full = path.resolve(root, name);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return full;
}

function contentTypeFor(storedName) {
  return CONTENT_TYPES[extensionOf(storedName)] || 'application/octet-stream';
}

function ensureUploadDir() {
  fs.mkdirSync(uploadDir(), { recursive: true });
}

function removeUploaded(files) {
  for (const file of files || []) {
    if (file && file.path) fs.unlink(file.path, () => {});
  }
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      ensureUploadDir();
      cb(null, uploadDir());
    } catch (err) {
      cb(err);
    }
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

function uploadErrorMessage(err) {
  if (!err) return null;
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
  uploadDir,
  maxUploadMb,
  maxUploadBytes,
  maxFilesPerRequest,
  extensionOf,
  sanitizeOriginalName,
  safeStoredPath,
  contentTypeFor,
  ensureUploadDir,
  removeUploaded,
  uploadMiddleware,
  uploadErrorMessage,
};
