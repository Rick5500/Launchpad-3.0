# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Admin Board at `/` for admin and operator, with department tabs, stat cards, a paginated active work order table, department queue summary, recent activity, the last 10 scans, pending approvals, and system alerts
- `GET /api/admin-board`, `GET /api/admin-board/work-orders`, `GET /api/admin-board/activity`, and `GET /api/admin-board/approvals` for admin and operator. Customers receive HTTP 403
- Admin-only `POST /api/admin-board/approvals/:id` to approve or reject a pending request, recording `approval_by`, `approval_at`, and an activity row
- Activity rows when a work order is created, moved to another department, or completed, including a department move when a barcode location matches a department name
- `barcode_events.from_department` and `barcode_events.to_department`, filled in when a scan is recorded
- Placeholder pages for Search Orders, Services, Users, System Settings, Activity Log, and Barcode Settings, and a print-work-order placeholder for the next phase
- Customer order intake: `orders`, `services`, `order_line_items`, `order_files`, `delivery_methods`, and a daily `order_sequences` counter (`YYYYMMDD-NNN`, work orders suffixed `-A`, `-B`, `-C`)
- `POST /api/orders`, `GET /api/orders`, and `GET /api/orders/:id` for admin, operator, and customer, with customers limited to their own orders
- Multipart uploads at `POST /api/uploads` with type and size limits, random stored names under `UPLOAD_DIR`, and authenticated download and delete
- Customer Order Form at `/order`, with a success panel, and order specs, files, and routing on the work order detail page
- Seeded print-shop services and the Large Format, Planroom, Archive File, Quality, Dispatch, and Complete departments
- Tables reserved for later phases: `production_history`, `activity_log`, `system_settings`, `notification_settings`, and `system_alerts`
- Staff reports for work orders by status, department, and stage; completed throughput by day or week; overdue and due-today deliveries; barcode scans by operator and location; and average completed time in each production stage
- `format=csv` on each report, and a Reports page at `/reports` with from/to filters
- In-app notifications in SQLite (`notifications`, `notification_reads`) for overdue deliveries, deliveries due within `DELIVERY_DUE_SOON_MINUTES`, work orders put on hold, completed work orders, and rush work orders created
- `GET /api/notifications`, `POST /api/notifications/:id/read`, and `POST /api/notifications/read-all`, with unread counts and paging
- A top-bar notification bell with an unread badge and a `/notifications` page, polling about every 45 seconds. The customer order form shell shows the same bell
- An unref'd in-process scheduler that checks delivery due times and skips events that were already notified
- A stub email interface that stays off unless `EMAIL_NOTIFICATIONS` is enabled and never sends mail
- A per-user limit on unattached uploads (`MAX_UNATTACHED_UPLOADS`) and an unref'd sweep that deletes unattached uploads older than `UPLOAD_ORPHAN_HOURS`
- Barcode scan logging on `POST /api/barcode`, writing `scanned_value`, resolved `work_order_id`, session `operator_id`, `location`, and `event_time` to `barcode_events`
- `GET /api/barcode/events` with work order, operator, date-range, limit, and offset filters
- `GET /api/workorders/:id/events` for one work order's scan history
- Per-user rate limit on barcode scans (`BARCODE_RATE_LIMIT_MAX`, `BARCODE_RATE_LIMIT_WINDOW_SECONDS`)
- Optional scan-location production stage advancement via `BARCODE_LOCATION_STAGES`, stored on `barcode_events.stage_id`
- Delivery create, update, and detail endpoints with status validation (`pending`, `scheduled`, `out-for-delivery`, `complete`)
- `GET /api/delivery/rules` with cutoff rules and a computed due time for will-call and carrier deliveries
- Overdue, due-today, and due-soon flags on delivery records
- Operator scan page and a deliveries page with overdue / due-today highlighting and a will-call badge
- Admin password reset: `PUT /api/customers/:id/password` returns the new password once, and the Customers page can set or generate it
- `GET /api/customers/lookup` for admin and operator, returning only `id`, `username`, and `display_name`
- Optional `TRUST_PROXY` so the login rate limit uses the client IP behind a reverse proxy
- Role checks via `requireRole` for admin, operator, and customer access
- Bcrypt password hashing, with a one-time upgrade from legacy SHA-256 hashes on successful login
- Session expiry (`SESSION_TTL_HOURS`, default 8 hours), periodic session cleanup, and `POST /api/auth/logout`
- In-memory login rate limit (10 attempts per 15 minutes per IP and username)
- Optional `password` on `POST /api/customers`; when omitted, a random password is returned once
- Work order create/edit form UI (`frontend/src/routes/WorkOrderForm.jsx`)
- Work order create API endpoint (`backend/routes/workOrders.js`, `POST /api/workorders`)
- Work order update API endpoint (`backend/routes/workOrders.js`, `PUT /api/workorders/:id`)
- Authenticated API fetch helper (`frontend/src/api.js`)
- New frontend routes for work order creation and editing
- `CHANGELOG.md` file

### Changed
- Admin and operator land on the Admin Board instead of the earlier home dashboard. Customers still open the order form
- The staff sidebar follows the admin mockup. Operators see only Admin Board, Create Order, Reports, and Notifications
- A barcode scan whose location names a department moves that work order. Scanning into Complete also marks it completed. Other locations keep the existing production-stage map
- Editing a work order's department updates `next_department` from the department route when that department exists
- The due-soon window defaults to 1 hour. `DUE_SOON_HOURS` defaults to 1, and `DELIVERY_DUE_SOON_MINUTES` defaults to 60. When the minutes setting is unset, notifications use the delivery-list window
- The Reports navigation item opens the reports page for admin and operator. Customers are still blocked from that route and from the report APIs
- `init_db.js` creates the notification tables when they are missing, including on a database created before this change
- Removed the placeholder `POST /api/barcode` and `GET /api/delivery/rules` handlers from `server.js`
- `GET /api/delivery` now returns `{ deliveries, total, limit, offset, evaluated_at }` with work order fields and timing flags. Customers still only see their own work orders
- Delivery due times follow `backend/deliveryRules.js`. Cutoff times, timezone, and the due-soon window are environment settings
- Operators can select an existing customer on the work order form. New customers must still be created by an administrator
- A password supplied to `POST /api/customers` must be at least 8 characters
- `INIT_ADMIN_PASSWORD` is no longer optional with a hardcoded fallback. When it is unset, database init generates a random admin password and prints it once
- Seeded customer accounts no longer use published passwords
- Customer, department, work order, dashboard, and production board routes enforce roles. Customers only receive their own work orders, and their home page does not call the staff dashboard or production board
- Work order statuses are `open`, `in-progress`, `completed`, and `on-hold`. `PUT /api/workorders/:id/stage` requires a numeric work order id and an existing numeric `stage_id`
- Duplicate department names return HTTP 409
- Extended work order schema with new fields for specifications, start date, production line, routing instructions, attachments, and notes (`database/schema.sql`)
- Added database migration logic to preserve existing work orders when adding new columns (`backend/init_db.js`)
- Added edit action to work order detail page
- Added "New Work Order" button on work order list page

### Fixed
- Simultaneous `POST /api/orders` calls no longer fail with `SQLITE_BUSY`. Order numbers stay unique, and a rolled-back create does not leave a gap
- A line item with no `service_id` on a multi-service order is rejected instead of being left off the work orders
- Customers can delete an uploaded file only before it is attached to a submitted order
- Customer work order detail shows production history as department, status, and timestamps. Internal fields such as `scanned_by` stay on the staff response
- `work_orders.external_id` gets a unique index when existing values are already unique. Init logs a warning and continues when duplicates are present
- Legacy work order status `complete` is normalized to `completed` on save and by an idempotent database init migration. Lists, detail, and the dashboard treat `complete` and `completed` as the same finished status
- `PUT /api/workorders/:id/priority` requires a positive integer id
- Database init no longer exits before departments, stages, and sample data are seeded, and it always exits after each independent seed step
- Sample production board and delivery rows reference real work order ids
- Removed the unused `addColumnIfMissing` helper
- API errors no longer include raw database messages
- Customer creation uses `datetime('now')` and no longer discards the generated password
- Corrected inconsistent frontend work order route paths
