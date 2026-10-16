# Launchpad 3.0

Launchpad 3.0 — initial scaffold for a manufacturing/work-order web app.

Architecture:
- Frontend: React (separate `frontend/` folder)
- Backend: Node.js + Express (in `backend/` folder)
- Database: SQLite (schema in `database/`)
- Assets: static files in `assets/`
- Docs: project requirements and notes in `docs/`

Getting started (backend):

1. Change to `backend/` and install dependencies:

```bash
cd backend
npm install
```

2. Copy `.env.example` to `.env` and adjust values. Set `INIT_ADMIN_PASSWORD` before the first seed if you want a chosen admin password. If it is omitted, `init_db.js` generates a random password and prints it once. That value is not stored anywhere else.

3. Initialize the database:

```bash
node init_db.js
```

Seeding is idempotent. Creating the admin user, customer users, departments, production stages, sample orders, board rows, and deliveries are separate steps, so an existing admin user does not skip the rest of the seed. Sample board and delivery rows point at the seeded work orders by external id. Seeded customer users (`acme`, `whitebox`, `orion`) get random unknown passwords and cannot log in until an administrator resets the password from the Customers page or creates a new account. Passwords other than a newly generated admin password are never printed.

4. Start the backend:

```bash
npm start
```

Frontend:
- `frontend/` is a Vite + React app. From that folder, run `npm install` and `npm run dev`.
- Navigation follows the signed-in role. Customers see their own work orders and deliveries. The production board, barcode scan page, customer directory, and admin pages are hidden from roles that cannot use them.

Security notes:
- Passwords are stored with bcrypt. A successful login still accepts a legacy unsalted SHA-256 hash once, then replaces it with bcrypt.
- Sessions expire after `SESSION_TTL_HOURS` (default 8). `POST /api/auth/logout` clears the bearer session. Expired sessions are removed on use and by a periodic cleanup.
- `POST /api/auth/login` is limited to 10 attempts per 15 minutes for each IP and username. Set `TRUST_PROXY` (see `backend/.env.example`) when the API is behind a reverse proxy so that limit uses the client IP from `X-Forwarded-For`.
- `POST /api/barcode` is limited per signed-in user (`BARCODE_RATE_LIMIT_MAX` scans per `BARCODE_RATE_LIMIT_WINDOW_SECONDS`, default 60 per 60 seconds). Restart the server after changing those values.
- `POST /api/customers` is admin-only. Omit `password` to receive a one-time random password in the create response. A supplied password must be at least 8 characters, is stored, and is not echoed back.
- `PUT /api/customers/:id/password` is admin-only and only updates users whose role is `customer`. Omit `password` to generate one. The new password is returned once as `{ id, username, password }` and is not written to the server log. The customer's active sessions are cleared, so they must sign in again. The Customers page lets an admin set or generate that password and copy it.
- `GET /api/customers/lookup` is available to admin and operator and returns only `id`, `username`, and `display_name`. Operators use it to pick an existing customer on a work order. Creating a customer stays admin-only.
- Customer create/list and department create/update/delete require the admin role. Work order create, update, stage, and priority changes require admin or operator. Customers can read only their own work orders. The dashboard and production board are limited to admin and operator; the customer home page shows only that customer's orders.
- Report endpoints require admin or operator. Notification endpoints require a signed-in user and then limit rows by role.
- Work order status values are `open`, `in-progress`, `completed`, and `on-hold`. A legacy `complete` value is rewritten to `completed` when the database is initialized and when a work order is saved. Delivery status values are `pending`, `scheduled`, `out-for-delivery`, and `complete`.

Barcode scans:
- `POST /api/barcode` (admin or operator) stores `scanned_value`, the resolved `work_order_id`, `operator_id` from the session, `location`, and `event_time` on `barcode_events`.
- The scanned value matches `work_orders.external_id` exactly first (for example `WO-1001`). If that misses and the value is a positive integer, it matches `work_orders.id`. Unknown values return 404. Missing or invalid input returns 400.
- `GET /api/barcode/events` (admin or operator) filters by `work_order_id`, `operator` (user id or username), and `from` / `to`, with `limit` (default 50, max 200) and `offset`.
- `GET /api/workorders/:id/events` returns that order's scans. Customers only receive events for their own work orders.
- A scan location can advance the work order's production stage. `BARCODE_LOCATION_STAGES` is a semicolon-separated list of `Location=Stage Name` pairs. When the variable is unset, `Shipping`, `Quality Control`, and `Finishing` map to the stages of those names. Set it to an empty value to disable advancement. The scan is still stored if the stage name is missing. `barcode_events.stage_id` records the stage that was applied.
- A scan location that matches a department name moves the work order to that department and records `from_department` and `to_department`. Scanning into Complete also sets the work order status to `completed`. Stage advancement and the department move are independent, so Shipping still advances a stage without changing the department.
- Operators use the Scan page (`/scan`). The field accepts keyboard-wedge input and submits on Enter. Work order detail shows the scan history tab.

Deliveries:
- `GET /api/delivery` lists deliveries with work order and customer fields, plus `overdue`, `due_today`, `due_soon`, and `timing`. Customers only see deliveries for their own work orders. The response is `{ deliveries, total, limit, offset, evaluated_at }`.
- `POST /api/delivery` and `PUT /api/delivery/:id` are admin or operator. A delivery stores `will_call`, `due_time`, `carrier`, and `status`. Several deliveries may exist for one work order. Updating a delivery does not change its work order.
- Leave `due_time` blank on create, or send null on update, to calculate it. Will-call uses `WILL_CALL_CUTOFF` (default `15:00`). Carrier deliveries use `CARRIER_CUTOFF` (default `14:00`). If the order is ready before the cutoff on a Monday–Friday, it is due that day at the cutoff; at the cutoff or later, or on a weekend, it is due the next business day at the cutoff. Holidays are not skipped. Times are wall-clock in `DELIVERY_TIMEZONE`. When that variable is unset the code default is `UTC`; `backend/.env.example` sets `America/New_York` for the shop. `DUE_SOON_HOURS` (default 1) marks a non-complete delivery due soon. Completed deliveries are not marked overdue.
- `GET /api/delivery/rules` returns those rules and a computed suggestion for an order ready now.
- The Delivery page highlights overdue and due-today rows and shows a will-call badge. Customers can open it read-only.

Customer orders:
- An order groups one or more work orders. The order number is `YYYYMMDD-NNN` (for example `20260609-041`). The sequence resets each day in `DELIVERY_TIMEZONE` and is stored in `order_sequences`. Creates are serialized in process and retried if SQLite reports the database is busy, so overlapping requests keep unique numbers. A number is used only after the transaction commits.
- `POST /api/orders` (customer, admin, or operator) creates the order, its line items, and one work order per selected service in a single transaction. Work order numbers add `-A`, `-B`, `-C`, and so on, in service sort order. Customers can read only their own orders (`GET /api/orders`, `GET /api/orders/:id`). Staff creating an order must send `customer_id` for an existing customer. Customers cannot set production fields such as status, priority, assignment, or approval.
- Required fields are company, contact name, phone, email, delivery method, due date, due time, and at least one service. Due date must be a Monday–Friday, not before today in the delivery timezone. Due time must be a slot from `DELIVERY_WINDOW_START` through `DELIVERY_WINDOW_END` (default 9:00 AM–2:00 PM) in `DELIVERY_SLOT_MINUTES` (default 15). The same wall-clock normalization as other deliveries stores that due time.
- A delivery row is created for the order. `will_call` follows the delivery method (`Will Call` and `Customer Pickup` are will-call). Carrier is the method name. Add methods by inserting rows into `delivery_methods`; init only inserts missing names.
- Services are seeded to match the order form: Large Format, Small Format, Signs & Graphics, Scanning, Planroom, Archive File Request, and Ship To (3rd Party). Each service opens a work order in a department. Archive File Request is marked pending approval for a later approvals screen. New departments (Large Format, Planroom, Archive File, Quality, Dispatch, Complete) are added beside the departments that were already there. Production departments route to Quality, then Dispatch, Delivery, and Complete. That route is filled in only when a department row has never been edited.
- Line items store description, size, quantity, media, color, binding/finish, mount, and laminate. A line item is linked to the work order for its service. With one selected service, an omitted service is assumed. When more than one service is selected, a line item without `service_id` is rejected. Work order detail shows those spec fields, attached files, and routing (department, current status, next department). Customers see production history as department, status, and timestamps. Staff also see who recorded the step and the notes.
- `POST /api/uploads` accepts multipart field `files` for signed-in users. Allowed types are pdf, images, dwg, zip, and plt. Size is capped by `MAX_UPLOAD_MB` (default 25). Files are stored under `UPLOAD_DIR` (default `../data/uploads`, resolved from the backend folder, outside the frontend web root) with a random filename. `GET /api/uploads/:id/download` and `DELETE /api/uploads/:id` require auth. Customers can access only their own files, and they can delete a file only while it is not attached to an order. Each user can leave at most `MAX_UNATTACHED_UPLOADS` files unattached (default 30). An unref'd sweep deletes unattached uploads older than `UPLOAD_ORPHAN_HOURS` (default 24). No confirmation email is sent; the API reports `confirmation.email_status` of `disabled`.
- Customers sign in to the Customer Order Form (`/order`). That shell includes the notification bell. Staff land on the Admin Board. `node scripts/verify-phase1.js` from `backend/` checks migrations, roles, order numbers, concurrent creates, validation, uploads, and customer isolation.

Admin Board (admin and operator):
- Staff home is the Admin Board at `/`. Customers stay on the order form and receive HTTP 403 from `/api/admin-board`.
- `GET /api/admin-board` returns department tabs and queue counts, stat cards, recent activity, the last 10 barcode scans, pending approvals, and system alerts. `GET /api/admin-board/work-orders` returns one page of the active table (`limit` default 8, max 100, plus `offset`). It filters by `department`, `q`, `status`, `priority`, `due_from`, and `due_to`. `sort` is `arrived`, `due`, `order_number`, `company`, or `department`.
- Active work is not finished (`completed` or legacy `complete`) and is not in the Complete department. On-hold work stays in the active queue. The Complete tab is finished work plus anything sitting in Complete. "Completed this month" uses `updated_at`, or `created_at` when that is empty, inside the current month in `DELIVERY_TIMEZONE`.
- The process column is the service name, then the production stage name, then the department. Company and contact come from the order, then the customer.
- Stat cards are total active, the Large Format, Small Format, Signs & Graphics, Scanning, and Planroom queues when those departments exist, and completed this month. Tabs list those shop departments plus any other department that currently has active work.
- Creating a work order writes `work_order.created` to `activity_log`. Changing its department writes `work_order.moved`. Moving it into a finished status writes `work_order.completed`. A barcode location that matches a department name moves the work order there, stores `from_department` and `to_department` on the scan, and writes the same activity. Scanning into Complete also marks the work order completed. Locations such as Shipping, Quality Control, and Finishing still advance production stages and do not move the department.
- Archive file requests stay `approval_status = pending`. `POST /api/admin-board/approvals/:id` with `{ "decision": "approved" }` or `"rejected"` is admin-only. It stores `approval_by` and `approval_at` and writes activity. Operators can see the queue and receive HTTP 403 if they try to decide.
- Alerts are computed from the database: empty department queues, overdue deliveries (the same rules as the delivery list), and backup status. Backup text comes from `system_settings.last_backup_at`. When that key is missing the alert says no backup has been recorded. Active rows in `system_alerts` are included. The board does not invent backup or uptime messages.
- The staff sidebar matches the admin mockup. Services, Users, System Settings, Activity Log, Barcode Settings, and Search Orders are placeholders for the next phase and are admin-only. Operators see Admin Board, Create Order, Reports, and Notifications. The print action opens the printable work order. `node scripts/verify-phase2.js` checks roles, counts, filters, pagination, approvals, activity, scans, and migrations.

Printable work orders:
- `GET /api/workorders/:id/print` returns one work order. `GET /api/orders/:id/print` returns every work order on that order. Both require a signed-in user. Admin and operator can print any work order. A customer can print only their own orders and work orders. Someone else's id returns HTTP 404, the same as the other customer reads. No token returns 401.
- The payload is built from the order, its line items, attached file names, delivery, routing, and `production_history`. It includes contact, project, the delivery or will-call method, due date and time, service and process, size, quantity, media, finishing, and special instructions. It does not include password hashes or stored upload filenames. A customer history row is department, status, and time. Staff also receive who recorded the step and the history note.
- The shop letterhead on the sheet is Accent Imaging, Inc., 8121 Brownleigh Drive, Raleigh, NC 27617, 919-782-3332, matching the owner's mockup. The delivery window label follows `DELIVERY_WINDOW_START`, `DELIVERY_WINDOW_END`, and `DELIVERY_SLOT_MINUTES`.
- The work order number, including `-A`, `-B`, and `-C`, is encoded as a black-on-white Code 128 SVG with `jsbarcode` (MIT). `@xmldom/xmldom` (MIT) is only used to build that SVG. Scanning the number with `POST /api/barcode` resolves that work order.
- Staff and customers open `/work-orders/:id/print` from the Admin Board print action, the work order list, and the work order page. `/orders/:id/print` is linked from the order page and prints each work order on its own letter page. The toolbar has Print and Download PDF. Download PDF opens the browser print dialog. `@media print` hides the toolbar. There is no server-side PDF.
- `node scripts/verify-phase3.js` checks roles, customer isolation, the payload, and the barcode scan round trip.

Reports (admin and operator):
- Customers receive HTTP 403. The Reports page and navigation item are hidden from them.
- `GET /api/reports/work-orders/status`, `/work-orders/department`, and `/work-orders/stage` count work orders created in the range. Known statuses are always listed. Every production stage is listed, including zeros. Unassigned work orders appear only when the count is greater than zero.
- `GET /api/reports/throughput` counts completed work orders (`completed`, plus legacy `complete`) per day or week. Pass `bucket=day` (default) or `bucket=week`. The timestamp is `updated_at`, or `created_at` when `updated_at` is empty. Weeks start on Monday.
- `GET /api/reports/deliveries` lists deliveries that `backend/deliveryRules.js` marks overdue or due today. Completed deliveries are omitted. `from` and `to` limit `due_time`.
- `GET /api/reports/scans/operators` and `/scans/locations` count `barcode_events` in the range.
- `GET /api/reports/stages/average-time` averages completed stays between scans that stored `stage_id`. The open stay at the end of a work order is not included. When no completed stay exists, `derivable` is false.
- Every report accepts `from` and `to` (`YYYY-MM-DD` or a date-time) and `format=csv`. CSV responses use `text/csv` and an attachment filename. The Reports page at `/reports` applies those filters and downloads each CSV.

Notifications:
- `notifications` stores one row per event. `notification_reads` stores who has read it. Both are created by `database/schema.sql` and again by `init_db.js`, so an existing database can be updated by running init again.
- Events are: a delivery becoming overdue, a delivery due within `DELIVERY_DUE_SOON_MINUTES` (default 60), a work order put on hold, a work order completed, and a rush-priority work order created. Rush is only notified when the work order is created, not when priority is changed later. On-hold and completed notify on the transition into that status. When `DELIVERY_DUE_SOON_MINUTES` is unset, that window follows `DUE_SOON_HOURS` (default 1 hour), so the delivery list and the notification use the same due-soon period.
- The same delivery and due time are not notified twice. A changed due time can notify again. A scheduler (`setInterval`, unref'd) runs the delivery check every `NOTIFICATION_CHECK_INTERVAL_SECONDS` (default 60) and once at startup.
- `GET /api/notifications` returns `{ notifications, unread_count, total, limit, offset }`. Admin and operator see every notification. A customer sees only rows whose `customer_id` is their user id.
- `POST /api/notifications/:id/read` and `POST /api/notifications/read-all` mark the signed-in user's visible notifications. A customer cannot mark another customer's notification.
- The top bar has a bell with an unread badge. It polls about every 45 seconds and opens a short list. The customer order form shell shows the same bell. `/notifications` is the full list for every role.
- Email is off unless `EMAIL_NOTIFICATIONS` is true. Even then the mail interface is a stub: it does not read SMTP settings and does not send email.

Docs:
- See `docs/requirements.md` for planned features and data model notes.
