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

Seeding is idempotent. Creating the admin user, customer users, departments, production stages, sample orders, board rows, and deliveries are separate steps, so an existing admin user does not skip the rest of the seed. Sample board and delivery rows point at the seeded work orders by external id. Seeded customer users (`acme`, `whitebox`, `orion`) get random unknown passwords and cannot log in until an administrator creates a usable account. Passwords other than a newly generated admin password are never printed.

4. Start the backend:

```bash
npm start
```

Frontend:
- `frontend/` is a Vite + React app. From that folder, run `npm install` and `npm run dev`.
- Navigation follows the signed-in role. Customers see their own work orders. The production board, customer directory, and admin pages are hidden from roles that cannot use them.

Security notes:
- Passwords are stored with bcrypt. A successful login still accepts a legacy unsalted SHA-256 hash once, then replaces it with bcrypt.
- Sessions expire after `SESSION_TTL_HOURS` (default 8). `POST /api/auth/logout` clears the bearer session. Expired sessions are removed on use and by a periodic cleanup.
- `POST /api/auth/login` is limited to 10 attempts per 15 minutes for each IP and username.
- `POST /api/customers` is admin-only. Omit `password` to receive a one-time random password in the create response. A supplied password must be at least 8 characters, is stored, and is not echoed back.
- `GET /api/customers/lookup` is available to admin and operator and returns only `id`, `username`, and `display_name`. Operators use it to pick an existing customer on a work order. Creating a customer stays admin-only.
- Customer create/list and department create/update/delete require the admin role. Work order create, update, stage, and priority changes require admin or operator. Customers can read only their own work orders. The dashboard and production board are limited to admin and operator; the customer home page shows only that customer's orders.
- Work order status values are `open`, `in-progress`, `completed`, and `on-hold`. A legacy `complete` value is rewritten to `completed` when the database is initialized and when a work order is saved. Delivery records still use `complete` for a finished delivery.
- Set `TRUST_PROXY` (see `backend/.env.example`) when the API is behind a reverse proxy so the login rate limit uses the client IP from `X-Forwarded-For`.

Docs:
- See `docs/requirements.md` for planned features and data model notes.
