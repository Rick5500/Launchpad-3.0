require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

const auth = require('./auth');
const db = require('./db');

app.use(express.json());

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

// Admin placeholder
app.get('/api/admin', auth.requireAuth, (req, res) => res.json({ message: 'admin endpoint (placeholder)', user: req.user }));

// Customer placeholder
app.get('/api/customer', auth.requireAuth, (req, res) => res.json({ message: 'customer endpoint (placeholder)', user: req.user }));

// Work orders placeholder
app.post('/api/workorders', auth.requireAuth, (req, res) => res.json({ message: 'create work order (placeholder)' }));
app.get('/api/workorders', auth.requireAuth, (req, res) => res.json({ message: 'list work orders (placeholder)' }));

// Production board placeholder
app.get('/api/production', auth.requireAuth, (req, res) => res.json({ message: 'production board (placeholder)' }));

// Barcode tracking placeholder
app.post('/api/barcode', auth.requireAuth, (req, res) => res.json({ message: 'barcode event recorded (placeholder)' }));

// Delivery / will-call rules placeholder
app.get('/api/delivery/rules', auth.requireAuth, (req, res) => res.json({ message: 'delivery rules (placeholder)' }));

app.listen(port, () => {
  console.log(`Launchpad backend listening on port ${port}`);
});
