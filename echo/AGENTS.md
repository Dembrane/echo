# AGENTS.md

This file provides context for AI coding assistants working on the ECHO codebase.

## Project Overview

ECHO is an event-driven platform for collective sense-making. Users run discrete engagement sessions (workshops, consultations, civic forums) to collect and analyze conversations.

## Repository Structure

```
echo/
├── frontend/          # React + Vite frontend
│   ├── src/
│   │   ├── components/
│   │   ├── routes/
│   │   ├── locales/   # Translation .po files
│   │   └── config.ts  # Feature flags
│   └── COPY_GUIDE.md  # UI copy style guide
├── server/            # Python FastAPI backend
│   └── dembrane/
│       ├── api/       # API endpoints
│       ├── service/   # Business logic
│       └── settings.py # Configuration & feature flags
└── docs/              # Documentation
```

## Key Conventions

### UI Copy (IMPORTANT)

Always follow [frontend/COPY_GUIDE.md](frontend/COPY_GUIDE.md) when writing user-facing text:

- **Shortest possible, highest clarity**
- **No jargon** — use plain language users understand
- **No corporate speak** — write like explaining to a colleague
- **Never say "successfully"** — just state what happened

Examples:
- "Context limit reached" → "Selection too large"
- "Successfully saved" → "Saved"
- "Please wait while we process" → "Processing..."

### Translations

See [docs/frontend_translations.md](docs/frontend_translations.md) for the full workflow.

Quick reference:
```bash
cd frontend
pnpm messages:extract    # Extract new strings to .po files
# Edit .po files in src/locales/
pnpm messages:compile    # Compile for production
```

Supported languages: en-US, nl-NL, de-DE, fr-FR, es-ES, it-IT

### Feature Flags

**Frontend** (`frontend/src/config.ts`):
```typescript
export const ENABLE_FEATURE_NAME = import.meta.env.VITE_ENABLE_FEATURE_NAME === "1";
```

**Backend** (`server/dembrane/settings.py`):
```python
feature_name: bool = Field(
    default=False,
    alias="ENABLE_FEATURE_NAME",
    validation_alias=AliasChoices("ENABLE_FEATURE_NAME", "FEATURE_FLAGS__ENABLE_FEATURE_NAME"),
)
```

Convention: Use `ENABLE_*` naming pattern for feature flags.

### Environment Variables

- Frontend env vars must be prefixed with `VITE_`
- Backend reads from `server/.env`
- See `frontend/.env.example` and `server/.env.example` for available options

## Common Tasks

### Adding a New Feature Flag

1. Add to `server/dembrane/settings.py` in `FeatureFlagSettings` class
2. Add to `frontend/src/config.ts` if frontend needs it
3. Update `.env.example` files to document the flag

### Adding Translations

1. Write copy following COPY_GUIDE.md
2. Use `<Trans>` component or `t` template literal
3. Run `pnpm messages:extract`
4. Fill in translations in all `.po` files
5. Run `pnpm messages:compile`

### Running Locally

```bash
# Frontend
cd frontend && pnpm i && pnpm dev

# Backend API
cd server && uv sync && uv run uvicorn dembrane.main:app --port 8000 --reload --loop asyncio

# Agent service (required for agentic chat)
cd ../agent && uv sync && uv run uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

For full background processing (transcription/audio and non-agentic jobs), also run:

```bash
cd server
uv run dramatiq-gevent --watch ./dembrane --queues network --processes 2 --threads 1 dembrane.tasks
uv run dramatiq --watch ./dembrane --queues cpu --processes 1 --threads 1 dembrane.tasks
```

Agentic chat execution is stream-first through `POST /api/agentic/runs/{run_id}/stream` and no longer enqueues an agentic Dramatiq actor.

## Important Files

| File | Purpose |
|------|---------|
| `frontend/COPY_GUIDE.md` | UI copy style guide |
| `frontend/src/config.ts` | Frontend feature flags |
| `server/dembrane/settings.py` | Backend configuration |
| `docs/frontend_translations.md` | Translation workflow |

## Code Style

- Frontend: TypeScript, React, Mantine UI
- Backend: Python 3.11+, FastAPI, Pydantic
- Use existing patterns in the codebase as reference

## Dev Notes

### Recent Changes (testing branch)
- Copy guide enforcement: "context limit" → "selection too large"
- Translations updated for all 6 languages
- Suggestions use faster model (`TEXT_FAST` instead of `MULTI_MODAL_PRO`)
- Stream status shows inline under "Thinking..." instead of toast
- Webhooks (conversation-level notifications)

### Tech Debt / Known Issues
- Some mypy errors in `llm_router.py` and `settings.py` (pre-existing, non-blocking)

## Deployment Process

### Merging to Main (for echo-next environment)

1. **Compare branches**: `git log main..testing --oneline`
2. **Check for new env vars**: Look for new `Field()` definitions in `settings.py` and new exports in `config.ts`
3. **Update deployment env vars** if needed (see checklist below)
4. **Push Directus schema** if there were database changes
5. **Create PR**: `testing` → `main`
6. **Deploy** after merge

### Environment Variables Checklist

When deploying new features, check for:

**Backend** (`server/dembrane/settings.py`):
- New `LLM__*` model configurations (for LLM router)
- New `ENABLE_*` feature flags
- Any new service credentials

**Frontend** (`frontend/src/config.ts`, `frontend/.env.example`):
- New `VITE_ENABLE_*` feature flags

### LLM Router Configuration

The LLM router supports multiple deployments per model group with automatic failover:

```bash
# Primary deployment
LLM__TEXT_FAST__MODEL=azure/gpt-4.1
LLM__TEXT_FAST__API_KEY=...
LLM__TEXT_FAST__API_BASE=...

# Fallback deployments (suffix _1, _2, etc.)
LLM__TEXT_FAST_1__MODEL=vertex_ai/gemini-2.5-flash
LLM__TEXT_FAST_1__VERTEX_PROJECT=...
LLM__TEXT_FAST_1__VERTEX_LOCATION=europe-west1

# Additional fallbacks for multimodal models
LLM__MULTI_MODAL_PRO_2__MODEL=vertex_ai/gemini-2.5-pro
LLM__MULTI_MODAL_PRO_2__GCP_SA_JSON=${GCP_SA_JSON}
LLM__MULTI_MODAL_PRO_2__VERTEX_LOCATION=europe-west1

LLM__MULTI_MODAL_FAST_2__MODEL=vertex_ai/gemini-2.5-flash
LLM__MULTI_MODAL_FAST_2__GCP_SA_JSON=${GCP_SA_JSON}
LLM__MULTI_MODAL_FAST_2__VERTEX_LOCATION=europe-west1
```

Model groups: `TEXT_FAST`, `MULTI_MODAL_PRO`, `MULTI_MODAL_FAST`
