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
- `users` table with `role` (admin, customer, operator)
- `work_orders` table capturing items, quantities, due dates, status
- `production_board` records or derived from `work_orders` status
- `barcode_events` to log scans (timestamp, operator, location, payload)
- `deliveries` table with will-call flags and due-time rules

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

Barcode scans:
- Persist `scanned_value`, `work_order_id`, `operator_id` (the signed-in user), `location`, and `event_time`.
- Resolve `scanned_value` to `work_orders.external_id` first, then to `work_orders.id` when the value is a positive integer.
- Return 400 for invalid input and 404 when no work order matches.
- `GET /api/barcode/events` accepts `work_order_id`, `operator`, `from`, `to`, `limit`, and `offset`.
- A configured location can move the work order to a production stage (`BARCODE_LOCATION_STAGES`). The default map is Shipping, Quality Control, and Finishing. An empty value turns advancement off.
- `POST /api/barcode` is rate limited per signed-in user.

Delivery / will-call:
- Rules live in `backend/deliveryRules.js`.
- Will-call cutoff defaults to 15:00 (`WILL_CALL_CUTOFF`). Carrier cutoff defaults to 14:00 (`CARRIER_CUTOFF`). Timezone defaults to UTC (`DELIVERY_TIMEZONE`).
- Ready before the cutoff on a weekday: due that day at the cutoff. Ready at or after the cutoff, or on a weekend: due the next Monday–Friday at the cutoff. Holidays are not skipped.
- Flag open deliveries overdue, due today, or due soon (`DUE_SOON_HOURS`, default 4). Status `complete` is not overdue.
- Status values are `pending`, `scheduled`, `out-for-delivery`, and `complete`.
- Customers can read only deliveries for their own work orders. Admin and operator can write.

Security & auth:
- Start with simple session or JWT-based auth; keep roles in `users.role`.
- Validate all inputs server-side. Barcode posts are rate limited in memory.

Notes for implementation:
- Use SQLite for v1. `init_db.js` is idempotent and adds missing columns such as `barcode_events.stage_id` and `deliveries.updated_at`.
- Keep backend routes modular (`routes/` folder) and layer DB access.
- Frontend will be a SPA with routes for login, admin, customer, and production board.
