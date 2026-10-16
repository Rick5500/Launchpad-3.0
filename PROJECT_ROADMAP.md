# Launchpad 3.0 Project Roadmap

## Vision
Launchpad 3.0 will be a modern manufacturing and work-order management platform that connects administrators, customers, operators, and production teams in a single unified web application. The product is designed to streamline work order entry, production tracking, barcode scanning, delivery scheduling, and role-based dashboards while providing a clean, extensible architecture for future growth.

## Technology Stack
- Frontend: React with Vite
- Backend: Node.js with Express
- Database: SQLite for initial implementation
- Authentication: session-like JWT-style token system
- Deployment: container-friendly Node/SQLite architecture with static frontend
- Docs: Markdown in repository root and `docs/`

## Architecture
- `frontend/`: React SPA powered by Vite, hosting login and dashboard UIs.
- `backend/`: Express API server with auth, health checks, and placeholder endpoints.
- `database/`: SQLite schema and initial data setup.
- `assets/`: Static branding and media assets.
- `docs/`: Requirements, roadmap notes, and implementation details.

The architecture is intentionally modular so the backend can later add route modules, middleware, and DB migration tooling while the frontend grows with route-based pages and reusable components.

## Milestones
1. Initial scaffold: frontend, backend, database, assets, docs.
2. User authentication + login.
3. Admin dashboard + customer dashboard placeholders.
4. Work order creation and listing.
5. Production board view and status tracking.
6. Barcode event logging and tracking.
7. Delivery / will-call due-time rules.
8. Reporting, notifications, and role-specific UI flows. **Done.** Staff reports with CSV export, in-app notifications, and a notification bell are in place. Customers cannot open reports and only see notifications for their own work orders and deliveries.
9. Phase 1 order intake: customer order form, order numbers, services, line items, and file uploads. Done in this phase.
10. Phase 2 Admin Board. **Done.** Department queues, stat cards, paginated work orders, activity, scans, approvals, and computed alerts.
11. Phase 3 printable work order. **Done.** Letter-size work order with a Code 128 barcode, production history, and print CSS. Customers can print only their own orders.
12. Phase 4 admin configuration pages. **Done.** Services, users, system settings, notification toggles, activity log, barcode locations, and order search.

## Phase 1 — Order intake (done)
Customers submit one order that creates a work order per selected service (`YYYYMMDD-NNN-A/B/C`). Contact, project, delivery, due date/time, line items, and files are stored with the order. The schema below is in place so later phases do not need a breaking redesign.

## Phase 2 — Admin Board (done)
Staff home is the Admin Board. Department tabs and the queue summary count active work (finished work and the Complete department are the Complete tab). Stat cards cover total active, the five entry departments, and completed this month. The work order table is filtered and paginated on the server. Recent activity is written when a work order is created, moved, or completed, including a department move from a barcode scan. Pending archive requests can be approved or rejected by an admin, with `approval_by`, `approval_at`, and an activity row. System alerts are computed from empty queues, overdue deliveries, `system_settings.last_backup_at`, and active `system_alerts` rows. The work order print action opens the printable work order. Search Orders, Services, Users, System Settings, Activity Log, and Barcode Settings are the Phase 4 pages.

## Phase 3 — Printable work order (done)
`GET /api/workorders/:id/print` and `GET /api/orders/:id/print` return the sheet data. The page is `/work-orders/:id/print` for one work order and `/orders/:id/print` for every work order on an order. The Code 128 SVG encodes `external_id` (for example `20261015-001-A`). `POST /api/barcode` still records the scan. Production history is the real `production_history` rows. A department scan that moves the work order adds a row. Customers see department, status, and time. Staff also see who scanned and the note. Print CSS targets letter paper, hides the toolbar, and page-breaks between work orders. Download PDF uses the browser print dialog. The letterhead is `company_name`, `company_address`, and `company_phone` from system settings. Missing keys use Accent Imaging, Inc., 8121 Brownleigh Drive, Raleigh, NC 27617, 919-782-3332.

## Phase 4 — Admin pages (done)
Services, users, system settings, notification toggles, the activity log, barcode locations, and order search replace the sidebar placeholders. Admins manage all of them. Operators can search orders and open the existing reports. Customers receive HTTP 403. Deactivated services leave the order form and stay on existing orders. Seeded services keep sequence suffixes. An admin cannot demote or deactivate themselves or the last active administrator. Password hashes are not returned. Letterhead, due-soon hours, and the last backup timestamp are editable settings; cutoffs, timezone, and upload limits stay environment values and are shown read-only. In-app notification events can be turned off. Email rows stay off and no mail is sent. `barcode_locations` is the scan map once it has any row. An empty table keeps the environment stage map and department-name match. The barcode page includes a dry run that writes nothing. Every admin change writes `activity_log` with the actor. Lists are paginated and sort columns are whitelisted. `init_db.js` adds the new columns and seeds on an existing database, and a second run does not duplicate or overwrite saved settings. Delivery methods remain a table. The Admin Board still approves and rejects pending requests.

## Module Status
- `frontend/`: Vite + React scaffold complete, login screen in place.
- `backend/`: Express scaffold complete, auth placeholder and health endpoints in place.
- `database/`: SQLite schema defined, DB init script available.
- `assets/`: placeholder folder added for static assets.
- `docs/`: requirements and roadmap notes captured.
- Reporting and notifications: admin and operator reports, CSV export, SQLite notifications, and the top-bar bell are implemented.

## Coding Standards
- Keep source files tracked in Git and avoid committing generated output.
- Use clear, descriptive route and component names.
- Prefer modular code separation for routes, services, and utilities.
- Validate input payloads on the server.
- Keep secrets and environment-specific values out of source control (`.env`, `.env.local`).
- Document APIs and features in repository docs.

## Release Notes
- **v0.1.0**: Initial project scaffold created for Launchpad 3.0.
- **v0.1.1**: Added backend auth scaffolding and login screen.
- **v0.1.2**: Migrated frontend to Vite + React and added `/health` backend endpoint.
- **v0.8.0**: Added staff reporting with CSV export and in-app delivery and work-order notifications. Email delivery is stubbed and off by default.
- **v0.9.0**: Added the printable Code 128 work order for staff and for a customer's own orders.
- **v0.10.0**: Added the admin pages for services, users, system settings, notification toggles, the activity log, barcode locations, and order search.
