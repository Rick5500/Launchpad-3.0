# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Work order create/edit form UI (`frontend/src/routes/WorkOrderForm.jsx`)
- Work order create API endpoint (`backend/routes/workOrders.js`, `POST /api/workorders`)
- Work order update API endpoint (`backend/routes/workOrders.js`, `PUT /api/workorders/:id`)
- Authenticated API fetch helper (`frontend/src/api.js`)
- New frontend routes for work order creation and editing
- `CHANGELOG.md` file

### Changed
- Extended work order schema with new fields for specifications, start date, production line, routing instructions, attachments, and notes (`database/schema.sql`)
- Added database migration logic to preserve existing work orders when adding new columns (`backend/init_db.js`)
- Added edit action to work order detail page
- Added "New Work Order" button on work order list page

### Fixed
- Corrected inconsistent frontend work order route paths
