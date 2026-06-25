require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get('/api/health', (req, res) => res.json({status: 'ok', env: process.env.NODE_ENV || 'development'}));

// Auth placeholder
app.post('/api/auth/login', (req, res) => {
  // TODO: implement auth (JWT/session)
  res.json({message: 'login endpoint (placeholder)'});
});

// Admin placeholder
app.get('/api/admin', (req, res) => res.json({message: 'admin endpoint (placeholder)'}));

// Customer placeholder
app.get('/api/customer', (req, res) => res.json({message: 'customer endpoint (placeholder)'}));

// Work orders placeholder
app.post('/api/workorders', (req, res) => res.json({message: 'create work order (placeholder)'}));
app.get('/api/workorders', (req, res) => res.json({message: 'list work orders (placeholder)'}));

// Production board placeholder
app.get('/api/production', (req, res) => res.json({message: 'production board (placeholder)'}));

// Barcode tracking placeholder
app.post('/api/barcode', (req, res) => res.json({message: 'barcode event recorded (placeholder)'}));

// Delivery / will-call rules placeholder
app.get('/api/delivery/rules', (req, res) => res.json({message: 'delivery rules (placeholder)'}));

app.listen(port, () => {
  console.log(`Launchpad backend listening on port ${port}`);
});
