const express = require('express');
const auth = require('../auth');
const quotes = require('../quotes');
const { sendError } = require('../httpError');

const router = express.Router();

router.get('/summary', auth.requireAuth, async (req, res) => {
  try {
    res.json(await quotes.summary(req.user));
  } catch (err) {
    sendError(res, err, 'QUOTE SUMMARY ERROR:', 'Failed to load quote requests');
  }
});

router.get('/', auth.requireAuth, async (req, res) => {
  try {
    res.json(await quotes.listQuotes(req.user, req.query || {}));
  } catch (err) {
    sendError(res, err, 'QUOTE LIST ERROR:', 'Failed to load quote requests');
  }
});

router.post('/', auth.requireAuth, async (req, res) => {
  try {
    const quote = await quotes.createQuote(req.user, req.body || {});
    res.status(201).json({ quote });
  } catch (err) {
    sendError(res, err, 'QUOTE CREATE ERROR:', 'Failed to create quote request');
  }
});

router.get('/:id/order-draft', auth.requireAuth, async (req, res) => {
  try {
    res.json(await quotes.orderDraft(req.user, req.params.id));
  } catch (err) {
    sendError(res, err, 'QUOTE DRAFT ERROR:', 'Failed to prepare the order');
  }
});

router.get('/:id', auth.requireAuth, async (req, res) => {
  try {
    res.json({ quote: await quotes.getQuote(req.user, req.params.id) });
  } catch (err) {
    sendError(res, err, 'QUOTE DETAIL ERROR:', 'Failed to load quote request');
  }
});

router.post('/:id/quote', auth.requireAuth, async (req, res) => {
  try {
    res.json(await quotes.sendQuote(req.user, req.params.id, req.body || {}));
  } catch (err) {
    sendError(res, err, 'QUOTE SEND ERROR:', 'Failed to send quote');
  }
});

router.post('/:id/accept', auth.requireAuth, async (req, res) => {
  try {
    res.json({ quote: await quotes.decide(req.user, req.params.id, 'accept', req.body || {}) });
  } catch (err) {
    sendError(res, err, 'QUOTE ACCEPT ERROR:', 'Failed to accept quote');
  }
});

router.post('/:id/decline', auth.requireAuth, async (req, res) => {
  try {
    res.json({ quote: await quotes.decide(req.user, req.params.id, 'decline', req.body || {}) });
  } catch (err) {
    sendError(res, err, 'QUOTE DECLINE ERROR:', 'Failed to decline quote');
  }
});

module.exports = router;
