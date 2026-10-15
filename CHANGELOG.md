# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
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
- Legacy work order status `complete` is normalized to `completed` on save and by an idempotent database init migration. Lists, detail, and the dashboard treat `complete` and `completed` as the same finished status
- `PUT /api/workorders/:id/priority` requires a positive integer id
- Database init no longer exits before departments, stages, and sample data are seeded, and it always exits after each independent seed step
- Sample production board and delivery rows reference real work order ids
- Removed the unused `addColumnIfMissing` helper
- API errors no longer include raw database messages
- Customer creation uses `datetime('now')` and no longer discards the generated password
- Corrected inconsistent frontend work order route paths
