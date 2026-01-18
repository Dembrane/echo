# Local Service Run Guide

This doc explains how to view running services, open UIs, and start/stop each service locally.

## Required Components

Core runtime pieces:

- **Infra (Docker Compose)**: `.devcontainer/docker-compose.yml`
  - Starts Postgres, Redis, Neo4j, Directus, and the devcontainer service.
- **Backend API**: `server/run.sh`
  - Uses env from `server/.env` (see `server/.env.sample` for required vars).
- **Frontends**: `frontend/package.json`
  - Dev scripts: `pnpm run dev` (admin) and `pnpm run participant:dev`
  - Env: `frontend/.env` (see `frontend/.env.sample` / `frontend/.env.example`)
- **Usage tracker (optional)**: `tools/usage-tracker/app.py`
  - Env: `tools/usage-tracker/.env` (from `tools/usage-tracker/env.example`)
- **Directus config**: `directus/.env` (see `directus/.env.sample`)

Minimum files needed:

- `server/.env`
- `frontend/.env`
- `directus/.env`
- `tools/usage-tracker/.env` (optional)
- `.devcontainer/docker-compose.yml`

## Where to See Them Running

- Logs are written to `.logs/` at the repo root when started via background commands.
  - `/.logs/server.log`
  - `/.logs/worker.log`
  - `/.logs/worker-cpu.log`
  - `/.logs/scheduler.log`
  - `/.logs/frontend-admin.log`
  - `/.logs/frontend-participant.log`
  - `/.logs/usage-tracker.log`

To tail logs:

```bash
# From repo root
ls .logs

# Example
tail -f .logs/server.log
```

To see listening ports:

```bash
ss -ltnp | rg '8000|5173|5174|8055|8501'
```

## URLs to Open

- Backend API: `http://localhost:8000`
- Admin frontend: `http://localhost:5173`
- Participant frontend: `http://localhost:5174`
- Usage tracker (Streamlit): `http://localhost:8501`
- Directus (if running): `http://localhost:8055`

## Docker Setup (Host Machine)

Docker is required to run Postgres, Redis, Neo4j, Directus, and optionally MinIO.

Debian/WSL example:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose
sudo service docker start
```

## Service Start Commands

### Backend API

```bash
cd server
./run.sh
```

### Workers

```bash
cd server
./run-worker.sh
./run-worker-cpu.sh
./run-scheduler.sh
```

### Frontends

```bash
cd frontend
pnpm run dev
pnpm run participant:dev
```

### Usage Tracker

```bash
cd tools/usage-tracker
uv run streamlit run app.py
```

### Directus / Postgres / Redis

These typically run via the devcontainer / docker-compose setup. See `readme.md` and `.devcontainer`.

## How to Interact With the App

- Open the admin frontend at `http://localhost:5173`.
- Open the participant portal at `http://localhost:5174`.
- Use the usage tracker at `http://localhost:8501`.
- For API exploration, visit `http://localhost:8000/docs` if `SERVE_API_DOCS=1` in `server/.env`.

## Notes

- If a service fails to start, check its log in `.logs/`.
- If ports are already in use, stop the conflicting process or change the port.
- Directus and DB services must be running for most app features to work.

## Resume After Closing the IDE

1) Start Docker (host machine):

```bash
service docker start
```

2) From repo root, start everything:

```bash
RUN_MINIO=1 ./run-all.sh
```

3) Open the local URLs listed above.
