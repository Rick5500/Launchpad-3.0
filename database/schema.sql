-- SQLite schema for Launchpad 3.0
-- Fresh databases get the full schema here.
-- Existing databases are upgraded idempotently by backend/init_db.js
-- (CREATE TABLE IF NOT EXISTS does not add columns to tables that already exist).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer', -- admin, manager, operator, customer. No CHECK: init_db.js relaxes an older one.
  display_name TEXT,
  company TEXT,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address_line1 TEXT, -- company street address, snapshotted onto orders at submission
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  department TEXT, -- staff home department; NULL means every department
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);

-- name is unique. init_db.js adds idx_departments_name_nocase so two names
-- that differ only by case cannot both exist. That index is not created here:
-- an older database that already has case-only duplicates must still initialize.
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  color TEXT DEFAULT '#90caf9',
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  show_on_board INTEGER NOT NULL DEFAULT 1, -- 0 keeps an empty department off the board tabs
  next_department TEXT, -- production route target; null at the end of the route
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS production_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#90caf9',
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT, -- short subtitle shown on the order form, e.g. "Plans, Drawings, Bid Sets"
  department_name TEXT NOT NULL, -- queue this service opens a work order in
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  requires_approval INTEGER DEFAULT 0, -- phase 4 pending approvals (archive file requests)
  code TEXT, -- short service code, used as the work order suffix when suffix_mode is code
  suffix_mode TEXT DEFAULT 'sequence', -- sequence (A/B/C by sort) or code
  default_turnaround_hours INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS delivery_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  will_call INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- One customer submission. order_number is YYYYMMDD-NNN and the sequence resets each day.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  po_number TEXT,
  project_number TEXT,
  project_name TEXT,
  notes TEXT,
  delivery_method TEXT NOT NULL,
  ups_account_number TEXT, -- optional UPS shipping account; not a password
  originals_source TEXT, -- how originals arrive; null on orders created before this column
  address_line1 TEXT, -- company address captured at submission; null on older orders
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  ship_to TEXT,
  attention TEXT,
  payment_method TEXT, -- Accent Account, Cash, Check, AMEX, Master Card, Visa, Discover; null on older orders
  return_to TEXT, -- To Me, or See ShipTo when a third-party ship-to line carries the delivery
  bill_to_name TEXT,
  bill_to_phone TEXT,
  bill_to_email TEXT,
  bill_to_company TEXT,
  bill_to_address_line1 TEXT,
  bill_to_address_line2 TEXT,
  bill_to_city TEXT,
  bill_to_state TEXT,
  bill_to_zip TEXT,
  due_date TEXT NOT NULL, -- YYYY-MM-DD in the shop calendar
  due_time TEXT NOT NULL, -- HH:MM slot inside the method window (Will Call 08:00-17:00, delivery 09:00-16:00)
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY(customer_id) REFERENCES users(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);

-- Daily counter for order_number. last_number is the last value issued for that YYYYMMDD.
CREATE TABLE IF NOT EXISTS order_sequences (
  order_date TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT, -- order work orders use {order_number}-A, -B, -C...
  customer_id INTEGER,
  description TEXT,
  quantity INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open',
  department TEXT DEFAULT 'General',
  stage_id INTEGER,
  priority TEXT DEFAULT 'Normal',
  assigned_department_id INTEGER,
  assigned_user_id INTEGER,
  estimated_hours REAL,
  actual_hours REAL,
  specifications TEXT,
  start_date DATETIME,
  due_date DATETIME,
  production_line TEXT,
  routing_instructions TEXT,
  attachments TEXT,
  notes TEXT,
  order_id INTEGER,
  service_id INTEGER,
  next_department TEXT,
  requires_approval INTEGER DEFAULT 0,
  approval_status TEXT, -- null, pending, approved, rejected
  approval_by INTEGER, -- user who approved or rejected a pending request
  approval_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY(customer_id) REFERENCES users(id),
  FOREIGN KEY(stage_id) REFERENCES production_stages(id),
  FOREIGN KEY(assigned_department_id) REFERENCES departments(id),
  FOREIGN KEY(assigned_user_id) REFERENCES users(id),
  FOREIGN KEY(order_id) REFERENCES orders(id),
  FOREIGN KEY(service_id) REFERENCES services(id)
);

CREATE TABLE IF NOT EXISTS order_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  service_id INTEGER,
  work_order_id INTEGER,
  line_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  size TEXT,
  quantity TEXT,
  media TEXT,
  color TEXT,
  binding_finish TEXT,
  finishing TEXT, -- None, Grommets, Easel, Cut/Trim, Velcro, Print Hanger, Framing, See Notes; null prints as None
  mount INTEGER DEFAULT 0, -- legacy Yes/No; new Signs & Graphics lines also store the mount option in field_values
  laminate INTEGER DEFAULT 0, -- legacy Yes/No; new Signs & Graphics lines also store the laminate option in field_values
  field_values TEXT, -- JSON object of service-specific line values; null on rows created before this column
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(order_id) REFERENCES orders(id),
  FOREIGN KEY(service_id) REFERENCES services(id),
  FOREIGN KEY(work_order_id) REFERENCES work_orders(id)
);

-- File bytes live under UPLOAD_DIR (outside the web root). This table stores metadata only.
CREATE TABLE IF NOT EXISTS order_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  line_item_id INTEGER,
  work_order_id INTEGER,
  customer_id INTEGER,
  uploaded_by INTEGER,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(order_id) REFERENCES orders(id),
  FOREIGN KEY(line_item_id) REFERENCES order_line_items(id),
  FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
  FOREIGN KEY(customer_id) REFERENCES users(id),
  FOREIGN KEY(uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS production_board (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL,
  lane TEXT,
  position INTEGER,
  status TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(work_order_id) REFERENCES work_orders(id)
);

CREATE TABLE IF NOT EXISTS barcode_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned_value TEXT NOT NULL,
  work_order_id INTEGER,
  operator_id INTEGER,
  location TEXT,
  event_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  stage_id INTEGER, -- production stage applied by a configured scan location, if any
  from_department TEXT, -- department the work order was in when the scan was recorded
  to_department TEXT, -- department the scan moved it to, when the location names a department
  FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
  FOREIGN KEY(operator_id) REFERENCES users(id),
  FOREIGN KEY(stage_id) REFERENCES production_stages(id)
);

-- Location names the scan endpoint maps to a department move and/or a production stage.
-- Seeded from active department names. Quality also advances Quality Control, and
-- Dispatch advances Shipping. Finishing is not a default selectable location.
CREATE TABLE IF NOT EXISTS barcode_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location TEXT NOT NULL UNIQUE,
  department_name TEXT,
  stage_name TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);

-- Phase 3 printable work order history. Order intake writes the "Submitted / Order Created" row.
CREATE TABLE IF NOT EXISTS production_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL,
  department TEXT,
  status TEXT,
  event_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  scanned_by TEXT,
  user_id INTEGER,
  notes TEXT,
  FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER,
  order_id INTEGER,
  will_call BOOLEAN DEFAULT 0,
  due_time DATETIME,
  carrier TEXT,
  status TEXT DEFAULT 'pending', -- pending, scheduled, out-for-delivery, complete
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

-- Phase 2 recent activity and phase 4 activity log.
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  detail TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(actor_id) REFERENCES users(id)
);

-- Phase 4 system settings (key/value), including future barcode settings.
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME
);

-- Notification settings. Email rows stay disabled (no mail is sent).
-- In-app rows toggle the events stored in notifications.
CREATE TABLE IF NOT EXISTS notification_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 0,
  channel TEXT DEFAULT 'email',
  updated_at DATETIME
);

-- Phase 2 system alerts panel.
CREATE TABLE IF NOT EXISTS system_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL DEFAULT 'info', -- info, warning, error, success
  message TEXT NOT NULL,
  detail TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
-- Per-service line item fields. options_json is [{value, active}].
-- Deactivated options stay in the definition so the editor can turn them back on.
-- Orders store the chosen string, so an option removed later still displays.
CREATE TABLE IF NOT EXISTS service_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL, -- text, select, number, checkbox, textarea
  options_json TEXT,
  required INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY(service_id) REFERENCES services(id),
  UNIQUE(service_id, key)
);

CREATE INDEX IF NOT EXISTS idx_service_fields_service ON service_fields(service_id);
CREATE INDEX IF NOT EXISTS idx_order_line_items_order ON order_line_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_line_items_work_order ON order_line_items(work_order_id);
CREATE INDEX IF NOT EXISTS idx_order_files_order ON order_files(order_id);
CREATE INDEX IF NOT EXISTS idx_order_files_customer ON order_files(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_files_work_order ON order_files(work_order_id);
CREATE INDEX IF NOT EXISTS idx_production_history_work_order ON production_history(work_order_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_barcode_events_work_order ON barcode_events(work_order_id);
CREATE INDEX IF NOT EXISTS idx_barcode_events_operator ON barcode_events(operator_id);
CREATE INDEX IF NOT EXISTS idx_barcode_events_event_time ON barcode_events(event_time);
CREATE INDEX IF NOT EXISTS idx_barcode_locations_active ON barcode_locations(is_active);
CREATE INDEX IF NOT EXISTS idx_deliveries_work_order ON deliveries(work_order_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_due_time ON deliveries(due_time);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);

-- In-app notifications. One row per event. Read state is per user in notification_reads.
-- type: delivery_overdue, delivery_due_soon, work_order_on_hold, work_order_completed, work_order_rush
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  customer_id INTEGER,
  work_order_id INTEGER,
  delivery_id INTEGER,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES users(id),
  FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
  FOREIGN KEY(delivery_id) REFERENCES deliveries(id)
);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notification_id, user_id),
  FOREIGN KEY(notification_id) REFERENCES notifications(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_customer_id ON notifications(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key ON notifications(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON notification_reads(user_id);
