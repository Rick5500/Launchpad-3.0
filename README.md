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
- Work order status values are `open`, `in-progress`, `completed`, and `on-hold`. A legacy `complete` value is rewritten to `completed` when the database is initialized and when a work order is saved. Delivery status values are `pending`, `scheduled`, `out-for-delivery`, and `complete`.

Barcode scans:
- `POST /api/barcode` (admin or operator) stores `scanned_value`, the resolved `work_order_id`, `operator_id` from the session, `location`, and `event_time` on `barcode_events`.
- The scanned value matches `work_orders.external_id` exactly first (for example `WO-1001`). If that misses and the value is a positive integer, it matches `work_orders.id`. Unknown values return 404. Missing or invalid input returns 400.
- `GET /api/barcode/events` (admin or operator) filters by `work_order_id`, `operator` (user id or username), and `from` / `to`, with `limit` (default 50, max 200) and `offset`.
- `GET /api/workorders/:id/events` returns that order's scans. Customers only receive events for their own work orders.
- A scan location can advance the work order's production stage. `BARCODE_LOCATION_STAGES` is a semicolon-separated list of `Location=Stage Name` pairs. When the variable is unset, `Shipping`, `Quality Control`, and `Finishing` map to the stages of those names. Set it to an empty value to disable advancement. The scan is still stored if the stage name is missing. `barcode_events.stage_id` records the stage that was applied.
- Operators use the Scan page (`/scan`). The field accepts keyboard-wedge input and submits on Enter. Work order detail shows the scan history tab.

Deliveries:
- `GET /api/delivery` lists deliveries with work order and customer fields, plus `overdue`, `due_today`, `due_soon`, and `timing`. Customers only see deliveries for their own work orders. The response is `{ deliveries, total, limit, offset, evaluated_at }`.
- `POST /api/delivery` and `PUT /api/delivery/:id` are admin or operator. A delivery stores `will_call`, `due_time`, `carrier`, and `status`. Several deliveries may exist for one work order. Updating a delivery does not change its work order.
- Leave `due_time` blank on create, or send null on update, to calculate it. Will-call uses `WILL_CALL_CUTOFF` (default `15:00`). Carrier deliveries use `CARRIER_CUTOFF` (default `14:00`). If the order is ready before the cutoff on a Monday–Friday, it is due that day at the cutoff; at the cutoff or later, or on a weekend, it is due the next business day at the cutoff. Holidays are not skipped. Times are wall-clock in `DELIVERY_TIMEZONE` (default `UTC`). `DUE_SOON_HOURS` (default 4) marks a non-complete delivery due soon. Completed deliveries are not marked overdue.
- `GET /api/delivery/rules` returns those rules and a computed suggestion for an order ready now.
- The Delivery page highlights overdue and due-today rows and shows a will-call badge. Customers can open it read-only.

Docs:
- See `docs/requirements.md` for planned features and data model notes.
