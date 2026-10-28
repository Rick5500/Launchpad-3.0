const auth = require('./auth');
const activityLog = require('./activityLog');
const { withTransaction } = require('./dbAsync');
const { httpError } = require('./httpError');

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;

function passwordPolicyError(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `password must be ${MAX_PASSWORD_BYTES} bytes or fewer`;
  }
  return null;
}

async function resetUserPassword({ user, password, actorId, exceptToken }) {
  if (!user || !user.id) throw httpError(404, 'User not found');
  const policyError = passwordPolicyError(password);
  if (policyError) throw httpError(400, policyError);
  const hash = await auth.hashPassword(password);
  await withTransaction(async (tx) => {
    const updated = await tx.run(
      `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`,
      [hash, user.id]
    );
    if (!updated.changes) throw httpError(404, 'User not found');
    await activityLog.recordOn(tx, actorId, 'user.password_reset', 'user', user.id, {
      username: user.username,
      role: user.role,
      message: `Reset password for ${user.username}`,
    });
  });
  auth.clearSessionsForUser(user.id, exceptToken || null);
  auth.clearLoginFailuresForUsername(user.username);
  try {
    const accountMail = require('./accountMail');
    await accountMail.sendPasswordResetNotice(user);
  } catch (err) {
    console.error('PASSWORD RESET EMAIL ERROR:', err && err.message ? err.message : 'failed');
  }
  return { id: user.id, username: user.username, password };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  passwordPolicyError,
  resetUserPassword,
};
