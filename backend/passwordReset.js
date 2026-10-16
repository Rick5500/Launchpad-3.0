const auth = require('./auth');
const activityLog = require('./activityLog');
const { run, withTransaction } = require('./dbAsync');
const { httpError } = require('./httpError');

async function resetUserPassword({ user, password, actorId, exceptToken }) {
  if (!user || !user.id) throw httpError(404, 'User not found');
  const hash = await auth.hashPassword(password);
  await withTransaction(async () => {
    const updated = await run(
      `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`,
      [hash, user.id]
    );
    if (!updated.changes) throw httpError(404, 'User not found');
    await activityLog.record(actorId, 'user.password_reset', 'user', user.id, {
      username: user.username,
      role: user.role,
      message: `Reset password for ${user.username}`,
    });
  });
  auth.clearSessionsForUser(user.id, exceptToken || null);
  auth.clearLoginFailuresForUsername(user.username);
  return { id: user.id, username: user.username, password };
}

module.exports = {
  resetUserPassword,
};
