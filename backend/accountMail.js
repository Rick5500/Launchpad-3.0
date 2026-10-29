// Welcome mail for a new login. A failure is returned, never thrown, so
// account creation can finish either way. Staff mail carries a set-password
// link and never receives the password.

const { loadLetterhead, letterheadFromMap } = require('./shopProfile');
const mailer = require('./mailer');
const mailOutbox = require('./mailOutbox');
const passwordSet = require('./passwordSet');
const systemSettings = require('./systemSettings');
const customerNotices = require('./customerNotices');
const { get } = require('./dbAsync');

async function withOutbox(noticeType, user, fn) {
  let outboxId = null;
  try {
    if (user && user.id) {
      outboxId = await mailOutbox.enqueue({
        scope: 'account',
        userId: user.id,
        channel: 'email',
        noticeType,
      });
    }
    return await fn();
  } finally {
    if (!outboxId) return;
    try {
      await mailOutbox.complete(outboxId);
    } catch (err) {
      console.error('MAIL OUTBOX ERROR:', err && err.message ? err.message : 'failed');
    }
  }
}

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
  return withOutbox('password_set', user, () => sendStaffWelcomeNow(user));
}

async function sendStaffWelcomeNow(user) {
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
      noticeType: 'password_set',
    });
    const result = withPreview({ status: sent && sent.status ? sent.status : 'failed', to }, sent);
    await customerNotices.recordAccountNotice({
      userId: user.id,
      channel: 'email',
      noticeType: 'password_set',
      recipient: to,
      result: result.status,
    });
    return result;
  } catch (err) {
    console.error('WELCOME EMAIL ERROR:', err && err.message ? err.message : 'failed');
    return { status: 'failed' };
  }
}

async function sendSignupWelcome(user) {
  return withOutbox('welcome', user, () => sendSignupWelcomeNow(user));
}

async function sendSignupWelcomeNow(user) {
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
      noticeType: 'welcome',
    });
    const result = withPreview({ status: sent && sent.status ? sent.status : 'failed', to }, sent);
    await customerNotices.recordAccountNotice({
      userId: user && user.id,
      channel: 'email',
      noticeType: 'welcome',
      recipient: to,
      result: result.status,
    });
    return result;
  } catch (err) {
    console.error('WELCOME EMAIL ERROR:', err && err.message ? err.message : 'failed');
    return { status: 'failed' };
  }
}

async function sendPasswordResetNotice(user) {
  return withOutbox('password_reset', user, () => sendPasswordResetNoticeNow(user));
}

async function sendPasswordResetNoticeNow(user) {
  try {
    const row = user && user.email
      ? user
      : await get(`SELECT id, username, email, display_name FROM users WHERE id = ?`, [user && user.id]);
    const to = addressOf(row);
    if (!to || !row) {
      await customerNotices.recordAccountNotice({
        userId: user && user.id,
        channel: 'email',
        noticeType: 'password_reset',
        recipient: null,
        result: 'skipped',
      });
      return { status: 'skipped' };
    }
    const link = mailer.signInLink();
    const sent = await mailer.deliver({
      to,
      subject: 'Your Launchpad password was reset',
      text: `The password for your Launchpad account was reset. Sign in at ${link}. This message does not include the new password.`,
      html: `<p>The password for your Launchpad account was reset.</p><p><a href="${mailer.escapeHtml(link)}">Sign in</a></p>`,
      noticeType: 'password_reset',
    });
    const status = sent && sent.status ? sent.status : 'failed';
    await customerNotices.recordAccountNotice({
      userId: row.id,
      channel: 'email',
      noticeType: 'password_reset',
      recipient: to,
      result: status,
    });
    return { status, to };
  } catch (err) {
    console.error('PASSWORD RESET EMAIL ERROR:', err && err.message ? err.message : 'failed');
    await customerNotices.recordAccountNotice({
      userId: user && user.id,
      channel: 'email',
      noticeType: 'password_reset',
      recipient: null,
      result: 'failed',
    });
    return { status: 'failed' };
  }
}

module.exports = {
  sendStaffWelcome,
  sendSignupWelcome,
  sendPasswordResetNotice,
  publicNotice,
};
