# Echo Agent Service

Isolated CopilotKit/LangGraph runtime for Agentic Chat.

## Why This Service Exists

- Keeps agent execution out of the frontend runtime.
- Avoids dependency conflicts with `echo/server`.
- Supports long-running execution and backend-owned run lifecycle.

## Local Run

```bash
cd echo/agent
# configure Vertex auth via one of:
# - VERTEX_PROJECT + VERTEX_LOCATION + VERTEX_CREDENTIALS / GCP_SA_JSON
# - Application Default Credentials (ADC)
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
- Default model is Vertex Anthropic Claude Opus 4.6 via `LLM_MODEL=claude-opus-4-6`.
- Default Vertex location is `europe-west1` because that is the working Europe region for the current project setup.
