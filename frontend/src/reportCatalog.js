export const REPORTS = [
  {
    id: 'status',
    label: 'By status',
    path: '/api/reports/work-orders/status',
    filename: 'work-orders-by-status.csv',
    description: 'Work orders created in the selected range, counted by status.',
    columns: [
      { key: 'status', label: 'Status' },
      { key: 'count', label: 'Count' },
    ],
  },
  {
    id: 'department',
    label: 'By department',
    path: '/api/reports/work-orders/department',
    filename: 'work-orders-by-department.csv',
    description: 'Work orders created in the selected range, counted by department.',
    columns: [
      { key: 'department', label: 'Department' },
      { key: 'count', label: 'Count' },
    ],
  },
  {
    id: 'stage',
    label: 'By stage',
    path: '/api/reports/work-orders/stage',
    filename: 'work-orders-by-stage.csv',
    description: 'Work orders created in the selected range, counted by production stage.',
    columns: [
      { key: 'stage_name', label: 'Stage' },
      { key: 'count', label: 'Count' },
    ],
  },
  {
    id: 'throughput',
    label: 'Throughput',
    path: '/api/reports/throughput',
    filename: 'throughput.csv',
    description: 'Completed work orders grouped by day or week. The date is updated_at, or created_at when that is empty.',
    bucket: true,
    columns: [
      { key: 'bucket', label: 'Period' },
      { key: 'count', label: 'Completed' },
    ],
  },
  {
    id: 'deliveries',
    label: 'Deliveries',
    path: '/api/reports/deliveries',
    filename: 'deliveries-due.csv',
    description: 'Open deliveries that are overdue or due today. A from/to range limits which due times are included.',
    columns: [
      { key: 'external_id', label: 'Work order' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'due_time', label: 'Due' },
      { key: 'carrier', label: 'Carrier' },
      { key: 'delivery_method', label: 'Method' },
      { key: 'ups_account_number', label: 'UPS account' },
      { key: 'status', label: 'Status' },
      { key: 'timing', label: 'Timing' },
      { key: 'will_call', label: 'Will call' },
    ],
  },
  {
    id: 'operators',
    label: 'Scans by operator',
    path: '/api/reports/scans/operators',
    filename: 'scans-by-operator.csv',
    description: 'Barcode scans in the selected range, counted by operator.',
    columns: [
      { key: 'operator_username', label: 'Operator' },
      { key: 'operator_name', label: 'Name' },
      { key: 'scan_count', label: 'Scans' },
    ],
  },
  {
    id: 'locations',
    label: 'Scans by location',
    path: '/api/reports/scans/locations',
    filename: 'scans-by-location.csv',
    description: 'Barcode scans in the selected range, counted by location.',
    columns: [
      { key: 'location', label: 'Location' },
      { key: 'scan_count', label: 'Scans' },
    ],
  },
  {
    id: 'stage-time',
    label: 'Stage time',
    path: '/api/reports/stages/average-time',
    filename: 'stage-time.csv',
    description: 'Average completed time in each production stage, from barcode scans that recorded a stage.',
    columns: [
      { key: 'stage_name', label: 'Stage' },
      { key: 'sample_count', label: 'Completed stays' },
      { key: 'average_seconds', label: 'Average' },
    ],
  },
];

export const REPORT_NAV = REPORTS.map((report) => ({
  title: report.label,
  route: `/reports/${report.id}`,
}));
