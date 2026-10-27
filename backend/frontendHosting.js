// Local development serves the Vite app, which has the same /terms, /privacy,
// and /sms-opt-in routes. A production process serves the built frontend from
// this server. When that build is not present, these three pages are still
// returned directly so they stay public.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { publicPageHtml } = require('./publicPages');

const frontendDist = path.resolve(__dirname, '..', 'frontend', 'dist');
const frontendIndex = path.join(frontendDist, 'index.html');
const frontendPublic = path.resolve(__dirname, '..', 'frontend', 'public');

function hasBuiltFrontend() {
  try {
    return fs.existsSync(frontendIndex);
  } catch (err) {
    return false;
  }
}

function isApiPath(urlPath) {
  return urlPath === '/api' || urlPath.startsWith('/api/') || urlPath === '/health';
}

// Vite marks the built script as crossorigin. The browser then requires
// Access-Control-Allow-Origin even when the file is served from this same host.
function reflectPageOrigin(res, req) {
  const origin = req && req.headers ? req.headers.origin : '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
}

function mountFrontend(app) {
  if (hasBuiltFrontend()) {
    app.use(express.static(frontendDist, {
      index: false,
      redirect: false,
      fallthrough: true,
      setHeaders(res) {
        reflectPageOrigin(res, res.req);
      },
    }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (isApiPath(req.path)) return next();
      if (path.extname(req.path)) return next();
      res.set('Cache-Control', 'no-cache');
      reflectPageOrigin(res, req);
      res.sendFile(frontendIndex, (err) => {
        if (err) next(err);
      });
    });
    return { mode: 'spa' };
  }

  if (fs.existsSync(frontendPublic)) {
    app.use(express.static(frontendPublic, {
      index: false,
      redirect: false,
      fallthrough: true,
    }));
  }
  app.get(['/terms', '/privacy', '/sms-opt-in'], (req, res) => {
    const html = publicPageHtml(req.path);
    if (!html) return res.status(404).type('text').send('Not found');
    res.status(200).type('html').send(html);
  });
  return { mode: 'public-pages' };
}

module.exports = {
  mountFrontend,
  hasBuiltFrontend,
};
