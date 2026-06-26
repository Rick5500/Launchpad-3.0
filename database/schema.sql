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

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  customer_id INTEGER,
  description TEXT,
  quantity INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open',
  department TEXT DEFAULT 'General',
  specifications TEXT,
  start_date DATETIME,
  due_date DATETIME,
  production_line TEXT,
  routing_instructions TEXT,
  attachments TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY(customer_id) REFERENCES users(id)
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
  FOREIGN KEY(work_order_id) REFERENCES work_orders(id),
  FOREIGN KEY(operator_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER,
  will_call BOOLEAN DEFAULT 0,
  due_time DATETIME,
  carrier TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(work_order_id) REFERENCES work_orders(id)
);
