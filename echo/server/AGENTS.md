Last updated: 2025-11-07T08:32:55Z

# Project Snapshot
- Dembrane ECHO server exposes a FastAPI app (`dembrane.main:app`) with async-heavy LightRAG integrations.
- Python 3.11 required; dependencies managed through `pyproject.toml` with `uv` as the package/runtime tool.
- Background work uses Dramatiq (network + cpu queues) and a scheduler module for periodic tasks.

# Build & Run
- Development API: `uv run uvicorn dembrane.main:app --port 8000 --reload --loop asyncio`
- Development scheduler: `uv run python -m dembrane.scheduler`
- Development workers:
  - Network: `uv run dramatiq-gevent --watch ./dembrane --queues network --processes 2 --threads 1 dembrane.tasks`
  - CPU: `uv run dramatiq --watch ./dembrane --queues cpu --processes 1 --threads 2 dembrane.tasks`
- Production API: `gunicorn dembrane.main:app --worker-class dembrane.lightrag_uvicorn_worker.LightRagUvicornWorker ...`
  - Uses env vars `API_WORKERS`, `API_WORKER_TIMEOUT`, `API_WORKER_MAX_REQUESTS`
- Production workers:
  - Network: `dramatiq-gevent --queues network --processes $PROCESSES --threads $THREADS dembrane.tasks`
  - CPU: `dramatiq --queues cpu --processes $PROCESSES --threads $THREADS --watch . --watch-use-polling dembrane.tasks`
- Production scheduler: `python -m dembrane.scheduler`

# Repeating Patterns
- `uv run` wraps all local entry points (uvicorn, python modules, dramatiq runners) to ensure env + dependencies stay consistent. Prefer this manager whenever spawning dev services.
- For API handlers, favor Directus queries over raw SQLAlchemy sessions when reading project/conversation data to keep behavior consistent with the admin console.

# Change Hotspots (last 90 days)
- High-churn (watch for conflicts): `echo/server/dembrane/tasks.py`, `echo/server/dembrane/transcribe.py`, `echo/server/pyproject.toml`
- Slow movers (risk of stale assumptions): CI workflow YAMLs under `.github/workflows/`, `contributors.yml`, and `echo-user-docs` backups.

# TODO / FIXME / HACK Inventory
- `dembrane/settings.py` – Centralized env loading; keep structure consistent as new services integrate.
- `dembrane/embedding.py:8` – Replace placeholder embeddings with Dembrane implementation.
- `dembrane/sentry.py:47` – Complete Sentry integration per docs.
- `dembrane/tasks.py:72` – Remove SSL bypass once proper certificate/VPC isolation exists.
- `dembrane/tasks.py:342` – Fetch contextual transcripts for previous segments.
- `dembrane/tasks.py:525` – Respect `use_pii_redaction` flag when available.
- `dembrane/quote_utils.py:118/272/289` – Link quotes to chunks; fix sampling algorithm; adjust context limit math.
- `dembrane/service/conversation.py:101` – Validate `project_tag_id_list`.
- `dembrane/transcribe.py:179` – Replace polling with webhook approach.
- `dembrane/api/chat.py` – Multiple TODOs: fill module stub, add RAG shortcut when quotes exist, implement Directus project fetch, conversation endpoint completion, admin auth checks.
- `dembrane/api/participant.py:76` – Remove unused `pin`.

# Gotchas & Notes
- Gunicorn uses custom LightRAG uvicorn worker; avoid uvloop to keep LightRAG compatible.
- CPU Dramatiq worker deliberately single-threaded to dodge LightRAG locking issues—respect `THREADS=1` guidance in prod.
- Watching directories (`--watch`, `--watch-use-polling`) adds overhead; keep file changes minimal when workers run locally.
- S3 audio paths used in verification/transcription flows should be loaded via the shared file service (`_get_audio_file_object`) so Gemini always receives fresh bytes—signed URLs may expire mid-request.
- When a Dramatiq actor needs to invoke an async FastAPI handler (e.g., `dembrane.api.conversation.summarize_conversation`), run the coroutine via `run_async_in_new_loop` from `dembrane.async_helpers` instead of calling it directly or with `asyncio.run` to avoid clashing with nested event loops.
