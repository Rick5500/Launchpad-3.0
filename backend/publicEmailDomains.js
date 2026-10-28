// Free and public mailbox domains. A company domain match is never taken from these.
// The list is maintained here. Add a provider when staff would otherwise
// attach a stranger's mail to the one customer who uses that provider.

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.in',
  'yahoo.ca',
  'yahoo.com.au',
  'ymail.com',
  'rocketmail.com',
  'outlook.com',
  'outlook.co.uk',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'live.co.uk',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'aim.com',
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  'comcast.net',
  'att.net',
  'sbcglobal.net',
  'bellsouth.net',
  'currently.com',
  'verizon.net',
  'cox.net',
  'charter.net',
  'spectrum.net',
  'rr.com',
  'mail.com',
  'email.com',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'fastmail.com',
  'fastmail.fm',
  'hey.com',
  'duck.com',
  'tutanota.com',
  'tuta.com',
  'inbox.com',
  'mail.ru',
  'qq.com',
  '163.com',
  '126.com',
]);

function emailDomain(value) {
  const text = String(value || '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1) return '';
  return text.slice(at + 1).replace(/\.+$/, '');
}

function isPublicEmailDomain(domain) {
  const text = String(domain || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!text) return false;
  if (PUBLIC_EMAIL_DOMAINS.has(text)) return true;
  const parts = text.split('.');
  if (parts.length > 2) {
    const parent = parts.slice(1).join('.');
    if (PUBLIC_EMAIL_DOMAINS.has(parent)) return true;
  }
  return false;
}

module.exports = {
  PUBLIC_EMAIL_DOMAINS,
  emailDomain,
  isPublicEmailDomain,
};
