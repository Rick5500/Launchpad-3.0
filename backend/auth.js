const crypto = require('crypto');
const db = require('./db');

const sessions = new Map();

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

function login(username, password, cb) {
  db.get('SELECT id,username,password_hash,role,display_name FROM users WHERE username = ?', [username], (err, row) => {
    if (err) return cb(err);
    if (!row) return cb(null, null);
    if (row.password_hash !== hashPassword(password)) return cb(null, null);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { userId: row.id, username: row.username, role: row.role, display_name: row.display_name });
    cb(null, { token, user: { id: row.id, username: row.username, role: row.role, display_name: row.display_name } });
  });
}

function getUserByToken(token) {
  return sessions.get(token) || null;
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'missing authorization header' });
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ error: 'invalid authorization format' });
  const token = parts[1];
  const s = getUserByToken(token);
  if (!s) return res.status(401).json({ error: 'invalid or expired token' });
  req.user = s;
  next();
}

module.exports = { login, getUserByToken, requireAuth };
