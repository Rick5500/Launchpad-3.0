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
  const extra = [];
  const raw = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '';
  for (const part of String(raw).split(',')) {
    const value = part.trim().replace(/\/$/, '');
    if (value) extra.push(value);
  }
  const appUrl = String(process.env.PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
  if (appUrl) extra.push(appUrl);
  if (isProduction()) return [...new Set(extra)];
  const defaults = ['http://localhost:5173', 'http://localhost:5174'];
  return [...new Set([...defaults, ...extra])];
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
  frontendDistDir,
  databaseFile,
  flagOn,
  flagOff,
};
