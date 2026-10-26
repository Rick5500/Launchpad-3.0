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

function orderPageLink(orderId) {
  return appLink(`/orders/${Number(orderId)}`);
}

// Login next path for one transfer. The frontend safeAppPath accepts this path.
function transferFilesLink(transferId) {
  const id = Number(transferId);
  const next = `/files/${id}`;
  const base = publicAppUrl();
  if (!base) return next;
  return `${base}/login?next=${encodeURIComponent(next)}`;
}

function appLink(nextPath) {
  const next = String(nextPath || '').startsWith('/') ? String(nextPath) : `/${nextPath || ''}`;
  const base = publicAppUrl();
  if (!base) return next;
  return `${base}/login?next=${encodeURIComponent(next)}`;
}

function orderProofLink(orderId) {
  return appLink(`/orders/${Number(orderId)}#proofs`);
}

function quoteLink(quoteId) {
  return appLink(`/quotes/${Number(quoteId)}`);
}

function staffQuoteLink(quoteId) {
  return appLink(`/quote-requests/${Number(quoteId)}`);
}

function proofReviewLink(orderId, workOrderId) {
  if (workOrderId) return appLink(`/work-orders/${Number(workOrderId)}`);
  return orderProofLink(orderId);
}

function transportMode() {
  if (process.env.NODE_ENV !== 'test') return 'smtp';
  const mode = String(process.env.MAIL_TRANSPORT || '').trim().toLowerCase();
  if (mode === 'json' || mode === 'stream') return mode;
  return 'smtp';
}

function smtpTimeoutMs() {
  const parsed = Number(process.env.SMTP_TIMEOUT_MS);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 120000) return 12000;
  return parsed;
}

function createTransport() {
  const mode = transportMode();
  if (mode === 'json') return nodemailer.createTransport({ jsonTransport: true });
  if (mode === 'stream') {
    return nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });
  }
  const smtp = smtpSettings();
  const timeout = smtpTimeoutMs();
  const options = {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  };
  if (smtp.user) options.auth = { user: smtp.user, pass: smtp.pass };
  return nodemailer.createTransport(options);
}

function warnTestJsonTransport() {
  if (process.env.NODE_ENV !== 'test') return;
  const mode = String(process.env.MAIL_TRANSPORT || '').trim().toLowerCase();
  if (mode !== 'json') return;
  if (!String(process.env.SMTP_HOST || '').trim()) return;
  console.warn('MAIL_TRANSPORT=json is set with SMTP_HOST. Test mail uses the JSON transport and does not connect to that SMTP server.');
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

function reserveEmail(actorId) {
  return emailLimiter().check(`mail:${actorId}`);
}

function consumeRate(actorId) {
  const limit = reserveEmail(actorId);
  if (limit.allowed) return;
  const error = httpError(429, 'Too many emails. Try again later.');
  error.retryAfterSeconds = limit.retryAfterSeconds;
  throw error;
}

function footerLines(letterhead) {
  const lines = [];
  function push(value) {
    const text = String(value || '').trim();
    if (!text) return;
    if (lines.some((line) => line.trim().toLowerCase() === text.toLowerCase())) return;
    lines.push(text);
  }
  if (letterhead && letterhead.name) push(letterhead.name);
  if (letterhead && letterhead.location_name) push(letterhead.location_name);
  for (const line of (letterhead && letterhead.location_address_lines) || []) push(line);
  if (letterhead && letterhead.location_phone) push(letterhead.location_phone);
  for (const line of (letterhead && letterhead.address_lines) || []) push(line);
  if (letterhead && letterhead.phone) push(letterhead.phone);
  return lines;
}

function safeSubject(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
}

// Hosted on the public site, same origin as the sign-in links. Email clients
// cannot load a relative path, so the image is omitted until PUBLIC_APP_URL is set.
const EMAIL_LOGO_PATH = '/brand/logo.png';

function emailLogoHtml() {
  const base = publicAppUrl();
  if (!base) return '';
  const src = escapeHtml(`${base}${EMAIL_LOGO_PATH}`);
  return `<img src="${src}" alt="Launchpad" width="280" style="display:block;width:280px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;margin:0 0 12px;" />`;
}

function emailBannerHtml(name) {
  const logo = emailLogoHtml();
  const title = name
    ? `<div style="color:#ffffff;font-size:18px;font-weight:700;">${escapeHtml(name)}</div>`
    : '';
  return `<tr><td style="background:#0A2F6E;padding:16px 24px;border-bottom:4px solid #F58220;">${logo}${title}</td></tr>`;
}

// Small customer credit. Images use the same absolute-URL rule as the
// Launchpad logo and are omitted until PUBLIC_APP_URL is set. Staff-only
// mail (proof changes, quote-request alerts, and the test email) leaves
// this block off. The letterhead lines stay either way.
const EMAIL_ACG_LOGO_PATH = '/brand/acg-logo.png';
const EMAIL_AI_LOGO_PATH = '/brand/accent-imaging-logo.png';
const CREDIT_SENTENCE = 'A service of Accent Imaging and Accent Corporate Graphics';

function emailCreditHtml() {
  const sentence = `<div style="margin:8px 0 0;font-size:12px;line-height:1.35;color:#0A2F6E;font-weight:700;text-align:center;">${CREDIT_SENTENCE}</div>`;
  const base = publicAppUrl();
  if (!base) {
    return `<div style="font-size:12px;line-height:1.35;color:#0A2F6E;font-weight:700;text-align:center;">${CREDIT_SENTENCE}</div>`;
  }
  const ai = escapeHtml(`${base}${EMAIL_AI_LOGO_PATH}`);
  const acg = escapeHtml(`${base}${EMAIL_ACG_LOGO_PATH}`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" style="text-align:center;">
                <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;">
                  <tr>
                    <td valign="middle" style="padding:0 8px 0 0;"><img src="${ai}" alt="Accent Imaging" width="37" height="36" style="display:block;width:37px;height:36px;border:0;outline:none;text-decoration:none;" /></td>
                    <td valign="middle"><img src="${acg}" alt="Accent Corporate Graphics" width="56" height="36" style="display:block;width:56px;height:36px;border:0;outline:none;text-decoration:none;" /></td>
                  </tr>
                </table>
                ${sentence}
              </td>
            </tr>
          </table>`;
}

function footerText(lines, options = {}) {
  if (!options.credit) return lines;
  return [...lines, CREDIT_SENTENCE];
}

function emailFooterHtml(lines, options = {}) {
  const text = (lines || []).map((line) => escapeHtml(line)).join('<br>');
  if (!options.credit) {
    return `<tr><td style="padding:16px 24px;background:#F4F7FB;border-top:1px solid #E2E8F0;font-size:13px;color:#5E6A78;line-height:1.5;">${text}</td></tr>`;
  }
  const address = text
    ? `<div style="font-size:13px;color:#5E6A78;line-height:1.5;">${text}</div>`
    : '';
  return `<tr><td style="padding:16px 24px;background:#F4F7FB;border-top:1px solid #E2E8F0;">
          ${address}
          <div style="margin-top:${address ? '12px' : '0'};">${emailCreditHtml()}</div>
        </td></tr>`;
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
    footerText(footer, { credit: true }).join('\n'),
  ].join('\n').replace(/\n{3,}/g, '\n\n');

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F7FB;font-family:Arial,Helvetica,sans-serif;color:#1B2838;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FB;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #E2E8F0;">
        ${emailBannerHtml(name)}
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0A2F6E;">New files for order ${escapeHtml(orderLabel)}</h1>
          ${messageHtml}
          <p style="margin:0 0 8px;font-weight:700;color:#0A2F6E;">Files</p>
          <ul style="margin:0 0 20px;padding-left:18px;">${filesHtml}</ul>
          <p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;background:#F58220;color:#111111;text-decoration:none;font-weight:700;padding:10px 16px;">Sign in to view files</a></p>
          <p style="margin:0;font-size:13px;color:#5E6A78;">Or copy this link:<br><a href="${href}" style="color:#0A2F6E;">${safeLink}</a></p>
          <p style="margin:16px 0 0;font-size:13px;color:#5E6A78;">You need to sign in. These files are not available from a public download link.</p>
        </td></tr>
        ${emailFooterHtml(footer, { credit: true })}
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

function renderTransferEmail({ letterhead, subject, message, fileNames, link }) {
  const name = letterhead && letterhead.name ? letterhead.name : 'Accent Imaging';
  const heading = subject ? safeSubject(subject) : 'New files from Accent';
  const names = fileNames || [];
  const footer = footerLines(letterhead);
  const safeLink = escapeHtml(link);
  const href = String(link || '').replace(/"/g, '%22');
  const messageHtml = message ? `<p style="margin:0 0 16px;line-height:1.5;">${escapeHtml(message).replace(/\n/g, '<br>')}</p>` : '';
  const filesHtml = names.map((file) => `<li>${escapeHtml(file)}</li>`).join('');
  const text = [
    name,
    '',
    heading,
    message ? `\n${message}\n` : '',
    'Files:',
    ...names.map((file) => `- ${file}`),
    '',
    'Sign in to open these files:',
    link,
    '',
    'This link opens Launchpad. You need to sign in. Files are not available from a public link.',
    '',
    footerText(footer, { credit: true }).join('\n'),
  ].join('\n').replace(/\n{3,}/g, '\n\n');

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F7FB;font-family:Arial,Helvetica,sans-serif;color:#1B2838;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FB;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #E2E8F0;">
        ${emailBannerHtml(name)}
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0A2F6E;">${escapeHtml(heading)}</h1>
          ${messageHtml}
          <p style="margin:0 0 8px;font-weight:700;color:#0A2F6E;">Files</p>
          <ul style="margin:0 0 20px;padding-left:18px;">${filesHtml}</ul>
          <p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;background:#F58220;color:#111111;text-decoration:none;font-weight:700;padding:10px 16px;">Sign in to view files</a></p>
          <p style="margin:0;font-size:13px;color:#5E6A78;">Or copy this link:<br><a href="${href}" style="color:#0A2F6E;">${safeLink}</a></p>
          <p style="margin:16px 0 0;font-size:13px;color:#5E6A78;">You need to sign in. These files are not available from a public download link.</p>
        </td></tr>
        ${emailFooterHtml(footer, { credit: true })}
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    subject: safeSubject(subject || `New files from ${name}`),
    text,
    html,
  };
}

function renderQuoteEmail({ letterhead, projectName, price, notes, validUntil, lineItems, link }) {
  const name = letterhead && letterhead.name ? letterhead.name : '';
  const project = projectName || 'your project';
  const footer = footerLines(letterhead);
  const safeLink = escapeHtml(link);
  const href = String(link || '').replace(/"/g, '%22');
  const lines = Array.isArray(lineItems) ? lineItems : [];
  const lineText = lines.map((line) => {
    const parts = [line.code, line.unit, line.quantity, line.description, line.price].filter(Boolean);
    return parts.join(' · ');
  }).filter(Boolean);
  const notesText = notes ? String(notes) : '';
  const text = [
    name,
    '',
    `Your quote for ${project} is ready.`,
    price ? `Total: ${price}` : '',
    validUntil ? `Valid until: ${validUntil}` : '',
    notesText ? `\n${notesText}\n` : '',
    lineText.length ? 'Line items:' : '',
    ...lineText.map((line) => `- ${line}`),
    '',
    'Sign in to accept or decline this quote.',
    link,
    '',
    'This link opens Launchpad. You need to sign in.',
    '',
    footerText(footer, { credit: true }).join('\n'),
  ].filter((line) => line !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');

  const notesHtml = notesText
    ? `<p style="margin:0 0 16px;line-height:1.5;">${escapeHtml(notesText).replace(/\n/g, '<br>')}</p>`
    : '';
  const itemsHtml = lineText.length
    ? `<p style="margin:0 0 8px;font-weight:700;color:#0A2F6E;">Line items</p><ul style="margin:0 0 20px;padding-left:18px;">${lineText.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
    : '';
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F7FB;font-family:Arial,Helvetica,sans-serif;color:#1B2838;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FB;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #E2E8F0;">
        ${emailBannerHtml(name)}
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0A2F6E;">Quote for ${escapeHtml(project)}</h1>
          ${price ? `<p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#0A2F6E;">Total: ${escapeHtml(price)}</p>` : ''}
          ${validUntil ? `<p style="margin:0 0 16px;">Valid until ${escapeHtml(validUntil)}</p>` : ''}
          ${notesHtml}
          ${itemsHtml}
          <p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;background:#F58220;color:#111111;text-decoration:none;font-weight:700;padding:10px 16px;">Sign in to review this quote</a></p>
          <p style="margin:0;font-size:13px;color:#5E6A78;">Or copy this link:<br><a href="${href}" style="color:#0A2F6E;">${safeLink}</a></p>
          <p style="margin:16px 0 0;font-size:13px;color:#5E6A78;">You need to sign in to accept or decline this quote.</p>
        </td></tr>
        ${emailFooterHtml(footer, { credit: true })}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return {
    subject: safeSubject(`Quote for ${project}`),
    text,
    html,
  };
}

function renderProofEmail({ letterhead, orderNumber, version, message, fileNames, link, workOrderNumber }) {
  const name = letterhead && letterhead.name ? letterhead.name : '';
  const orderLabel = orderNumber || 'your order';
  const versionLabel = `v${version || 1}`;
  const names = fileNames || [];
  const footer = footerLines(letterhead);
  const safeLink = escapeHtml(link);
  const href = String(link || '').replace(/"/g, '%22');
  const where = workOrderNumber ? `work order ${workOrderNumber}` : `order ${orderLabel}`;
  const messageHtml = message ? `<p style="margin:0 0 16px;line-height:1.5;">${escapeHtml(message).replace(/\n/g, '<br>')}</p>` : '';
  const filesHtml = names.map((file) => `<li>${escapeHtml(file)}</li>`).join('');
  const text = [
    name,
    '',
    `Proof ${versionLabel} is ready for ${where}.`,
    message ? `\n${message}\n` : '',
    'Files:',
    ...names.map((file) => `- ${file}`),
    '',
    'Sign in to review this proof. You can approve it or request changes.',
    link,
    '',
    'This link opens Launchpad. You need to sign in. The proof is not available from a public link.',
    '',
    footerText(footer, { credit: true }).join('\n'),
  ].join('\n').replace(/\n{3,}/g, '\n\n');

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F7FB;font-family:Arial,Helvetica,sans-serif;color:#1B2838;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FB;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #E2E8F0;">
        ${emailBannerHtml(name)}
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0A2F6E;">Proof ${escapeHtml(versionLabel)} for order ${escapeHtml(orderLabel)}</h1>
          ${messageHtml}
          <p style="margin:0 0 8px;font-weight:700;color:#0A2F6E;">Files</p>
          <ul style="margin:0 0 20px;padding-left:18px;">${filesHtml}</ul>
          <p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;background:#F58220;color:#111111;text-decoration:none;font-weight:700;padding:10px 16px;">Sign in to review this proof</a></p>
          <p style="margin:0;font-size:13px;color:#5E6A78;">Or copy this link:<br><a href="${href}" style="color:#0A2F6E;">${safeLink}</a></p>
          <p style="margin:16px 0 0;font-size:13px;color:#5E6A78;">You need to sign in. This proof is not available from a public download link.</p>
        </td></tr>
        ${emailFooterHtml(footer, { credit: true })}
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    subject: safeSubject(`Proof ${versionLabel} for order ${orderLabel}`),
    text,
    html,
  };
}

function renderProofChangesEmail({ letterhead, orderNumber, version, comment, customerName, link, workOrderNumber }) {
  const name = letterhead && letterhead.name ? letterhead.name : '';
  const orderLabel = orderNumber || 'an order';
  const versionLabel = `v${version || 1}`;
  const who = customerName || 'The customer';
  const where = workOrderNumber ? `${workOrderNumber} on order ${orderLabel}` : `order ${orderLabel}`;
  const footer = footerLines(letterhead);
  const safeLink = escapeHtml(link);
  const href = String(link || '').replace(/"/g, '%22');
  const text = [
    name,
    '',
    `${who} requested changes on proof ${versionLabel} for ${where}.`,
    '',
    comment || '',
    '',
    'Sign in to upload a new proof version:',
    link,
    '',
    footerText(footer).join('\n'),
  ].join('\n').replace(/\n{3,}/g, '\n\n');

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F7FB;font-family:Arial,Helvetica,sans-serif;color:#1B2838;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FB;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #E2E8F0;">
        ${emailBannerHtml(name)}
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0A2F6E;">Changes requested on proof ${escapeHtml(versionLabel)}</h1>
          <p style="margin:0 0 12px;line-height:1.5;">${escapeHtml(who)} requested changes on ${escapeHtml(where)}.</p>
          <p style="margin:0 0 16px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(comment || '').replace(/\n/g, '<br>')}</p>
          <p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;background:#F58220;color:#111111;text-decoration:none;font-weight:700;padding:10px 16px;">Sign in to send a new version</a></p>
          <p style="margin:0;font-size:13px;color:#5E6A78;">Or copy this link:<br><a href="${href}" style="color:#0A2F6E;">${safeLink}</a></p>
        </td></tr>
        ${emailFooterHtml(footer)}
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    subject: safeSubject(`Changes requested on proof ${versionLabel} for order ${orderLabel}`),
    text,
    html,
  };
}

function renderQuoteRequestEmail({ letterhead, customerName, projectName, neededBy, link }) {
  const name = letterhead && letterhead.name ? letterhead.name : '';
  const customer = customerName || 'A customer';
  const project = projectName || 'a project';
  const footer = footerLines(letterhead);
  const safeLink = escapeHtml(link);
  const href = String(link || '').replace(/"/g, '%22');
  const headline = `New quote request from ${customer}: ${project}`;
  const needed = neededBy ? `Needed by ${neededBy}.` : '';
  const text = [
    name,
    '',
    headline,
    needed,
    '',
    'Sign in to review this quote request.',
    link,
    '',
    footerText(footer).join('\n'),
  ].filter((line) => line !== '').join('\n');

  const neededHtml = needed
    ? `<p style="margin:0 0 16px;line-height:1.5;">${escapeHtml(needed)}</p>`
    : '';
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F7FB;font-family:Arial,Helvetica,sans-serif;color:#1B2838;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FB;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #E2E8F0;">
        ${emailBannerHtml(name)}
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0A2F6E;">${escapeHtml(headline)}</h1>
          ${neededHtml}
          <p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;background:#F58220;color:#111111;text-decoration:none;font-weight:700;padding:10px 16px;">Sign in to review this request</a></p>
          <p style="margin:0;font-size:13px;color:#5E6A78;">Or copy this link:<br><a href="${href}" style="color:#0A2F6E;">${safeLink}</a></p>
        </td></tr>
        ${emailFooterHtml(footer)}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return {
    subject: safeSubject(headline),
    text,
    html,
  };
}

function renderPickupReadyEmail({ letterhead, orderNumber, locationName, locationAddress, locationPhone, link }) {
  const name = letterhead && letterhead.name ? letterhead.name : '';
  const orderLabel = orderNumber || 'your order';
  const placeName = String(locationName || '').trim();
  const place = placeName ? `our ${placeName} location` : 'our shop';
  const addressLines = String(locationAddress || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const phone = String(locationPhone || '').trim();
  const footer = footerLines(letterhead);
  const safeLink = escapeHtml(link);
  const href = String(link || '').replace(/"/g, '%22');
  const addressText = addressLines.join('\n');
  const text = [
    name,
    '',
    `Order #${orderLabel} is ready for pickup at ${place}.`,
    addressText,
    phone ? `Questions? ${phone}` : '',
    '',
    link ? 'Sign in to view this order:' : '',
    link || '',
    '',
    footerText(footer, { credit: true }).join('\n'),
  ].filter((line) => line !== '').join('\n').replace(/\n{3,}/g, '\n\n');

  const addressHtml = addressLines.length
    ? `<p style="margin:0 0 8px;line-height:1.5;">${addressLines.map((line) => escapeHtml(line)).join('<br>')}</p>`
    : '';
  const phoneHtml = phone
    ? `<p style="margin:0 0 16px;line-height:1.5;">Questions? ${escapeHtml(phone)}</p>`
    : '';
  const linkHtml = link
    ? `<p style="margin:16px 0 0;"><a href="${href}" style="display:inline-block;background:#F58220;color:#111111;text-decoration:none;font-weight:700;padding:10px 16px;">Sign in to view your order</a></p>
          <p style="margin:12px 0 0;font-size:13px;color:#5E6A78;">Or copy this link:<br><a href="${href}" style="color:#0A2F6E;">${safeLink}</a></p>`
    : '';
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F7FB;font-family:Arial,Helvetica,sans-serif;color:#1B2838;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FB;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #E2E8F0;">
        ${emailBannerHtml(name)}
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0A2F6E;">Your order is ready for pickup</h1>
          <p style="margin:0 0 12px;line-height:1.5;">Order #${escapeHtml(orderLabel)} is ready for pickup at ${escapeHtml(place)}.</p>
          ${addressHtml}
          ${phoneHtml}
          ${linkHtml}
        </td></tr>
        ${emailFooterHtml(footer, { credit: true })}
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    subject: safeSubject(`Order ${orderLabel} is ready for pickup`),
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
    footerText(footer).join('\n'),
  ].filter((line) => line !== '').join('\n');
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F7FB;font-family:Arial,Helvetica,sans-serif;color:#1B2838;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FB;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #E2E8F0;">
        ${emailBannerHtml(name)}
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0A2F6E;">Test email</h1>
          <p style="margin:0 0 12px;line-height:1.5;">This is a test email from Launchpad. If you received it, mail sending is working.</p>
          ${appUrl ? `<p style="margin:0;font-size:13px;color:#5E6A78;">App: ${escapeHtml(appUrl)}</p>` : ''}
        </td></tr>
        ${emailFooterHtml(footer)}
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
  orderPageLink,
  transferFilesLink,
  orderProofLink,
  quoteLink,
  staffQuoteLink,
  proofReviewLink,
  escapeHtml,
  parseAddressList,
  reserveEmail,
  consumeRate,
  warnTestJsonTransport,
  renderShareEmail,
  renderTransferEmail,
  renderQuoteEmail,
  renderQuoteRequestEmail,
  renderProofEmail,
  renderProofChangesEmail,
  renderPickupReadyEmail,
  renderTestEmail,
  deliver,
  sendTest,
  previewFrom,
};
