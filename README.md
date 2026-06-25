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

2. Copy `.env.example` to `.env` and adjust values.

3. Start the backend:

```bash
npm start
```

Frontend:
- `frontend/` contains placeholder React files. Use `create-react-app` or your preferred setup when ready.

Docs:
- See `docs/requirements.md` for planned features and data model notes.
