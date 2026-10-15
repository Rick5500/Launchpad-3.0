const WORK_ORDER_STATUSES = Object.freeze(['open', 'in-progress', 'completed', 'on-hold']);
const ACTIVE_WORK_ORDER_STATUSES = Object.freeze(['open', 'in-progress']);
// Legacy rows may still say "complete". New work orders are stored as "completed".
const FINISHED_WORK_ORDER_STATUSES = Object.freeze(['completed', 'complete']);
// Deliveries keep "complete" for a finished delivery. Do not reuse the work-order value "completed".
const DELIVERY_STATUSES = Object.freeze(['pending', 'scheduled', 'out-for-delivery', 'complete']);

function sqlStringList(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

module.exports = {
  WORK_ORDER_STATUSES,
  ACTIVE_WORK_ORDER_STATUSES,
  FINISHED_WORK_ORDER_STATUSES,
  DELIVERY_STATUSES,
  sqlStringList,
};
