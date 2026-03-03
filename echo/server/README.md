## Dembrane ECHO Server

## Getting Started

- [docs/getting_started.md](./docs/getting_started.md): General information and setup instructions of the development environment.

## Agentic Run Inspection Script

Use the local script below to inspect the latest agentic runs/events from Postgres.
It prefers a running `postgres` container via `docker exec`, and falls back to devcontainer `docker compose` when needed:

```bash
./scripts/agentic/latest_runs.sh --limit 20 --events 30
```

Optional filters:

```bash
./scripts/agentic/latest_runs.sh --project-id <project_uuid>
./scripts/agentic/latest_runs.sh --chat-id <chat_uuid>
./scripts/agentic/latest_runs.sh --run-id <run_uuid>
```

JSON output:

```bash
./scripts/agentic/latest_runs.sh --json
```
