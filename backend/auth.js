const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { sessionTokenFromCookie } = require('./cookies');

const BCRYPT_ROUNDS = 10;
const DEFAULT_SESSION_TTL_HOURS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const SESSION_EXPIRED_MESSAGE = 'Session expired. Please log in again.';

const sessions = new Map();
const loginAttempts = new Map();

function sessionTtlMs() {
  const hours = Number(process.env.SESSION_TTL_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) {
    return DEFAULT_SESSION_TTL_HOURS * 60 * 60 * 1000;
  }
  return hours * 60 * 60 * 1000;
}

function isBcryptHash(hash) {
  return typeof hash === 'string' && /^\$2[aby]\$\d{2}\$/.test(hash);
}

function legacySha256(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function verifyPassword(password, passwordHash) {
  if (isBcryptHash(passwordHash)) {
    return bcrypt.compare(password, passwordHash);
  }
  return Promise.resolve(safeEqual(legacySha256(password), passwordHash));
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    role: user.role,
    display_name: user.display_name,
    createdAt: now,
    expiresAt: now + sessionTtlMs(),
  });
  return token;
}

function publicUser(session) {
  return {
    id: session.userId,
    userId: session.userId,
    username: session.username,
    role: session.role,
    display_name: session.display_name,
  };
}

function getUserByToken(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (!session.expiresAt || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return publicUser(session);
}

function clearSession(token) {
  if (token) {
    sessions.delete(token);
  }
}

function clearSessionsForUser(userId, exceptToken) {
  const target = Number(userId);
  if (!Number.isInteger(target)) return;
  for (const [token, session] of sessions) {
    if (exceptToken && token === exceptToken) continue;
    if (Number(session.userId) === target) {
      sessions.delete(token);
    }
  }
}

function cleanupExpired() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (!session.expiresAt || session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
  for (const [key, entry] of loginAttempts) {
    if (!entry.resetAt || entry.resetAt <= now) {
      loginAttempts.delete(key);
    }
  }
}

const cleanupTimer = setInterval(cleanupExpired, CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

function loginKey(ip, username) {
  return `${ip}\n${String(username || '').trim().toLowerCase()}`;
}

function checkLoginRateLimit(ip, username) {
  const entry = loginAttempts.get(loginKey(ip, username));
  const now = Date.now();
  if (!entry || entry.resetAt <= now) {
    return { allowed: true };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
  return { allowed: true };
}

function recordLoginFailure(ip, username) {
  const key = loginKey(ip, username);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(ip, username) {
  loginAttempts.delete(loginKey(ip, username));
}

function clearLoginFailuresForUsername(username) {
  const suffix = `\n${String(username || '').trim().toLowerCase()}`;
  for (const key of loginAttempts.keys()) {
    if (key.endsWith(suffix)) {
      loginAttempts.delete(key);
    }
  }
}

function login(username, password, cb) {
  db.get(
    `SELECT id, username, password_hash, role, display_name, company, contact_name, phone, email,
            address_line1, address_line2, city, state, zip, department, is_active
     FROM users
     WHERE username = ? COLLATE NOCASE
     ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END, id ASC
     LIMIT 1`,
    [username, username],
    (err, row) => {
      if (err) return cb(err);
      if (!row || !row.password_hash) return cb(null, null);
      if (row.is_active === 0) return cb(null, null);

      verifyPassword(password, row.password_hash)
        .then((matches) => {
          if (!matches) return cb(null, null);

          const finish = () => {
            const token = createSession(row);
            cb(null, {
              token,
              user: {
                id: row.id,
                username: row.username,
                role: row.role,
                display_name: row.display_name,
                company: row.company || '',
                contact_name: row.contact_name || '',
                phone: row.phone || '',
                email: row.email || '',
                address_line1: row.address_line1 || '',
                address_line2: row.address_line2 || '',
                city: row.city || '',
                state: row.state || '',
                zip: row.zip || '',
                department: row.department || null,
              },
            });
          };

          if (isBcryptHash(row.password_hash)) return finish();

          // Accept a legacy unsalted SHA-256 hash once, then store bcrypt.
          hashPassword(password)
            .then((newHash) => {
              db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, row.id], (updateErr) => {
                if (updateErr) console.error('PASSWORD REHASH ERROR:', updateErr);
                finish();
              });
            })
            .catch((hashErr) => {
              console.error('PASSWORD REHASH ERROR:', hashErr);
              finish();
            });
        })
        .catch((verifyErr) => cb(verifyErr));
    }
  );
}

function tokenFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = String(authHeader).split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && parts[1]) return parts[1];
    return '';
  }
  return sessionTokenFromCookie(req);
}

function requireAuth(req, res, next) {
  const token = tokenFromRequest(req);
  if (!token) return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE });

  const session = getUserByToken(token);
  if (!session) {
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE });
  }

  req.user = session;
  next();
}

function requireRole(...roles) {
  const allowed = roles.flat();
  return function roleGuard(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE });
    }
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = {
  login,
  hashPassword,
  getUserByToken,
  clearSession,
  clearSessionsForUser,
  requireAuth,
  requireRole,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  clearLoginFailuresForUsername,
  SESSION_EXPIRED_MESSAGE,
};
