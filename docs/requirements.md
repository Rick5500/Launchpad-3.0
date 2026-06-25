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

API endpoints (initial placeholders):
- `POST /api/auth/login` — authenticate users
- `GET /api/admin/...` — admin resources
- `GET /api/customer/...` — customer resources
- `POST /api/workorders` — create work orders
- `GET /api/production` — production board data
- `POST /api/barcode` — record barcode event
- `GET /api/delivery/rules` — delivery/will-call rules

Security & auth:
- Start with simple session or JWT-based auth; keep roles in `users.role`.
- Validate all inputs server-side; plan for rate-limiting on barcode endpoints.

Notes for implementation:
- Use SQLite for v1 to simplify deployment and testing; plan migrations later.
- Keep backend routes modular (`routes/` folder) and layer DB access.
- Frontend will be a SPA with routes for login, admin, customer, and production board.
