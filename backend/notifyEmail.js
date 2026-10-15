// Optional email delivery. Off unless EMAIL_NOTIFICATIONS is explicitly enabled.
// There is no SMTP client in this process. Enabling the flag still does not send mail.

const ENABLED = new Set(['1', 'true', 'yes', 'on']);

function isEnabled() {
  return ENABLED.has(String(process.env.EMAIL_NOTIFICATIONS || '').trim().toLowerCase());
}

function deliver(notification) {
  if (!isEnabled()) {
    return { delivered: false, skipped: 'disabled' };
  }
  console.info(
    `Email notifications are enabled, but mail delivery is not configured (notification ${notification && notification.id ? notification.id : 'new'}).`
  );
  return { delivered: false, skipped: 'stub' };
}

module.exports = {
  isEnabled,
  deliver,
};
