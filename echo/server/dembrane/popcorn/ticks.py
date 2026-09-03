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
- Popcorn phrases are never presented as direct quotes. The upstream validation
  pass (popcorn-validate) has not been written yet, so `validated` stays false.
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
from dembrane.popcorn.model import run_analysis, extract_popcorn
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
    shape_tensions,
    shape_stakeholders,
    shape_popcorn_items,
)
from dembrane.popcorn.grounding import ground_items

logger = logging.getLogger("dembrane.popcorn.ticks")

# Parallel extractors per tick. The upstream demo runs 16; Vertex flash keeps up.
MAX_PARALLEL_EXTRACTORS = 16
# A single conversation rarely passes 100k characters in a day; the cap only
# guards the prompt against a runaway recording.
MAX_CHARS_PER_CONVERSATION = 150_000
# The analysis corpus is every transcript at once. Above this the transcripts
# are clipped evenly so the two slow calls stay inside one context window.
MAX_ANALYSIS_CHARS = 600_000
RUN_LOCK_SECONDS = 15 * 60
MANUAL_LOCK_WAIT_SECONDS = 180
ANALYSIS_KINDS = ("tensions", "stakeholders")
ANALYSIS_SHAPERS = {"tensions": shape_tensions, "stakeholders": shape_stakeholders}


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


async def _claim_run_lock(loop_id: str) -> bool:
    """Serialise ticks per loop: a manual refresh must never race a scheduled tick
    over the same state row."""
    try:
        client = await get_redis_client()
        return bool(await client.set(f"popcorn:run:{loop_id}", "1", ex=RUN_LOCK_SECONDS, nx=True))
    except Exception:
        logger.warning("Redis unavailable for popcorn run lock", exc_info=True)
        return True


async def _release_run_lock(loop_id: str) -> None:
    try:
        client = await get_redis_client()
        await client.delete(f"popcorn:run:{loop_id}")
    except Exception:
        logger.warning("Redis unavailable releasing popcorn run lock", exc_info=True)


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


async def _enqueue_next_if_due(loop: dict[str, Any]) -> None:
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
    next_at = now + timedelta(minutes=cadence)
    if expires_at and next_at >= expires_at:
        final_at = expires_at - timedelta(seconds=5)
        if final_at > now:
            next_at = final_at
        else:
            await async_directus.update_item("agent_loop", loop_id, {"status": "expired"})
            return
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
                "fields": ["id", "participant_name", "created_at"],
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
        await publish_generation_nudge(self.report_id)


async def _extract_one(
    writer: _TickWriter,
    semaphore: asyncio.Semaphore,
    transcript: dict[str, Any],
    outcomes: list[str],
    host_note: str = "",
) -> None:
    cid = transcript["id"]
    entry = writer.state["conversations"][cid]
    async with semaphore:
        started = _now()
        try:
            raw = await extract_popcorn(
                transcript_id=cid, transcript=transcript["text"], host_note=host_note
            )
            # Grounding is code, not a model call: verbatim phrases earn a quote in
            # the next analysis pass, the rest carry their closest passage for the host.
            items = ground_items(shape_popcorn_items(raw, cid), transcript["text"])
            entry.update(
                {
                    "items": items,
                    "revision": int(entry.get("revision") or 0) + 1,
                    "done": True,
                    "fingerprint": transcript["fingerprint"],
                    "chars": len(transcript["text"]),
                    "extracted_at": _now().isoformat(),
                    "error": None,
                }
            )
            elapsed_ms = int((_now() - started).total_seconds() * 1000)
            outcomes.append(f"popcorn {cid[:8]}: {len(items)} phrases in {elapsed_ms} ms")
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


async def _run_analysis_pass(
    transcripts: list[dict[str, Any]],
    outcomes: list[str],
    state: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Both slow slides at once, sharing one quote registry. Returns the new
    analysis block, or None when any slide failed so the previous block stays."""
    total = sum(len(t["text"]) for t in transcripts)
    per_transcript = (
        MAX_ANALYSIS_CHARS // max(1, len(transcripts)) if total > MAX_ANALYSIS_CHARS else None
    )
    sources = {
        t["id"]: (t["text"][:per_transcript] if per_transcript else t["text"]) for t in transcripts
    }
    corpus = build_corpus([(tid, text) for tid, text in sources.items()])
    book = QuoteBook(sources)
    book_lock = asyncio.Lock()
    shaped: dict[str, dict[str, Any]] = {}

    # Verbatim popcorn phrases go into the registry first, in deck order, so
    # their ids stay stable across the two analysis calls that follow.
    popcorn_quotes: dict[str, str] = {}
    conversations = (state or {}).get("conversations") or {}
    for cid in (state or {}).get("order") or []:
        for item in (conversations.get(cid) or {}).get("items") or []:
            if isinstance(item, dict) and item.get("verbatim") and item.get("phrase"):
                qid = book.add({"transcript": cid, "text": item["phrase"]})
                if qid:
                    popcorn_quotes[str(item.get("id"))] = qid

    async def one(kind: str) -> None:
        started = _now()
        raw = await run_analysis(kind=kind, corpus=corpus)
        async with book_lock:
            shaped[kind] = ANALYSIS_SHAPERS[kind](raw, book)
        n = len(shaped[kind].get(kind) or [])
        extra = (
            f", {len(shaped[kind].get('relations') or [])} relations"
            if kind == "stakeholders"
            else ""
        )
        elapsed_ms = int((_now() - started).total_seconds() * 1000)
        outcomes.append(f"{kind}: {n} items{extra} in {elapsed_ms} ms")

    results = await asyncio.gather(*(one(kind) for kind in ANALYSIS_KINDS), return_exceptions=True)
    failed = [
        f"{kind}: FAILED {exc}"
        for kind, exc in zip(ANALYSIS_KINDS, results, strict=True)
        if isinstance(exc, BaseException)
    ]
    if failed:
        outcomes.extend(failed)
        return None
    outcomes.append(
        f"quotes: {len(book.quotes)} verified ({len(popcorn_quotes)} popcorn), {book.rejected} rejected"
    )
    return {
        "popcorn_quotes": popcorn_quotes,
        "fingerprint": _fingerprint(
            "|".join(f"{tid}:{_fingerprint(text)}" for tid, text in sources.items())
        ),
        "quotes": book.quotes,
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

    report_id = _as_id(loop.get("report_id"))
    project_id = _as_id(loop.get("project_id"))
    acting_user_id = str(loop.get("acting_directus_user_id") or "")
    try:
        if not report_id or not project_id or not acting_user_id:
            raise RuntimeError("Popcorn loop is missing required ids")

        state = normalize_state(loop.get("popcorn_state"))
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
            if entry.get("fingerprint") != t["fingerprint"] or not entry.get("done"):
                changed.append(t)
        # A conversation that vanished (deleted, or its chunks removed) leaves
        # the deck with it; the legend must not name a table that is not there.
        present = {t["id"] for t in transcripts}
        for cid in list(state["conversations"]):
            if cid not in present:
                state["conversations"].pop(cid, None)
        state["order"] = [cid for cid in state["order"] if cid in present]

        analysis_fingerprint = _fingerprint(
            "|".join(f"{t['id']}:{t['fingerprint']}" for t in transcripts)
        )
        analysis_stale = bool(transcripts) and (
            (state.get("analysis") or {}).get("fingerprint") != analysis_fingerprint
        )

        if not changed and not analysis_stale and tick_kind != "manual":
            run = await _create_run(
                loop_id=loop_id,
                status="no_op",
                detail="No new transcript content since the last tick",
                started_at=started_at,
            )
            await _enqueue_next_if_due(loop)
            return {"status": "no_op", "run": run}

        state["run"] = int(state.get("run") or 0) + 1
        writer = _TickWriter(loop_id, report_id, state)
        # The legend and the "listening…" stage need the transcript list before
        # any phrase lands, so the session is published before extraction starts.
        await writer.flush()

        outcomes: list[str] = []
        if changed:
            semaphore = asyncio.Semaphore(MAX_PARALLEL_EXTRACTORS)
            await asyncio.gather(
                *(_extract_one(writer, semaphore, t, outcomes, host_note) for t in changed)
            )

        if transcripts and (analysis_stale or changed or tick_kind == "manual"):
            analysis = await _run_analysis_pass(transcripts, outcomes, state)
            if analysis is not None:
                analysis["fingerprint"] = analysis_fingerprint
                popcorn_quotes = analysis.pop("popcorn_quotes", {})
                for cid in state["order"]:
                    conv = state["conversations"].get(cid) or {}
                    for item in conv.get("items") or []:
                        if isinstance(item, dict):
                            qid = popcorn_quotes.get(str(item.get("id")))
                            if qid:
                                item["quoteId"] = qid
                            else:
                                item.pop("quoteId", None)
                    if conv.get("done"):
                        conv["validated_run"] = state["run"]
                state["analysis"] = analysis
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

    from dembrane.scheduled_tasks import STATUS_SCHEDULED, STATUS_PROCESSING, TASK_POPCORN_TICK

    existing = await async_directus.get_items(
        "scheduled_task",
        {
            "query": {
                "filter": {
                    "task_type": {"_eq": TASK_POPCORN_TICK},
                    "status": {"_in": [STATUS_SCHEDULED, STATUS_PROCESSING]},
                },
                "fields": ["payload"],
                "limit": -1,
            }
        },
    )
    covered = {
        str((task.get("payload") or {}).get("loop_id"))
        for task in (existing or [])
        if isinstance(task, dict) and (task.get("payload") or {}).get("loop_id")
    }
    enqueued = 0
    for loop in popcorn_loops:
        loop_id = str(loop.get("id") or "")
        if not loop_id or loop_id in covered:
            continue
        await _enqueue_next_if_due(loop)
        enqueued += 1
    if enqueued:
        logger.info("Backfilled %d missing popcorn tick scheduled_task row(s)", enqueued)
    return enqueued
