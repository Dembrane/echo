"""Map as the API uses it: page state, generation requests, titles, fact-checks.

Every function here assumes the caller already checked access to the project
the row belongs to.

Results come in two versions. A v1 `map_result` row owns its manifest. A v2 row
points at a map view snapshot (`dembrane.analysis.map_view`), and a snapshot id
is a result id of its own: titles and fact-checks of a snapshot name exact
revision ids instead of node ids. Once the arguments recipe is registered, a
generation request is a run of it through the analysis executor; until then it
is a v1 attempt, and a v1 attempt still running is always returned first.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any, Callable, Awaitable
from datetime import datetime, timezone
from collections import defaultdict
from dataclasses import dataclass

from dembrane.map import recipe
from dembrane.map.store import ACTIVE_STATUSES, MapStore, ActiveAttemptExists, lease_of
from dembrane.map.events import publish_map_event
from dembrane.map.fact_check import (
    STALE_SECONDS as FACT_CHECK_STALE_SECONDS,
    assessment_state,
    fact_check_state,
)
from dembrane.analysis.executor import RunRequest, ExecutorDeps, request_run
from dembrane.analysis.map_view import (
    MAP_VIEW_ID,
    ARGUMENT_TYPES,
    LEGACY_VIEW_ID,
    VIEW_SCOPE_KEY,
    ARGUMENTS_RECIPE_ID,
    MapViewReads,
    claim_of,
    label_of,
    is_v2_manifest,
    snapshot_revision,
)
from dembrane.analysis.registry import UnknownRecipe, get_recipe
from dembrane.analysis.contracts import (
    Run,
    RunMode,
    Snapshot,
    RunStatus,
    ScopeKind,
    AnalysisStore,
    ObjectRevision,
    AnalysisStoreError,
)

logger = logging.getLogger("dembrane.map.service")

# An attempt whose worker has not written progress for this long is dead.
STALE_ATTEMPT_SECONDS = 20 * 60
TITLE_CACHE_SECONDS = 7 * 24 * 3600
TITLE_LOCK_SECONDS = 90
TITLE_WAIT_SECONDS = 60.0

Dispatch = Callable[..., str]

PROGRESS_KEYS = (
    "stage",
    "conversations_total",
    "conversations_done",
    "conversations_failed",
    "conversations_resumed",
    "embeddings_total",
    "embeddings_done",
    "embeddings_reused",
)


class NotReady(Exception):
    """The result is not a ready revision."""


class UnknownArguments(ValueError):
    pass


class NotAClaim(ValueError):
    pass


@dataclass(frozen=True)
class MapAnalysis:
    """The analysis side Map uses once generation runs through the executor."""

    store: AnalysisStore
    reads: MapViewReads
    deps: ExecutorDeps | None = None


@dataclass(frozen=True)
class SnapshotTarget:
    """A map snapshot addressed as a result: by its id, or through its v2 row."""

    snapshot: Snapshot
    result_id: str | None = None

    @property
    def project_id(self) -> str:
        return self.snapshot.project_id


def default_map_analysis() -> MapAnalysis:
    from dembrane.analysis.store import SqlAnalysisStore
    from dembrane.analysis.map_view import SqlMapViewReads

    return MapAnalysis(store=SqlAnalysisStore(), reads=SqlMapViewReads())


def generation_recipe_available() -> bool:
    """Whether map generation runs through the analysis executor."""
    try:
        get_recipe(ARGUMENTS_RECIPE_ID)
    except UnknownRecipe:
        return False
    return True


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _utc(value: Any) -> datetime | None:
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def attempt_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    progress = row.get("progress") or {}
    return {
        "id": row["id"],
        "status": row["status"],
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
        "completed_at": _iso(row.get("completed_at")),
        "error": row.get("error"),
        "progress": {key: progress.get(key) for key in PROGRESS_KEYS if key in progress},
    }


def run_attempt(run: Run | None) -> dict[str, Any] | None:
    """An arguments run as the attempt the page shows: queued, extracting,
    embedding or failed. A ready, superseded or cancelled run is no attempt."""
    if run is None:
        return None
    stage = str(run.progress.get("stage") or "")
    if run.status in (RunStatus.QUEUED, RunStatus.WAITING_FOR_INPUTS):
        status = "queued"
    elif run.status == RunStatus.RUNNING:
        status = stage if stage in ("extracting", "embedding") else "extracting"
    elif run.status == RunStatus.FAILED:
        status = "failed"
    else:
        return None
    return {
        "id": run.id,
        "status": status,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
        "completed_at": run.completed_at,
        "error": run.error,
        "progress": {**{k: v for k, v in run.progress.items() if k in PROGRESS_KEYS}, "stage": stage or status},
    }


async def result_payload(row: dict[str, Any], store: MapStore) -> dict[str, Any]:
    """A ready revision with every argument, its evidence and its vector."""
    manifest = row.get("manifest") or {}
    arguments = manifest.get("arguments") or []
    vectors = await store.vectors_by_ids(
        row["project_id"], [a["embedding_id"] for a in arguments if a.get("embedding_id")]
    )
    shaped = []
    missing = []
    for argument in arguments:
        vector = vectors.get(argument.get("embedding_id") or "")
        if vector is None:
            missing.append(argument["id"])
        shaped.append(
            {
                "id": argument["id"],
                "statement": argument["statement"],
                "kind": argument["kind"],
                "valence": argument["valence"],
                "claim_key": argument.get("claim_key"),
                "evidence": argument.get("evidence") or [],
                "created_at": argument.get("created_at"),
                "embedding": [round(value, 6) for value in vector] if vector is not None else None,
            }
        )
    config = row.get("embedding_config") or {}
    return {
        "id": row["id"],
        "status": row["status"],
        "created_at": _iso(row.get("created_at")),
        "completed_at": _iso(row.get("completed_at")),
        "recipe_version": row.get("recipe_version"),
        "source_fingerprint": row.get("source_fingerprint"),
        "embedding": {
            "model": config.get("model"),
            "dims": config.get("dims"),
            "key": config.get("key"),
        },
        "stats": manifest.get("stats") or {},
        "conversations": manifest.get("conversations") or [],
        "arguments": shaped,
        "missing_embeddings": missing,
    }


async def snapshot_result_payload(row: dict[str, Any], analysis: MapAnalysis) -> dict[str, Any]:
    """A v2 row in the v1 result shape, for a reader of the project state that
    predates the v2 payload: the snapshot's deduplicated arguments when it
    shows any, else its arguments, with evidence and vectors."""
    from dembrane.analysis.map_view import load_vectors

    snapshot = await analysis.store.get_snapshot(str(row["manifest"]["snapshotId"]))
    objects = (snapshot.manifest.get("objects") or []) if snapshot else []
    kind = "deduplicated_argument" if any(o["type"] == "deduplicated_argument" for o in objects) else "argument"
    ids = [str(o["revisionId"]) for o in objects if o["type"] == kind]
    revisions = await analysis.store.get_revisions(row["project_id"], ids) if snapshot else {}
    config = (snapshot.embedding_config if snapshot else None) or {}
    vectors = await load_vectors(row["project_id"], revisions.values(), config, store=analysis.store)
    shaped = []
    for revision_id in ids:
        revision = revisions.get(revision_id)
        if revision is None:
            continue
        payload = revision.payload
        claim = claim_of(revision)
        vector = vectors.get(revision_id)
        shaped.append(
            {
                "id": revision_id,
                "statement": payload["statement"],
                "kind": payload["epistemicKind"],
                "valence": payload.get("valence"),
                "claim_key": claim[2] if claim else None,
                "evidence": [
                    {
                        "conversation_id": item.get("conversationId"),
                        "label": item.get("label") or "",
                        "created_at": item.get("createdAt"),
                        "quotes": item.get("quotes") or [],
                    }
                    for item in payload.get("evidence") or []
                ],
                "created_at": max((str(e["createdAt"]) for e in payload.get("evidence") or [] if e.get("createdAt")), default=None),
                "embedding": [round(value, 6) for value in vector] if vector is not None else None,
            }
        )
    return {
        "id": row["id"],
        "status": row["status"],
        "created_at": _iso(row.get("created_at")),
        "completed_at": _iso(row.get("completed_at")),
        "recipe_version": row.get("recipe_version"),
        "source_fingerprint": row.get("source_fingerprint"),
        "embedding": {"model": config.get("model"), "dims": config.get("dims"), "key": config.get("key")},
        "stats": {"arguments": len(shaped)},
        "conversations": [],
        "arguments": shaped,
        "missing_embeddings": [a["id"] for a in shaped if a["embedding"] is None],
        "snapshot_id": snapshot.id if snapshot else None,
    }


async def _arguments_run(project_id: str, analysis: MapAnalysis) -> Run | None:
    scope = await analysis.store.find_scope(
        project_id=project_id, kind=ScopeKind.PRODUCER, owner_id=ARGUMENTS_RECIPE_ID, scope_key=VIEW_SCOPE_KEY
    )
    if scope is None:
        return None
    return await analysis.store.latest_run(
        scope.id, (RunStatus.QUEUED, RunStatus.WAITING_FOR_INPUTS, RunStatus.RUNNING, RunStatus.FAILED)
    )


async def project_rows(
    project_id: str, store: MapStore, analysis: MapAnalysis | None = None
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """The current ready revision, and an attempt newer than it (running or
    failed): a v1 attempt, or with `analysis` the latest arguments run."""
    await store.expire_stale(project_id, STALE_ATTEMPT_SECONDS)
    current = await store.latest_ready(project_id)
    latest = await store.latest_attempt(project_id)
    attempt = None
    if (
        latest
        and latest["status"] in (*ACTIVE_STATUSES, "failed")
        and (not current or latest["created_at"] > current["created_at"])
    ):
        attempt = latest
    if analysis is not None and not (attempt and attempt["status"] in ACTIVE_STATUSES):
        try:
            run = run_attempt(await _arguments_run(project_id, analysis))
        except AnalysisStoreError as exc:
            # The attempt is a hint beside the saved map, like the source count.
            logger.warning("map attempt lookup failed for project %s: %s", project_id, exc)
            run = None
        newer = run is not None and (
            not current or (_utc(run["created_at"]) or datetime.min.replace(tzinfo=timezone.utc)) > (_utc(current["created_at"]) or datetime.min.replace(tzinfo=timezone.utc))
        )
        if run is not None and newer and (attempt is None or run["status"] != "failed"):
            attempt = run
    return current, attempt


async def state_payload(
    current: dict[str, Any] | None,
    attempt: dict[str, Any] | None,
    store: MapStore,
    analysis: MapAnalysis | None = None,
    *,
    metadata_only: bool = False,
) -> dict[str, Any]:
    shaped: dict[str, Any] | None
    if current is not None and metadata_only:
        manifest = current.get("manifest") or {}
        config = current.get("embedding_config") or {}
        shaped = {
            "id": current["id"],
            "status": current["status"],
            "created_at": _iso(current.get("created_at")),
            "completed_at": _iso(current.get("completed_at")),
            "recipe_version": current.get("recipe_version"),
            "source_fingerprint": current.get("source_fingerprint"),
            "snapshot_id": manifest.get("snapshotId"),
            "metadata_only": True,
            "embedding": {"model": config.get("model"), "dims": config.get("dims"), "key": config.get("key")},
            "stats": manifest.get("stats") or {},
            "conversations": [],
            "arguments": [],
            "missing_embeddings": [],
        }
    elif current is not None and is_v2_manifest(current.get("manifest")) and analysis is not None:
        shaped = await snapshot_result_payload(current, analysis)
    else:
        shaped = await result_payload(current, store) if current else None
    return {"current": shaped, "attempt": attempt_payload(attempt)}


async def project_state(project_id: str, store: MapStore) -> dict[str, Any]:
    current, attempt = await project_rows(project_id, store)
    return await state_payload(current, attempt, store)


def state_etag(
    current: dict[str, Any] | None,
    attempt: dict[str, Any] | None,
    conversations_with_transcripts: int | None,
) -> str:
    """Names everything the project map response is built from. A ready revision
    never changes, so its id and completion time stand for its arguments and
    vectors; an attempt changes as it moves."""
    parts = [
        str(recipe.MANIFEST_VERSION),
        f"{(current or {}).get('id')}:{_iso((current or {}).get('completed_at'))}",
        f"{(attempt or {}).get('id')}:{(attempt or {}).get('status')}:"
        f"{_iso((attempt or {}).get('updated_at'))}",
        str(conversations_with_transcripts),
    ]
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:24]
    return f'W/"map-{digest}"'


def dispatch_generation(result_id: str) -> str:
    from dembrane.tasks import task_map_generate

    return task_map_generate.send(result_id).message_id


def dispatch_fact_check(fact_check_id: str, attempt: int, result_id: str, node_id: str) -> str:
    from dembrane.tasks import task_map_fact_check

    return task_map_fact_check.send(fact_check_id, attempt, result_id, node_id).message_id


async def request_generation(
    project_id: str,
    requested_by: str | None,
    *,
    store: MapStore,
    dispatch: Dispatch | None = None,
    analysis: MapAnalysis | None = None,
) -> dict[str, Any] | None:
    """Start a generation, or return the one already running.

    A v1 attempt still running is returned first: the executor never starts a
    competing arguments run next to it. Once the arguments recipe is registered
    a generation is a refresh of it through the executor (None when its ready
    output already answers the current transcripts), unless the caller hands
    in a v1 `dispatch`, which asks for a v1 attempt. A v1 attempt resumes a
    failed latest attempt of the same recipe: its saved extractions and every
    stored vector are reused. At most one attempt runs per project."""
    await store.expire_stale(project_id, STALE_ATTEMPT_SECONDS)
    active = await store.active_attempt(project_id)
    if active:
        return active
    if analysis is None and dispatch is None and generation_recipe_available():
        analysis = default_map_analysis()
    if analysis is not None:
        outcome = await request_run(
            RunRequest(
                project_id=project_id,
                recipe_id=ARGUMENTS_RECIPE_ID,
                scope_key=VIEW_SCOPE_KEY,
                mode=RunMode.REFRESH,
                requested_by=requested_by,
            ),
            store=analysis.store,
            deps=analysis.deps,
        )
        await publish_map_event(project_id, {"type": "queued", "run_id": outcome.run.id, "outcome": outcome.outcome})
        return run_attempt(outcome.run)
    row: dict[str, Any] | None = None
    latest = await store.latest_attempt(project_id)
    try:
        if (
            latest
            and latest["status"] == "failed"
            and latest.get("recipe_version") == recipe.RECIPE_VERSION
        ):
            row = await store.requeue(latest["id"])
        if row is None:
            row = await store.create_attempt(
                project_id=project_id,
                recipe_version=recipe.RECIPE_VERSION,
                requested_by=requested_by,
            )
    except ActiveAttemptExists as exc:
        return exc.row or await store.active_attempt(project_id) or {}
    try:
        # Looked up at call time, so tests can patch the module-level dispatcher.
        await store.set_execution_ref(row["id"], (dispatch or dispatch_generation)(row["id"]))
    except Exception as exc:
        logger.error("map generation %s could not be dispatched: %s", row["id"], exc)
        await store.fail(row["id"], "The generation could not be started.", lease=lease_of(row))
        raise
    await publish_map_event(project_id, {"type": "queued", "result_id": row["id"]})
    return row


async def resolve_target(
    result_id: str, *, store: MapStore, analysis_store: AnalysisStore
) -> dict[str, Any] | SnapshotTarget | None:
    """What a result id names: a v1 row, or a map snapshot (by its v2 row or
    by the snapshot id itself). None when it names nothing."""
    row = await store.get_result(result_id)
    if row is not None:
        manifest = row.get("manifest")
        if not isinstance(manifest, dict) or not is_v2_manifest(manifest):
            return row
        snapshot = await analysis_store.get_snapshot(str(manifest["snapshotId"]))
        if snapshot is None or snapshot.project_id != row["project_id"]:
            return None
        return SnapshotTarget(snapshot, row["id"])
    snapshot = await analysis_store.get_snapshot(result_id)
    if snapshot is None or snapshot.view_id not in (MAP_VIEW_ID, LEGACY_VIEW_ID):
        return None
    return SnapshotTarget(snapshot)


def _ready(row: dict[str, Any]) -> dict[str, Any]:
    if row.get("status") != "ready":
        raise NotReady()
    return row.get("manifest") or {}


# ── selection titles ────────────────────────────────────────────────────


async def _title_once(
    redis: Any, key: str, produce: Callable[[], Awaitable[str]]
) -> dict[str, Any]:
    """One title per cache key, generated once: a concurrent identical request
    waits for the first one's answer."""
    cached = await redis.get(key)
    if cached:
        return {"title": cached.decode() if isinstance(cached, bytes) else str(cached), "cached": True}

    lock_key = f"{key}:lock"
    owns_lock = bool(await redis.set(lock_key, "1", nx=True, ex=TITLE_LOCK_SECONDS))
    if not owns_lock:
        # Another request is generating this exact title: wait for its answer.
        waited = 0.0
        while waited < TITLE_WAIT_SECONDS:
            await asyncio.sleep(0.5)
            waited += 0.5
            cached = await redis.get(key)
            if cached:
                text = cached.decode() if isinstance(cached, bytes) else str(cached)
                return {"title": text, "cached": True}
            if not await redis.exists(lock_key):
                break
    try:
        title = await produce()
        await redis.set(key, title, ex=TITLE_CACHE_SECONDS)
        return {"title": title, "cached": False}
    finally:
        if owns_lock:
            await redis.delete(lock_key)


async def selection_title(
    row: dict[str, Any],
    node_ids: list[str],
    *,
    project_name: str,
    project_context: str,
    store: MapStore,
    redis: Any,
    generate: Callable[..., Awaitable[str]] | None = None,
) -> dict[str, Any]:
    """One title per (revision, selection, its claims' verdicts, prompt and
    model), generated once.

    The whole selection goes to the model or the request is refused: a
    selection too large for the prompt is an error, never a partial summary."""
    from dembrane.map.model import TITLE_PROMPT, model_identity, title_selection

    manifest = _ready(row)
    by_id = {a["id"]: a for a in manifest.get("arguments") or []}
    ordered_ids = list(dict.fromkeys(node_ids))
    unknown = [node_id for node_id in ordered_ids if node_id not in by_id]
    if unknown:
        raise UnknownArguments(f"{len(unknown)} selected arguments are not in this map")
    selected = [by_id[node_id] for node_id in ordered_ids]
    claim_keys = [a["claim_key"] for a in selected if a.get("claim_key")]
    checks = await store.fact_checks_for(row["project_id"], claim_keys)
    verdicts = {
        key: check.get("verdict") for key, check in checks.items() if check.get("status") == "done"
    }
    lines = recipe.title_lines(selected, verdicts)

    # A finished verdict changes the lines the model reads, so it keys the title too.
    verdict_state = ",".join(f"{key}={verdicts[key] or 'unverified'}" for key in sorted(verdicts))
    config = f"{TITLE_PROMPT}|{model_identity()}|{verdict_state}"
    key = "map:title:" + recipe.title_selection_key(row["id"], ordered_ids, config)
    return await _title_once(
        redis,
        key,
        lambda: (generate or title_selection)(lines=lines, project_name=project_name, project_context=project_context),
    )


RELATION_PHRASES = {
    "supports_pole_a": "supports pole A of",
    "supports_pole_b": "supports pole B of",
    "holds_position": "holds the position in",
    "affected_by": "is affected by",
    "stakeholder_relation": "is related to",
    "derived_from": "is derived from",
}


def _title_text(revision: ObjectRevision) -> str:
    payload = revision.payload
    if revision.type == "tension":
        return f"{payload['poleA']} / {payload['poleB']}: {payload['knot']}"
    if revision.type == "stakeholder":
        return f"{payload['name']} ({payload['role']}): {payload['stake']}"
    return label_of(revision)


def typed_title_lines(
    revisions: list[ObjectRevision],
    verdicts: dict[str, str | None],
    relations: list[dict[str, Any]],
) -> list[str]:
    """One tagged line per selected revision, in the order given: its type (a
    claim with its pinned verdict), and every explicit relation inside the
    selection by line number, so a tension and the arguments that support it
    read as connected rather than as independent corroboration."""
    numbers = {revision.id: index for index, revision in enumerate(revisions, start=1)}
    notes: dict[str, list[str]] = defaultdict(list)
    for relation in relations:
        start, end = str(relation["from"]), str(relation["to"])
        if start in numbers and end in numbers:
            phrase = RELATION_PHRASES.get(str(relation["type"]), str(relation["type"]).replace("_", " "))
            notes[start].append(f"{phrase} {numbers[end]}")
    lines = []
    for index, revision in enumerate(revisions, start=1):
        prefix = "deduplicated " if revision.type == "deduplicated_argument" else ""
        if claim_of(revision) is not None:
            tag = [f"{prefix}claim", verdicts.get(revision.id) or "unverified"]
        elif revision.type in ARGUMENT_TYPES:
            tag = [f"{prefix}argument"]
        else:
            tag = [revision.type.replace("_", " ")]
        lines.append(f"{index}. [{', '.join([*tag, *notes.get(revision.id, [])])}] {_title_text(revision)}")
    total = sum(len(line) + 1 for line in lines)
    if len(lines) < recipe.MIN_TITLE_NODES:
        raise recipe.SelectionTooSmall(f"a title needs at least {recipe.MIN_TITLE_NODES} objects")
    if total > recipe.MAX_TITLE_CHARS:
        raise recipe.SelectionTooLarge(f"the selection is {total} characters; the limit is {recipe.MAX_TITLE_CHARS}")
    return lines


async def snapshot_selection_title(
    target: SnapshotTarget,
    revision_ids: list[str],
    *,
    project_name: str,
    project_context: str,
    analysis_store: AnalysisStore,
    redis: Any,
    generate: Callable[..., Awaitable[str]] | None = None,
) -> dict[str, Any]:
    """A title for revisions the snapshot displays, resolved on the server from
    what it pins. Cached by snapshot, the selected revisions, prompt, model and
    the assessment revisions it pins for them."""
    from dembrane.map.model import TITLE_PROMPT, model_identity, title_selection

    snapshot = target.snapshot
    manifest = snapshot.manifest
    ordered = list(dict.fromkeys(revision_ids))
    displayed = {str(o["revisionId"]) for o in manifest.get("objects") or []}
    unknown = [rid for rid in ordered if rid not in displayed]
    if unknown:
        raise UnknownArguments(f"{len(unknown)} selected objects are not in this map")
    revisions = await analysis_store.get_revisions(snapshot.project_id, ordered)
    if len(revisions) != len(ordered):
        raise UnknownArguments(f"{len(ordered) - len(revisions)} selected objects are no longer available")
    selected = set(ordered)
    pinned = {str(a["targetRevisionId"]): str(a["revisionId"]) for a in manifest.get("assessments") or [] if str(a["targetRevisionId"]) in selected}
    assessments = await analysis_store.get_revisions(snapshot.project_id, sorted(pinned.values())) if pinned else {}
    verdicts = {target_id: assessments[aid].payload.get("verdict") for target_id, aid in pinned.items() if aid in assessments}
    relations = [r for r in manifest.get("relations") or [] if str(r["from"]) in selected and str(r["to"]) in selected]
    lines = typed_title_lines([revisions[rid] for rid in ordered], verdicts, relations)
    config = f"{TITLE_PROMPT}|{model_identity()}|{','.join(sorted(pinned.values()))}"
    key = "map:title:v2:" + recipe.title_selection_key(snapshot.id, ordered, config)
    return await _title_once(
        redis,
        key,
        lambda: (generate or title_selection)(lines=lines, project_name=project_name, project_context=project_context),
    )


# ── fact-checks ─────────────────────────────────────────────────────────


async def fact_check_states(row: dict[str, Any], store: MapStore) -> dict[str, dict[str, Any]]:
    manifest = _ready(row)
    claims = [a for a in manifest.get("arguments") or [] if a.get("claim_key")]
    stored = await store.fact_checks_for(row["project_id"], [a["claim_key"] for a in claims])
    return {a["id"]: fact_check_state(stored.get(a["claim_key"])) for a in claims}


async def snapshot_fact_check_states(
    target: SnapshotTarget, *, store: MapStore, analysis_store: AnalysisStore
) -> dict[str, dict[str, Any]]:
    """States by revision id for the claims a snapshot displays. The operational
    state shows a check in progress; otherwise the assessment the snapshot pins
    wins, so a shared snapshot keeps its original verdict after a re-check."""
    snapshot = target.snapshot
    manifest = snapshot.manifest
    ids = [str(o["revisionId"]) for o in manifest.get("objects") or [] if o.get("type") in ARGUMENT_TYPES]
    revisions = await analysis_store.get_revisions(snapshot.project_id, ids) if ids else {}
    claims = {rid: claim for rid in ids if rid in revisions and (claim := claim_of(revisions[rid])) is not None}
    operational = await store.fact_checks_for(snapshot.project_id, sorted({c[2] for c in claims.values()}))
    pinned = {str(a["targetRevisionId"]): str(a["revisionId"]) for a in manifest.get("assessments") or []}
    wanted = sorted({pinned[rid] for rid in claims if rid in pinned})
    assessments = await analysis_store.get_revisions(snapshot.project_id, wanted) if wanted else {}
    out: dict[str, dict[str, Any]] = {}
    for revision_id, claim in claims.items():
        state = fact_check_state(operational.get(claim[2]))
        assessment = assessments.get(pinned.get(revision_id, ""))
        if assessment is not None and state["status"] != "processing":
            state = assessment_state(assessment)
        out[revision_id] = state
    return out


def _claim(row: dict[str, Any], node_id: str) -> dict[str, Any]:
    manifest = _ready(row)
    for argument in manifest.get("arguments") or []:
        if argument.get("id") == node_id:
            if argument.get("kind") != "claim" or not argument.get("claim_key"):
                raise NotAClaim("only claims are fact-checked")
            return argument
    raise UnknownArguments("the argument is not in this map")


async def _snapshot_claim(
    target: SnapshotTarget, revision_id: str, analysis_store: AnalysisStore
) -> tuple[str, list[str], str]:
    revision = await snapshot_revision(target.snapshot, revision_id, store=analysis_store)
    if revision is None:
        raise UnknownArguments("the object is not in this map")
    claim = claim_of(revision)
    if claim is None:
        raise NotAClaim("only claims are fact-checked")
    return claim


async def _start(
    project_id: str,
    claim_key: str,
    statement: str,
    job: tuple[str, str],
    *,
    requested_by: str | None,
    force: bool,
    store: MapStore,
    dispatch: Dispatch | None,
) -> dict[str, Any]:
    check, should_dispatch = await store.start_fact_check(
        project_id=project_id,
        claim_key=claim_key,
        statement=statement,
        requested_by=requested_by,
        force=force,
        stale_seconds=FACT_CHECK_STALE_SECONDS,
    )
    if should_dispatch:
        try:
            (dispatch or dispatch_fact_check)(check["id"], int(check["attempt"]), *job)
        except Exception as exc:
            logger.error("map fact-check %s could not be dispatched: %s", check["id"], exc)
            await store.fail_fact_check(
                check["id"], int(check["attempt"]), "The fact-check could not be started."
            )
            raise
        await publish_map_event(project_id, {"type": "fact_check", "claim_key": claim_key})
    return fact_check_state(check)


async def start_fact_check(
    row: dict[str, Any],
    node_id: str,
    *,
    requested_by: str | None,
    force: bool,
    store: MapStore,
    dispatch: Dispatch | None = None,
) -> dict[str, Any]:
    """Start (or join) the check of one claim revision.

    Both renderers and the panel share one state: a second request for a claim
    that is already processing returns that state and dispatches nothing."""
    argument = _claim(row, node_id)
    return await _start(
        row["project_id"],
        argument["claim_key"],
        argument["statement"],
        (row["id"], node_id),
        requested_by=requested_by,
        force=force,
        store=store,
        dispatch=dispatch,
    )


async def start_snapshot_fact_check(
    target: SnapshotTarget,
    revision_id: str,
    *,
    requested_by: str | None,
    force: bool,
    store: MapStore,
    analysis_store: AnalysisStore,
    dispatch: Dispatch | None = None,
) -> dict[str, Any]:
    """Start (or join) the check of one revision a snapshot displays. The worker
    is sent the snapshot and revision ids."""
    statement, _quotes, key = await _snapshot_claim(target, revision_id, analysis_store)
    return await _start(
        target.project_id,
        key,
        statement,
        (target.snapshot.id, revision_id),
        requested_by=requested_by,
        force=force,
        store=store,
        dispatch=dispatch,
    )


async def cancel_fact_check(row: dict[str, Any], node_id: str, *, store: MapStore) -> dict[str, Any]:
    argument = _claim(row, node_id)
    check = await store.cancel_fact_check(row["project_id"], argument["claim_key"])
    await publish_map_event(
        row["project_id"], {"type": "fact_check", "claim_key": argument["claim_key"]}
    )
    return fact_check_state(check)


async def cancel_snapshot_fact_check(
    target: SnapshotTarget, revision_id: str, *, store: MapStore, analysis_store: AnalysisStore
) -> dict[str, Any]:
    _statement, _quotes, key = await _snapshot_claim(target, revision_id, analysis_store)
    check = await store.cancel_fact_check(target.project_id, key)
    await publish_map_event(target.project_id, {"type": "fact_check", "claim_key": key})
    return fact_check_state(check)
