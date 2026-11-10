// Welcome mail for a new login. A failure is returned, never thrown, so
// account creation can finish either way. Staff mail carries a set-password
// link and never receives the password.

const shopLocations = require('./shopLocations');
const mailer = require('./mailer');
const mailOutbox = require('./mailOutbox');
const passwordSet = require('./passwordSet');
const systemSettings = require('./systemSettings');
const customerNotices = require('./customerNotices');
const { get } = require('./dbAsync');

async function withOutbox(noticeType, user, fn) {
  const fields = {
    scope: 'account',
    userId: user && user.id,
    channel: 'email',
    noticeType,
  };
  if (user && user.id && !mailOutbox.reserve(fields)) {
    return { status: 'skipped', leased: true };
  }
  let owned = false;
  let result = { status: 'skipped', leased: true };
  try {
    if (user && user.id) {
      await mailOutbox.enqueue(fields);
      const gate = await mailOutbox.acquire(fields);
      if (gate === 'leased') return result;
      owned = gate === 'owned';
    }
    result = await fn();
    return result;
  } finally {
    try {
      if (owned) {
        if (mailOutbox.deliverySettled(result)) await mailOutbox.completeMatching(fields);
        else await mailOutbox.releaseMatching(fields);
      }
    } catch (err) {
      console.error('MAIL OUTBOX ERROR:', err && err.message ? err.message : 'failed');
    } finally {
      if (user && user.id) mailOutbox.release(fields);
    }
  }
}

async function loadAccount(user) {
  if (!user || !user.id) return user || null;
  try {
    const row = await get(
      `SELECT id, username, email, display_name, contact_name, location_id FROM users WHERE id = ?`,
      [user.id]
    );
    if (!row) return user;
    const suppliedLocation = user.location_id != null && String(user.location_id).trim() !== '';
    return {
      id: row.id,
      username: user.username || row.username,
      email: user.email || row.email,
      display_name: user.display_name || row.display_name,
      contact_name: user.contact_name || row.contact_name,
      location_id: suppliedLocation ? user.location_id : row.location_id,
    };
  } catch (err) {
    return user;
  }
}

async function shopLetterhead(account) {
  const locationId = account && account.location_id != null && String(account.location_id).trim() !== ''
    ? account.location_id
    : null;
  return shopLocations.safeLetterheadForLocationId(locationId);
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
    const account = await loadAccount(user);
    const to = addressOf(account);
    if (!to || !account || !account.id) return { status: 'skipped' };
    const token = await passwordSet.issueToken(account.id);
    const rendered = mailer.renderSetPasswordEmail({
      letterhead: await shopLetterhead(account),
      displayName: account.display_name || account.username || '',
      username: account.username || '',
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
      userId: account.id,
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
    const account = await loadAccount(user);
    const to = addressOf(account);
    if (!to) return { status: 'skipped' };
    const rendered = mailer.renderWelcomeEmail({
      letterhead: await shopLetterhead(account),
      displayName: account.display_name || account.contact_name || account.username || '',
      username: account.username || '',
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
      userId: account && account.id,
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
    const row = await loadAccount(user);
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
    const rendered = mailer.renderPasswordResetEmail({
      letterhead: await shopLetterhead(row),
      displayName: row.display_name || '',
      username: row.username || '',
      link: mailer.signInLink(),
    });
    const sent = await mailer.deliver({
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
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
    return withPreview({ status, to }, sent);
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
