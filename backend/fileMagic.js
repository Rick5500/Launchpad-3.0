// Magic-byte checks for inbound attachments. The extension allowlist is not enough:
// the bytes have to match the extension, and encrypted or password-protected
// files stay quarantined even when the bytes are otherwise a known type.

const { ALLOWED_EXTENSIONS } = require('./fileStore');

const EXT_KIND = {
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  tif: 'tiff',
  tiff: 'tiff',
  webp: 'webp',
  bmp: 'bmp',
  dwg: 'dwg',
  zip: 'zip',
  plt: 'plt',
};

function startsWith(buffer, text) {
  const sample = Buffer.from(String(text));
  return buffer.length >= sample.length && buffer.subarray(0, sample.length).equals(sample);
}

function detectKind(buffer) {
  if (!buffer || !buffer.length) return null;
  if (startsWith(buffer, '%PDF')) return 'pdf';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (startsWith(buffer, 'GIF87a') || startsWith(buffer, 'GIF89a')) return 'gif';
  if (buffer.length >= 12 && startsWith(buffer, 'RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.length >= 4 && buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) return 'tiff';
  if (buffer.length >= 4 && buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a) return 'tiff';
  if (startsWith(buffer, 'BM')) return 'bmp';
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
    && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) return 'zip';
  if (buffer.length >= 6 && /^AC\d{4}/.test(buffer.subarray(0, 6).toString('ascii'))) return 'dwg';
  if (isPlt(buffer)) return 'plt';
  return null;
}

function isPlt(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 256)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (!sample || sample.includes('<') || sample.includes('\0')) return false;
  return /^(IN;|PA|PU|PD|SP|LT|%\d|%|\.)/i.test(sample);
}

function zipEncrypted(buffer) {
  if (buffer.length < 8 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  let offset = 0;
  while (offset + 8 < buffer.length && buffer[offset] === 0x50 && buffer[offset + 1] === 0x4b && buffer[offset + 2] === 0x03 && buffer[offset + 3] === 0x04) {
    const flags = buffer.readUInt16LE(offset + 6);
    if (flags & 0x1 || flags & 0x40) return true;
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const next = offset + 30 + nameLen + extraLen + compressed;
    if (next <= offset) break;
    offset = next;
  }
  return false;
}

function pdfEncrypted(buffer) {
  const window = Buffer.concat([
    buffer.subarray(0, Math.min(buffer.length, 65536)),
    buffer.subarray(Math.max(0, buffer.length - 65536)),
  ]).toString('latin1');
  return /\/Encrypt\b/.test(window);
}

function isEncrypted(buffer, kind) {
  if (!buffer || !buffer.length) return false;
  if (kind === 'pdf' && pdfEncrypted(buffer)) return true;
  if (kind === 'zip' && zipEncrypted(buffer)) return true;
  return false;
}

function checkAllowed(ext, buffer) {
  const extension = String(ext || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return { ok: false, reason: 'This file type is not allowed' };
  }
  const expected = EXT_KIND[extension];
  const detected = detectKind(buffer);
  if (!detected || detected !== expected) {
    return { ok: false, reason: 'File contents do not match the file type' };
  }
  return {
    ok: true,
    kind: detected,
    encrypted: isEncrypted(buffer, detected),
  };
}

module.exports = {
  EXT_KIND,
  detectKind,
  isEncrypted,
  checkAllowed,
};
