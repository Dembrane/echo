# AssemblyAI Webhook Integration — Implementation Plan

> Standalone implementation guide. An engineer can work through this top-to-bottom.

## Context

The Dembrane-25-09 transcription provider runs a two-stage pipeline: (1) AssemblyAI transcription, (2) Gemini correction. Stage 1 currently **polls** every 3 seconds in a `while True` / `time.sleep(3)` loop (`transcribe.py:130`), blocking a Dramatiq network worker for 30-180+ seconds per chunk. With only 2 network worker threads, a handful of concurrent transcriptions saturates the queue and blocks all downstream tasks (summarization, webhooks, finalization).

AssemblyAI natively supports webhooks via a `webhook_url` parameter on the submit endpoint ([docs](https://www.assemblyai.com/docs/deployment/webhooks)). This plan replaces polling with webhooks — submit the job instantly, free the worker, and process the result when AssemblyAI calls back.

**Goal**: Reduce network worker occupation from ~60-180s per chunk to <1s per chunk.

**Scope**: Only the Dembrane-25-09 provider (confirmed production provider). Feature-flagged — polling remains the default when webhook URL is unset.

---

## Architecture

### Current flow (polling)
```
task_transcribe_chunk  ───────────────────────────────────────────→  _on_chunk_transcription_done
  │  (worker blocked entire time: 60-180s)                            │
  ├─ submit to AssemblyAI                                             ├─ decrement counter
  ├─ poll every 3s until done            ← THIS IS THE BOTTLENECK     ├─ if counter==0 && is_finished:
  ├─ save partial (AssemblyAI result)                                 │    task_finalize_conversation
  ├─ run Gemini correction                                            │
  └─ save final (corrected result)                                    │
```

### New flow (webhooks)
```
task_transcribe_chunk          webhook endpoint              task_correct_transcript
  │  (worker freed in <1s)        │                            │  (worker: ~10-20s)
  ├─ submit to AssemblyAI         │                            │
  ├─ store metadata in Redis      │                            │
  └─ return immediately           │                            │
                                  │ ← AssemblyAI calls back    │
                                  ├─ verify secret             │
                                  ├─ fetch full transcript     │
                                  ├─ save partial result       │
                                  └─ enqueue ─────────────────→├─ run Gemini correction
                                                               ├─ save final result
                                                               └─ _on_chunk_transcription_done
```

### What is NOT touched
- `task_finalize_conversation` — unchanged
- `task_summarize_conversation` — unchanged
- `task_merge_conversation_chunks` — unchanged
- `task_finish_conversation_hook` — unchanged
- `task_process_conversation_chunk` — unchanged
- `coordination.py` core functions (`increment_pending_chunks`, `decrement_pending_chunks`, etc.) — unchanged
- `_on_chunk_transcription_done()` — reused as-is (the bridge to finalization)
- Frontend — unchanged

---

## Prerequisites

- Read and understand the current transcription flow in `dembrane/transcribe.py` (especially `transcribe_audio_assemblyai` lines 90-168, `transcribe_audio_dembrane_25_09` lines 276-338)
- Read `dembrane/tasks.py` `task_transcribe_chunk` (lines 108-154) and `_on_chunk_transcription_done` (lines 156-197)
- Read `dembrane/coordination.py` to understand the Redis counter pattern

---

## Implementation Steps

### Step 1: Add settings

**File**: `dembrane/settings.py`
**Where**: Inside `TranscriptionSettings` class, after `assemblyai_base_url` field (line ~467)

Add two fields following the existing pattern:

```python
assemblyai_webhook_url: Optional[str] = Field(
    default=None,
    alias="ASSEMBLYAI_WEBHOOK_URL",
    validation_alias=AliasChoices(
        "ASSEMBLYAI_WEBHOOK_URL",
        "TRANSCRIPTION__ASSEMBLYAI__WEBHOOK_URL",
    ),
)
assemblyai_webhook_secret: Optional[str] = Field(
    default=None,
    alias="ASSEMBLYAI_WEBHOOK_SECRET",
    validation_alias=AliasChoices(
        "ASSEMBLYAI_WEBHOOK_SECRET",
        "TRANSCRIPTION__ASSEMBLYAI__WEBHOOK_SECRET",
    ),
)
```

**Also** read these in `dembrane/transcribe.py` at module level (next to existing `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_BASE_URL` on lines 35-36):

```python
ASSEMBLYAI_WEBHOOK_URL = transcription_cfg.assemblyai_webhook_url
ASSEMBLYAI_WEBHOOK_SECRET = transcription_cfg.assemblyai_webhook_secret
```

**Feature flag behavior**: If `ASSEMBLYAI_WEBHOOK_URL` is unset/None, everything behaves exactly as today (polling). No other feature flag needed.

---

### Step 2: Add Redis webhook metadata store

**File**: `dembrane/coordination.py`
**Where**: End of file, new section after `cleanup_conversation_coordination` (line 479)

Add three functions using the existing `_get_sync_redis_client()` pattern:

```python
# ------------------------------------------------------------------------------
# AssemblyAI Webhook Coordination
# ------------------------------------------------------------------------------

_AAI_WEBHOOK_TTL_SECONDS = 60 * 60 * 24  # 24 hours


def _assemblyai_webhook_key(transcript_id: str) -> str:
    return f"{_KEY_PREFIX}:aai_transcript:{transcript_id}"


def store_assemblyai_webhook_metadata(
    transcript_id: str,
    chunk_id: str,
    conversation_id: str,
    audio_file_uri: str,
    language: str | None,
    hotwords: list[str] | None,
    use_pii_redaction: bool,
    custom_guidance_prompt: str | None,
) -> None:
    """Store context for AssemblyAI webhook callback. Maps transcript_id -> chunk metadata."""
    import json

    client = _get_sync_redis_client()
    key = _assemblyai_webhook_key(transcript_id)

    try:
        client.set(
            key,
            json.dumps({
                "chunk_id": chunk_id,
                "conversation_id": conversation_id,
                "audio_file_uri": audio_file_uri,
                "language": language,
                "hotwords": hotwords or [],
                "use_pii_redaction": use_pii_redaction,
                "custom_guidance_prompt": custom_guidance_prompt,
            }),
        )
        client.expire(key, _AAI_WEBHOOK_TTL_SECONDS)
        logger.debug(f"Stored AAI webhook metadata for transcript {transcript_id}, chunk {chunk_id}")
    finally:
        client.close()


def get_assemblyai_webhook_metadata(transcript_id: str) -> dict | None:
    """Retrieve webhook metadata. Returns None if expired or never stored."""
    import json

    client = _get_sync_redis_client()
    key = _assemblyai_webhook_key(transcript_id)

    try:
        data = client.get(key)
        return json.loads(data) if data else None
    finally:
        client.close()


def delete_assemblyai_webhook_metadata(transcript_id: str) -> None:
    """Clean up after processing. Prevents duplicate handling."""
    client = _get_sync_redis_client()
    key = _assemblyai_webhook_key(transcript_id)

    try:
        client.delete(key)
    finally:
        client.close()
```

No changes to existing functions.

---

### Step 3: Modify `transcribe_audio_assemblyai()` — add webhook submit mode

**File**: `dembrane/transcribe.py`
**Where**: Function at lines 90-168

**Changes**:
1. Add two optional parameters to the signature:
   ```python
   def transcribe_audio_assemblyai(
       audio_file_uri: str,
       language: Optional[str],
       hotwords: Optional[List[str]],
       webhook_url: Optional[str] = None,      # NEW
       webhook_secret: Optional[str] = None,    # NEW
   ) -> tuple[Optional[str], dict[str, Any]]:
   ```

2. After building the `data` dict (after line 122), insert webhook mode:
   ```python
   # --- Webhook mode: submit and return immediately ---
   if webhook_url:
       logger.info("Submitting AssemblyAI transcription (webhook mode) for %s", audio_file_uri)
       data["webhook_url"] = webhook_url
       if webhook_secret:
           data["webhook_auth_header_name"] = "X-AssemblyAI-Webhook-Secret"
           data["webhook_auth_header_value"] = webhook_secret

       response = requests.post(
           f"{ASSEMBLYAI_BASE_URL}/v2/transcript", headers=headers, json=data
       )
       if response.status_code == 200:
           transcript_id = response.json()["id"]
           logger.info("AssemblyAI job submitted (webhook), transcript_id: %s", transcript_id)
           return None, {"transcript_id": transcript_id}
       elif response.status_code == 400:
           raise TranscriptionError(f"Transcription failed: {response.json()['error']}")
       else:
           raise Exception(f"Transcription failed: {response.json()['error']}")
   # --- End webhook mode ---
   ```

3. Existing polling code below this block is unchanged.

**Return type note**: In webhook mode, transcript text is `None`. Type annotation widens to `tuple[Optional[str], dict[str, Any]]`. The only caller that checks the return is `transcribe_audio_dembrane_25_09`, but in webhook mode we handle it in `task_transcribe_chunk` before that function is even called (see Step 5).

---

### Step 4: Add `fetch_assemblyai_result()` helper

**File**: `dembrane/transcribe.py`
**Where**: After `transcribe_audio_assemblyai()`, before `_get_audio_file_object()` (~line 170)

```python
def fetch_assemblyai_result(transcript_id: str) -> tuple[str, dict[str, Any]]:
    """Fetch a completed transcript from AssemblyAI by ID.

    Called by the webhook handler after AssemblyAI notifies completion.

    Returns:
        (transcript_text, full_assemblyai_response)

    Raises:
        TranscriptionError: If transcript is not completed or fetch fails.
    """
    logger = logging.getLogger("transcribe.fetch_assemblyai_result")
    headers = {"Authorization": f"Bearer {ASSEMBLYAI_API_KEY}"}

    url = f"{ASSEMBLYAI_BASE_URL}/v2/transcript/{transcript_id}"
    response = requests.get(url, headers=headers)

    if response.status_code != 200:
        raise TranscriptionError(
            f"Failed to fetch transcript {transcript_id}: HTTP {response.status_code}"
        )

    data = response.json()

    if data.get("status") == "error":
        raise TranscriptionError(f"Transcript {transcript_id} failed: {data.get('error')}")

    if data.get("status") != "completed":
        raise TranscriptionError(
            f"Transcript {transcript_id} not completed: status={data.get('status')}"
        )

    text = data.get("text", "")
    logger.info("Fetched transcript %s (%d chars)", transcript_id, len(text))
    return text, data
```

---

### Step 5: Modify `task_transcribe_chunk` — webhook mode branch

**File**: `dembrane/tasks.py`
**Where**: Inside `task_transcribe_chunk` (lines 108-154), at the top of the try block

Add a webhook-mode early-return branch **before** the existing `transcribe_conversation_chunk()` call:

```python
@dramatiq.actor(queue_name="network", priority=0)
def task_transcribe_chunk(
    conversation_chunk_id: str, conversation_id: str, use_pii_redaction: bool = False
) -> None:
    logger = getLogger("dembrane.tasks.task_transcribe_chunk")

    try:
        with ProcessingStatusContext(
            conversation_id=conversation_id,
            event_prefix="task_transcribe_chunk",
            message=f"for chunk {conversation_chunk_id}",
        ):
            # --- Webhook mode: submit to AssemblyAI and return immediately ---
            from dembrane.transcribe import ASSEMBLYAI_WEBHOOK_URL, ASSEMBLYAI_WEBHOOK_SECRET

            if ASSEMBLYAI_WEBHOOK_URL and settings.transcription.provider == "Dembrane-25-09":
                from dembrane.transcribe import (
                    _fetch_chunk,
                    _fetch_conversation,
                    _build_hotwords,
                    transcribe_audio_assemblyai,
                )
                from dembrane.s3 import get_signed_url
                from dembrane.coordination import store_assemblyai_webhook_metadata

                chunk = _fetch_chunk(conversation_chunk_id)
                conversation = _fetch_conversation(chunk["conversation_id"])
                language = conversation["project_id"]["language"] or "en"
                hotwords = _build_hotwords(conversation)
                custom_guidance_prompt = conversation["project_id"].get(
                    "default_conversation_transcript_prompt"
                )
                signed_url = get_signed_url(chunk["path"], expires_in_seconds=3 * 24 * 60 * 60)

                _, response = transcribe_audio_assemblyai(
                    signed_url,
                    language=language,
                    hotwords=hotwords,
                    webhook_url=ASSEMBLYAI_WEBHOOK_URL,
                    webhook_secret=ASSEMBLYAI_WEBHOOK_SECRET,
                )

                transcript_id = response["transcript_id"]

                store_assemblyai_webhook_metadata(
                    transcript_id=transcript_id,
                    chunk_id=conversation_chunk_id,
                    conversation_id=conversation_id,
                    audio_file_uri=signed_url,
                    language=language,
                    hotwords=hotwords,
                    use_pii_redaction=use_pii_redaction,
                    custom_guidance_prompt=custom_guidance_prompt,
                )

                logger.info(
                    "Webhook mode: submitted transcript %s for chunk %s. Worker freed.",
                    transcript_id,
                    conversation_chunk_id,
                )
                # DO NOT call _on_chunk_transcription_done here.
                # Counter decrement happens in task_correct_transcript (or webhook error handler).
                return
            # --- End webhook mode ---

            # Polling mode (existing behavior, unchanged)
            transcribe_conversation_chunk(conversation_chunk_id, use_pii_redaction)

        # Polling mode: decrement counter
        _on_chunk_transcription_done(conversation_id, conversation_chunk_id, logger)
        return

    except Exception as e:
        # ... existing error handling unchanged ...
```

**Key point**: In webhook mode, we return before `_on_chunk_transcription_done()`. The decrement is deferred to the terminal step (`task_correct_transcript` on success, or webhook error handler on failure).

---

### Step 6: Add `task_correct_transcript` — Gemini correction task

**File**: `dembrane/tasks.py`
**Where**: After `_on_chunk_transcription_done` function definition (after line ~197)

```python
@dramatiq.actor(queue_name="network", priority=0)
def task_correct_transcript(
    chunk_id: str,
    conversation_id: str,
    audio_file_uri: str,
    candidate_transcript: str,
    hotwords: list | None,
    use_pii_redaction: bool,
    custom_guidance_prompt: str | None,
    assemblyai_response: dict,
) -> None:
    """
    Gemini transcript correction (Dembrane-25-09 stage 2, webhook mode).

    Enqueued by the AssemblyAI webhook endpoint after receiving a completed transcript.
    Runs correction, saves the final result, then calls _on_chunk_transcription_done
    to decrement the counter and potentially trigger finalization.
    """
    logger = getLogger("dembrane.tasks.task_correct_transcript")

    try:
        from dembrane.transcribe import _transcript_correction_workflow, _save_transcript

        logger.info(
            "Running Gemini correction for chunk %s (%d chars)",
            chunk_id,
            len(candidate_transcript),
        )

        with ProcessingStatusContext(
            conversation_id=conversation_id,
            event_prefix="task_correct_transcript",
            message=f"for chunk {chunk_id}",
        ):
            corrected_transcript, note = _transcript_correction_workflow(
                audio_file_uri=audio_file_uri,
                candidate_transcript=candidate_transcript,
                hotwords=hotwords,
                use_pii_redaction=use_pii_redaction,
                custom_guidance_prompt=custom_guidance_prompt,
            )

        if corrected_transcript == "":
            corrected_transcript = "[Nothing to transcribe]"

        _save_transcript(
            chunk_id,
            corrected_transcript,
            diarization={
                "schema": "Dembrane-25-09",
                "data": {"note": note, "raw": assemblyai_response},
            },
        )
        logger.info("Correction complete for chunk %s", chunk_id)

    except Exception as e:
        logger.error("Gemini correction failed for chunk %s: %s", chunk_id, e)
        # Partial AssemblyAI transcript was already saved by the webhook handler.
        # No need to re-save — just log and continue to decrement.

    # ALWAYS decrement, whether correction succeeded or failed.
    # This is the terminal step — triggers finalization if all chunks done.
    _on_chunk_transcription_done(conversation_id, chunk_id, logger)
```

**Design notes**:
- Gemini failure is **non-fatal**: the AssemblyAI partial transcript is already saved by the webhook handler. The user gets the uncorrected transcript rather than nothing.
- `_on_chunk_transcription_done` is always called — prevents counter deadlock.
- Uses `mark_chunk_decremented` internally (via `_on_chunk_transcription_done`) — safe for Dramatiq retries.

---

### Step 7: Create webhook endpoint

**File**: `dembrane/api/webhooks.py` (NEW FILE)

```python
"""
Incoming webhook endpoints for third-party service callbacks.

These endpoints are PUBLIC (no Directus auth). Authentication is via
secrets embedded in webhook headers by the calling service.
"""

import hmac
import logging
from typing import Optional

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

from dembrane.settings import get_settings

logger = logging.getLogger("api.webhooks")

WebhooksRouter = APIRouter(tags=["webhooks"])


class AssemblyAIWebhookPayload(BaseModel):
    transcript_id: str
    status: str


@WebhooksRouter.post("/webhooks/assemblyai")
async def assemblyai_webhook_callback(
    payload: AssemblyAIWebhookPayload,
    request: Request,
) -> dict:
    """
    Receive AssemblyAI webhook callback when transcription completes or fails.

    Flow:
    1. Verify webhook secret
    2. Look up chunk metadata from Redis (stored by task_transcribe_chunk)
    3. Fetch full transcript from AssemblyAI
    4. Save partial transcript to chunk
    5. Enqueue Gemini correction task (Dembrane-25-09)
    """
    settings = get_settings()
    expected_secret = settings.transcription.assemblyai_webhook_secret

    # 1. Verify secret
    if expected_secret:
        received = request.headers.get("X-AssemblyAI-Webhook-Secret", "")
        if not hmac.compare_digest(received, expected_secret):
            logger.warning("Webhook auth failed for transcript %s", payload.transcript_id)
            raise HTTPException(status_code=401, detail="Invalid webhook secret")

    logger.info(
        "AssemblyAI webhook: transcript_id=%s status=%s",
        payload.transcript_id,
        payload.status,
    )

    # 2. Look up metadata
    from dembrane.coordination import (
        get_assemblyai_webhook_metadata,
        delete_assemblyai_webhook_metadata,
    )

    metadata = get_assemblyai_webhook_metadata(payload.transcript_id)
    if not metadata:
        logger.warning("No metadata for transcript %s (expired or duplicate)", payload.transcript_id)
        raise HTTPException(status_code=404, detail="Transcript metadata not found")

    chunk_id = metadata["chunk_id"]
    conversation_id = metadata["conversation_id"]

    # 3. Handle error
    if payload.status == "error":
        from dembrane.transcribe import _save_chunk_error
        from dembrane.tasks import _on_chunk_transcription_done

        _save_chunk_error(chunk_id, f"AssemblyAI error for transcript {payload.transcript_id}")
        _on_chunk_transcription_done(conversation_id, chunk_id, logger)
        delete_assemblyai_webhook_metadata(payload.transcript_id)
        return {"status": "error_handled"}

    # 4. Handle completion
    if payload.status == "completed":
        from dembrane.transcribe import fetch_assemblyai_result, _save_transcript
        from dembrane.tasks import task_correct_transcript

        # Fetch full transcript
        try:
            transcript_text, full_response = fetch_assemblyai_result(payload.transcript_id)
        except Exception as e:
            logger.error("Failed to fetch transcript %s: %s", payload.transcript_id, e)
            from dembrane.transcribe import _save_chunk_error
            from dembrane.tasks import _on_chunk_transcription_done

            _save_chunk_error(chunk_id, f"Failed to fetch transcript: {e}")
            _on_chunk_transcription_done(conversation_id, chunk_id, logger)
            delete_assemblyai_webhook_metadata(payload.transcript_id)
            return {"status": "fetch_error"}

        # Save partial result (AssemblyAI transcript before Gemini correction)
        _save_transcript(
            chunk_id,
            transcript_text,
            diarization={
                "schema": "Dembrane-25-09-assemblyai-partial",
                "data": full_response,
            },
        )

        # Enqueue Gemini correction
        task_correct_transcript.send(
            chunk_id=chunk_id,
            conversation_id=conversation_id,
            audio_file_uri=metadata["audio_file_uri"],
            candidate_transcript=transcript_text,
            hotwords=metadata.get("hotwords"),
            use_pii_redaction=metadata.get("use_pii_redaction", False),
            custom_guidance_prompt=metadata.get("custom_guidance_prompt"),
            assemblyai_response=full_response,
        )

        logger.info("Webhook processed for chunk %s, correction task enqueued", chunk_id)
        delete_assemblyai_webhook_metadata(payload.transcript_id)
        return {"status": "ok"}

    # Unknown status
    logger.warning("Unknown webhook status for transcript %s: %s", payload.transcript_id, payload.status)
    return {"status": "ignored"}
```

**Design notes**:
- All imports from `dembrane.tasks` and `dembrane.transcribe` are **lazy** (inside the endpoint function) to avoid circular import issues. This matches the existing pattern in `api/participant.py:520`.
- Error path always calls `_on_chunk_transcription_done` to prevent counter deadlock.
- `delete_assemblyai_webhook_metadata` after processing prevents duplicate handling on AssemblyAI retry.

---

### Step 8: Register the router

**File**: `dembrane/api/api.py`

Add import:
```python
from dembrane.api.webhooks import WebhooksRouter
```

Add registration (after existing `include_router` calls):
```python
api.include_router(WebhooksRouter)
```

No prefix — the route is `/webhooks/assemblyai`, producing full path `/api/webhooks/assemblyai`.

---

## Edge Cases and Mitigations

| Edge Case | Mitigation |
|-----------|-----------|
| **Redis metadata expires before webhook** (24h TTL) | Webhook returns 404, chunk stays pending. Caught by existing `task_reconcile_transcribed_flag` scheduler (runs every 3 min). |
| **Duplicate webhook delivery** | First webhook deletes metadata. Subsequent ones get 404 (no double-processing). |
| **Gemini correction fails** | Partial AssemblyAI transcript already saved. `_on_chunk_transcription_done` still called (counter doesn't deadlock). User sees uncorrected transcript. |
| **AssemblyAI returns error** | Webhook handler saves error to chunk, calls `_on_chunk_transcription_done`. Same behavior as current recoverable error path. |
| **Webhook endpoint unreachable** | AssemblyAI retries on their side. If all retries fail, chunk stays pending — caught by scheduler. |
| **Fake/spoofed webhook** | Secret verification via `hmac.compare_digest`. Returns 401 without touching any data. |
| **Dramatiq retries `task_correct_transcript`** | `_on_chunk_transcription_done` uses `mark_chunk_decremented` internally — prevents double-decrement on retry. |
| **Webhook URL misconfigured** | AssemblyAI submit succeeds but webhook never arrives. Chunk stays pending. Unset the env var to revert to polling. |
| **`fetch_assemblyai_result` fails** | Error saved to chunk, counter decremented, metadata cleaned up. Chunk shows error state. |

---

## Files Modified (Summary)

| File | Change | Risk |
|------|--------|------|
| `dembrane/settings.py` | Add 2 fields to `TranscriptionSettings` | None — additive, defaults to `None` |
| `dembrane/transcribe.py` | Add optional params to `transcribe_audio_assemblyai()`, add `fetch_assemblyai_result()`, read new settings at module level | Low — new params default to `None`, existing callers unaffected |
| `dembrane/coordination.py` | Add 3 new functions (store/get/delete webhook metadata) | None — additive, no changes to existing functions |
| `dembrane/tasks.py` | Add webhook branch to `task_transcribe_chunk`, add new `task_correct_transcript` actor | Low — branch only taken when env var set |
| `dembrane/api/webhooks.py` | **NEW FILE** — webhook endpoint | None — new endpoint, no existing code modified |
| `dembrane/api/api.py` | Add 2 lines (import + register router) | None — additive |

---

## Configuration

### Local development (polling mode — default)

```bash
# echo/server/.env — no changes needed
TRANSCRIPTION_PROVIDER=Dembrane-25-09
ASSEMBLYAI_API_KEY=your_key
GCP_SA_JSON={"type":"service_account",...}
# ASSEMBLYAI_WEBHOOK_URL is NOT set → polling mode
```

### Production (webhook mode)

```bash
# echo/server/.env
TRANSCRIPTION_PROVIDER=Dembrane-25-09
ASSEMBLYAI_API_KEY=your_key
GCP_SA_JSON={"type":"service_account",...}

# Enable webhooks
ASSEMBLYAI_WEBHOOK_URL=https://api.yourserver.com/api/webhooks/assemblyai
ASSEMBLYAI_WEBHOOK_SECRET=<generate-a-strong-random-string>
```

**Note**: The webhook URL must be publicly reachable from AssemblyAI's servers. Ensure firewall/ingress rules allow POST requests to `/api/webhooks/assemblyai`.

---

## Testing

### Unit tests (add to existing test files or new `tests/test_transcribe_webhook.py`)

1. **`transcribe_audio_assemblyai` webhook mode**: Mock `requests.post`, verify `webhook_url` + auth headers in payload, verify returns `(None, {"transcript_id": ...})` with no polling.
2. **`transcribe_audio_assemblyai` polling mode**: Verify unchanged behavior when `webhook_url=None`.
3. **`fetch_assemblyai_result`**: Mock GET, verify returns `(text, response)`. Test error/non-completed status.
4. **Redis metadata functions**: Test store/get/delete roundtrip (requires Redis or mock).
5. **`task_correct_transcript`**: Mock `_transcript_correction_workflow`, verify saves correct diarization schema, verify calls `_on_chunk_transcription_done`.
6. **`task_correct_transcript` Gemini failure**: Mock workflow to raise, verify `_on_chunk_transcription_done` is still called (no deadlock).

### API tests (new `tests/api/test_webhooks.py`)

7. **Webhook completed flow**: POST to `/api/webhooks/assemblyai` with valid secret + `status: completed`. Mock `fetch_assemblyai_result` + Redis metadata. Verify partial save + `task_correct_transcript` enqueued.
8. **Webhook error flow**: POST with `status: error`. Verify error saved to chunk + `_on_chunk_transcription_done` called.
9. **Webhook auth rejection**: POST with wrong secret. Verify 401, no side effects.
10. **Webhook unknown transcript**: POST with `transcript_id` not in Redis. Verify 404.
11. **Webhook duplicate delivery**: POST same payload twice. First succeeds, second gets 404 (metadata deleted).

### Manual verification

```bash
# 1. Feature off — verify polling still works
unset ASSEMBLYAI_WEBHOOK_URL
cd echo/server
pytest tests/ -v -m "not integration and not slow and not smoke"

# 2. Feature on — simulate webhook roundtrip
export ASSEMBLYAI_WEBHOOK_URL=https://your-server.com/api/webhooks/assemblyai
export ASSEMBLYAI_WEBHOOK_SECRET=test-secret

# Start API server
uv run uvicorn dembrane.main:app --port 8000 --reload --loop asyncio

# Simulate AssemblyAI webhook callback
curl -X POST http://localhost:8000/api/webhooks/assemblyai \
  -H "Content-Type: application/json" \
  -H "X-AssemblyAI-Webhook-Secret: test-secret" \
  -d '{"transcript_id": "test-id-123", "status": "completed"}'
# Expected: 404 (no metadata stored) — confirms endpoint is live and auth works

# With wrong secret:
curl -X POST http://localhost:8000/api/webhooks/assemblyai \
  -H "Content-Type: application/json" \
  -H "X-AssemblyAI-Webhook-Secret: wrong-secret" \
  -d '{"transcript_id": "test-id-123", "status": "completed"}'
# Expected: 401
```

---

## Rollout Plan

1. **Deploy with feature off**: Ship code with `ASSEMBLYAI_WEBHOOK_URL` unset. Behavior is identical to today — zero risk.
2. **Run test suite**: Verify all existing tests pass (polling mode unchanged).
3. **Enable on staging**: Set `ASSEMBLYAI_WEBHOOK_URL` + `ASSEMBLYAI_WEBHOOK_SECRET`. Upload a test audio chunk. Verify:
   - `task_transcribe_chunk` returns immediately (check Dramatiq logs)
   - AssemblyAI webhook arrives at the endpoint
   - Partial transcript saved
   - `task_correct_transcript` runs and saves final transcript
   - Conversation finalization triggers correctly
4. **Enable in production**: Set env vars, restart API. Monitor:
   - Dramatiq network queue depth (should drop dramatically)
   - Worker idle time (should increase)
   - Transcription completion times (should be comparable or faster)
   - Redis key count for `coord:aai_transcript:*` (should stay low, 24h TTL)
5. **Rollback**: Unset `ASSEMBLYAI_WEBHOOK_URL`, restart API server. Instant revert to polling. In-flight webhooks for already-submitted jobs will 404 (metadata may still exist but jobs will be caught by the reconciliation scheduler).

---

## Performance Impact

| Metric | Before (polling) | After (webhooks) |
|--------|------------------|-------------------|
| Worker time per chunk | 30-180s (blocking) | <1s (submit only) |
| Max concurrent transcriptions | ~2 (worker count) | Hundreds (AssemblyAI limit) |
| Queue backlog under load | High | Minimal |
| Gemini correction | Same worker, sequential | Separate task, independent retry |
| Redis overhead | None | ~1KB per in-flight transcript |
