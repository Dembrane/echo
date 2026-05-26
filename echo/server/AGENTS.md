# AGENTS: server

Cross-cutting rules (Directus, BFF, LLM model groups, Dramatiq/gevent, transcription, brand) live in @../AGENTS.md, which also defines the maintenance protocol for these files. This file only adds server-specific patterns and non-obvious gotchas.

## Patterns

- Local entry points always go through `uv run` so env + deps stay consistent (uvicorn, scheduler, dramatiq runners)
- For API handlers reading project/conversation data, prefer Directus queries over raw SQLAlchemy sessions; keeps behavior aligned with the admin console
- Config lives in `dembrane/settings.py`. Add new env vars as fields on `AppSettings`; group accessors (e.g. `feature_flags`, `directus`) when multiple modules read them. Fetch at runtime with `settings = get_settings()`. **Never import env vars directly**
- Embeddings: populate `EMBEDDING_*` env vars (model, key, base URL, version) before calling `dembrane.embedding.embed_text`. The placeholder in `dembrane/embedding.py` is not yet the production implementation
- Production API uses a **custom asyncio uvicorn worker** (`dembrane.asyncio_uvicorn_worker.AsyncioUvicornWorker`); avoid `uvloop` for `nest_asyncio` compatibility

## Background task design

When fixing or extending Dramatiq flows:

1. **Fix root causes, not symptoms**. If a flag isn't being set, fix the flag-setting logic rather than adding catch-up task workarounds
2. **Single source of truth per flag**:
   - `is_finished`: user/system marked the conversation done
   - `is_all_chunks_transcribed`: ready for summarization (audio **and** text conversations)
   - `summary != null`: summarization complete
3. **Layered reconciliation, simple catch-ups**. Each layer has a normal flow (event-triggered) and a catch-up flow (scheduler finds stuck items). Catch-up tasks should check exactly **one** flag, not compound conditions:
   - L1 `task_collect_and_finish_unfinished_conversations` (~2 min) → sets `is_finished=True` for abandoned conversations
   - L2 `task_reconcile_transcribed_flag` (~3 min) → sets `is_all_chunks_transcribed=True` for finished conversations with no pending chunks
   - L3 `task_catch_up_unsummarized_conversations` (~5 min) → `is_all_chunks_transcribed=True AND summary=null` → summarize
4. **TEXT and AUDIO conversations share the same state machine**; both must converge to the same flags

## Worker tuning

- CPU Dramatiq worker uses **1 thread per process** to cap memory (FFmpeg can be hungry). Scale via processes/replicas, not threads
- `--watch` + `--watch-use-polling` add overhead; minimize file churn while local workers run

## Verification topic reconciliation

Verification topics reconcile at startup (`reconcile_default_verification_topics`) and use a Redis lock `dembrane:verification_topics:reconcile_lock` (5m TTL). If logs say another worker holds the lock, wait for it to release, or manually delete the key if a crash left it behind.

## Agentic runtime

Reconnect-driven and lease-based in Redis: create/append persist events; turn execution starts from `/api/agentic/runs/{run_id}/stream` when a client is attached. Workers exist only for non-agentic jobs.
