// SMTP mail for files shared with a customer, and the admin test message.
// Notification-event email stays in notifyEmail.js and still does not send.
// MAIL_TRANSPORT=json|stream is honored only when NODE_ENV=test.

const nodemailer = require('nodemailer');
const { httpError } = require('./httpError');
const { createFixedWindowLimiter } = require('./rateLimit');
const { loadLetterhead } = require('./shopProfile');

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ON = new Set(['1', 'true', 'yes', 'on']);

let limiter;

function emailRateMax() {
  const parsed = Number(process.env.EMAIL_RATE_LIMIT_MAX);
  if (!Number.isInteger(parsed) || parsed < 1) return 30;
  return parsed;
}

function emailRateWindow() {
  const parsed = Number(process.env.EMAIL_RATE_LIMIT_WINDOW_MS);
  if (!Number.isFinite(parsed) || parsed < 1000) return 15 * 60 * 1000;
  return parsed;
}

function emailLimiter() {
  if (!limiter) {
    limiter = createFixedWindowLimiter({
      windowMs: emailRateWindow(),
      max: emailRateMax(),
    });
  }
  return limiter;
}

function flagOn(value) {
  return ON.has(String(value || '').trim().toLowerCase());
}

function isValidAddress(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 160) return false;
  if (/[\u0000-\u001F]/.test(text)) return false;
  return ADDRESS.test(text);
}

function smtpSettings() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const from = String(process.env.SMTP_FROM || '').trim();
  const portText = String(process.env.SMTP_PORT || '').trim();
  const port = portText ? Number(portText) : 587;
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = process.env.SMTP_PASS == null ? '' : String(process.env.SMTP_PASS);
  const secureText = process.env.SMTP_SECURE;
  const secure = secureText == null || String(secureText).trim() === ''
    ? port === 465
    : flagOn(secureText);
  return { host, from, port, user, pass, secure };
}

function fromAddress(value) {
  const text = String(value || '').trim();
  if (!text || /[\u0000-\u001F]/.test(text) || text.length > 200) return '';
  const angled = /<([^<>]+)>\s*$/.exec(text);
  const email = (angled ? angled[1] : text).trim();
  if (!isValidAddress(email)) return '';
  return text;
}

function isConfigured() {
  const smtp = smtpSettings();
  if (!smtp.host || smtp.host.length > 253) return false;
  if (!Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535) return false;
  if (!fromAddress(smtp.from)) return false;
  return true;
}

function publicFrom() {
  if (!isConfigured()) return null;
  return fromAddress(smtpSettings().from);
}

function publicAppUrl() {
  const raw = String(process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  if (!raw || raw.length > 300) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (err) {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password) return '';
  return raw;
}

function orderFilesLink(orderId) {
  const id = Number(orderId);
  const next = `/orders/${id}#files-from-accent`;
  const base = publicAppUrl();
  if (!base) return next;
  return `${base}/login?next=${encodeURIComponent(next)}`;
}

function transportMode() {
  if (process.env.NODE_ENV !== 'test') return 'smtp';
  const mode = String(process.env.MAIL_TRANSPORT || '').trim().toLowerCase();
  if (mode === 'json' || mode === 'stream') return mode;
  return 'smtp';
}

function createTransport() {
  const mode = transportMode();
  if (mode === 'json') return nodemailer.createTransport({ jsonTransport: true });
  if (mode === 'stream') {
    return nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });
  }
  const smtp = smtpSettings();
  const options = {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
  };
  if (smtp.user) options.auth = { user: smtp.user, pass: smtp.pass };
  return nodemailer.createTransport(options);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseAddressList(value, { max = 5, field = 'email' } = {}) {
  if (value == null || String(value).trim() === '') return { value: [] };
  const text = String(value);
  if (/[\u0000-\u001F]/.test(text)) return { error: `${field} contains invalid characters` };
  const parts = text.split(/[;,]/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return { value: [] };
  if (parts.length > max) return { error: `${field} accepts at most ${max} addresses` };
  const seen = new Set();
  const addresses = [];
  for (const part of parts) {
    if (!isValidAddress(part)) return { error: `${field} contains an invalid address` };
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(part);
  }
  return { value: addresses };
}

function consumeRate(actorId) {
  const limit = emailLimiter().check(`mail:${actorId}`);
  if (limit.allowed) return;
  const error = httpError(429, 'Too many emails. Try again later.');
  error.retryAfterSeconds = limit.retryAfterSeconds;
  throw error;
}

function footerLines(letterhead) {
  const lines = [];
  if (letterhead && letterhead.name) lines.push(letterhead.name);
  for (const line of (letterhead && letterhead.address_lines) || []) lines.push(line);
  if (letterhead && letterhead.phone) lines.push(letterhead.phone);
  return lines;
}

function safeSubject(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
}

function renderShareEmail({ letterhead, orderNumber, message, fileNames, link }) {
  const name = letterhead && letterhead.name ? letterhead.name : '';
  const orderLabel = orderNumber || 'your order';
  const names = fileNames || [];
  const footer = footerLines(letterhead);
  const safeLink = escapeHtml(link);
  const href = String(link || '').replace(/"/g, '%22');
  const messageHtml = message ? `<p style="margin:0 0 16px;line-height:1.5;">${escapeHtml(message).replace(/\n/g, '<br>')}</p>` : '';
  const filesHtml = names.map((file) => `<li>${escapeHtml(file)}</li>`).join('');
  const text = [
    name,
    '',
    `New files are ready for order ${orderLabel}.`,
    message ? `\n${message}\n` : '',
    'Files:',
    ...names.map((file) => `- ${file}`),
    '',
    'Sign in to open these files:',
    link,
    '',
    'This link opens Launchpad. You need to sign in. Files are not available from a public link.',
    '',
    footer.join('\n'),
  ].join('\n').replace(/\n{3,}/g, '\n\n');

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F7FB;font-family:Arial,Helvetica,sans-serif;color:#1B2838;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FB;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #E2E8F0;">
        <tr><td style="background:#0A2F6E;padding:18px 24px;border-bottom:4px solid #F58220;">
          <div style="color:#ffffff;font-size:18px;font-weight:700;">${escapeHtml(name)}</div>
        </td></tr>
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0A2F6E;">New files for order ${escapeHtml(orderLabel)}</h1>
          ${messageHtml}
          <p style="margin:0 0 8px;font-weight:700;color:#0A2F6E;">Files</p>
          <ul style="margin:0 0 20px;padding-left:18px;">${filesHtml}</ul>
          <p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;background:#F58220;color:#111111;text-decoration:none;font-weight:700;padding:10px 16px;">Sign in to view files</a></p>
          <p style="margin:0;font-size:13px;color:#5E6A78;">Or copy this link:<br><a href="${href}" style="color:#0A2F6E;">${safeLink}</a></p>
          <p style="margin:16px 0 0;font-size:13px;color:#5E6A78;">You need to sign in. These files are not available from a public download link.</p>
        </td></tr>
        <tr><td style="padding:16px 24px;background:#F4F7FB;border-top:1px solid #E2E8F0;font-size:13px;color:#5E6A78;line-height:1.5;">
          ${footer.map((line) => escapeHtml(line)).join('<br>')}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    subject: safeSubject(`New files for order ${orderLabel}`),
    text,
    html,
  };
}

function renderTestEmail({ letterhead }) {
  const name = letterhead && letterhead.name ? letterhead.name : 'Launchpad';
  const footer = footerLines(letterhead);
  const appUrl = publicAppUrl();
  const text = [
    name,
    '',
    'This is a test email from Launchpad.',
    'If you received it, mail sending is working.',
    appUrl ? `App: ${appUrl}` : '',
    '',
    footer.join('\n'),
  ].filter((line) => line !== '').join('\n');
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F7FB;font-family:Arial,Helvetica,sans-serif;color:#1B2838;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FB;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #E2E8F0;">
        <tr><td style="background:#0A2F6E;padding:18px 24px;border-bottom:4px solid #F58220;">
          <div style="color:#ffffff;font-size:18px;font-weight:700;">${escapeHtml(name)}</div>
        </td></tr>
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0A2F6E;">Test email</h1>
          <p style="margin:0 0 12px;line-height:1.5;">This is a test email from Launchpad. If you received it, mail sending is working.</p>
          ${appUrl ? `<p style="margin:0;font-size:13px;color:#5E6A78;">App: ${escapeHtml(appUrl)}</p>` : ''}
        </td></tr>
        <tr><td style="padding:16px 24px;background:#F4F7FB;border-top:1px solid #E2E8F0;font-size:13px;color:#5E6A78;line-height:1.5;">
          ${footer.map((line) => escapeHtml(line)).join('<br>')}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return {
    subject: safeSubject(`Test email from ${name}`),
    text,
    html,
  };
}

function captureMessage(info) {
  if (!info) return null;
  if (typeof info.message === 'string') {
    try {
      return JSON.parse(info.message);
    } catch (err) {
      return { raw: info.message };
    }
  }
  if (info.message && Buffer.isBuffer(info.message)) {
    return { raw: info.message.toString('utf8') };
  }
  return null;
}

function previewFrom(captured) {
  if (process.env.NODE_ENV !== 'test' || !captured) return null;
  if (captured.raw && !captured.html) {
    return { raw: captured.raw };
  }
  return {
    subject: captured.subject || null,
    text: captured.text || null,
    html: captured.html || null,
    to: captured.to || null,
    cc: captured.cc || null,
    from: captured.from || null,
  };
}

async function deliver({ to, cc, subject, text, html }) {
  if (!isConfigured()) {
    return { status: 'not_configured', recipients: [] };
  }
  const addresses = [to, ...(cc || [])].filter(Boolean);
  try {
    const info = await createTransport().sendMail({
      from: fromAddress(smtpSettings().from),
      to,
      cc: cc && cc.length ? cc : undefined,
      subject,
      text,
      html,
    });
    return {
      status: 'sent',
      recipients: addresses.map((address) => ({ address, status: 'sent' })),
      captured: captureMessage(info),
    };
  } catch (err) {
    console.error('MAIL SEND ERROR:', err && err.code ? err.code : 'failed');
    return {
      status: 'failed',
      recipients: addresses.map((address) => ({ address, status: 'failed', error: 'Mail could not be sent' })),
    };
  }
}

async function sendTest(actorId, to) {
  const parsed = parseAddressList(to, { max: 1, field: 'to' });
  if (parsed.error) throw httpError(400, parsed.error);
  if (parsed.value.length !== 1) throw httpError(400, 'to must be one email address');
  if (!isConfigured()) throw httpError(400, "Email isn't set up");
  consumeRate(actorId);
  const letterhead = await loadLetterhead();
  const rendered = renderTestEmail({ letterhead });
  const result = await deliver({
    to: parsed.value[0],
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
  if (result.status !== 'sent') {
    const error = httpError(502, 'Mail could not be sent');
    error.recipient = parsed.value[0];
    throw error;
  }
  return {
    status: 'sent',
    to: parsed.value[0],
    preview: previewFrom(result.captured),
  };
}

module.exports = {
  isConfigured,
  publicFrom,
  publicAppUrl,
  orderFilesLink,
  escapeHtml,
  parseAddressList,
  consumeRate,
  renderShareEmail,
  renderTestEmail,
  deliver,
  sendTest,
  previewFrom,
};
