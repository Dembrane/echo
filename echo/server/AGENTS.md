Last updated: 2026-02-15

# Project Snapshot
- Dembrane ECHO server exposes a FastAPI app (`dembrane.main:app`).
- Python 3.11 required; dependencies managed through `pyproject.toml` with `uv` as the package/runtime tool.
- Background work uses Dramatiq (network + cpu queues) and a scheduler module for periodic tasks.

# Build & Run
- Development API: `uv run uvicorn dembrane.main:app --port 8000 --reload --loop asyncio`
- Agent service (from `echo/agent`): `uv run uvicorn main:app --host 0.0.0.0 --port 8001 --reload`
- Development scheduler: `uv run python -m dembrane.scheduler`
- Development workers:
  - Network: `uv run dramatiq-gevent --watch ./dembrane --queues network --processes 2 --threads 1 dembrane.tasks`
  - CPU: `uv run dramatiq --watch ./dembrane --queues cpu --processes 1 --threads 1 dembrane.tasks`
- Agentic chat runs directly in the API `/api/agentic/runs/{run_id}/stream` flow (no agentic Dramatiq dispatch). Keep workers for non-agentic jobs.
- Production API: `gunicorn dembrane.main:app --worker-class dembrane.asyncio_uvicorn_worker.AsyncioUvicornWorker ...`
  - Uses env vars `API_WORKERS`, `API_WORKER_TIMEOUT`, `API_WORKER_MAX_REQUESTS`
- Production workers:
  - Network: `dramatiq-gevent --queues network --processes $PROCESSES --threads $THREADS dembrane.tasks`
  - CPU: `dramatiq --queues cpu --processes $PROCESSES --threads $THREADS --watch . --watch-use-polling dembrane.tasks`
- Production scheduler: `python -m dembrane.scheduler`

# Repeating Patterns
- `uv run` wraps all local entry points (uvicorn, python modules, dramatiq runners) to ensure env + dependencies stay consistent. Prefer this manager whenever spawning dev services.
- Agentic runtime is reconnect-driven and lease-based in Redis: create/append persists events, and turn execution starts from `/stream` when a client is attached.
- For API handlers, favor Directus queries over raw SQLAlchemy sessions when reading project/conversation data to keep behavior consistent with the admin console.
- Config changes live in `dembrane/settings.py`: add new env vars as fields on `AppSettings`, expose grouped accessors (e.g., `feature_flags`, `directus`) if multiple modules read them, and fetch config at runtime with `settings = get_settings()`—never import env vars directly.
- Embeddings use `settings.embedding`; populate `EMBEDDING_*` env vars (model, key/base URL/version) before calling `dembrane.embedding.embed_text`.
- Ongoing clean-up: Several legacy modules and JSON templates were removed; see the pruning checklist (note 2025-11-11) before reviving anything.

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

# Background Task Design Patterns
When fixing or extending Dramatiq task flows, follow these principles:

1. **Fix root causes, not symptoms**: If a flag isn't being set correctly, fix the flag-setting logic rather than adding complex workarounds in catch-up tasks.

2. **Single source of truth**: Each state flag should be THE authoritative indicator for its purpose:
   - `is_finished` = user/system marked conversation as done
   - `is_all_chunks_transcribed` = ready for summarization (works for BOTH audio and text conversations)
   - `summary != null` = summarization complete

3. **Layered reconciliation with simple catch-up tasks**: Build eventually-consistent systems where each layer has:
   - A normal flow (task triggered by events)
   - A catch-up flow (scheduler finds stuck items)
   
   Each catch-up task should check ONE flag, not complex compound conditions:
   ```
   Layer 1: task_collect_and_finish_unfinished_conversations (2 min)
            → Sets is_finished=True for abandoned conversations
   
   Layer 2: task_reconcile_transcribed_flag (3 min)
            → Sets is_all_chunks_transcribed=True for finished conversations with no pending chunks
   
   Layer 3: task_catch_up_unsummarized_conversations (5 min)
            → Simple: is_all_chunks_transcribed=True AND summary=null → summarize
   ```

4. **Handle all conversation types**: TEXT conversations (portal input) and AUDIO conversations (uploads) must follow the same state machine. The reconciliation tasks ensure both paths converge to the same flags.

# Gotchas & Notes
- Gunicorn uses custom asyncio uvicorn worker (avoid uvloop for nest_asyncio compatibility).
- CPU Dramatiq worker uses 1 thread per process to limit memory (FFmpeg can be memory-hungry). Scale via processes/replicas instead.
- Watching directories (`--watch`, `--watch-use-polling`) adds overhead; keep file changes minimal when workers run locally.
- S3 audio paths used in verification/transcription flows should be loaded via the shared file service (`_get_audio_file_object`) so Gemini always receives fresh bytes—signed URLs may expire mid-request.
- Verification topics reconcile at startup (see `reconcile_default_verification_topics`) and use a Redis lock `dembrane:verification_topics:reconcile_lock` (5m TTL); if logs say another worker holds the lock, just rerun once it releases or manually delete the key if a crash left it behind.
- When a Dramatiq actor needs to invoke an async FastAPI handler (e.g., `dembrane.api.conversation.summarize_conversation`), run the coroutine via `run_async_in_new_loop` from `dembrane.async_helpers` instead of calling it directly or with `asyncio.run` to avoid clashing with nested event loops.
