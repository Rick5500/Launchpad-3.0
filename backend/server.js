process.env.UV_THREADPOOL_SIZE ||= '32';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

function trustProxySetting(raw) {
  if (raw == null) return false;
  const value = String(raw).trim();
  if (!value || value === 'false' || value === '0' || value === 'no' || value === 'off') return false;
  if (value === 'true' || value === 'yes' || value === 'on') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true
}));

app.use(express.json());
const port = process.env.PORT || 3000;

const auth = require('./auth');
const db = require('./db');
const dashboardRouter = require('./routes/dashboard');
const workOrdersRouter = require('./routes/workOrders');
const productionRouter = require('./routes/production');
const productionBoardRouter = require('./routes/productionBoard');
const customersRouter = require('./routes/customers');
const deliveryRouter = require('./routes/delivery');
const barcodeRouter = require('./routes/barcode');
const departmentsRouter = require('./routes/departments');
const ordersRouter = require('./routes/orders');
const sharedFileRoutes = require('./routes/sharedFiles');
const uploadsRouter = require('./routes/uploads');
sharedFileRoutes.mount(ordersRouter);
const { ensureUploadDir } = require('./fileStore');
const { startOrphanSweep } = require('./uploadMaintenance');
const adminBoardRouter = require('./routes/adminBoard');
const reportsRouter = require('./routes/reports');
const notificationsRouter = require('./routes/notifications');
const notificationScheduler = require('./notificationScheduler');
const servicesRouter = require('./routes/services');
const usersRouter = require('./routes/users');
const settingsRouter = require('./routes/settings');
const activityRouter = require('./routes/activity');
const searchRouter = require('./routes/search');
const systemSettings = require('./systemSettings');
const userAdmin = require('./userAdmin');
const registerLimit = require('./registerLimit');
const { sendError } = require('./httpError');


// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', env: process.env.NODE_ENV || 'development' }));

// Short health route for external tools
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'launchpad-backend' }));

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Auth routes
app.get('/api/auth/config', async (req, res) => {
  try {
    res.json({
      customer_self_signup_enabled: await systemSettings.customerSelfSignupEnabled(),
    });
  } catch (err) {
    sendError(res, err, 'AUTH CONFIG ERROR:', 'Unable to load sign-in options');
  }
});

app.post('/api/auth/register', async (req, res) => {
  const ip = clientIp(req);
  let reserved = false;
  try {
    const enabled = await systemSettings.customerSelfSignupEnabled();
    if (!enabled) {
      return res.status(403).json({ error: 'Customer sign-up is turned off' });
    }
    const limit = registerLimit.checkAttempt(ip);
    if (!limit.allowed) {
      res.set('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many registration attempts. Try again later.' });
    }
    reserved = true;
    const session = await userAdmin.registerCustomer(req.body);
    registerLimit.commit(ip);
    reserved = false;
    return res.status(201).json(session);
  } catch (err) {
    if (reserved) {
      if (err && err.honeypot) registerLimit.commit(ip);
      else registerLimit.release(ip);
      reserved = false;
    }
    return sendError(res, err, 'REGISTER ERROR:', 'Unable to create an account');
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const ip = clientIp(req);
  const limit = auth.checkLoginRateLimit(ip, username);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  auth.login(username, password, (err, result) => {
    if (err) {
      console.error('LOGIN ERROR:', err);
      return res.status(500).json({ error: 'server error' });
    }
    if (!result) {
      auth.recordLoginFailure(ip, username);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    auth.clearLoginFailures(ip, username);
    res.json(result);
  });
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const parts = header.split(' ');
  const token = parts.length === 2 && parts[0] === 'Bearer' ? parts[1] : null;
  auth.clearSession(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  db.get(
    `SELECT id, username, role, display_name, company, contact_name, phone, email,
            address_line1, address_line2, city, state, zip, department
     FROM users WHERE id = ?`,
    [req.user.userId],
    (err, row) => {
      if (err || !row) {
        if (err) console.error('AUTH ME ERROR:', err);
        return res.json({ user: req.user });
      }
      res.json({
        user: {
          id: row.id,
          userId: row.id,
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
    }
  );
});

app.use('/api/dashboard', dashboardRouter);
app.use('/api/workorders', workOrdersRouter);
app.use('/api/production', productionRouter);
app.use('/api/production-board', productionBoardRouter);
app.use('/api/production-stages', productionBoardRouter);
app.use('/api/customers', customersRouter);
app.use('/api/delivery', deliveryRouter);
app.use('/api/barcode', barcodeRouter);
app.use('/api/departments', departmentsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/shared-files', sharedFileRoutes.fileRouter);
app.use('/api/admin-board', adminBoardRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/services', servicesRouter);
app.use('/api/users', usersRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/search', searchRouter);

try {
  ensureUploadDir();
} catch (err) {
  console.error('UPLOAD DIR ERROR:', err.message);
}

// Admin placeholder
app.get('/api/admin', auth.requireAuth, auth.requireRole('admin'), (req, res) => res.json({ message: 'admin endpoint (placeholder)', user: req.user }));

// Customer placeholder
app.get('/api/customer', auth.requireAuth, (req, res) => res.json({ message: 'customer endpoint (placeholder)', user: req.user }));

systemSettings.loadRuntimeCache()
  .catch((err) => {
    console.error('SETTINGS CACHE ERROR:', err);
  })
  .finally(() => {
    app.listen(port, () => {
      console.log(`Launchpad backend listening on port ${port}`);
      notificationScheduler.start();
      startOrphanSweep();
    });
  });
