require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
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
const departmentsRouter = require('./routes/departments');
const barcodeRouter = require('./routes/barcode');
const usersRouter = require('./routes/users');
const matrixRouter = require('./routes/matrix');
const productsRouter = require('./routes/products');


// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', env: process.env.NODE_ENV || 'development' }));

// Short health route for external tools
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'launchpad-backend' }));

// Auth routes
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  auth.login(username, password, (err, result) => {
    if (err) return res.status(500).json({ error: 'server error' });
    if (!result) return res.status(401).json({ error: 'invalid credentials' });
    res.json(result);
  });
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.use('/api/dashboard', dashboardRouter);
app.use('/api/workorders', workOrdersRouter);
app.use('/api/production', productionRouter);
app.use('/api/production-board', productionBoardRouter);
app.use('/api/production-stages', productionBoardRouter);
app.use('/api/customers', customersRouter);
app.use('/api/delivery', deliveryRouter);
app.use('/api/departments', departmentsRouter);
app.use('/api/barcode', barcodeRouter);
app.use('/api/users', usersRouter);
app.use('/api/matrix', matrixRouter);
app.use('/api/products', productsRouter);

// Admin settings endpoint (admin only)
app.get('/api/admin/settings', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  res.json({
    message: 'System settings and configuration',
    features: ['user_management', 'department_settings', 'barcode_settings', 'system_logs'],
  });
});

// Admin placeholder
app.get('/api/admin', auth.requireAuth, auth.requireRole('admin'), (req, res) => res.json({ message: 'admin endpoint', user: req.user }));

// Customer placeholder
app.get('/api/customer', auth.requireAuth, (req, res) => res.json({ message: 'customer endpoint (placeholder)', user: req.user }));

// Delivery / will-call rules placeholder
app.get('/api/delivery/rules', auth.requireAuth, (req, res) => res.json({ message: 'delivery rules (placeholder)' }));

app.listen(port, () => {
  console.log(`Launchpad backend listening on port ${port}`);
});
