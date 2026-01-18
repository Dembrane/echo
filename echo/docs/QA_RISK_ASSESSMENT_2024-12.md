# QA Risk Assessment Report: Echo Platform

**Prepared by**: QA Team  
**Date**: December 25, 2024  
**Classification**: Internal Use Only

---

## Executive Summary

This document identifies **5 critical/high priority risks** discovered during QA analysis of the Echo codebase. Each risk includes code locations, impact assessment, and recommended fixes for the development team.

**Severity Distribution:**
- 🔴 Critical: 3
- 🟠 High: 2
- 🟡 Medium: 3 (documented but not detailed)

---

## 🔴 Critical #1: Unbounded Parallel LLM API Calls

### Location
- **File**: `server/dembrane/chat_utils.py`
- **Lines**: 460-462

### Current Code
```python
# Execute all batches in parallel - NO concurrency limit!
batch_results = await asyncio.gather(*tasks, return_exceptions=True)
```

### Impact
| Risk | Severity |
|------|----------|
| API quota exhaustion | High |
| 429 rate limit errors from Vertex AI/Claude | High |
| Cascading failures during traffic spikes | Medium |
| Uncontrolled LLM costs | Medium |

### Root Cause
The `auto_select_conversations` function spawns unlimited parallel LLM requests. A project with 200 conversations (batch_size=20) launches 10 simultaneous API calls.

### Existing Safeguard
- Backoff retry exists per-request (lines 505-510)
- Does NOT prevent concurrent requests from all hitting the API simultaneously

### Recommended Fix
```python
# Add semaphore-based concurrency control
MAX_CONCURRENT_LLM_CALLS = 3
_llm_semaphore = asyncio.Semaphore(MAX_CONCURRENT_LLM_CALLS)

async def _call_llm_with_concurrency(prompt: str, batch_num: int):
    async with _llm_semaphore:
        return await _call_llm_with_backoff(prompt, batch_num)
```

### Acceptance Criteria
- [ ] Maximum 3 concurrent LLM calls at any time
- [ ] Add configurable `LLM_MAX_CONCURRENT_CALLS` env variable
- [ ] Add metrics for LLM queue depth and latency

---

## 🔴 Critical #2: In-Memory Rate Limiting Doesn't Scale

### Location
- **File**: `server/dembrane/api/participant.py`
- **Lines**: 103-141

### Current Code
```python
# Simple in-memory rate limiter
# NOTE: This is process-local and won't be shared across workers/pods.
_rate_limit_cache: dict[str, list[float]] = {}

def check_rate_limit(conversation_id: str) -> bool:
    # Uses in-memory dict - NOT distributed!
```

### Impact
| Scenario | Effective Rate Limit |
|----------|---------------------|
| Single worker | 40 req/min ✅ |
| 2 workers | 80 req/min ❌ |
| 2 workers × 3 pods | 240 req/min ❌ |
| After deploy/restart | 0 (cache cleared) ❌ |

### Root Cause
Rate limit state is stored in process memory, not shared across Gunicorn workers or Kubernetes pods.

### Existing Solution (Not Used!)
A Redis-based rate limiter already exists at `server/dembrane/api/rate_limit.py`:
```python
class RedisRateLimiter:
    async def check(self, identifier: str) -> None:
        client = await get_redis_client()
        redis_key = f"{self.key}:{identifier}"
        count = await client.incr(redis_key)
        # Distributed rate limiting!
```

### Recommended Fix
Replace manual cache with existing Redis limiter:
```python
from dembrane.api.rate_limit import create_rate_limiter

_presigned_url_limiter = create_rate_limiter(
    name="presigned_url", capacity=40, window_seconds=60
)

@ParticipantRouter.post("/conversations/{conversation_id}/get-upload-url")
async def get_chunk_upload_url(...):
    await _presigned_url_limiter.check(conversation_id)  # Use Redis!
```

### Acceptance Criteria
- [ ] Delete `_rate_limit_cache` and `check_rate_limit` function
- [ ] Use `create_rate_limiter` from existing module
- [ ] Verify rate limiting works across multiple workers

---

## 🔴 Critical #3: Redis Single Point of Failure

### Locations
- **File**: `server/dembrane/coordination.py` - Creates new connection per operation
- **File**: `server/dembrane/redis_async.py` - No health checks
- **File**: `server/dembrane/tasks.py` - Dramatiq broker

### Current Code Issues

**coordination.py** - New connection per operation (no pooling):
```python
def _get_sync_redis_client() -> Any:
    return redis.from_url(connection_string, decode_responses=True)  # New connection!
```

**redis_async.py** - No health verification:
```python
async def get_redis_client() -> Redis:
    if _redis_client is not None:
        return _redis_client  # Returns potentially dead connection!
```

### Impact
| Failure Mode | Consequence |
|--------------|-------------|
| Redis restart | Async client holds dead connection |
| High traffic | Connection exhaustion |
| Network blip | Silent failures in rate limiting |

### Recommended Fix
```python
# redis_async.py - Add health check
async def get_redis_client() -> Redis:
    if _redis_client is not None:
        try:
            await _redis_client.ping()  # Verify connection is alive
            return _redis_client
        except ConnectionError:
            _redis_client = None  # Force reconnection
    # ... reconnection logic
```

### Acceptance Criteria
- [ ] Add connection pooling with `max_connections=20`
- [ ] Add health check via PING before returning client
- [ ] Add `health_check_interval=30` to pool config
- [ ] Document Redis HA requirements for production

---

## 🟠 High #4: No Recovery for Stuck Transcriptions

### Location
- **File**: `server/dembrane/tasks.py`
- **File**: `server/dembrane/coordination.py`

### Problem
If a Dramatiq worker crashes mid-transcription:
1. Chunk is never marked complete
2. Pending counter stays > 0 forever
3. Conversation never finalizes (no merge, no summary)
4. User sees conversation stuck in "processing"

### Current State
- 24-hour TTL on coordination keys (eventual cleanup only)
- No active detection or recovery mechanism

### Recommended Fix
Add scheduled recovery job:
```python
@dramatiq.actor
def task_recover_stuck_conversations():
    """Run every 30 minutes to find and recover stuck conversations."""
    cutoff = datetime.utcnow() - timedelta(hours=2)
    
    stuck = directus.get_items("conversation", {
        "filter": {
            "is_finished": True,
            "is_all_chunks_transcribed": False,
            "date_updated": {"_lt": cutoff.isoformat()}
        }
    })
    
    for conv in stuck:
        logger.warning(f"Recovering stuck conversation {conv['id']}")
        reset_pending_chunks(conv['id'])
        task_finalize_conversation.send(conv['id'])
```

### Acceptance Criteria
- [ ] Create `task_recover_stuck_conversations` actor
- [ ] Add to APScheduler (every 30 minutes)
- [ ] Add Sentry alert when stuck conversations found
- [ ] Add admin endpoint for manual recovery

---

## 🟠 High #5: S3 Upload Confirmation Window Too Short

### Location
- **File**: `server/dembrane/api/participant.py`
- **Lines**: 421-422

### Current Code
```python
max_retries = 3
retry_delays = [0.1, 0.5, 2.0]  # Total: 2.6 seconds
```

### Problem
S3 eventual consistency can take up to 15 seconds. Current retry window (2.6s) is insufficient.

### Recommended Fix
```python
max_retries = 5
retry_delays = [1.0, 2.0, 4.0, 8.0, 15.0]  # Total: 30 seconds with backoff
```

### Acceptance Criteria
- [ ] Increase retry window to 30 seconds total
- [ ] Use exponential backoff pattern
- [ ] Return "pending_verification" status instead of error on timeout

---

## Additional Issues (Lower Priority)

| Issue | Location | Severity |
|-------|----------|----------|
| CORS `DISABLE_CORS` flag allows `*` origins | `main.py:60-61` | 🟡 Medium |
| SSL disabled for Directus (`verify=False`) | `directus.py:168` | 🟡 Medium |
| Limited unit test coverage | `tests/` | 🟡 Medium |

---

## Implementation Priority

### Sprint 1 (Immediate)
1. ✅ Fix in-memory rate limiting → Redis (Critical #2)
2. ✅ Add LLM concurrency limit (Critical #1)
3. ✅ Increase S3 retry window (High #5)

### Sprint 2 (Short-term)
4. Add Redis health checks and pooling (Critical #3)
5. Add stuck conversation recovery job (High #4)

### Backlog
6. Add comprehensive metrics and alerting
7. Redis Sentinel/Cluster for production HA
8. Migrate to async database driver

---

## Contact

For questions about this assessment, please contact the QA team.
