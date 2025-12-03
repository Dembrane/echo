# Audio Upload Pipeline - Deep Issues Analysis

This document provides a deep analysis of issues in the audio upload and transcription pipeline, categorized by type and severity.

---

## Executive Summary

The pipeline has several critical orchestration issues that can lead to:
- Summaries generated from incomplete transcripts
- `is_all_chunks_transcribed` flag set incorrectly
- Silent failures with no retry mechanism
- Orphaned files in S3

---

## Part 1: Orchestration-Level Issues

### 1.1 CRITICAL: Race Condition - Summary Before Transcriptions Complete

**Location:** `server/dembrane/tasks.py` lines 248-249

**Problem:**
```python
# In task_finish_conversation_hook():
task_merge_conversation_chunks.send(conversation_id)
task_summarize_conversation.send(conversation_id)
```

Both tasks are fired in parallel immediately after `is_finished=True` is set. However:
- `task_summarize_conversation` calls `get_conversation_transcript()` which concatenates chunk transcripts
- Transcription tasks may still be running from `task_process_conversation_chunk`
- Summary will be generated from partial or empty transcript data

**Impact:** Users see incomplete or empty summaries that never get updated.

**Current Flow:**
```
Chunk Upload → task_process_conversation_chunk → split → task_transcribe_chunk (async)
                                                              ↓
                                                    [running in background]
                                                              
/finish called → task_finish_conversation_hook
                         ↓
         is_finished=True (immediately)
                         ↓
         task_merge_conversation_chunks.send()  ← may merge incomplete audio
         task_summarize_conversation.send()     ← may summarize empty transcript
                         ↓
         Check chunk counts (at THIS moment, not after transcription)
                         ↓
         is_all_chunks_transcribed=True (if counts match NOW)
```

---

### 1.2 CRITICAL: `is_all_chunks_transcribed` Set Prematurely

**Location:** `server/dembrane/tasks.py` lines 251-258

**Problem:**
```python
counts = conversation_service.get_chunk_counts(conversation_id)

if counts["processed"] == counts["total"]:
    conversation_service.update(
        conversation_id=conversation_id,
        is_all_chunks_transcribed=True,
    )
```

This check happens during `task_finish_conversation_hook`, which runs when:
1. Frontend calls `/finish` (immediately after uploads complete)
2. Scheduler catchup (every 2 minutes)

Neither timing guarantees transcription tasks have completed.

**Impact:** 
- `is_all_chunks_transcribed=True` when transcriptions are still pending
- Downstream processes relying on this flag may operate on incomplete data

---

### 1.3 HIGH: No Completion Callback After Transcriptions

**Location:** `server/dembrane/tasks.py` lines 310-316

**Problem:**
```python
group(
    [
        task_transcribe_chunk.message(cid, chunk["conversation_id"], use_pii_redaction)
        for cid in split_chunk_ids
        if cid is not None
    ]
).run()
```

The `group().run()` is fire-and-forget. Dramatiq's group callbacks middleware is loaded, but no callback is configured.

**What's Missing:**
```python
# Should be something like:
group([...]).add_completion_callback(
    task_on_all_chunks_transcribed.message(conversation_id)
).run()
```

---

### 1.4 MEDIUM: Scheduler Catchup Filter Bug

**Location:** `server/dembrane/conversation_utils.py` lines 33-35

**Problem:**
```python
# Must not be created in the last 5 minutes
"created_at": {
    "_gte": (get_utc_timestamp() - timedelta(minutes=5)).isoformat()
},
```

The filter uses `_gte` (greater than or equal) which means "created_at >= 5 minutes ago", i.e., conversations created IN the last 5 minutes. This is the OPPOSITE of the comment's intent.

**Should be:**
```python
"created_at": {
    "_lte": (get_utc_timestamp() - timedelta(minutes=5)).isoformat()
},
```

**Impact:** The scheduler may try to finish conversations that were just created, or miss conversations that should be caught up.

---

### 1.5 MEDIUM: Task Retry Configuration Unclear

**Location:** `server/dembrane/tasks.py` lines 69-80

**Problem:**
```python
broker = RedisBroker(
    url=redis_connection_string,
    # middleware=[
    #     ...
    #     Retries,
    # ],
)
```

The Retries middleware is commented out, suggesting custom retry configuration was attempted. However, Dramatiq includes Retries by default when middleware isn't explicitly specified.

**Issues:**
- No `max_retries` configured on actors
- Unclear what the actual retry behavior is
- Failed tasks may retry indefinitely or not at all

---

## Part 2: Function-Level Issues

### 2.1 CRITICAL: Transcription Errors Not Persisted

**Location:** `server/dembrane/transcribe.py` lines 486-490

**Problem:**
```python
except Exception as e:
    logger.error("Failed to process conversation chunk %s: %s", conversation_chunk_id, e)
    raise TranscriptionError(
        "Failed to process conversation chunk %s: %s" % (conversation_chunk_id, e)
    ) from e
```

When transcription fails:
1. Error is logged
2. Exception is raised
3. **Chunk's `error` field is NEVER set**

The `set_error_status()` function exists in `processing_status_utils.py` but is never called in the transcription flow.

**Impact:**
- `get_chunk_counts()` counts chunks with `error=None` as "pending" forever
- No way to identify which chunks failed
- No automatic retry mechanism

**Should be:**
```python
except Exception as e:
    logger.error("Failed to process conversation chunk %s: %s", conversation_chunk_id, e)
    set_error_status(str(e), conversation_chunk_id=conversation_chunk_id)
    raise TranscriptionError(...) from e
```

---

### 2.2 HIGH: Blocking Polling Loop in AssemblyAI Transcription

**Location:** `server/dembrane/transcribe.py` lines 139-147

**Problem:**
```python
# TODO: using webhooks will be ideal, but this is easy to impl and test for ;)
while True:
    transcript = requests.get(polling_endpoint, headers=headers).json()
    if transcript["status"] == "completed":
        return transcript["text"], transcript
    elif transcript["status"] == "error":
        raise TranscriptionError(f"Transcription failed: {transcript['error']}")
    else:
        time.sleep(3)
```

**Issues:**
- Blocks worker thread indefinitely (no timeout)
- For long audio files, worker is stuck for minutes
- Reduces worker pool effective capacity
- No cancellation mechanism

**Impact:** Worker starvation under load; slow transcriptions block other tasks.

---

### 2.3 HIGH: Audio Merge Silently Skips Failed Files

**Location:** `server/dembrane/audio_utils.py` lines 358-359

**Problem:**
```python
except Exception as e:
    logger.error(f"Error probing file {i_name}: {str(e)} - Moving on to next file")
```

When a file fails to probe:
1. Error is logged
2. Processing continues with remaining files
3. No indication in output which files were skipped
4. Merged audio is partial

**Impact:** Users get incomplete merged audio without knowing files were skipped.

---

### 2.4 HIGH: split_audio_chunk Deletes Original Before Verifying Splits

**Location:** `server/dembrane/audio_utils.py` lines 719-721

**Problem:**
```python
if delete_original:
    directus.delete_item("conversation_chunk", original_chunk["id"])
    logger.debug("Deleted original chunk from Directus after splitting.")
```

The original chunk is deleted AFTER split chunks are created in DB, but:
1. If any S3 uploads failed, we've lost the original
2. If Directus create partially failed, state is inconsistent

**Should:** Verify all splits succeeded before deleting original, or use a transaction pattern.

---

### 2.5 MEDIUM: Unreachable Code in get_conversation_content

**Location:** `server/dembrane/api/conversation.py` lines 316-319

**Problem:**
```python
    except Exception as e:
        logger.error(f"Error merging audio files: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Failed to merge audio files: {str(e)}") from e

    raise HTTPException(  # <-- UNREACHABLE
        status_code=400,
        detail="Error merging audio files because no valid paths were found",
    )
```

The final `raise HTTPException` is unreachable because the try block either returns or raises.

---

### 2.6 MEDIUM: Orphaned S3 Files on confirm_upload Failure

**Location:** `server/dembrane/api/participant.py` lines 504-512

**Problem:**
```python
except Exception as e:
    logger.error("[Upload] Failed to confirm upload:", error)
    # File is in S3 but not in database - this is an orphaned file
    # Log error for monitoring/cleanup
    throw new Error(...)
```

The frontend comment acknowledges the issue but no cleanup mechanism exists.

**Impact:** S3 storage costs increase over time from orphaned files.

---

### 2.7 MEDIUM: task_finish_conversation_hook Sets is_finished Before Tasks Complete

**Location:** `server/dembrane/tasks.py` line 242

**Problem:**
```python
conversation_service.update(conversation_id=conversation_id, is_finished=True)

# ... then triggers merge and summarize tasks
task_merge_conversation_chunks.send(conversation_id)
task_summarize_conversation.send(conversation_id)
```

If merge or summarize fails, the conversation is already marked as `is_finished=True`, and idempotency checks prevent retry:
```python
if conversation["is_finished"] and conversation["summary"] is not None:
    logger.info(f"Conversation {conversation_id} already summarized, skipping")
    return
```

---

### 2.8 LOW: Inconsistent Error Handling Across Providers

**Location:** `server/dembrane/transcribe.py` lines 148-151

**Problem:**
```python
elif response.status_code == 400:
    raise TranscriptionError(f"Transcription failed: {response.json()['error']}")
else:
    raise Exception(f"Transcription failed: {response.json()['error']}")
```

400 errors raise `TranscriptionError`, but other errors raise generic `Exception`. This affects error handling consistency upstream.

---

## Part 3: Systemic Improvement Plan

### Phase 1: Fix Critical Issues (Breaking Changes)

1. **Add completion callback for transcription groups**
   - Use Dramatiq's group callbacks to trigger post-transcription processing
   - Move summary and merge to completion callback
   - Set `is_all_chunks_transcribed` in callback

2. **Persist transcription errors to chunk**
   - Call `set_error_status()` or `conversation_service.update_chunk(error=...)` on failure
   - Enable proper retry logic based on error state

3. **Fix scheduler filter bug**
   - Change `_gte` to `_lte` for `created_at`

### Phase 2: Improve Reliability (Non-Breaking)

4. **Add timeout to AssemblyAI polling**
   - Implement max polling duration (e.g., 30 minutes)
   - Return error on timeout

5. **Configure explicit Dramatiq retry behavior**
   - Set `max_retries` on critical actors
   - Add exponential backoff

6. **Add file validation before merge**
   - Track which files were skipped
   - Store merge metadata (file count, skipped count)

### Phase 3: Operational Improvements

7. **Add S3 orphan cleanup job**
   - Scheduled task to identify files without DB records
   - Age-based cleanup (>24h old orphans)

8. **Improve observability**
   - Add metrics for transcription duration, failure rate
   - Track chunk processing pipeline stage

9. **Add idempotency improvements**
   - Don't set `is_finished` until merge/summarize complete
   - Or: allow re-running summarize even if `is_finished=True`

---

## Appendix: Affected Files

| File | Issues |
|------|--------|
| `tasks.py` | 1.1, 1.2, 1.3, 1.5, 2.7 |
| `transcribe.py` | 2.1, 2.2, 2.8 |
| `audio_utils.py` | 2.3, 2.4 |
| `conversation_utils.py` | 1.4 |
| `api/conversation.py` | 2.5 |
| `api/participant.py` | 2.6 |
| `service/conversation.py` | (data model) |

