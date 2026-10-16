# Requirements — Launchpad 3.0

Scope (v1 scaffold):
- User login / authentication (basic user table + roles)
- Admin dashboard (management views)
- Customer dashboard (customer-specific work orders)
- Work order entry and lifecycle tracking
- Production board (kanban / status board)
- Barcode scanning/events tracking
- Delivery / Will-call due-time rules and scheduling

High-level data model notes:
- `users` table with `role` (admin, customer, operator), plus optional company, contact name, phone, and email for order prefill
- `orders` group work orders. Order numbers are `YYYYMMDD-NNN` and reset daily. Each selected service becomes a work order suffixed `-A`, `-B`, `-C`
- `services` map to a department queue. Archive file requests are flagged for later approval
- `order_line_items` hold size, quantity, media, color, binding/finish, mount, and laminate, and link to the matching service's work order
- `order_files` store upload metadata. Bytes live under `UPLOAD_DIR`, outside the web root
- `work_orders` table capturing items, quantities, due dates, status, plus `order_id`, `service_id`, and `next_department`
- `production_board` records or derived from `work_orders` status
- `barcode_events` to log scans (timestamp, operator, location, payload)
- `production_history` starts with an "Order Created" row for printable work orders
- `deliveries` table with will-call flags, due-time rules, and an optional `order_id`
- `activity_log` records work order create, move, and complete events for the Admin Board. `system_settings.last_backup_at` is the backup status placeholder. `system_alerts` holds real stored alerts. `notification_settings` stays for a later admin screen

API endpoints:
- `POST /api/auth/login` — authenticate users
- `GET /api/admin/...` — admin resources
- `GET /api/customer/...` — customer resources
- `POST /api/workorders` — create work orders
- `GET /api/workorders/:id/events` — barcode scans for one work order
- `GET /api/production` — production board data
- `POST /api/barcode` — record a barcode scan (admin, operator)
- `GET /api/barcode/events` — list scans (admin, operator)
- `GET /api/delivery` — list deliveries with work order info and due-time flags
- `POST /api/delivery` and `PUT /api/delivery/:id` — create or update a delivery (admin, operator)
- `GET /api/delivery/rules` — will-call and carrier cutoff rules, plus the due time those rules would assign now
- `GET /api/reports/...` — staff reports (admin, operator). `format=csv` downloads a CSV file
- `GET /api/notifications` — notifications visible to the signed-in user, with `unread_count`, `total`, `limit`, and `offset`
- `POST /api/notifications/:id/read` and `POST /api/notifications/read-all` — mark visible notifications read
- `GET /api/admin-board` — staff board summary (admin, operator). Customers receive HTTP 403
- `GET /api/admin-board/work-orders` — paginated, filtered active work orders
- `GET /api/admin-board/activity` and `GET /api/admin-board/approvals` — paged activity and pending approvals
- `POST /api/admin-board/approvals/:id` — admin approve or reject (`decision` of `approved` or `rejected`)
- `GET /api/workorders/:id/print` — printable work order payload. Customers only receive their own work orders (404 otherwise)
- `GET /api/orders/:id/print` — the same payload for every work order on an order. Customers only receive their own orders (404 otherwise)
- A staff `external_id` is 1 to 80 printable ASCII characters, or blank. Otherwise `POST` and `PUT /api/workorders` return HTTP 400. An older unprintable id still prints, with `barcode_error` set, and the other work orders on that order still print
- A department-move barcode scan commits the event, department update, production history row, and activity row together

Barcode scans:
- Persist `scanned_value`, `work_order_id`, `operator_id` (the signed-in user), `location`, and `event_time`.
- Resolve `scanned_value` to `work_orders.external_id` first, then to `work_orders.id` when the value is a positive integer.
- Return 400 for invalid input and 404 when no work order matches.
- `GET /api/barcode/events` accepts `work_order_id`, `operator`, `from`, `to`, `limit`, and `offset`.
- A configured location can move the work order to a production stage (`BARCODE_LOCATION_STAGES`). The default map is Shipping, Quality Control, and Finishing. An empty value turns advancement off.
- A location that matches a department name moves the work order into that department. Complete also marks the work order completed. The scan stores the department it left and the department it entered.
- `POST /api/barcode` is rate limited per signed-in user.

Delivery / will-call:
- Rules live in `backend/deliveryRules.js`.
- Will-call cutoff defaults to 15:00 (`WILL_CALL_CUTOFF`). Carrier cutoff defaults to 14:00 (`CARRIER_CUTOFF`). When `DELIVERY_TIMEZONE` is unset the code default is UTC. `backend/.env.example` sets `America/New_York` for the shop.
- Ready before the cutoff on a weekday: due that day at the cutoff. Ready at or after the cutoff, or on a weekend: due the next Monday–Friday at the cutoff. Holidays are not skipped.
- Flag open deliveries overdue, due today, or due soon (`DUE_SOON_HOURS`, default 1). Status `complete` is not overdue.
- Status values are `pending`, `scheduled`, `out-for-delivery`, and `complete`.
- Customers can read only deliveries for their own work orders. Admin and operator can write.

Reports (admin and operator):
- Work orders by status, department, and production stage over `from` / `to`, using `created_at`.
- Throughput of completed work orders per day or week (`bucket=day` or `bucket=week`).
- Overdue and due-today deliveries, classified by `backend/deliveryRules.js`.
- Barcode scan counts by operator and by location.
- Average time in a production stage when barcode scans recorded the stage. Open stays are excluded.
- Each report accepts `format=csv`. Customers receive HTTP 403.

Notifications:
- Stored in `notifications`, with per-user read state in `notification_reads`.
- Generated when a delivery is overdue or due within `DELIVERY_DUE_SOON_MINUTES` (default 60). When that variable is unset, the window matches `DUE_SOON_HOURS` (default 1 hour). Also generated when a work order is put on hold or completed, and when a rush-priority work order is created.
- Admin and operator see all notifications. Customers see only notifications for their own work orders and deliveries.
- A scheduler checks delivery times in process and does not insert the same delivery event twice.
- Email notifications are off by default and are not sent.

Security & auth:
- Start with simple session or JWT-based auth; keep roles in `users.role`.
- Validate all inputs server-side. Barcode posts are rate limited in memory.

Notes for implementation:
- Use SQLite for v1. `init_db.js` is idempotent and adds missing columns such as `barcode_events.stage_id` and `deliveries.updated_at`.
- Keep backend routes modular (`routes/` folder) and layer DB access.
- Frontend will be a SPA with routes for login, admin, customer, and production board.
