const express = require('express');
const auth = require('../auth');
const users = require('../userAdmin');
const { sendError } = require('../httpError');

const router = express.Router();

router.get('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await users.listUsers(req.query));
  } catch (err) {
    sendError(res, err, 'USERS LIST ERROR:', 'Failed to load users');
  }
});

router.post('/', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const created = await users.createUser(req.user.userId, req.body);
    res.status(201).json(created);
  } catch (err) {
    sendError(res, err, 'USERS CREATE ERROR:', 'Failed to create user');
  }
});

router.get('/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await users.getUser(req.params.id));
  } catch (err) {
    sendError(res, err, 'USERS GET ERROR:', 'Failed to load user');
  }
});

router.put('/:id/password', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const result = await users.resetPassword(
      req.user.userId,
      req.params.id,
      req.body,
      users.bearerToken(req)
    );
    res.json(result);
  } catch (err) {
    sendError(res, err, 'USERS PASSWORD ERROR:', 'Failed to reset password');
  }
});

router.put('/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    res.json(await users.updateUser(req.user.userId, req.params.id, req.body));
  } catch (err) {
    sendError(res, err, 'USERS UPDATE ERROR:', 'Failed to update user');
  }
});

module.exports = router;
