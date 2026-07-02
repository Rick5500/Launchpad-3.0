/**
 * Work Order Query Helpers
 * Centralizes common queries for work orders to ensure consistency across modules
 */

const db = require('../db');

/**
 * Synchronize delivery_method from work_orders to work_order_matrix_state
 * Called when QC status changes to 'Complete' to auto-set delivery_type
 * @param {number} workOrderId - The work order ID
 * @param {function} callback - (err) callback
 */
function syncDeliveryMethod(workOrderId, callback) {
  // Get delivery_method from work_orders table
  db.get(
    'SELECT delivery_method FROM work_orders WHERE id = ?',
    [workOrderId],
    (err, row) => {
      if (err) return callback(err);
      if (!row) return callback(new Error('Work order not found'));

      const deliveryType = row.delivery_method || 'delivery';
      
      // Sync to work_order_matrix_state.delivery_type
      db.run(
        `UPDATE work_order_matrix_state 
         SET delivery_type = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE work_order_id = ?`,
        [deliveryType, workOrderId],
        callback
      );
    }
  );
}

/**
 * Get work order with all related data and matrix state
 * Used for detail views across all modules
 * @param {number} workOrderId - The work order ID
 * @param {function} callback - (err, result) callback
 */
function getWorkOrderWithMatrixState(workOrderId, callback) {
  const workOrderFields = `
    wo.id,
    wo.external_id,
    wo.customer_id,
    wo.description,
    wo.quantity,
    wo.status,
    wo.priority,
    wo.due_date,
    wo.delivery_method,
    wo.requested_delivery_time,
    wo.stage_id,
    wo.department,
    wo.assigned_department_id,
    wo.assigned_user_id,
    wo.estimated_hours,
    wo.actual_hours,
    wo.specifications,
    wo.start_date,
    wo.production_line,
    wo.routing_instructions,
    wo.attachments,
    wo.notes,
    wo.created_at,
    wo.updated_at
  `;

  const query = `
    SELECT 
      ${workOrderFields},
      u.display_name AS customer_name,
      u.username AS customer_username,
      ms.qc_status,
      ms.delivery_status,
      ms.is_completed
    FROM work_orders wo
    LEFT JOIN users u ON wo.customer_id = u.id
    LEFT JOIN work_order_matrix_state ms ON wo.id = ms.work_order_id
    WHERE wo.id = ?
  `;

  db.get(query, [workOrderId], callback);
}

/**
 * Get all work orders with matrix state for list views
 * @param {object} options - Query options
 *   - status: Filter by work_order status (default: 'open')
 *   - sortBy: Sort field (default: 'due_date')
 *   - sortOrder: 'ASC' or 'DESC' (default: 'ASC')
 *   - limit: Result limit (default: 500)
 * @param {function} callback - (err, results) callback
 */
function getAllWorkOrdersWithMatrixState(options = {}, callback) {
  const { status = 'open', sortBy = 'due_date', sortOrder = 'ASC', limit = 500 } = options;

  const workOrderFields = `
    wo.id,
    wo.external_id,
    wo.customer_id,
    wo.description,
    wo.quantity,
    wo.status,
    wo.priority,
    wo.due_date,
    wo.delivery_method,
    wo.requested_delivery_time,
    wo.created_at,
    wo.updated_at
  `;

  const query = `
    SELECT 
      ${workOrderFields},
      u.display_name AS customer_name,
      u.username AS customer_username,
      ms.qc_status,
      ms.delivery_status,
      ms.is_completed
    FROM work_orders wo
    LEFT JOIN users u ON wo.customer_id = u.id
    LEFT JOIN work_order_matrix_state ms ON wo.id = ms.work_order_id
    WHERE wo.status = ?
    ORDER BY wo.${sortBy} ${sortOrder}, wo.created_at DESC
    LIMIT ?
  `;

  db.all(query, [status, limit], (err, rows) => {
    if (err) return callback(err);
    if (!rows || rows.length === 0) return callback(null, []);

    // Get department statuses for all work orders
    const workOrderIds = rows.map(r => r.id);
    const placeholders = workOrderIds.map(() => '?').join(',');

    const deptQuery = `
      SELECT 
        wds.work_order_id,
        d.id AS dept_id,
        d.name,
        d.color,
        d.icon,
        wds.status
      FROM work_order_department_status wds
      JOIN departments d ON wds.department_id = d.id
      WHERE wds.work_order_id IN (${placeholders})
      ORDER BY d.sort_order ASC
    `;

    db.all(deptQuery, workOrderIds, (err2, deptStatuses) => {
      if (err2) return callback(err2);

      // Build department status map
      const deptMap = {};
      (deptStatuses || []).forEach(ds => {
        if (!deptMap[ds.work_order_id]) {
          deptMap[ds.work_order_id] = [];
        }
        deptMap[ds.work_order_id].push({
          id: ds.dept_id,
          name: ds.name,
          color: ds.color,
          icon: ds.icon,
          status: ds.status,
        });
      });

      // Attach department statuses to work orders
      const result = rows.map(wo => ({
        ...wo,
        department_statuses: deptMap[wo.id] || [],
      }));

      callback(null, result);
    });
  });
}

/**
 * Get work orders filtered for delivery queue
 * Only returns jobs where QC is complete and delivery is ready to be marked
 * @param {string} deliveryType - 'delivery' or 'will_call' or 'all'
 * @param {function} callback - (err, results) callback
 */
function getDeliveryQueueWorkOrders(deliveryType = 'all', callback) {
  let deliveryFilter = '';
  if (deliveryType === 'delivery') {
    deliveryFilter = "AND wo.delivery_method = 'delivery'";
  } else if (deliveryType === 'will_call') {
    deliveryFilter = "AND wo.delivery_method = 'will_call'";
  }

  const query = `
    SELECT 
      wo.id,
      wo.external_id,
      wo.description,
      wo.quantity,
      wo.delivery_method,
      wo.requested_delivery_time,
      u.display_name AS customer_name,
      ms.qc_status,
      ms.delivery_status,
      ms.is_completed
    FROM work_orders wo
    LEFT JOIN users u ON wo.customer_id = u.id
    LEFT JOIN work_order_matrix_state ms ON wo.id = ms.work_order_id
    WHERE wo.status = 'open' 
      AND ms.qc_status = 'Complete'
      AND ms.delivery_status IN ('Ready', 'Pending')
      ${deliveryFilter}
    ORDER BY wo.requested_delivery_time ASC NULLS LAST, wo.due_date ASC, wo.id ASC
  `;

  db.all(query, [], (err, rows) => {
    if (err) return callback(err);
    if (!rows || rows.length === 0) return callback(null, []);

    // Get department statuses for all work orders
    const workOrderIds = rows.map(r => r.id);
    const placeholders = workOrderIds.map(() => '?').join(',');

    const deptQuery = `
      SELECT 
        wds.work_order_id,
        d.id AS dept_id,
        d.name,
        d.color,
        wds.status
      FROM work_order_department_status wds
      JOIN departments d ON wds.department_id = d.id
      WHERE wds.work_order_id IN (${placeholders})
      ORDER BY d.sort_order ASC
    `;

    db.all(deptQuery, workOrderIds, (err2, deptStatuses) => {
      if (err2) return callback(err2);

      // Build department status map
      const deptMap = {};
      (deptStatuses || []).forEach(ds => {
        if (!deptMap[ds.work_order_id]) {
          deptMap[ds.work_order_id] = [];
        }
        deptMap[ds.work_order_id].push({
          id: ds.dept_id,
          name: ds.name,
          color: ds.color,
          status: ds.status,
        });
      });

      // Attach department statuses to work orders
      const result = rows.map(wo => ({
        ...wo,
        department_statuses: deptMap[wo.id] || [],
      }));

      callback(null, result);
    });
  });
}

module.exports = {
  syncDeliveryMethod,
  getWorkOrderWithMatrixState,
  getAllWorkOrdersWithMatrixState,
  getDeliveryQueueWorkOrders,
};
