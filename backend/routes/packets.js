const express = require('express');
const auth = require('../auth');
const db = require('../db');
const { isAllowedPacketStatus } = require('../utils/departmentPackets');

const router = express.Router();

router.put('/:id/status', auth.requireAuth, (req, res) => {
  const packetId = Number(req.params.id);
  const status = String(req.body?.status || '').trim();

  if (!Number.isInteger(packetId) || packetId <= 0) {
    return res.status(400).json({ error: 'Invalid packet id' });
  }

  if (!isAllowedPacketStatus(status)) {
    return res.status(400).json({ error: 'Invalid packet status' });
  }

  db.run(
    `UPDATE work_order_department_packets
     SET status = ?,
         completed_at = CASE WHEN ? = 'Complete' THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END,
         updated_at = datetime('now')
     WHERE id = ?`,
    [status, status, packetId],
    function onUpdate(err) {
      if (err) {
        console.error('PACKET STATUS UPDATE ERROR:', err);
        return res.status(500).json({ error: 'Failed to update packet status' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Packet not found' });
      }

      db.get(
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
         WHERE p.id = ?`,
        [packetId],
        (readErr, row) => {
          if (readErr) {
            console.error('PACKET STATUS READBACK ERROR:', readErr);
            return res.status(500).json({ error: 'Packet updated but failed to load result' });
          }
          res.json(row);
        }
      );
    }
  );
});

router.put('/:id/qc-received', auth.requireAuth, (req, res) => {
  const packetId = Number(req.params.id);

  if (!Number.isInteger(packetId) || packetId <= 0) {
    return res.status(400).json({ error: 'Invalid packet id' });
  }

  db.run(
    `UPDATE work_order_department_packets
     SET received_in_qc_at = COALESCE(received_in_qc_at, datetime('now')),
         status = CASE WHEN status = 'Complete' THEN status ELSE 'In QC' END,
         updated_at = datetime('now')
     WHERE id = ?`,
    [packetId],
    function onUpdate(err) {
      if (err) {
        console.error('PACKET QC RECEIVED UPDATE ERROR:', err);
        return res.status(500).json({ error: 'Failed to mark packet as received in QC' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Packet not found' });
      }

      db.get(
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
         WHERE p.id = ?`,
        [packetId],
        (readErr, row) => {
          if (readErr) {
            console.error('PACKET QC RECEIVED READBACK ERROR:', readErr);
            return res.status(500).json({ error: 'Packet updated but failed to load result' });
          }
          res.json(row);
        }
      );
    }
  );
});

module.exports = router;
