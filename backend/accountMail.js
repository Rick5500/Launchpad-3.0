// Welcome mail for a new login. A failure is returned, never thrown, so
// account creation can finish either way. Staff mail carries a set-password
// link and never receives the password.

const { loadLetterhead, letterheadFromMap } = require('./shopProfile');
const mailer = require('./mailer');
const passwordSet = require('./passwordSet');
const systemSettings = require('./systemSettings');

async function letterhead() {
  try {
    return await loadLetterhead();
  } catch (err) {
    return letterheadFromMap({});
  }
}

function addressOf(row) {
  const parsed = mailer.parseAddressList(row && row.email, { max: 1, field: 'email' });
  if (parsed.error || !parsed.value || parsed.value.length !== 1) return null;
  return parsed.value[0];
}

function withPreview(result, sent) {
  if (process.env.NODE_ENV === 'test' && sent && sent.captured) {
    result.preview = mailer.previewFrom(sent.captured);
  }
  return result;
}

function publicNotice(result) {
  const notice = { status: result && result.status ? result.status : 'failed' };
  if (process.env.NODE_ENV === 'test' && result && result.preview) notice.preview = result.preview;
  return notice;
}

function forcedFailure() {
  return process.env.NODE_ENV === 'test' && process.env.MAIL_TEST_THROW === 'welcome';
}

async function sendStaffWelcome(user) {
  try {
    if (forcedFailure()) throw new Error('forced');
    const enabled = await systemSettings.emailWelcomeOnAccount();
    if (!enabled) return { status: 'disabled' };
    const to = addressOf(user);
    if (!to || !user || !user.id) return { status: 'skipped' };
    const token = await passwordSet.issueToken(user.id);
    const rendered = mailer.renderSetPasswordEmail({
      letterhead: await letterhead(),
      displayName: user.display_name || user.username || '',
      link: mailer.setPasswordLink(token),
    });
    const sent = await mailer.deliver({
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    return withPreview({ status: sent && sent.status ? sent.status : 'failed', to }, sent);
  } catch (err) {
    console.error('WELCOME EMAIL ERROR:', err && err.message ? err.message : 'failed');
    return { status: 'failed' };
  }
}

async function sendSignupWelcome(user) {
  try {
    if (forcedFailure()) throw new Error('forced');
    const enabled = await systemSettings.emailWelcomeOnAccount();
    if (!enabled) return { status: 'disabled' };
    const to = addressOf(user);
    if (!to) return { status: 'skipped' };
    const rendered = mailer.renderWelcomeEmail({
      letterhead: await letterhead(),
      displayName: user.display_name || user.contact_name || user.username || '',
      link: mailer.signInLink(),
    });
    const sent = await mailer.deliver({
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    return withPreview({ status: sent && sent.status ? sent.status : 'failed', to }, sent);
  } catch (err) {
    console.error('WELCOME EMAIL ERROR:', err && err.message ? err.message : 'failed');
    return { status: 'failed' };
  }
}

module.exports = {
  sendStaffWelcome,
  sendSignupWelcome,
  publicNotice,
};
