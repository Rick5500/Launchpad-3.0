const express = require('express');
const auth = require('../auth');
const db = require('../db');
const router = express.Router();

// POST /api/barcode/scan - Scan a barcode and update work order
router.post('/scan', auth.requireAuth, (req, res) => {
  const {
    barcode_value, // Can be work order ID or other barcode format
    work_order_id, // Explicit work order ID
    new_stage_id, // Optional: stage to move to
    new_department_id, // Optional: department to move to
    note, // Optional: note about the scan
  } = req.body || {};

  // Determine which work order we're scanning
  const targetWorkOrderId = work_order_id || barcode_value;

  if (!targetWorkOrderId) {
    return res.status(400).json({ error: 'barcode_value or work_order_id is required' });
  }

  // Verify the work order exists
  db.get(
    `SELECT id, stage_id, assigned_department_id FROM work_orders WHERE id = ?`,
    [targetWorkOrderId],
    (err, workOrder) => {
      if (err) {
        console.error('BARCODE SCAN ERROR:', err);
        return res.status(500).json({ error: 'Failed to scan barcode' });
      }

      if (!workOrder) {
        return res.status(404).json({ error: 'Work order not found' });
      }

      let updates = [];
      let params = [];

      // Prepare stage update if provided
      if (new_stage_id) {
        updates.push('stage_id = ?');
        params.push(new_stage_id);
      }

      // Prepare department update if provided
      if (new_department_id) {
        updates.push('assigned_department_id = ?');
        params.push(new_department_id);
      }

      // Always update the timestamp
      updates.push('updated_at = datetime("now")');

      params.push(targetWorkOrderId);

      // Update the work order if there are any changes
      if (updates.length > 1) {
        // More than just the timestamp
        db.run(
          `UPDATE work_orders SET ${updates.join(', ')} WHERE id = ?`,
          params,
          function (err2) {
            if (err2) {
              console.error('BARCODE UPDATE ERROR:', err2);
              return res.status(500).json({ error: 'Failed to update work order' });
            }

            // Create timeline event for the scan
            const eventType = [];
            if (new_stage_id) eventType.push('stage_change');
            if (new_department_id) eventType.push('department_change');

            db.run(
              `INSERT INTO work_order_events (work_order_id, event_type, from_stage_id, to_stage_id, from_department_id, to_department_id, note)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                targetWorkOrderId,
                eventType.join('+'),
                new_stage_id ? workOrder.stage_id : null,
                new_stage_id || null,
                new_department_id ? workOrder.assigned_department_id : null,
                new_department_id || null,
                note || null,
              ],
              function (err3) {
                if (err3) {
                  console.error('BARCODE EVENT CREATE ERROR:', err3);
                  // Don't fail the response if event creation fails
                }

                res.json({
                  success: true,
                  work_order_id: targetWorkOrderId,
                  barcode_value: barcode_value,
                  stage_updated: !!new_stage_id,
                  department_updated: !!new_department_id,
                });
              }
            );
          }
        );
      } else {
        // Just the timestamp, still create an event for the scan
        db.run(
          `INSERT INTO work_order_events (work_order_id, event_type, note)
           VALUES (?, ?, ?)`,
          [
            targetWorkOrderId,
            'barcode_scan',
            note || null,
          ],
          function (err2) {
            if (err2) {
              console.error('BARCODE EVENT CREATE ERROR:', err2);
              return res.status(500).json({ error: 'Failed to create scan event' });
            }

            res.json({
              success: true,
              work_order_id: targetWorkOrderId,
              barcode_value: barcode_value,
              stage_updated: false,
              department_updated: false,
            });
          }
        );
      }
    }
  );
});

module.exports = router;
