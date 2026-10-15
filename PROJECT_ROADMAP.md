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
11. Phase 3 printable work order.
12. Phase 4 admin configuration pages.

## Phase 1 — Order intake (done)
Customers submit one order that creates a work order per selected service (`YYYYMMDD-NNN-A/B/C`). Contact, project, delivery, due date/time, line items, and files are stored with the order. The schema below is in place so later phases do not need a breaking redesign.

## Phase 2 — Admin Board (done)
Staff home is the Admin Board. Department tabs and the queue summary count active work (finished work and the Complete department are the Complete tab). Stat cards cover total active, the five entry departments, and completed this month. The work order table is filtered and paginated on the server. Recent activity is written when a work order is created, moved, or completed, including a department move from a barcode scan whose location matches a department. Pending archive requests can be approved or rejected by an admin, with `approval_by`, `approval_at`, and an activity row. System alerts are computed from empty queues, overdue deliveries, `system_settings.last_backup_at`, and active `system_alerts` rows. Search Orders, Services, Users, System Settings, Activity Log, Barcode Settings, and the printable work order are still placeholders.

## Phase 3 — Printable work order (not built)
A print/PDF view of the work order with a Code 128 barcode of the work order number (`external_id`), production history (`production_history` plus barcode scans), scan instructions, and the spec block already returned by work order detail. Scanning stays on `POST /api/barcode`.

## Phase 4 — Admin pages (not built)
Services, Users, System Settings (`system_settings`), notification settings (`notification_settings`, seeded disabled — no mail is sent), Activity Log, Barcode Settings, and Search Orders. The Admin Board already approves and rejects pending requests; this phase is the dedicated admin screen for that queue and for the older notification settings rows. Staff reports and in-app notifications from milestone 8 are already available. Delivery methods are already a table so the method list can be edited without a schema change.

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
