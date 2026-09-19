"""Map generation: one attempt, from queued to a ready revision or a failure.

1. Gather the project's transcripts and fingerprint them.
2. Probe the embedding deployment for its real identity and dimensions.
3. Extract candidates per conversation (bounded concurrency), saving each
   conversation's result as it lands, so a resumed attempt skips it.
4. Embed every distinct candidate statement not already stored for this
   project and configuration, validating and saving each vector as it lands.
5. Consolidate, build the manifest and publish it atomically.

Nothing here holds a database transaction across a model call. A failure marks
the attempt failed and leaves the project's previous ready revision current.
Every write carries the attempt's lease: a worker whose attempt expired and was
requeued for another worker stops at its next write.
"""

from __future__ import annotations

import time
import asyncio
import logging
from typing import Any, Callable, Awaitable
from collections import Counter
from dataclasses import field, dataclass

from dembrane.map import recipe
from dembrane.embedding import EmbeddingIdentity
from dembrane.map.store import ACTIVE_STATUSES, MapStore, SqlMapStore, MapStoreError, lease_of

logger = logging.getLogger("dembrane.map.generate")

EXTRACTION_CONCURRENCY = 6
EMBEDDING_CONCURRENCY = 8
# Embedding progress reaches the page at most this often; extraction progress
# is saved on every finished conversation because it is also the resume point.
PROGRESS_INTERVAL_SECONDS = 1.5
# Between the windows of a long conversation the attempt is kept alive at most
# this often, far inside the API's stale limit, so a worker still reading is
# never expired for looking quiet.
WINDOW_HEARTBEAT_SECONDS = 60.0


class GenerationStopped(Exception):
    """The attempt stopped being ours (expired, failed or requeued elsewhere)."""


class ExtractionFailed(RuntimeError):
    def __init__(self, failed: int, total: int) -> None:
        super().__init__(f"reading {failed} of {total} conversations failed")
        self.failed = failed
        self.total = total


@dataclass
class GenerationDeps:
    """The outside world, injectable for tests."""

    transcripts: Callable[[str], Awaitable[list[recipe.Transcript]]]
    probe: Callable[[], Awaitable[EmbeddingIdentity]]
    extract: Callable[..., Awaitable[tuple[dict[str, Any], dict[str, int]]]]
    embed: Callable[[str], Awaitable[list[float]]]
    publish: Callable[[str, dict[str, Any]], Awaitable[None]]
    clock: Callable[[], float] = field(default=time.monotonic)


def default_deps() -> GenerationDeps:
    from dembrane.map import model
    from dembrane.embedding import embed_text, probe_embedding_identity
    from dembrane.map.events import publish_map_event
    from dembrane.map.transcripts import load_transcripts

    async def probe() -> EmbeddingIdentity:
        return await asyncio.to_thread(probe_embedding_identity)

    async def embed(text: str) -> list[float]:
        return await asyncio.to_thread(embed_text, text)

    return GenerationDeps(
        transcripts=load_transcripts,
        probe=probe,
        extract=model.extract_arguments,
        embed=embed,
        publish=publish_map_event,
    )


Extract = Callable[..., Awaitable[tuple[dict[str, Any], dict[str, int]]]]


async def read_conversation(
    transcript: recipe.Transcript,
    extract: Extract,
    *,
    between_windows: Callable[[], Awaitable[None]] | None = None,
) -> list[tuple[dict[str, Any], dict[str, int]]]:
    """One extraction call per window of a conversation, in order: each raw
    answer with its token usage, before grounding. `between_windows` is
    awaited after every window but the last (a long conversation's keepalive).
    Shared with the `arguments` recipe, which saves these answers as its
    extraction artifact and grounds them in a step of their own."""
    windows = recipe.transcript_windows(transcript.text)
    answers: list[tuple[dict[str, Any], dict[str, int]]] = []
    for index, window in enumerate(windows):
        answers.append(
            await extract(
                conversation_id=transcript.id,
                window=window,
                window_index=index,
                window_count=len(windows),
            )
        )
        if between_windows is not None and index < len(windows) - 1:
            await between_windows()
    return answers


def _leaf_exceptions(exc: BaseException) -> list[BaseException]:
    if isinstance(exc, BaseExceptionGroup):
        return [leaf for inner in exc.exceptions for leaf in _leaf_exceptions(inner)]
    return [exc]


def failure_message(exc: BaseException) -> str:
    """What the page may show about a failed attempt: plain, no content."""
    if isinstance(exc, ExtractionFailed):
        return f"Reading {exc.failed} of {exc.total} conversations failed."
    if isinstance(exc, recipe.InvalidVector):
        return "The embedding service returned an unusable vector."
    if isinstance(exc, MapStoreError):
        return "Saving the map failed."
    return "Generating the map failed."


async def run_generation(
    result_id: str,
    *,
    store: MapStore | None = None,
    deps: GenerationDeps | None = None,
) -> str:
    """Run one attempt. Returns ready, superseded, failed, stopped or skipped."""
    store = store or SqlMapStore()
    deps = deps or default_deps()
    row = await store.get_result(result_id)
    if not row or row["status"] not in ACTIVE_STATUSES:
        logger.info("map generation %s skipped: not active", result_id)
        return "skipped"
    project_id = row["project_id"]
    lease = lease_of(row)
    try:
        return await _generate(row, store, deps)
    except Exception as raised:
        # Extraction and embedding run in TaskGroups, which wrap what a task
        # raised in an ExceptionGroup: judge the attempt by what was inside.
        leaves = _leaf_exceptions(raised)
        if any(isinstance(leaf, GenerationStopped) for leaf in leaves):
            logger.info("map generation %s stopped: no longer active", result_id)
            return "stopped"
        exc = leaves[0]
        stopped = False
        try:
            stopped = not await store.fail(result_id, failure_message(exc), lease=lease)
        except MapStoreError:
            logger.exception("map generation %s: could not record the failure", result_id)
        if stopped:
            # Expired or requeued for another worker meanwhile: not ours to fail.
            logger.info("map generation %s stopped: no longer active", result_id)
            return "stopped"
        # Only messages this package wrote are logged: a provider's error can
        # quote its input, and that input is participant-derived text.
        detail = (
            str(exc)[:500]
            if isinstance(exc, (ExtractionFailed, recipe.InvalidVector, MapStoreError))
            else "(detail withheld)"
        )
        logger.error(
            "map generation %s for project %s failed: %s: %s",
            result_id,
            project_id,
            type(exc).__name__,
            detail,
        )
        await deps.publish(project_id, {"type": "failed", "result_id": result_id})
        return "failed"


async def _generate(row: dict[str, Any], store: MapStore, deps: GenerationDeps) -> str:
    result_id = row["id"]
    project_id = row["project_id"]
    lease = lease_of(row)
    started = deps.clock()
    saved = dict(row.get("progress") or {})

    transcripts = await deps.transcripts(project_id)
    by_id = {t.id: t for t in transcripts}
    fingerprint = recipe.source_fingerprint(transcripts)
    identity = await deps.probe()
    config = identity.as_config()

    extractions: dict[str, dict[str, Any]] = {
        cid: entry
        for cid, entry in (saved.get("extractions") or {}).items()
        if cid in by_id and isinstance(entry, dict) and entry.get("text_hash") == by_id[cid].text_hash
    }
    resumed = len(extractions)
    failed: dict[str, str] = {}
    usage: Counter[str] = Counter()
    for entry in extractions.values():
        usage.update(entry.get("usage") or {})
    counts = {"embeddings_total": 0, "embeddings_done": 0, "embeddings_reused": 0}
    lock = asyncio.Lock()
    last_progress = 0.0

    def progress_doc(stage: str) -> dict[str, Any]:
        return {
            "stage": stage,
            "conversations_total": len(transcripts),
            "conversations_done": len(extractions),
            "conversations_failed": len(failed),
            "conversations_resumed": resumed,
            **counts,
            "extractions": extractions,
        }

    async def save(
        stage: str, *, force: bool = True, interval: float = PROGRESS_INTERVAL_SECONDS
    ) -> None:
        nonlocal last_progress
        now = deps.clock()
        if not force and now - last_progress < interval:
            return
        last_progress = now
        doc = progress_doc(stage)
        if not await store.heartbeat(
            result_id,
            lease=lease,
            status=stage,
            progress=doc,
            source_fingerprint=fingerprint,
            embedding_config=config,
        ):
            raise GenerationStopped()
        await deps.publish(
            project_id,
            {
                "type": "progress",
                "result_id": result_id,
                **{k: v for k, v in doc.items() if k != "extractions"},
            },
        )

    # ── extraction ──────────────────────────────────────────────────────
    await save("extracting")
    semaphore = asyncio.Semaphore(EXTRACTION_CONCURRENCY)

    async def keep_alive() -> None:
        async with lock:
            await save("extracting", force=False, interval=WINDOW_HEARTBEAT_SECONDS)

    async def extract_one(transcript: recipe.Transcript) -> None:
        async with semaphore:
            try:
                answers = await read_conversation(
                    transcript, deps.extract, between_windows=keep_alive
                )
                shaped: list[list[dict[str, Any]]] = []
                dropped = 0
                conversation_usage: Counter[str] = Counter()
                for index, (raw, used) in enumerate(answers):
                    candidates, lost = recipe.shape_extraction(raw, transcript, window_index=index)
                    shaped.append(candidates)
                    dropped += lost
                    conversation_usage.update(used)
            except (GenerationStopped, MapStoreError):
                raise
            except Exception as exc:
                failed[transcript.id] = type(exc).__name__
                logger.warning(
                    "map generation %s: conversation %s failed: %s",
                    result_id,
                    transcript.id,
                    type(exc).__name__,
                )
                return
        entry = {
            "text_hash": transcript.text_hash,
            "windows": len(answers),
            "dropped": dropped,
            "usage": dict(conversation_usage),
            "candidates": recipe.merge_conversation_candidates(shaped),
        }
        async with lock:
            extractions[transcript.id] = entry
            usage.update(conversation_usage)
            await save("extracting")

    pending = [t for t in transcripts if t.id not in extractions]
    async with asyncio.TaskGroup() as group:
        for transcript in pending:
            group.create_task(extract_one(transcript))
    if failed:
        raise ExtractionFailed(len(failed), len(transcripts))

    ranks = {t.id: index for index, t in enumerate(transcripts)}
    candidates: list[dict[str, Any]] = []
    for transcript in transcripts:
        for candidate in extractions[transcript.id]["candidates"]:
            candidates.append({**candidate, "conversation_rank": ranks[transcript.id]})

    # ── embeddings ──────────────────────────────────────────────────────
    texts = {recipe.input_hash(c["statement"]): recipe.embedding_input(c["statement"]) for c in candidates}
    hashes = sorted(texts)
    stored = await store.load_embeddings(project_id, identity.key, hashes)
    vectors: dict[str, list[float]] = {}
    embedding_ids: dict[str, str] = {}
    for hashed, (embedding_id, vector) in stored.items():
        vectors[hashed] = recipe.validate_vector(vector, identity.dims)
        embedding_ids[hashed] = embedding_id
    counts["embeddings_total"] = len(hashes)
    counts["embeddings_reused"] = len(stored)
    counts["embeddings_done"] = len(stored)
    await save("embedding")

    embed_semaphore = asyncio.Semaphore(EMBEDDING_CONCURRENCY)

    async def embed_one(hashed: str) -> None:
        async with embed_semaphore:
            vector = recipe.validate_vector(await deps.embed(texts[hashed]), identity.dims)
            # Another worker may have saved this input first: what comes back
            # is the stored row, the vector the manifest will reference.
            embedding_id, stored_vector = await store.save_embedding(
                project_id=project_id,
                input_hash=hashed,
                config_key=identity.key,
                model=identity.model,
                dims=identity.dims,
                vector=vector,
            )
        async with lock:
            vectors[hashed] = recipe.validate_vector(stored_vector, identity.dims)
            embedding_ids[hashed] = embedding_id
            counts["embeddings_done"] += 1
            await save("embedding", force=False)

    missing = [hashed for hashed in hashes if hashed not in stored]
    async with asyncio.TaskGroup() as group:
        for hashed in missing:
            group.create_task(embed_one(hashed))

    # ── consolidation and publish ───────────────────────────────────────
    threshold = recipe.merge_threshold_for(identity.model)
    groups = recipe.consolidate(candidates, vectors, threshold)
    referenced = sorted(
        {embedding_ids[recipe.input_hash(recipe.representative(g)["statement"])] for g in groups}
    )
    durable = await store.vectors_by_ids(project_id, referenced)
    if len(durable) != len(referenced):
        raise MapStoreError(
            f"{len(referenced) - len(durable)} embeddings are missing after saving"
        )

    elapsed = round(deps.clock() - started, 1)
    stats = {
        "conversations": len(transcripts),
        "conversations_resumed": resumed,
        "candidates": len(candidates),
        "dropped_ungrounded": sum(int(e.get("dropped") or 0) for e in extractions.values()),
        "arguments": len(groups),
        "claims": sum(1 for g in groups if recipe.representative(g)["kind"] == "claim"),
        "merged": len(candidates) - len(groups),
        "embeddings_new": len(missing),
        "embeddings_reused": len(stored),
        "usage": dict(usage),
        "seconds": elapsed,
    }
    manifest = recipe.build_manifest(
        groups,
        transcripts,
        embedding_ids,
        stats=stats,
        consolidation={
            "embedding_model": identity.model,
            "embedding_threshold": threshold,
            "rule": "same kind and valence; identical statements or complete linkage",
        },
    )
    outcome = await store.publish(
        result_id,
        manifest,
        {k: v for k, v in progress_doc("ready").items() if k != "extractions"},
        lease=lease,
    )
    if outcome == "inactive":
        raise GenerationStopped()
    logger.info(
        "map generation %s for project %s %s: %d conversations (%d resumed), "
        "%d candidates, %d arguments, %d embedded, %d reused, config %s (%s, %d dims), "
        "usage %s, %.1fs",
        result_id,
        project_id,
        outcome,
        len(transcripts),
        resumed,
        len(candidates),
        len(groups),
        len(missing),
        len(stored),
        identity.key[:12],
        identity.model,
        identity.dims,
        dict(usage),
        elapsed,
    )
    await deps.publish(project_id, {"type": outcome, "result_id": result_id})
    return outcome
