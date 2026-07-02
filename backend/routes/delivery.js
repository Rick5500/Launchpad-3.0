const express = require('express');
const auth = require('../auth');
const db = require('../db');
const { getDeliveryQueueWorkOrders } = require('../utils/workOrderHelpers');
const router = express.Router();

router.get('/', auth.requireAuth, (req, res) => {
  getDeliveryQueueWorkOrders('all', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load deliveries' });
    
    if (!rows || rows.length === 0) {
      return res.json([]);
    }

    // Get products for each delivery
    let completed = 0;
    const result = rows.map(row => ({
      ...row,
      products: [],
    }));

    rows.forEach((row, idx) => {
      db.all(
        `SELECT p.name, woli.quantity
         FROM work_order_line_items woli
         JOIN products p ON woli.product_id = p.id
         WHERE woli.work_order_id = ?`,
        [row.id],
        (err, products) => {
          if (!err && products) {
            result[idx].products = products;
          }
          completed++;
          if (completed === rows.length) {
            res.json(result);
          }
        }
      );
    });
  });
});

// Get upcoming deliveries (QC Complete, ready for delivery/will-call)
// Uses work_orders.delivery_method as the source of truth
router.get('/upcoming', auth.requireAuth, (req, res) => {
  const deliveryType = req.query.type || 'all'; // 'delivery', 'will_call', or 'all'
  
  getDeliveryQueueWorkOrders(deliveryType, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load upcoming deliveries' });
    res.json(rows || []);
  });
});

module.exports = router;
