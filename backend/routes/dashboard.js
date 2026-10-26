const express = require('express');
const auth = require('../auth');
const db = require('../db');
const shopLocations = require('../shopLocations');
const { ACTIVE_WORK_ORDER_STATUSES, sqlStringList } = require('../statuses');
const router = express.Router();

router.use(auth.requireAuth, auth.requireRole('admin', 'manager', 'operator'));

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || { count: 0 })));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

const WORK_FROM = `FROM work_orders wo LEFT JOIN orders o ON o.id = wo.order_id`;
const BOARD_FROM = `FROM production_board pb
  LEFT JOIN work_orders wo ON wo.id = pb.work_order_id
  LEFT JOIN orders o ON o.id = wo.order_id`;
const DELIVERY_FROM = `FROM deliveries d
  LEFT JOIN work_orders wo ON wo.id = d.work_order_id
  LEFT JOIN orders o ON o.id = COALESCE(d.order_id, wo.order_id)`;

router.get('/', async (req, res) => {
  try {
    const access = await shopLocations.loadAccess(req.user.userId);
    const shop = shopLocations.predicate('COALESCE(wo.location_id, o.location_id)', access);
    const where = shop.sql ? `WHERE ${shop.sql}` : '';
    const andShop = shop.sql ? `AND ${shop.sql}` : '';
    const activeList = sqlStringList(ACTIVE_WORK_ORDER_STATUSES);
    const orderShop = shopLocations.predicate('o.location_id', access);
    const readyWhere = orderShop.sql
      ? `WHERE lower(trim(coalesce(o.status, ''))) = 'ready for pickup' AND ${orderShop.sql}`
      : `WHERE lower(trim(coalesce(o.status, ''))) = 'ready for pickup'`;
    const [total, active, board, customers, deliveries, ready, departments] = await Promise.all([
      get(`SELECT COUNT(*) AS count ${WORK_FROM} ${where}`, shop.params),
      get(
        `SELECT COUNT(*) AS count ${WORK_FROM} WHERE wo.status IN (${activeList}) ${andShop}`,
        shop.params
      ),
      get(`SELECT COUNT(*) AS count ${BOARD_FROM} ${where}`, shop.params),
      get(`SELECT COUNT(*) AS count FROM users WHERE role = 'customer'`),
      get(
        `SELECT COUNT(*) AS count ${DELIVERY_FROM} WHERE lower(d.status) != 'complete' ${andShop}`,
        shop.params
      ),
      get(`SELECT COUNT(*) AS count FROM orders o ${readyWhere}`, orderShop.params),
      all(
        `SELECT wo.department AS department, COUNT(*) AS count
         ${WORK_FROM}
         ${where}
         GROUP BY wo.department
         ORDER BY count DESC`,
        shop.params
      ),
    ]);
    res.json({
      totalWorkOrders: total.count,
      activeWorkOrders: active.count,
      productionBoardItems: board.count,
      customers: customers.count,
      pendingDeliveries: deliveries.count,
      readyForPickup: ready.count,
      departmentSummary: departments,
    });
  } catch (err) {
    console.error('DASHBOARD ERROR:', err);
    return res.status(500).json({ error: 'Failed to load dashboard summary' });
  }
});

module.exports = router;
