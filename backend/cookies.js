const { cookieSecure, sessionCookiesEnabled } = require('./runtimeConfig');

const COOKIE_NAME = 'lp_session';

function sessionMaxAgeSeconds() {
  const hours = Number(process.env.SESSION_TTL_HOURS);
  const ms = !Number.isFinite(hours) || hours <= 0
    ? 8 * 60 * 60 * 1000
    : hours * 60 * 60 * 1000;
  return Math.max(1, Math.floor(ms / 1000));
}

function readCookie(req, name) {
  const header = req && req.headers ? req.headers.cookie : '';
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch (err) {
      return '';
    }
  }
  return '';
}

function sessionTokenFromCookie(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!/^[a-f0-9]{48}$/i.test(token)) return '';
  return token;
}

function cookieParts(req, value, maxAge) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${maxAge}`,
    'SameSite=Lax',
  ];
  if (cookieSecure(req)) parts.push('Secure');
  return parts;
}

function appendSessionCookie(res, req, token) {
  if (!sessionCookiesEnabled()) return;
  if (!token || !/^[a-f0-9]+$/i.test(String(token))) return;
  res.append('Set-Cookie', cookieParts(req, encodeURIComponent(token), sessionMaxAgeSeconds()).join('; '));
}

function clearSessionCookie(res, req) {
  if (!sessionCookiesEnabled()) return;
  res.append('Set-Cookie', cookieParts(req, '', 0).join('; '));
}

module.exports = {
  COOKIE_NAME,
  readCookie,
  sessionTokenFromCookie,
  appendSessionCookie,
  clearSessionCookie,
  sessionMaxAgeSeconds,
};
