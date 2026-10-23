const fs = require('fs');
const path = require('path');
const express = require('express');
const { frontendDistDir, isProduction } = require('./runtimeConfig');

function mountProductionFrontend(app) {
  if (!isProduction()) return { enabled: false, dist: null };

  const dist = frontendDistDir();
  const indexFile = path.join(dist, 'index.html');
  if (!fs.existsSync(indexFile)) {
    console.error(`FRONTEND BUILD MISSING: ${indexFile}. Run npm run build before starting in production.`);
  }

  const staticFiles = express.static(dist, {
    index: false,
    fallthrough: true,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/api' || req.path.startsWith('/api/')) return next();
    return staticFiles(req, res, next);
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/health' || req.path === '/api' || req.path.startsWith('/api/')) return next();
    if (path.extname(req.path)) return res.status(404).type('text/plain').send('Not found');
    if (!fs.existsSync(indexFile)) {
      return res.status(404).type('text/plain').send('Frontend build is missing');
    }
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(indexFile);
  });

  return { enabled: true, dist };
}

module.exports = {
  mountProductionFrontend,
};
