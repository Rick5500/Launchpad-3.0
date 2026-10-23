const path = require('path');

function applyPathAliases() {
  const dbPath = process.env.DATABASE_PATH == null ? '' : String(process.env.DATABASE_PATH).trim();
  if (dbPath) process.env.DATABASE_FILE = dbPath;
  const uploads = process.env.UPLOADS_DIR == null ? '' : String(process.env.UPLOADS_DIR).trim();
  if (uploads) process.env.UPLOAD_DIR = uploads;
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function flagOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function flagOff(value) {
  return /^(0|false|no|off)$/i.test(String(value || '').trim());
}

function shouldAutoMigrate() {
  const raw = process.env.AUTO_MIGRATE;
  if (raw != null && String(raw).trim() !== '') {
    if (flagOff(raw)) return false;
    if (flagOn(raw)) return true;
  }
  return isProduction();
}

function corsOrigins() {
  const defaults = ['http://localhost:5173', 'http://localhost:5174'];
  const extra = [];
  const raw = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '';
  for (const part of String(raw).split(',')) {
    const value = part.trim().replace(/\/$/, '');
    if (value) extra.push(value);
  }
  const appUrl = String(process.env.PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
  if (appUrl) extra.push(appUrl);
  return [...new Set([...defaults, ...extra])];
}

function cookieSecure(req) {
  const raw = process.env.COOKIE_SECURE;
  if (raw != null && String(raw).trim() !== '') return flagOn(raw);
  const appUrl = String(process.env.PUBLIC_APP_URL || '').trim().toLowerCase();
  if (appUrl.startsWith('https://')) return true;
  if (req && req.secure) return true;
  return false;
}

// Local dev keeps bearer tokens only. A session cookie is set in production,
// or when the public site is HTTPS, so the Windows dev servers stay the same.
function sessionCookiesEnabled() {
  if (isProduction()) return true;
  const raw = process.env.COOKIE_SECURE;
  if (raw != null && String(raw).trim() !== '') return true;
  const appUrl = String(process.env.PUBLIC_APP_URL || '').trim().toLowerCase();
  return appUrl.startsWith('https://');
}

function frontendDistDir() {
  const override = process.env.FRONTEND_DIST == null ? '' : String(process.env.FRONTEND_DIST).trim();
  if (override) return path.resolve(override);
  return path.resolve(__dirname, '..', 'frontend', 'dist');
}

function databaseFile() {
  applyPathAliases();
  const configured = process.env.DATABASE_FILE == null ? '' : String(process.env.DATABASE_FILE).trim();
  if (configured) return configured;
  return path.join(__dirname, '..', 'database', 'launchpad.db');
}

module.exports = {
  applyPathAliases,
  isProduction,
  shouldAutoMigrate,
  corsOrigins,
  cookieSecure,
  sessionCookiesEnabled,
  frontendDistDir,
  databaseFile,
  flagOn,
  flagOff,
};
