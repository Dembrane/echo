# Echo Agent Service

Isolated CopilotKit/LangGraph runtime for Agentic Chat.

## Why This Service Exists

- Keeps agent execution out of the frontend runtime.
- Avoids dependency conflicts with `echo/server`.
- Supports long-running execution and backend-owned run lifecycle.

## Local Run

```bash
cd echo/agent
cp .env.sample .env
# set GEMINI_API_KEY in .env
uv sync
uv run uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

## Docker Run

```bash
cd echo/agent
docker build -t echo-agent:local .
docker run --rm -p 8001:8001 --env-file .env echo-agent:local
```

## Endpoints

- `GET /health`
- `POST /copilotkit/{project_id}`

## Notes

- This service is intentionally scoped to one purpose: agentic chat execution.
- Auth, persistence, and notifications should be owned by `echo/server` gateway routes.
