// Read-only Microsoft Graph client for the orders mailbox.
// Credentials stay in the environment. This module never logs them and never
// writes, moves, or deletes mail.

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_POLL_SECONDS = 180;
const MIN_POLL_SECONDS = 15;

let cachedToken = null;

function envTrim(name) {
  const value = process.env[name];
  if (value == null) return '';
  return String(value).trim();
}

function isConfigured() {
  return Boolean(
    envTrim('M365_TENANT_ID')
    && envTrim('M365_CLIENT_ID')
    && envTrim('M365_CLIENT_SECRET')
    && envTrim('M365_MAILBOX')
  );
}

function loginBase() {
  return (envTrim('M365_LOGIN_BASE_URL') || 'https://login.microsoftonline.com').replace(/\/$/, '');
}

function graphBase() {
  return (envTrim('M365_GRAPH_BASE_URL') || 'https://graph.microsoft.com').replace(/\/$/, '');
}

function mailbox() {
  return envTrim('M365_MAILBOX');
}

function folderName() {
  return envTrim('M365_FOLDER') || 'Inbox';
}

function pollSeconds() {
  const parsed = Number(process.env.M365_POLL_SECONDS);
  if (!Number.isFinite(parsed) || parsed < MIN_POLL_SECONDS) return DEFAULT_POLL_SECONDS;
  return Math.min(Math.floor(parsed), 86400);
}

function timeoutMs() {
  const parsed = Number(process.env.M365_HTTP_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, 120000);
}

function publicConfig() {
  const configured = isConfigured();
  if (!configured) {
    return {
      configured: false,
      mailbox: null,
      folder: null,
      poll_seconds: null,
    };
  }
  return {
    configured: true,
    mailbox: mailbox() || null,
    folder: folderName(),
    poll_seconds: pollSeconds(),
  };
}

function graphError(message, status) {
  const error = new Error(message);
  error.status = status || 502;
  error.publicMessage = message;
  return error;
}

function safeMessage(status, body) {
  let detail = '';
  if (body && typeof body === 'object') {
    if (typeof body.error === 'string') detail = body.error;
    else if (body.error && typeof body.error.message === 'string') detail = body.error.message;
    else if (typeof body.error_description === 'string') detail = body.error_description;
  }
  detail = detail
    .replace(/client_secret=[^&\s]+/gi, 'client_secret=(redacted)')
    .replace(/https?:\/\/\S+/g, '[url]')
    .slice(0, 240);
  if (status === 401 || status === 403) return 'Microsoft 365 refused the mailbox request';
  if (detail) return `Microsoft 365 returned ${status}: ${detail}`;
  return `Microsoft 365 returned ${status}`;
}

function assertAllowed(url, kind) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw graphError('Refusing a mailbox request with an invalid address', 400);
  }
  const base = new URL(kind === 'login' ? loginBase() : graphBase());
  if (parsed.origin !== base.origin) {
    throw graphError('Refusing a mailbox request outside the configured host', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw graphError('Refusing a mailbox request with an unsupported protocol', 400);
  }
}

async function fetchJson(url, options = {}, meta = {}) {
  assertAllowed(url, meta.kind || 'graph');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(url, {
      ...options,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw graphError('Microsoft 365 redirected the mailbox request', 502);
    }
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (err) {
        json = null;
      }
    }
    if (!response.ok) {
      // 410 means the saved delta link expired. Every other Microsoft status,
      // including 401 and 403, stays 502 so the browser does not treat it as a signed-out session.
      const status = response.status === 410 ? 410 : 502;
      throw graphError(safeMessage(response.status, json), status);
    }
    return json || {};
  } catch (err) {
    if (err && err.publicMessage) throw err;
    if (err && (err.name === 'AbortError' || /aborted|timeout/i.test(String(err.message || '')))) {
      throw graphError('The mailbox request timed out', 504);
    }
    throw graphError('The mailbox request failed', 502);
  } finally {
    clearTimeout(timer);
  }
}

function clearTokenCache() {
  cachedToken = null;
}

async function getToken() {
  if (!isConfigured()) throw graphError('Microsoft 365 mailbox is not configured', 400);
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.token;
  const body = new URLSearchParams({
    client_id: envTrim('M365_CLIENT_ID'),
    client_secret: envTrim('M365_CLIENT_SECRET'),
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const tenant = encodeURIComponent(envTrim('M365_TENANT_ID'));
  const payload = await fetchJson(`${loginBase()}/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  }, { kind: 'login' });
  if (!payload.access_token) throw graphError('Microsoft 365 did not return an access token', 502);
  const expiresIn = Number(payload.expires_in);
  cachedToken = {
    token: payload.access_token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
  };
  return cachedToken.token;
}

function folderSegment() {
  const known = {
    inbox: 'inbox',
    drafts: 'drafts',
    'sent items': 'sentitems',
    sentitems: 'sentitems',
    'deleted items': 'deleteditems',
    deleteditems: 'deleteditems',
    junkemail: 'junkemail',
    'junk email': 'junkemail',
    archive: 'archive',
    outbox: 'outbox',
  };
  const key = folderName().toLowerCase();
  return known[key] || encodeURIComponent(folderName());
}

function initialDeltaUrl(watermark) {
  const since = watermark || new Date().toISOString();
  const select = 'id,subject,receivedDateTime,from,body,bodyPreview,hasAttachments';
  const filter = `receivedDateTime ge ${since}`;
  const params = new URLSearchParams();
  params.set('$select', select);
  params.set('$filter', filter);
  const user = encodeURIComponent(mailbox());
  return `${graphBase()}/v1.0/users/${user}/mailFolders/${folderSegment()}/messages/delta?${params.toString()}`;
}

function attachmentsUrl(messageId) {
  const user = encodeURIComponent(mailbox());
  const id = encodeURIComponent(messageId);
  return `${graphBase()}/v1.0/users/${user}/messages/${id}/attachments`;
}

module.exports = {
  isConfigured,
  mailbox,
  folderName,
  pollSeconds,
  timeoutMs,
  publicConfig,
  loginBase,
  graphBase,
  fetchJson,
  getToken,
  clearTokenCache,
  initialDeltaUrl,
  attachmentsUrl,
};
