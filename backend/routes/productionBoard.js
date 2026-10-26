const express = require('express');
const auth = require('../auth');
const db = require('../db');
const shopLocations = require('../shopLocations');
const { FINISHED_WORK_ORDER_STATUSES, sqlStringList } = require('../statuses');
const router = express.Router();

router.use(auth.requireAuth, auth.requireRole('admin', 'manager', 'operator'));

function serializeBoardResponse(res, stages, workOrders, metrics) {
  res.json({ stages, workOrders, metrics });
}

router.get('/', (req, res) => {
  const basePath = req.baseUrl || '';
  const isStagesEndpoint = basePath.includes('production-stages');

  if (isStagesEndpoint) {
    db.all(
      `SELECT id, name, color, icon, sort_order FROM production_stages ORDER BY sort_order ASC, name ASC`,
      [],
      (err, stages) => {
        if (err) return res.status(500).json({ error: 'Failed to load production stages' });
        res.json(stages || []);
      }
    );
    return;
  }

  shopLocations.loadAccess(req.user.userId).then((access) => {
    const pred = shopLocations.predicate('wo.location_id', access);
    const plain = shopLocations.predicate('location_id', access);
    const where = pred.sql ? `WHERE ${pred.sql}` : '';
    const andPlain = plain.sql ? `AND ${plain.sql}` : '';
  db.all(
    `SELECT id, name, color, icon, sort_order FROM production_stages ORDER BY sort_order ASC, name ASC`,
    [],
    (err, stages) => {
      if (err) return res.status(500).json({ error: 'Failed to load production stages' });

      db.all(
        `SELECT
          wo.id,
          wo.external_id,
          wo.description,
          wo.department,
          wo.priority,
          wo.stage_id,
          wo.due_date,
          wo.estimated_hours,
          wo.actual_hours,
          wo.created_at,
          wo.location_id,
          l.name AS location_name,
          ps.name AS stage_name,
          ps.color AS stage_color,
          u.display_name AS customer_name,
          u.username AS customer_username,
          au.display_name AS assigned_user_name,
          au.username AS assigned_user_username,
          d.name AS assigned_department_name
        FROM work_orders wo
        LEFT JOIN production_stages ps ON wo.stage_id = ps.id
        LEFT JOIN users u ON wo.customer_id = u.id
        LEFT JOIN users au ON wo.assigned_user_id = au.id
        LEFT JOIN departments d ON wo.assigned_department_id = d.id
        LEFT JOIN locations l ON l.id = wo.location_id
        ${where}
        ORDER BY ps.sort_order ASC, wo.due_date ASC, wo.created_at DESC`,
        pred.params,
        (err2, workOrders) => {
          if (err2) return res.status(500).json({ error: 'Failed to load production board data' });

              db.all(
            `SELECT ps.name AS stage_name, COUNT(*) AS count
             FROM work_orders wo
             LEFT JOIN production_stages ps ON wo.stage_id = ps.id
             ${where}
             GROUP BY ps.id, ps.name
             ORDER BY ps.sort_order ASC`,
            pred.params,
            (err3, stageCounts) => {
              if (err3) return res.status(500).json({ error: 'Failed to load stage counts' });

              db.get(`SELECT COUNT(*) AS count FROM work_orders WHERE priority = 'Rush' ${andPlain}`, plain.params, (err4, rushRow) => {
                if (err4) return res.status(500).json({ error: 'Failed to load rush order count' });

                db.get(
                  `SELECT COUNT(*) AS count FROM work_orders WHERE due_date IS NOT NULL AND date(due_date) < date('now') AND lower(status) NOT IN (${sqlStringList(FINISHED_WORK_ORDER_STATUSES)}) ${andPlain}`,
                  plain.params,
                  (err5, lateRow) => {
                    if (err5) return res.status(500).json({ error: 'Failed to load late order count' });

                    db.get(
                      `SELECT COUNT(*) AS count
                       FROM deliveries d
                       LEFT JOIN work_orders wo ON wo.id = d.work_order_id
                       WHERE date(d.due_time) = date('now') AND lower(d.status) != 'complete'
                       ${pred.sql ? `AND ${pred.sql}` : ''}`,
                      pred.params,
                      (err6, shipmentRow) => {
                        if (err6) return res.status(500).json({ error: 'Failed to load shipment count' });

                        const metrics = {
                          workOrdersByStage: stageCounts || [],
                          rushOrders: Number(rushRow?.count || 0),
                          lateOrders: Number(lateRow?.count || 0),
                          todaysShipments: Number(shipmentRow?.count || 0),
                        };

                        serializeBoardResponse(res, stages || [], workOrders || [], metrics);
                      }
                    );
                  }
                );
              });
            }
          );
        }
      );
    }
  );
  }).catch((err) => {
    console.error('PRODUCTION BOARD ERROR:', err);
    return res.status(500).json({ error: 'Failed to load production board data' });
  });
});

module.exports = router;
