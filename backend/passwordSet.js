// One-time link so a staff-created account can choose a password.
// The raw token is emailed once. Only its hash is stored.

const crypto = require('crypto');
const { get, run, withTransaction } = require('./dbAsync');
const { httpError } = require('./httpError');
const { resetUserPassword, passwordPolicyError } = require('./passwordReset');

const DEFAULT_HOURS = 168;
const INVALID = 'This link is invalid or has expired';

function lifetimeHours() {
  const parsed = Number(process.env.PASSWORD_SET_HOURS);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 24 * 30) return DEFAULT_HOURS;
  return parsed;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function expiresAt() {
  const stamp = new Date(Date.now() + lifetimeHours() * 60 * 60 * 1000);
  return stamp.toISOString().slice(0, 19).replace('T', ' ');
}

async function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const digest = hashToken(token);
  await withTransaction(async (tx) => {
    await tx.run(
      `UPDATE password_reset_tokens
       SET used_at = datetime('now')
       WHERE user_id = ? AND used_at IS NULL`,
      [userId]
    );
    await tx.run(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES (?, ?, ?)`,
      [userId, digest, expiresAt()]
    );
  });
  return token;
}

async function consumeToken({ token, password, actorId }) {
  const text = typeof token === 'string' ? token.trim() : '';
  if (!text || text.length > 200 || /[\u0000-\u001F]/.test(text)) throw httpError(400, INVALID);
  const policyError = passwordPolicyError(password);
  if (policyError) throw httpError(400, policyError);

  const row = await get(
    `SELECT t.id, t.expires_at, t.used_at, u.id AS user_id, u.username, u.role, u.is_active
     FROM password_reset_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ?`,
    [hashToken(text)]
  );
  if (!row || row.used_at || Number(row.is_active) === 0) throw httpError(400, INVALID);

  const claimed = await run(
    `UPDATE password_reset_tokens
     SET used_at = datetime('now')
     WHERE id = ? AND used_at IS NULL AND expires_at >= datetime('now')`,
    [row.id]
  );
  if (!claimed.changes) throw httpError(400, INVALID);

  await resetUserPassword({
    user: { id: row.user_id, username: row.username, role: row.role },
    password,
    actorId: actorId || row.user_id,
  });
  return { id: row.user_id, username: row.username };
}

module.exports = {
  issueToken,
  consumeToken,
  hashToken,
};
