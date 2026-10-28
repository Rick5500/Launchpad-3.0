// Quality and the departments after it, identified by departments.dept_key.
// A rename keeps the key, so a display-name change does not drop a stage
// off the ready-for-delivery check.

const { get, all } = require('./dbAsync');

const STAGE_KEYS = Object.freeze(['quality', 'dispatch', 'delivery', 'complete']);

function dbOf(executor) {
  if (executor && typeof executor.get === 'function' && typeof executor.all === 'function') return executor;
  return { get, all };
}

function normalizedKey(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || null;
}

function keyForRow(row) {
  if (!row) return null;
  const stored = normalizedKey(row.dept_key);
  if (stored) return stored;
  const name = normalizedKey(row.name);
  return STAGE_KEYS.includes(name) ? name : null;
}

function isQualityDepartmentRow(row) {
  return keyForRow(row) === 'quality';
}

async function loadStages(executor) {
  const db = dbOf(executor);
  const rows = await db.all(`SELECT id, name, dept_key FROM departments`);
  const readyIds = new Set();
  const readyNames = new Set();
  let qualityId = null;
  for (const row of rows || []) {
    const key = keyForRow(row);
    if (key === 'quality') qualityId = Number(row.id);
    if (!STAGE_KEYS.includes(key)) continue;
    readyIds.add(Number(row.id));
    const name = normalizedKey(row.name);
    if (name) readyNames.add(name);
  }
  return { readyIds, readyNames, qualityId };
}

async function isQualityDepartmentId(executor, departmentId) {
  const id = Number(departmentId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const db = dbOf(executor);
  const row = await db.get(`SELECT id, name, dept_key FROM departments WHERE id = ?`, [id]);
  return isQualityDepartmentRow(row);
}

function workOrderAtOrPastQuality(workOrder, stages) {
  if (!workOrder || !stages) return false;
  if (workOrder.assigned_department_id != null && stages.readyIds.has(Number(workOrder.assigned_department_id))) {
    return true;
  }
  const name = normalizedKey(workOrder.department);
  return Boolean(name) && stages.readyNames.has(name);
}

async function allWorkOrdersAtOrPastQuality(executor, workOrders) {
  const rows = workOrders || [];
  if (!rows.length) return false;
  const stages = await loadStages(executor);
  return rows.every((row) => workOrderAtOrPastQuality(row, stages));
}

module.exports = {
  STAGE_KEYS,
  isQualityDepartmentRow,
  isQualityDepartmentId,
  loadStages,
  workOrderAtOrPastQuality,
  allWorkOrdersAtOrPastQuality,
};
