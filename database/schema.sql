-- SQLite schema for Launchpad 3.0 (initial)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer', -- admin, customer, operator
  display_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  color TEXT DEFAULT '#90caf9',
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
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

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY(customer_id) REFERENCES users(id),
  FOREIGN KEY(stage_id) REFERENCES production_stages(id),
  FOREIGN KEY(assigned_department_id) REFERENCES departments(id),
  FOREIGN KEY(assigned_user_id) REFERENCES users(id)
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
  FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
  FOREIGN KEY(operator_id) REFERENCES users(id),
  FOREIGN KEY(stage_id) REFERENCES production_stages(id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER,
  will_call BOOLEAN DEFAULT 0,
  due_time DATETIME,
  carrier TEXT,
  status TEXT DEFAULT 'pending', -- pending, scheduled, out-for-delivery, complete
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY(work_order_id) REFERENCES work_orders(id)
);

CREATE INDEX IF NOT EXISTS idx_barcode_events_work_order ON barcode_events(work_order_id);
CREATE INDEX IF NOT EXISTS idx_barcode_events_operator ON barcode_events(operator_id);
CREATE INDEX IF NOT EXISTS idx_barcode_events_event_time ON barcode_events(event_time);
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
