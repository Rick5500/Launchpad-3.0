const express = require('express');
const auth = require('../auth');
const {
  OrderError,
  createOrder,
  listOrders,
  getOrder,
  orderOptions,
  previewOrder,
  presentOrder,
} = require('../orderService');

const router = express.Router();
const orderRoles = auth.requireRole('admin', 'operator', 'customer');

function sendOrderError(res, err, fallback) {
  if (err instanceof OrderError || err.status) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: 'Failed to process order' });
}

router.get('/options', auth.requireAuth, orderRoles, async (req, res) => {
  try {
    res.json(await orderOptions());
  } catch (err) {
    sendOrderError(res, err, 'ORDER OPTIONS ERROR:');
  }
});

router.get('/preview', auth.requireAuth, orderRoles, async (req, res) => {
  try {
    res.json(await previewOrder(req.query || {}));
  } catch (err) {
    sendOrderError(res, err, 'ORDER PREVIEW ERROR:');
  }
});

router.get('/', auth.requireAuth, orderRoles, async (req, res) => {
  try {
    res.json(await listOrders(req.user, req.query || {}));
  } catch (err) {
    sendOrderError(res, err, 'ORDER LIST ERROR:');
  }
});

router.get('/:id', auth.requireAuth, orderRoles, async (req, res) => {
  try {
    const order = await getOrder(req.user, req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(presentOrder(order));
  } catch (err) {
    sendOrderError(res, err, 'ORDER DETAIL ERROR:');
  }
});

router.post('/', auth.requireAuth, orderRoles, async (req, res) => {
  try {
    const created = await createOrder(req.user, req.body || {});
    res.status(201).json(created);
  } catch (err) {
    sendOrderError(res, err, 'ORDER CREATE ERROR:');
  }
});

module.exports = router;
