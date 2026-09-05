"""The popcorn tick: gather every conversation, pop the changed ones, then analyse.

Processing model, following the upstream popcorn plan (Dembrane/popcorn
PROJECT_PLAN.md and tools/serve_demo.py):

- One fast extractor per conversation, all launched in parallel, thinking off.
  Each result is published the moment it lands, so the first phrase reaches the
  room before the slowest transcript finishes.
- Only conversations whose transcript changed since the last tick are
  re-extracted. Unchanged ones keep their phrases and their stable ids.
- Tensions and stakeholders read the whole session at once and run after the
  popcorn pass, in parallel with each other. One QuoteBook owns the quote
  registry for the run: every quote is checked verbatim against the transcripts
  before it is written, and the analysis block is replaced atomically so a
  new run never mixes with stale slides.
- Once every fast extractor has flushed, each changed conversation gets the
  second pass (`enrichment.py`): one evidence call and one kind call per
  phrase, applied in one write per conversation, so its phrases turn into
  verified quotes with icons while tensions and stakeholders are still
  cooking. `validated` on the bundle means that pass finished for the
  transcript as it stands.
- Every quote of the session lives in one registry (`state["quotes"]`), seeded
  into one QuoteBook per tick, so ids the deck already holds stay valid.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any
from datetime import datetime, timezone, timedelta

from dembrane.utils import generate_uuid
from dembrane.settings import get_settings
from dembrane.redis_async import get_redis_client
from dembrane.canvas.access import CanvasReaderAccessDenied, resolve_canvas_reader_context
from dembrane.canvas.events import publish_generation_nudge
from dembrane.popcorn.flags import gate_items, known_shingles, introduced_names
from dembrane.popcorn.gates import name_flags, island_flags
from dembrane.popcorn.model import (
    prompt_text,
    run_analysis,
    analysis_call,
    classify_phrase,
    extract_popcorn,
    validate_phrase,
    rewrite_question,
)
from dembrane.directus_async import async_directus
from dembrane.popcorn.service import (
    MIN_CADENCE_MINUTES,
    DEFAULT_CADENCE_MINUTES,
    save_version,
    is_popcorn_loop,
    normalize_state,
    voice_host_note,
    get_latest_config,
    normalize_settings,
    enqueue_popcorn_tick,
)
from dembrane.popcorn.analysis import (
    QuoteBook,
    build_corpus,
    shape_stakeholders,
    shape_popcorn_items,
)
from dembrane.popcorn.tensions import PROMPT_NAMES as TENSION_PROMPTS, run_pipeline
from dembrane.popcorn.grounding import ground_items
from dembrane.popcorn.enrichment import enrich_item, apply_results

logger = logging.getLogger("dembrane.popcorn.ticks")

# Parallel extractors per tick. The upstream demo runs 16; Vertex flash keeps up.
MAX_PARALLEL_EXTRACTORS = 16
# Second-pass calls in flight per tick (two per phrase). The pass starts only
# after every fast extractor has flushed, so it never competes with a first
# phrase for the model.
MAX_PARALLEL_ENRICHMENT = 8
# Calls in flight for the tensions pipeline, which runs beside the stakeholders call.
MAX_PARALLEL_ANALYSIS = 8
# A single conversation rarely passes 100k characters in a day; the cap only
# guards the prompt against a runaway recording.
MAX_CHARS_PER_CONVERSATION = 150_000
# The analysis corpus is every transcript at once. Above this the transcripts
# are clipped evenly so the two slow calls stay inside one context window.
MAX_ANALYSIS_CHARS = 600_000
RUN_LOCK_SECONDS = 5 * 60
MANUAL_LOCK_WAIT_SECONDS = 180
STALE_TICK_SECONDS = 90
# A running tick says so every HEARTBEAT_SECONDS; the key lives STALE_TICK_SECONDS,
# so a worker that dies is noticed within one cadence and a slow second pass is not.
HEARTBEAT_SECONDS = 30


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value else None


def _fingerprint(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def labels_for(conversation: dict[str, Any], index: int) -> tuple[str, str]:
    """Human label and short label for the legend, from the participant name."""
    name = str(conversation.get("participant_name") or "").strip()
    full = name or f"Conversation {index}"
    short = full if len(full) <= 24 else full[:23] + "…"
    return full, short


async def _create_run(
    *,
    loop_id: str,
    status: str,
    started_at: datetime,
    detail: str | None = None,
) -> dict[str, Any]:
    result = await async_directus.create_item(
        "agent_loop_run",
        {
            "id": generate_uuid(),
            "loop_id": loop_id,
            "status": status,
            "detail": (detail or "")[:5000] or None,
            "started_at": started_at.isoformat(),
            "finished_at": _now().isoformat(),
        },
    )
    return result["data"] if isinstance(result, dict) and "data" in result else result


# The lock carries the token of the tick that took it, so a tick that outlived
# its lock cannot renew or release the one a later tick holds.
_LOCK_TOKENS: dict[str, str] = {}


async def _claim_run_lock(loop_id: str) -> bool:
    """Serialise ticks per loop: a manual refresh must never race a scheduled tick
    over the same state row."""
    token = generate_uuid()
    try:
        client = await get_redis_client()
        taken = bool(
            await client.set(f"popcorn:run:{loop_id}", token, ex=RUN_LOCK_SECONDS, nx=True)
        )
        if taken:
            _LOCK_TOKENS[loop_id] = token
        return taken
    except Exception:
        logger.warning("Redis unavailable for popcorn run lock", exc_info=True)
        _LOCK_TOKENS[loop_id] = token
        return True


async def _owns_run_lock(client: Any, loop_id: str) -> bool:
    held = await client.get(f"popcorn:run:{loop_id}")
    if isinstance(held, bytes):
        held = held.decode()
    return bool(held) and held == _LOCK_TOKENS.get(loop_id)


async def _release_run_lock(loop_id: str) -> None:
    try:
        client = await get_redis_client()
        if await _owns_run_lock(client, loop_id):
            await client.delete(f"popcorn:run:{loop_id}")
    except Exception:
        logger.warning("Redis unavailable releasing popcorn run lock", exc_info=True)
    finally:
        _LOCK_TOKENS.pop(loop_id, None)


async def _mark_alive(loop_id: str) -> None:
    try:
        client = await get_redis_client()
        await client.set(f"popcorn:alive:{loop_id}", "1", ex=STALE_TICK_SECONDS)
    except Exception:
        logger.warning("Redis unavailable for popcorn heartbeat", exc_info=True)


async def _clear_alive(loop_id: str) -> None:
    try:
        client = await get_redis_client()
        await client.delete(f"popcorn:alive:{loop_id}")
    except Exception:
        logger.warning("Redis unavailable clearing popcorn heartbeat", exc_info=True)


async def _tick_alive(loop_id: str) -> bool:
    """True while a tick for this loop is still beating, however long it runs."""
    try:
        client = await get_redis_client()
        return bool(await client.exists(f"popcorn:alive:{loop_id}"))
    except Exception:
        return False


async def _heartbeat(loop_id: str) -> None:
    while True:
        await _mark_alive(loop_id)
        await _renew_run_lock(loop_id)
        await asyncio.sleep(HEARTBEAT_SECONDS)


async def _renew_run_lock(loop_id: str) -> None:
    """The second pass can outlast the lock on a big session; every write of
    the state and every heartbeat renews it, so a scheduled tick cannot start
    underneath. Only the tick that holds the lock may renew it."""
    try:
        client = await get_redis_client()
        if await _owns_run_lock(client, loop_id):
            await client.expire(f"popcorn:run:{loop_id}", RUN_LOCK_SECONDS)
    except Exception:
        logger.warning("Redis unavailable renewing popcorn run lock", exc_info=True)


async def _popcorn_enabled_for_loop(loop: dict[str, Any]) -> bool:
    if not get_settings().feature_flags.enable_canvas:
        return False
    project_id = _as_id(loop.get("project_id"))
    if not project_id:
        return False
    try:
        project = await async_directus.get_item("project", project_id)
    except Exception:
        return False
    return bool(isinstance(project, dict) and project.get("is_canvas_enabled"))


async def _update_loop_after_tick(loop: dict[str, Any], *, status: str) -> None:
    loop_id = str(loop["id"])
    if status == "ok":
        await async_directus.update_item("agent_loop", loop_id, {"failure_count": 0})
        return
    if status == "error":
        failures = int(loop.get("failure_count") or 0) + 1
        patch: dict[str, Any] = {"failure_count": failures}
        if failures >= 3:
            patch["status"] = "paused"
        await async_directus.update_item("agent_loop", loop_id, patch)


async def _enqueue_next_if_due(loop: dict[str, Any], when: datetime | None = None) -> None:
    loop_id = str(loop["id"])
    fresh = await async_directus.get_item("agent_loop", loop_id)
    if not fresh or fresh.get("status") != "active":
        return
    expires_at = _parse_dt(fresh.get("expires_at"))
    now = _now()
    if expires_at and now >= expires_at:
        await async_directus.update_item("agent_loop", loop_id, {"status": "expired"})
        return
    cadence = max(MIN_CADENCE_MINUTES, int(fresh.get("cadence_minutes") or DEFAULT_CADENCE_MINUTES))
    next_at = when or (now + timedelta(minutes=cadence))
    if expires_at and next_at >= expires_at:
        final_at = expires_at - timedelta(seconds=5)
        if final_at > now:
            next_at = final_at
        else:
            await async_directus.update_item("agent_loop", loop_id, {"status": "expired"})
            return
    # One chain per loop. Every manual read and every go-live adds a safety
    # tick, and each tick that runs schedules the next, so without this the
    # chains multiply and a busy host ends the day with a tick storm.
    from dembrane.scheduled_tasks import TASK_POPCORN_TICK, cancel_pending_tasks

    await cancel_pending_tasks(task_type=TASK_POPCORN_TICK, payload_match={"loop_id": loop_id})
    await enqueue_popcorn_tick(loop_id, when=next_at)


# ── gather ───────────────────────────────────────────────────────────


async def gather_transcripts(
    *,
    project_id: str,
    acting_directus_user_id: str,
) -> list[dict[str, Any]]:
    """Every conversation in the project with its full transcript so far,
    oldest first so marker colours stay stable as new tables join."""
    await resolve_canvas_reader_context(
        acting_directus_user_id=acting_directus_user_id,
        project_id=project_id,
    )
    conversations_raw = await async_directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {"project_id": {"_eq": project_id}, "deleted_at": {"_null": True}},
                "fields": ["id", "participant_name", "created_at", "duration"],
                "sort": ["created_at"],
                "limit": 500,
            }
        },
    )
    conversations = [c for c in (conversations_raw or []) if isinstance(c, dict)]
    ids = [cid for cid in (_as_id(c.get("id")) for c in conversations) if cid]
    if not ids:
        return []
    chunks_raw = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {
                    "conversation_id": {"_in": ids},
                    "transcript": {"_nnull": True},
                },
                "fields": ["id", "conversation_id", "transcript", "created_at", "timestamp"],
                "sort": ["timestamp", "created_at"],
                "limit": -1,
            }
        },
    )
    by_conversation: dict[str, list[str]] = {}
    for chunk in chunks_raw or []:
        if not isinstance(chunk, dict):
            continue
        cid = _as_id(chunk.get("conversation_id"))
        text = str(chunk.get("transcript") or "").strip()
        if cid and text:
            by_conversation.setdefault(cid, []).append(text)

    out: list[dict[str, Any]] = []
    for index, conv in enumerate(conversations, start=1):
        cid = _as_id(conv.get("id"))
        if not cid:
            continue
        text = "\n".join(by_conversation.get(cid, [])).strip()
        if not text:
            continue
        label, short = labels_for(conv, index)
        out.append(
            {
                "id": cid,
                "label": label,
                "short": short,
                "created_at": conv.get("created_at"),
                "duration": conv.get("duration"),
                "text": text[:MAX_CHARS_PER_CONVERSATION],
            }
        )
    return out


# ── the tick ─────────────────────────────────────────────────────────


class _TickWriter:
    """Single writer for the loop's state row. Extractors finish in any order;
    every completion is written straight away so the stage sees it, and the
    lock keeps two completions from clobbering each other's write."""

    def __init__(self, loop_id: str, report_id: str, state: dict[str, Any]) -> None:
        self.loop_id = loop_id
        self.report_id = report_id
        self.state = state
        self._lock = asyncio.Lock()

    async def flush(self) -> None:
        async with self._lock:
            await async_directus.update_item(
                "agent_loop", self.loop_id, {"popcorn_state": self.state}
            )
        await _renew_run_lock(self.loop_id)
        await publish_generation_nudge(self.report_id)


async def _extract_one(
    writer: _TickWriter,
    semaphore: asyncio.Semaphore,
    transcript: dict[str, Any],
    outcomes: list[str],
    host_note: str = "",
    known: set[tuple[str, ...]] | None = None,
) -> None:
    cid = transcript["id"]
    entry = writer.state["conversations"][cid]
    async with semaphore:
        started = _now()
        try:
            raw = await extract_popcorn(
                transcript_id=cid, transcript=transcript["text"], host_note=host_note
            )
            # The gates are code: a name from the introductions, text the room was
            # shown, or a twin of another phrase never reaches the stage.
            items, suppressed = gate_items(
                shape_popcorn_items(raw, cid),
                names=introduced_names(transcript["text"]),
                known=known or set(),
            )
            # Grounding is code too: the closest passage behind each phrase, for
            # the host. The quote behind it is the second pass's job.
            items = ground_items(items, transcript["text"])
            entry.update(
                {
                    "items": items,
                    "review": {"suppressed": suppressed} if suppressed else {},
                    "revision": int(entry.get("revision") or 0) + 1,
                    "done": True,
                    "fingerprint": transcript["fingerprint"],
                    "chars": len(transcript["text"]),
                    "extracted_at": _now().isoformat(),
                    "error": None,
                }
            )
            elapsed_ms = int((_now() - started).total_seconds() * 1000)
            held = f", {len(suppressed)} held back" if suppressed else ""
            outcomes.append(f"popcorn {cid[:8]}: {len(items)} phrases{held} in {elapsed_ms} ms")
        except Exception as exc:  # a dead transcript must not stall the stage
            entry.update(
                {
                    "items": entry.get("items") or [],
                    "revision": int(entry.get("revision") or 0) + 1,
                    "done": True,
                    "extracted_at": _now().isoformat(),
                    "error": str(exc)[:500],
                }
            )
            outcomes.append(f"popcorn {cid[:8]}: FAILED {exc}")
    await writer.flush()


async def _enrich_one(
    writer: _TickWriter,
    semaphore: asyncio.Semaphore,
    transcript: dict[str, Any],
    outcomes: list[str],
    book: QuoteBook,
) -> None:
    """The second pass over one conversation's phrases, written once: quotes into
    the shared registry, kinds and question marks onto the items, one revision,
    one flush. A failed call leaves its phrase as it was; the pass is retried
    next tick because the transcript's fingerprint is not stamped."""
    cid = transcript["id"]
    entry = writer.state["conversations"][cid]
    # A phrase that already has its kind and its evidence answer is done; the
    # pass is retried only for what a failed call left behind.
    items = [item for item in entry.get("items") or [] if _needs_pass(item)]
    text = transcript["text"]
    names = introduced_names(text)
    started = _now()

    async def one(item: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            return await enrich_item(
                item,
                transcript_id=cid,
                transcript=text,
                names=names,
                validate=validate_phrase,
                classify=classify_phrase,
                rewrite=rewrite_question,
            )

    try:
        results = await asyncio.gather(*(one(item) for item in items))
    except Exception as exc:  # a dead pass must not stall the tick
        outcomes.append(f"enrich {cid[:8]}: FAILED {exc}")
        return
    if entry.get("fingerprint") != transcript["fingerprint"]:
        return  # re-read underneath the pass; the next tick enriches the new phrases
    stats = apply_results(
        items,
        results,
        transcript_id=cid,
        register=lambda tid, quote: book.add({"transcript": tid, "text": quote}),
    )
    entry["revision"] = int(entry.get("revision") or 0) + 1
    failed = sum(len(r.get("errors") or []) for r in results)
    if not failed:
        # Only a complete pass is stamped; a failed call keeps the conversation
        # owed, so the next tick retries exactly the phrases it failed on.
        entry["validated_fingerprint"] = transcript["fingerprint"]
    writer.state["quotes"] = list(book.quotes)
    elapsed_ms = int((_now() - started).total_seconds() * 1000)
    outcomes.append(
        f"enrich {cid[:8]}: {stats['rooted']}/{len(items)} rooted, {stats['classified']} kinds, "
        f"{stats['rewritten']} rewritten in {elapsed_ms} ms"
        + (f", {failed} call(s) failed" if failed else "")
    )
    await writer.flush()


def _pending_enrichment(
    state: dict[str, Any], transcripts: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """The conversations still owed a second pass on the transcript as it
    stands: read this tick, or read earlier without the pass finishing."""
    out = []
    for t in transcripts:
        conv = state["conversations"].get(t["id"])
        if (
            conv
            and conv.get("done")
            and conv.get("items")
            and conv.get("validated_fingerprint") != t["fingerprint"]
        ):
            out.append(t)
    return out


def _needs_pass(item: dict[str, Any]) -> bool:
    """A phrase still owed the second pass: no kind yet, or a call that failed."""
    if not isinstance(item, dict):
        return False
    if "kind" not in item:
        return True
    return bool((item.get("review") or {}).get("errors"))


def _referenced_quote_ids(value: Any) -> set[str]:
    ids: set[str] = set()
    if isinstance(value, dict):
        qid = value.get("quoteId")
        if isinstance(qid, str):
            ids.add(qid)
        qids = value.get("quoteIds")
        if isinstance(qids, list):
            ids.update(str(q) for q in qids)
        for v in value.values():
            if isinstance(v, (dict, list)):
                ids |= _referenced_quote_ids(v)
    elif isinstance(value, list):
        for v in value:
            ids |= _referenced_quote_ids(v)
    return ids


def _referenced_quotes(state: dict[str, Any], quotes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The registry after a run: every quote something on the deck still cites."""
    ids = _referenced_quote_ids(state.get("conversations") or {}) | _referenced_quote_ids(
        state.get("analysis") or {}
    )
    return [q for q in quotes if q.get("id") in ids]


async def run_tensions_pipeline(sources: dict[str, str], book: QuoteBook) -> dict[str, Any]:
    """The five-stage tensions pipeline over the session, into the shared registry."""
    return await run_pipeline(
        sources,
        book,
        generate=analysis_call,
        prompts={name: prompt_text(name) for name in TENSION_PROMPTS},
        concurrency=MAX_PARALLEL_ANALYSIS,
    )


async def _run_analysis_pass(
    transcripts: list[dict[str, Any]],
    outcomes: list[str],
    book: QuoteBook,
) -> dict[str, Any] | None:
    """Both slow slides at once, registering into the tick's shared quote book:
    the stakeholders call with its two gates and one retry, and the tensions
    pipeline. Returns the new analysis block, or None when either failed so
    the previous block stays."""
    total = sum(len(t["text"]) for t in transcripts)
    per_transcript = (
        MAX_ANALYSIS_CHARS // max(1, len(transcripts)) if total > MAX_ANALYSIS_CHARS else None
    )
    sources = {
        t["id"]: (t["text"][:per_transcript] if per_transcript else t["text"]) for t in transcripts
    }
    corpus = build_corpus([(tid, text) for tid, text in sources.items()])
    shaped: dict[str, dict[str, Any]] = {}

    async def stakeholders_slide() -> None:
        started = _now()
        raw = await run_analysis(kind="stakeholders", corpus=corpus)
        # The gates read a shaped answer; a throwaway book keeps a rejected
        # answer's quotes out of the shared registry.
        probe = shape_stakeholders(raw, QuoteBook(sources))
        flags = name_flags(probe) + island_flags(probe)
        if flags:
            raw = await run_analysis(kind="stakeholders", corpus=corpus, feedback=flags)
        shaped["stakeholders"] = shape_stakeholders(raw, book)
        left = name_flags(shaped["stakeholders"]) + island_flags(shaped["stakeholders"])
        elapsed_ms = int((_now() - started).total_seconds() * 1000)
        outcomes.append(
            f"stakeholders: {len(shaped['stakeholders']['stakeholders'])} items, "
            f"{len(shaped['stakeholders']['relations'])} relations in {elapsed_ms} ms"
            + (f", {len(flags)} gate flag(s), asked again" if flags else "")
            + (f", {len(left)} left" if left else "")
        )

    async def tensions_slide() -> None:
        started = _now()
        result = await run_tensions_pipeline(sources, book)
        shaped["tensions"] = result["tensions"]
        c = result.get("counts") or {}
        elapsed_ms = int((_now() - started).total_seconds() * 1000)
        outcomes.append(
            f"tensions: {len(result['tensions']['tensions'])} items in {elapsed_ms} ms "
            f"({c.get('positions', 0)} positions, {c.get('candidates', 0)} pairs, "
            f"{c.get('cross_table', 0)} across tables, {c.get('verified', 0)} verified)"
            + (
                f", {len(result['gate_flags'])} screen flag(s) left"
                if result.get("gate_flags")
                else ""
            )
        )

    results = await asyncio.gather(stakeholders_slide(), tensions_slide(), return_exceptions=True)
    failed = [
        f"{kind}: FAILED {exc}"
        for kind, exc in zip(("stakeholders", "tensions"), results, strict=True)
        if isinstance(exc, BaseException)
    ]
    if failed:
        outcomes.extend(failed)
        return None
    outcomes.append(f"quotes: {len(book.quotes)} verified, {book.rejected} rejected")
    return {
        "fingerprint": _fingerprint(
            "|".join(f"{tid}:{_fingerprint(text)}" for tid, text in sources.items())
        ),
        "tensions": shaped["tensions"],
        "stakeholders": shaped["stakeholders"],
        "updated_at": _now().isoformat(),
    }


async def _snapshot_version(
    *,
    report_id: str,
    config_id: str | None,
    state: dict[str, Any],
    settings: dict[str, Any],
    project_id: str,
    tick_kind: str,
    detail: str,
) -> None:
    from dembrane.settings import get_settings as _get_settings
    from dembrane.popcorn.service import build_bundle

    project = await async_directus.get_item("project", project_id)
    report = await async_directus.get_item("project_report", report_id)
    urls = _get_settings().urls
    bundle = build_bundle(
        state=state,
        settings=settings,
        report=report if isinstance(report, dict) else {"id": report_id},
        project=project if isinstance(project, dict) else {"id": project_id},
        participant_base_url=urls.participant_base_url,
        admin_base_url=urls.admin_base_url,
        host=True,
    )
    await save_version(
        report_id=report_id,
        config_id=config_id,
        files=bundle["files"],
        tick_kind=tick_kind,
        detail=detail,
    )


async def run_popcorn_tick(loop_id: str, tick_kind: str = "scheduled") -> dict[str, Any]:
    started_at = _now()
    loop = await async_directus.get_item("agent_loop", loop_id)
    if not loop or not is_popcorn_loop(loop):
        raise RuntimeError("Popcorn loop not found")

    if not await _popcorn_enabled_for_loop(loop):
        run = await _create_run(
            loop_id=loop_id,
            status="no_op",
            detail="Popcorn is disabled for this project",
            started_at=started_at,
        )
        return {"status": "disabled", "run": run}

    expires_at = _parse_dt(loop.get("expires_at"))
    if expires_at and started_at >= expires_at:
        await async_directus.update_item("agent_loop", loop_id, {"status": "expired"})
        run = await _create_run(
            loop_id=loop_id,
            status="no_op",
            detail="Loop expired before tick start",
            started_at=started_at,
        )
        return {"status": "expired", "run": run}
    if loop.get("status") != "active" and tick_kind != "manual":
        run = await _create_run(
            loop_id=loop_id,
            status="no_op",
            detail=f"Loop is {loop.get('status')}",
            started_at=started_at,
        )
        return {"status": "no_op", "run": run}

    if not await _claim_run_lock(loop_id):
        # A host pressing "read again" while a tick is mid-flight expects the
        # new chunks to be read, not dropped: wait for the running tick to end.
        claimed = False
        if tick_kind == "manual":
            for _ in range(MANUAL_LOCK_WAIT_SECONDS // 2):
                await asyncio.sleep(2)
                if await _claim_run_lock(loop_id):
                    claimed = True
                    break
        if not claimed:
            run = await _create_run(
                loop_id=loop_id,
                status="no_op",
                detail="A tick is already running",
                started_at=started_at,
            )
            return {"status": "duplicate", "run": run}
        # The tick that just finished wrote the state; read it, not the snapshot
        # taken before the wait.
        loop = await async_directus.get_item("agent_loop", loop_id) or loop

    report_id = _as_id(loop.get("report_id"))
    project_id = _as_id(loop.get("project_id"))
    acting_user_id = str(loop.get("acting_directus_user_id") or "")
    pulse = asyncio.create_task(_heartbeat(loop_id))
    try:
        if not report_id or not project_id or not acting_user_id:
            raise RuntimeError("Popcorn loop is missing required ids")

        # The next read is booked before this one starts, so a worker that dies
        # mid-read (a pod scaled away, a crash) costs the room one cadence and
        # never the chain. The booking is refreshed again when this read ends.
        await _enqueue_next_if_due(loop)

        state = normalize_state(loop.get("popcorn_state"))
        # What the tool has put in front of the room so far, before this tick
        # writes anything: a new phrase that quotes it is the tool quoting itself.
        # Each conversation is checked against everything but its own phrases.
        known_all = known_shingles(state)
        known_by = {cid: known_shingles(state, exclude=cid) for cid in state["conversations"]}
        config = await get_latest_config(report_id)
        settings = normalize_settings(
            (config or {}).get("popcorn_settings"),
            fallback_title=str(loop.get("name") or "Popcorn"),
        )
        host_note = voice_host_note(settings.get("voice"))
        transcripts = await gather_transcripts(
            project_id=project_id, acting_directus_user_id=acting_user_id
        )
        for t in transcripts:
            # A change of voice re-reads every conversation, like a new transcript would.
            t["fingerprint"] = _fingerprint(t["text"] + "\x1f" + host_note)

        changed: list[dict[str, Any]] = []
        for t in transcripts:
            entry = state["conversations"].get(t["id"])
            if entry is None:
                entry = {"id": t["id"], "revision": 0, "done": False, "items": []}
                state["conversations"][t["id"]] = entry
                state["order"].append(t["id"])
            entry["label"] = t["label"]
            entry["short"] = t["short"]
            entry["created_at"] = t["created_at"]
            entry["duration"] = t.get("duration")
            if entry.get("fingerprint") != t["fingerprint"] or not entry.get("done"):
                changed.append(t)
        # A conversation that vanished (deleted, or its chunks removed) leaves
        # the deck with it; the legend must not name a table that is not there.
        present = {t["id"] for t in transcripts}
        vanished = [cid for cid in state["conversations"] if cid not in present]
        for cid in vanished:
            state["conversations"].pop(cid, None)
        state["order"] = [cid for cid in state["order"] if cid in present]
        if vanished and not transcripts:
            # The last conversation is gone: nothing derived from it may stay on
            # the deck. Written now, because the no-op path below never writes.
            state["analysis"] = None
            state["quotes"] = []
            await async_directus.update_item("agent_loop", loop_id, {"popcorn_state": state})
            await publish_generation_nudge(report_id)

        analysis_fingerprint = _fingerprint(
            "|".join(f"{t['id']}:{t['fingerprint']}" for t in transcripts)
        )
        analysis_stale = bool(transcripts) and (
            (state.get("analysis") or {}).get("fingerprint") != analysis_fingerprint
        )

        owed = _pending_enrichment(state, transcripts)
        if not changed and not analysis_stale and not owed and tick_kind != "manual":
            run = await _create_run(
                loop_id=loop_id,
                status="no_op",
                detail="No new transcript content since the last tick",
                started_at=started_at,
            )
            await _enqueue_next_if_due(loop)
            return {"status": "no_op", "run": run}

        state["run"] = int(state.get("run") or 0) + 1
        # A conversation being re-read shows as "reading" on the deck and the
        # host page until its extractor lands; its old phrases stay on screen.
        for t in changed:
            state["conversations"][t["id"]]["done"] = False
        writer = _TickWriter(loop_id, report_id, state)
        # The legend and the "listening…" stage need the transcript list before
        # any phrase lands, so the session is published before extraction starts.
        await writer.flush()

        outcomes: list[str] = []
        if changed:
            semaphore = asyncio.Semaphore(MAX_PARALLEL_EXTRACTORS)
            await asyncio.gather(
                *(
                    _extract_one(
                        writer, semaphore, t, outcomes, host_note, known_by.get(t["id"], known_all)
                    )
                    for t in changed
                )
            )

        # One quote registry for the tick, seeded with the session's so the ids
        # the deck holds stay valid; every pass below registers into it.
        book = QuoteBook(
            {t["id"]: t["text"] for t in transcripts},
            names=set().union(*(introduced_names(t["text"]) for t in transcripts))
            if transcripts
            else set(),
            existing=state.get("quotes"),
        )

        # The second pass, only now that every first phrase is on the stage: the
        # conversations re-read this tick, and any whose earlier pass did not finish.
        pending = _pending_enrichment(state, transcripts)
        if pending:
            enrich_semaphore = asyncio.Semaphore(MAX_PARALLEL_ENRICHMENT)
            await asyncio.gather(
                *(_enrich_one(writer, enrich_semaphore, t, outcomes, book) for t in pending)
            )

        if transcripts and (analysis_stale or changed or tick_kind == "manual"):
            analysis = await _run_analysis_pass(transcripts, outcomes, book)
            if analysis is not None:
                analysis["fingerprint"] = analysis_fingerprint
                state["analysis"] = analysis
        if transcripts:
            state["quotes"] = _referenced_quotes(state, book.quotes)
            await writer.flush()

        detail = "; ".join(
            [f"run {state['run']}: {len(changed)} of {len(transcripts)} conversations re-read"]
            + outcomes
        )
        run = await _create_run(loop_id=loop_id, status="ok", detail=detail, started_at=started_at)
        try:
            await _snapshot_version(
                report_id=report_id,
                config_id=_as_id((config or {}).get("id")),
                state=state,
                settings=settings,
                project_id=project_id,
                tick_kind=tick_kind,
                detail=detail,
            )
        except Exception as exc:  # a failed snapshot must not fail the tick
            logger.warning("popcorn version snapshot failed for %s: %s", report_id, exc)
        await _update_loop_after_tick(loop, status="ok")
        await _enqueue_next_if_due(loop)
        return {"status": "ok", "run": run, "state": state}
    except (CanvasReaderAccessDenied, Exception) as exc:
        detail = str(exc)
        run = await _create_run(
            loop_id=loop_id, status="error", detail=detail, started_at=started_at
        )
        await _update_loop_after_tick(loop, status="error")
        await _enqueue_next_if_due(loop)
        logger.warning("popcorn tick failed for loop %s: %s", loop_id, detail)
        return {"status": "error", "run": run}
    finally:
        pulse.cancel()
        await _clear_alive(loop_id)
        await _release_run_lock(loop_id)


async def reconcile_missing_popcorn_tick_tasks() -> int:
    """Backfill one pending scheduled tick for each active popcorn loop missing one."""
    if not get_settings().feature_flags.enable_canvas:
        return 0
    now = _now()
    loops = await async_directus.get_items(
        "agent_loop",
        {
            "query": {
                "filter": {"status": {"_eq": "active"}, "expires_at": {"_gt": now.isoformat()}},
                "fields": ["id", "expires_at", "cadence_minutes", "caps", "status"],
                "limit": -1,
            }
        },
    )
    popcorn_loops = [
        loop for loop in (loops or []) if isinstance(loop, dict) and is_popcorn_loop(loop)
    ]
    if not popcorn_loops:
        return 0

    from dembrane.scheduled_tasks import (
        STATUS_FAILED,
        STATUS_SCHEDULED,
        STATUS_PROCESSING,
        TASK_POPCORN_TICK,
    )

    existing = await async_directus.get_items(
        "scheduled_task",
        {
            "query": {
                "filter": {
                    "task_type": {"_eq": TASK_POPCORN_TICK},
                    "status": {"_in": [STATUS_SCHEDULED, STATUS_PROCESSING]},
                },
                "fields": ["id", "payload", "status", "claimed_at"],
                "limit": -1,
            }
        },
    )
    covered: set[str] = set()
    for task in existing or []:
        if not isinstance(task, dict):
            continue
        loop_id = str((task.get("payload") or {}).get("loop_id") or "")
        if not loop_id:
            continue
        status = task.get("status")
        if status == STATUS_SCHEDULED:
            covered.add(loop_id)
        elif status == STATUS_PROCESSING:
            claimed_at = _parse_dt(task.get("claimed_at"))
            # Stranded: claimed longer ago than STALE_TICK_SECONDS and no heartbeat.
            # A tick in its second pass beats for as long as it runs.
            fresh = (
                claimed_at is not None and (now - claimed_at).total_seconds() <= STALE_TICK_SECONDS
            )
            if fresh or await _tick_alive(loop_id):
                covered.add(loop_id)
            else:
                task_id = str(task.get("id") or "")
                logger.warning(
                    "Rescuing stranded popcorn tick task %s for loop %s (claimed at %s)",
                    task_id,
                    loop_id,
                    task.get("claimed_at"),
                )
                if task_id:
                    try:
                        await async_directus.update_item(
                            "scheduled_task",
                            task_id,
                            {
                                "status": STATUS_FAILED,
                                "error": "Stale processing claim rescued by popcorn reconciler",
                                "updated_at": now.isoformat(),
                            },
                        )
                    except Exception as exc:
                        logger.warning(
                            "Failed to mark stranded task %s as failed: %s", task_id, exc
                        )

    enqueued = 0
    for loop in popcorn_loops:
        loop_id = str(loop.get("id") or "")
        if not loop_id or loop_id in covered:
            continue
        await _enqueue_next_if_due(loop, when=now)
        enqueued += 1
    if enqueued:
        logger.info("Backfilled %d missing popcorn tick scheduled_task row(s)", enqueued)
    return enqueued
