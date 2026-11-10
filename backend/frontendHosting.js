// The Vite dev server has the same /terms, /privacy, and /sms-opt-in routes.
// This process also returns those three pages directly, with no login, so they
// stay public when the built app is not being served. Production still serves
// the built frontend from productionStatic.js for every other client route.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { isProduction } = require('./runtimeConfig');
const { publicPageHtml } = require('./publicPages');

const frontendPublic = path.resolve(__dirname, '..', 'frontend', 'public');

function mountFrontend(app) {
  if (!isProduction() && fs.existsSync(frontendPublic)) {
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
};
