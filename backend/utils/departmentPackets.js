const db = require('../db');

const suffixByDepartmentName = {
  graphics: 'GFX',
  'signs & graphics': 'GFX',
  'signs and graphics': 'GFX',
  'small format': 'SF',
  reprographics: 'REP',
  scanning: 'SCN',
};

const allowedPacketStatuses = new Set([
  'Waiting',
  'In Progress',
  'In QC',
  'On Hold',
  'Complete',
  'No Longer Required',
]);

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function normalizeDepartmentName(name) {
  return String(name || '').trim().toLowerCase();
}

function getDepartmentPacketSuffix(departmentName) {
  return suffixByDepartmentName[normalizeDepartmentName(departmentName)] || null;
}

function buildPacketNumber(parentWorkOrderNumber, departmentName) {
  const suffix = getDepartmentPacketSuffix(departmentName);
  if (!suffix) return null;
  return `${parentWorkOrderNumber}-${suffix}`;
}

function getRequiredPacketDepartments(workOrderId) {
  return all(
    `SELECT DISTINCT d.id, d.name, d.sort_order
     FROM work_order_line_items woli
     JOIN product_required_departments prd ON prd.product_id = woli.product_id
     JOIN departments d ON d.id = prd.department_id
     WHERE woli.work_order_id = ?
     ORDER BY d.sort_order ASC, d.name ASC`,
    [workOrderId]
  ).then((rows) => rows.filter((row) => getDepartmentPacketSuffix(row.name)));
}

async function syncDepartmentPackets(workOrderId) {
  await run('BEGIN TRANSACTION');

  try {
    const workOrder = await get(
      `SELECT id, external_id
       FROM work_orders
       WHERE id = ?`,
      [workOrderId]
    );

    if (!workOrder) {
      throw new Error('Work order not found');
    }

    const parentWorkOrderNumber = String(workOrder.external_id || workOrder.id).trim();
    const requiredDepartments = await getRequiredPacketDepartments(workOrderId);
    const requiredByDepartmentId = new Map(requiredDepartments.map((dept) => [dept.id, dept]));

    const existingPackets = await all(
      `SELECT id, department_id, packet_number, barcode_value, status, printed_at, received_in_qc_at, completed_at
       FROM work_order_department_packets
       WHERE work_order_id = ?`,
      [workOrderId]
    );

    const existingByDepartmentId = new Map(existingPackets.map((packet) => [packet.department_id, packet]));

    let created = 0;
    let updated = 0;
    let deactivated = 0;

    for (const department of requiredDepartments) {
      const packetNumber = buildPacketNumber(parentWorkOrderNumber, department.name);
      if (!packetNumber) {
        continue;
      }

      const existingPacket = existingByDepartmentId.get(department.id);
      const barcodeValue = packetNumber;

      if (!existingPacket) {
        await run(
          `INSERT INTO work_order_department_packets
           (work_order_id, department_id, packet_number, status, barcode_value, created_at, updated_at)
           VALUES (?, ?, ?, 'In Progress', ?, datetime('now'), datetime('now'))`,
          [workOrderId, department.id, packetNumber, barcodeValue]
        );
        created += 1;
        continue;
      }

      const nextStatus = existingPacket.status === 'No Longer Required' ? 'In Progress' : existingPacket.status;
      const shouldUpdate =
        existingPacket.packet_number !== packetNumber ||
        existingPacket.barcode_value !== barcodeValue ||
        existingPacket.status !== nextStatus;

      if (shouldUpdate) {
        await run(
          `UPDATE work_order_department_packets
           SET packet_number = ?,
               barcode_value = ?,
               status = ?,
               updated_at = datetime('now')
           WHERE id = ?`,
          [packetNumber, barcodeValue, nextStatus, existingPacket.id]
        );
        updated += 1;
      }
    }

    for (const packet of existingPackets) {
      if (requiredByDepartmentId.has(packet.department_id)) {
        continue;
      }

      if (packet.status === 'No Longer Required') {
        continue;
      }

      // Preserve completed/QC-progress packets as-is; only deactivate active/unfinished packets.
      const canDeactivate = !packet.received_in_qc_at && !packet.completed_at;
      if (!canDeactivate) {
        continue;
      }

      await run(
        `UPDATE work_order_department_packets
         SET status = 'No Longer Required',
             updated_at = datetime('now')
         WHERE id = ?`,
        [packet.id]
      );
      deactivated += 1;
    }

    await run('COMMIT');

    return {
      work_order_id: Number(workOrderId),
      required_departments: requiredDepartments.length,
      created,
      updated,
      deactivated,
    };
  } catch (err) {
    try {
      await run('ROLLBACK');
    } catch (rollbackErr) {
      console.error('PACKET SYNC ROLLBACK ERROR:', rollbackErr);
    }
    throw err;
  }
}

function getPacketsForWorkOrder(workOrderId, callback) {
  db.all(
    `SELECT
      p.id,
      p.work_order_id,
      p.department_id,
      d.name AS department_name,
      p.packet_number,
      p.status,
      p.barcode_value,
      p.printed_at,
      p.received_in_qc_at,
      p.completed_at,
      p.created_at,
      p.updated_at
     FROM work_order_department_packets p
     LEFT JOIN departments d ON d.id = p.department_id
     WHERE p.work_order_id = ?
     ORDER BY d.sort_order ASC, p.packet_number ASC`,
    [workOrderId],
    callback
  );
}

function isAllowedPacketStatus(status) {
  return allowedPacketStatuses.has(status);
}

module.exports = {
  buildPacketNumber,
  getDepartmentPacketSuffix,
  getPacketsForWorkOrder,
  isAllowedPacketStatus,
  syncDepartmentPackets,
};
