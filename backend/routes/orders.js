const express = require('express');
const auth = require('../auth');
const {
  OrderError,
  createOrder,
  transferOrder,
  listOrders,
  getOrder,
  orderOptions,
  previewOrder,
  presentOrder,
  listBillTos,
} = require('../orderService');
const { printForOrder } = require('../printWorkOrder');

const router = express.Router();
const orderRoles = auth.requireRole('admin', 'manager', 'operator', 'customer');

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

router.get('/bill-tos', auth.requireAuth, orderRoles, async (req, res) => {
  try {
    res.json(await listBillTos(req.user, req.query || {}));
  } catch (err) {
    sendOrderError(res, err, 'ORDER BILL TO ERROR:');
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

router.get('/:id/print', auth.requireAuth, orderRoles, async (req, res) => {
  try {
    const payload = await printForOrder(req.user, req.params.id);
    if (!payload) return res.status(404).json({ error: 'Order not found' });
    res.json(payload);
  } catch (err) {
    sendOrderError(res, err, 'ORDER PRINT ERROR:');
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

router.post('/:id/location', auth.requireAuth, auth.requireRole('admin', 'manager'), async (req, res) => {
  try {
    res.json(await transferOrder(req.user, req.params.id, req.body || {}));
  } catch (err) {
    sendOrderError(res, err, 'ORDER TRANSFER ERROR:');
  }
});

module.exports = router;
