const express = require('express');
const auth = require('../auth');
const reports = require('../reports');
const shopLocations = require('../shopLocations');

const router = express.Router();
const staffRoles = auth.requireRole('admin', 'manager', 'operator');

function sendReport(res, report, format, filename, columns) {
  if (format === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(reports.toCsv(columns, report.rows));
  }
  return res.json(report);
}

function handle(loader, filename, columns, options) {
  return async function reportHandler(req, res) {
    const parsed = reports.parseReportQuery(req.query, options);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    try {
      const access = await shopLocations.loadAccess(req.user.userId);
      const filter = await shopLocations.boardFilter(access, req.query);
      parsed.value.shopLocationId = filter.locationId;
      parsed.value.shopLocationNull = filter.includeNull;
    } catch (err) {
      console.error('REPORT ERROR:', err);
      return res.status(err.status || 500).json({ error: err.publicMessage || err.message || 'Failed to build report' });
    }
    loader(parsed.value, (err, report) => {
      if (err) {
        console.error('REPORT ERROR:', err);
        return res.status(500).json({ error: 'Failed to build report' });
      }
      sendReport(res, report, parsed.value.format, filename, columns);
    });
  };
}

router.get(
  '/work-orders/status',
  auth.requireAuth,
  staffRoles,
  handle(
    (query, cb) => reports.loadStatusReport(query, cb),
    'work-orders-by-status.csv',
    [
      { key: 'status', header: 'status' },
      { key: 'count', header: 'count' },
    ]
  )
);

router.get(
  '/work-orders/department',
  auth.requireAuth,
  staffRoles,
  handle(
    (query, cb) => reports.loadDepartmentReport(query, cb),
    'work-orders-by-department.csv',
    [
      { key: 'department', header: 'department' },
      { key: 'count', header: 'count' },
    ]
  )
);

router.get(
  '/work-orders/stage',
  auth.requireAuth,
  staffRoles,
  handle(
    (query, cb) => reports.loadStageReport(query, cb),
    'work-orders-by-stage.csv',
    [
      { key: 'stage_id', header: 'stage_id' },
      { key: 'stage_name', header: 'stage_name' },
      { key: 'count', header: 'count' },
    ]
  )
);

router.get(
  '/throughput',
  auth.requireAuth,
  staffRoles,
  handle(
    (query, cb) => reports.loadThroughputReport(query, query.bucket, cb),
    'throughput.csv',
    [
      { key: 'bucket', header: 'bucket' },
      { key: 'count', header: 'count' },
    ],
    { bucket: true }
  )
);

router.get(
  '/deliveries',
  auth.requireAuth,
  staffRoles,
  handle(
    (query, cb) => reports.loadDeliveryReport(query, cb),
    'deliveries-due.csv',
    [
      { key: 'id', header: 'id' },
      { key: 'work_order_id', header: 'work_order_id' },
      { key: 'external_id', header: 'external_id' },
      { key: 'customer_name', header: 'customer_name' },
      { key: 'will_call', header: 'will_call' },
      { key: 'due_time', header: 'due_time' },
      { key: 'carrier', header: 'carrier' },
      { key: 'delivery_method', header: 'delivery_method' },
      { key: 'ups_account_number', header: 'ups_account_number' },
      { key: 'payment_method', header: 'payment_method' },
      { key: 'bill_to_company', header: 'bill_to_company' },
      { key: 'status', header: 'status' },
      { key: 'overdue', header: 'overdue' },
      { key: 'due_today', header: 'due_today' },
      { key: 'timing', header: 'timing' },
    ]
  )
);

router.get(
  '/scans/operators',
  auth.requireAuth,
  staffRoles,
  handle(
    (query, cb) => reports.loadScansByOperator(query, cb),
    'scans-by-operator.csv',
    [
      { key: 'operator_id', header: 'operator_id' },
      { key: 'operator_username', header: 'operator_username' },
      { key: 'operator_name', header: 'operator_name' },
      { key: 'scan_count', header: 'scan_count' },
    ]
  )
);

router.get(
  '/scans/locations',
  auth.requireAuth,
  staffRoles,
  handle(
    (query, cb) => reports.loadScansByLocation(query, cb),
    'scans-by-location.csv',
    [
      { key: 'location', header: 'location' },
      { key: 'scan_count', header: 'scan_count' },
    ]
  )
);

router.get(
  '/stages/average-time',
  auth.requireAuth,
  staffRoles,
  handle(
    (query, cb) => reports.loadStageDurationReport(query, cb),
    'stage-time.csv',
    [
      { key: 'stage_id', header: 'stage_id' },
      { key: 'stage_name', header: 'stage_name' },
      { key: 'sample_count', header: 'sample_count' },
      { key: 'average_seconds', header: 'average_seconds' },
    ]
  )
);

module.exports = router;
