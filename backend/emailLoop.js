// Loop protection for the orders mailbox. Replies to mail Launchpad sent,
// mail from our own outbound address, and automatic replies are not drafts.

const crypto = require('crypto');
const { get, run } = require('./dbAsync');

function addressOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const angled = /<([^<>]+)>/.exec(raw);
  const email = (angled ? angled[1] : raw).trim().toLowerCase();
  if (!email.includes('@') || /[\s<>]/.test(email)) return '';
  return email;
}

function outboundAddresses() {
  const found = new Set();
  for (const name of ['SMTP_FROM', 'OUTBOUND_REPLY_TO']) {
    const email = addressOf(process.env[name]);
    if (email) found.add(email);
  }
  return found;
}

function replyToAddress() {
  const email = addressOf(process.env.OUTBOUND_REPLY_TO);
  return email || '';
}

function messageDomain() {
  const from = addressOf(process.env.SMTP_FROM) || replyToAddress();
  const at = from.lastIndexOf('@');
  if (at > 0) return from.slice(at + 1);
  return 'launchpad.invalid';
}

function newMessageId() {
  return `<${crypto.randomBytes(16).toString('hex')}.launchpad@${messageDomain()}>`;
}

function headerMap(message) {
  const headers = {};
  const list = (message && (message.internetMessageHeaders || message.internet_message_headers)) || [];
  if (!Array.isArray(list)) return headers;
  for (const item of list) {
    if (!item || !item.name) continue;
    headers[String(item.name).trim().toLowerCase()] = String(item.value || '');
  }
  return headers;
}

function messageIdsIn(value) {
  const text = String(value || '');
  const found = text.match(/<[^<>\s]+>/g);
  if (found && found.length) return found.map((id) => id.toLowerCase());
  const trimmed = text.trim().toLowerCase();
  return trimmed ? [trimmed] : [];
}

async function rememberMessageId(messageId, noticeType) {
  const id = String(messageId || '').trim();
  if (!id) return;
  await run(
    `INSERT OR IGNORE INTO outbound_message_ids (message_id, notice_type, created_at)
     VALUES (?, ?, datetime('now'))`,
    [id.toLowerCase(), noticeType ? String(noticeType).slice(0, 80) : null]
  );
}

function subjectAutoReply(subject) {
  const text = String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim();
  if (/^(automatic reply|auto:|out of office|undeliverable|delivery status notification|mail delivery failed|mail delivery subsystem)/i.test(text)) {
    return `Ignored automatic reply (subject: ${text.slice(0, 80)})`;
  }
  return '';
}

async function ignoreReason(message) {
  const headers = headerMap(message);
  const auto = String(headers['auto-submitted'] || '').trim().toLowerCase();
  if (auto && auto !== 'no') return `Ignored automatic reply (Auto-Submitted: ${auto.slice(0, 80)})`;
  const fromSubject = subjectAutoReply(message && (message.subject || message.subjectLine));
  if (fromSubject && !Object.keys(headers).length) return fromSubject;
  if (String(headers['x-auto-response-suppress'] || '').trim()) {
    return 'Ignored automatic reply (X-Auto-Response-Suppress)';
  }
  const precedence = String(headers.precedence || '').trim().toLowerCase();
  if (precedence === 'bulk' || precedence === 'auto_reply' || precedence === 'auto-reply') {
    return `Ignored automatic reply (Precedence: ${precedence})`;
  }
  const from = message && message.from && message.from.emailAddress
    ? addressOf(message.from.emailAddress.address)
    : addressOf(message && message.from_address);
  if (from && outboundAddresses().has(from)) {
    return 'Ignored because the sender is Launchpad\'s outbound address';
  }
  const ids = [
    ...messageIdsIn(headers['in-reply-to']),
    ...messageIdsIn(headers.references),
  ];
  if (!ids.length) return '';
  const unique = [...new Set(ids)].slice(0, 20);
  const placeholders = unique.map(() => '?').join(', ');
  const row = await get(
    `SELECT message_id FROM outbound_message_ids WHERE message_id IN (${placeholders}) LIMIT 1`,
    unique
  );
  if (!row) return '';
  return `Ignored reply to Launchpad notification ${row.message_id}`;
}

module.exports = {
  addressOf,
  outboundAddresses,
  replyToAddress,
  newMessageId,
  headerMap,
  rememberMessageId,
  ignoreReason,
  subjectAutoReply,
};
