---
title: The processing pipeline
description: What happens between an uploaded audio chunk and a finished, summarised conversation - transcription, correction, merge, summarise, reports, and the Redis coordination that holds it together.
audience: developer-internal
---

# The processing pipeline

This is the heart of dembrane: how raw audio becomes a clean, summarised, queryable
conversation. It's an event-driven fan-out - work is split into per-chunk tasks on the
Dramatiq `network` queue, coordinated through Redis counters, and joined back up when the
last chunk lands. The tasks live in `echo/server/dembrane/tasks.py`; the coordination lives in
`echo/server/dembrane/coordination.py`. Read [background jobs & scheduler](./background-jobs-and-scheduler.md)
alongside this - that page covers the queues, the gevent rules, and the catch-up jobs that
backstop the pipeline.

## The happy path, end to end

```
upload chunk → S3 (presigned)
   → task_transcribe_chunk        (AssemblyAI webhook/poll, or LiteLLM)
   → task_correct_transcript      (Gemini: hotwords + PII redaction)
   → decrement pending-chunks counter
        … when counter hits 0 AND conversation is finished:
   → task_finalize_conversation
        ├─ task_merge_conversation_chunks   (cpu queue)
        └─ task_summarize_conversation       (Gemini)
```

### 1. Upload to S3

Audio arrives in chunks (≈30 s each). The participant portal and the iOS app request a
presigned URL (`POST /api/participant/conversations/{cid}/get-upload-url`, rate-limited
40/min), upload the chunk straight to S3, then confirm. A `conversation_chunk` row is created.
See [the participant API](../developer-external/participant-api.md). When chunks are created
for transcription, the pipeline *increments a Redis pending-chunks counter* for the
conversation (`increment_pending_chunks`).

### 2. Transcribe - `task_transcribe_chunk` (priority 0, `network`)

Each chunk is transcribed independently. Two backends:

- *AssemblyAI* - the chunk audio is submitted with `keyterms_prompt` hotwords (up to 1000). Results come back either by *webhook* (`ASSEMBLYAI_WEBHOOK_URL`, secured with the `X-AssemblyAI-Webhook-Secret` header → handled in `api/webhooks.py`) or by *polling* the transcript endpoint (3 s interval, 30 min cap). The raw response and word-level timestamps are stored on the chunk's `diarization` field under schema `Dembrane-25-09` (or `Dembrane-25-09-assemblyai-partial`).
- *LiteLLM* - the multimodal fallback path, routed through the `MULTI_MODAL_*` groups.

### 3. Correct - `task_correct_transcript` (priority 0, `network`)

A Gemini pass that cleans the raw transcript: applies hotwords/key-terms context and performs
*PII redaction*. The output is written with a diarisation *schema tag* so downstream code
knows what shape it's reading:

- `Dembrane-26-01-redaction` - the redaction-aware schema (when anonymisation/redaction is on).
- `Dembrane-25-09` - the prior schema (no redaction).

The "key terms" / hotwords come from the project's `default_conversation_transcript_prompt`
field (set in [the portal editor](../../features/portal-editor.md)). When a chunk finishes
(success or recoverable error) the pipeline *decrements* the pending-chunks counter, guarded
so a single chunk can only decrement once (`_chunk_decremented_key`).

### 4. Finalize - `task_finalize_conversation` (priority 20, `network`)

When the pending-chunks counter reaches *0* *and* the conversation is marked finished, the
conversation is finalised. This step is *idempotent*: it takes a Redis finalize lock
(`mark_finalize_in_progress`) so two workers racing on the last chunk don't both finalise.
Finalize dispatches the join steps.

### 5. Merge - `task_merge_conversation_chunks` (priority 10, `cpu`)

The CPU-bound step: stitch the per-chunk transcripts into the full conversation transcript.
This runs on the `cpu` queue (single-threaded) rather than `network`, because it's
compute-bound, not I/O-bound. It stores its result (`store_results=True`).

### 6. Summarise - `task_summarize_conversation` (priority 30, `network`)

A Gemini pass that produces the conversation summary. Completion is signalled by `summary`
becoming non-null - that's the single source of truth for "summarisation done", which the
catch-up job keys off. There's a finish hook (`task_finish_conversation_hook`) and webhook
dispatch (`conversation.transcribed`, `conversation.summarized`) layered on top - see
[webhooks](../developer-external/webhooks.md).

## Coordination & idempotency (Redis)

Because the last-chunk join is a race, the pipeline leans on Redis keys under the `coord:`
prefix (`coordination.py`):

| Key | Purpose |
|---|---|
| `coord:pending_chunks:{cid}` | The fan-in counter. Hits 0 → trigger finalize. 24 h TTL. |
| `coord:processing_started:{cid}` | One-shot flag that processing has begun. |
| `coord:finalize_in_progress:{cid}` | Lock so only one worker finalises. ~5 min TTL. |
| `coord:finish_in_progress:{cid}` | Lock around the finish hook. |
| `coord:chunk_decremented:{cid}:{chunk_id}` | Guard so a chunk decrements the counter exactly once. |

> [!IMPORTANT]
> These counters can drift (a worker dies mid-task, a webhook is missed). That's why
> scheduled *catch-up / reconcile* jobs exist - `task_collect_and_finish_unfinished_conversations`
> (every 2 min), `task_reconcile_transcribed_flag` (every 3 min), and
> `task_catch_up_unsummarized_conversations` (every 5 min). Fix root causes in the pipeline,
> not symptoms in the catch-up jobs (see `echo/server/AGENTS.md`). The catch-up jobs are a
> safety net, not the mechanism.

The flag invariants worth memorising:

- `is_finished` - the user/system marked the conversation done.
- `is_all_chunks_transcribed` - ready for summarisation (true for *audio and text* conversations).
- `summary != null` - summarisation complete.

## Reports - two-phase

Report generation is a fan-out/fan-in of its own:

1. *Phase 1 - summarise.* `task_create_report` fans out per-conversation summarisation, then `task_report_summarization_done` signals when that's complete.
2. *Phase 2 - generate.* `task_create_report_continue` composes the multi-section report from the gathered summaries.

Scheduled reports are dispatched by `task_check_scheduled_reports` (every 5 min); notification
recipients come from `project_report_notification_participants`. See
[reports](../../features/reports.md).

## Chat retrieval modes

Chat doesn't re-read everything every time. It has two retrieval modes:

- *overview* - works over conversation *summaries*. Cheaper, broad, good for "what came up across all of this?".
- *deep_dive* - works over full *transcripts* for the selected conversations. More expensive, precise.

Embeddings (pgvector) back retrieval; the LangGraph agent service adds tool-driven search on
top. See [chat & the agent service](./chat-and-agent.md).

## Live progress - SSE over Redis pub/sub

The pipeline doesn't poll the database to drive the UI. Progress is *published to Redis* and
*streamed to clients over Server-Sent Events* (`stream_status.py`, `processing_status_utils.py`).
A worker publishes a status event; the FastAPI SSE endpoint, subscribed to the conversation's
Redis channel, relays it to the dashboard or the iOS app. This keeps workers and the API
decoupled - workers never hold an HTTP connection to a client.

## The LLM layer - LiteLLM Router

All model calls go through a *LiteLLM Router* (`llm_router.py`) configured by model group.
The router load-balances and fails over across multiple deployments per group, with weight
inferred from the env-var suffix (primary = 10, `_1` = 9, `_2` = 8, …):

| Group | Used for | Audio |
|---|---|---|
| `MULTI_MODAL_PRO` (Gemini 2.5 Pro) | Chat, reports, Get-Reply replies, artifact generation | Yes |
| `MULTI_MODAL_FAST` (Gemini Flash) | Realtime verification | Yes |
| `TEXT_FAST` | Summaries, chat streaming, auto-select | No |

Configure with `LLM__<GROUP>__*` (and numbered fallbacks `LLM__<GROUP>_1__*`). The full
reference is `echo/docs/litellm_config.md`; for the operator's view see
[configuration & LLM providers](../developer-external/configuration-and-llm-providers.md).

> [!NOTE]
> Built-in analysis (the Gemini-powered summaries, library, chat-with-analysis) is a
> *Changemaker+* capability. *Innovator* workspaces get bring-your-own-LLM via MCP
> instead (*coming soon*). Free workspaces have a 1-hour recording cap and the over-cap
> machinery (ADR 0001). See [tiers & billing](../../features/tiers-and-billing.md).

## EU data residency

Transcription and the language models can be pinned to EU regions: AssemblyAI EU, Vertex
`europe-west*`, an EU S3 endpoint, and EU SendGrid. The `Guardian` tier's sovereign stack
builds on this (*coming soon*). See [self-hosting](../developer-external/self-hosting.md).

---

*Related*

- [Background jobs & scheduler](./background-jobs-and-scheduler.md)
- [Chat & the agent service](./chat-and-agent.md)
- [The data model](./data-model.md)
- [Transcription (feature)](../../features/transcription.md)
- [The participant API](../developer-external/participant-api.md)
