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
8. Reporting, notifications, and role-specific UI flows.

## Module Status
- `frontend/`: Vite + React scaffold complete, login screen in place.
- `backend/`: Express scaffold complete, auth placeholder and health endpoints in place.
- `database/`: SQLite schema defined, DB init script available.
- `assets/`: placeholder folder added for static assets.
- `docs/`: requirements and roadmap notes captured.

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
