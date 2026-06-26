const crypto = require('crypto');
const db = require('./db');

const sessions = new Map();
const SESSION_EXPIRED_MESSAGE = 'Session expired. Please log in again.';

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    role: user.role,
    display_name: user.display_name,
  });
  return token;
}

function login(username, password, cb) {
  db.get('SELECT id,username,password_hash,role,display_name FROM users WHERE username = ?', [username], (err, row) => {
    if (err) return cb(err);
    if (!row) return cb(null, null);
    if (row.password_hash !== hashPassword(password)) return cb(null, null);

    const token = createSession(row);
    cb(null, {
      token,
      user: { id: row.id, username: row.username, role: row.role, display_name: row.display_name },
    });
  });
}

function getUserByToken(token) {
  return sessions.get(token) || null;
}

function clearSession(token) {
  if (token) {
    sessions.delete(token);
  }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE });

  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE });
  }

  const token = parts[1];
  const session = getUserByToken(token);
  if (!session) {
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE });
  }

  req.user = session;
  next();
}

module.exports = { login, getUserByToken, clearSession, requireAuth, SESSION_EXPIRED_MESSAGE };
