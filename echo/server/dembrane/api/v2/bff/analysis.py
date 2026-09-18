"""BFF endpoints for analysis recipes, runs and objects.

The same services the Map page and the popcorn tick use, exposed for a Recipes
tab and for contextual generate actions. Reading a run, an object or its
history needs project and conversation read access (payloads and step outcomes
carry transcript-derived text); requesting or cancelling a run writes shared
state and needs `project:update`. Run- and snapshot-scoped routes resolve the
row to its project before any access check, so an id from another project is
a 404.
"""

from __future__ import annotations

import uuid
import logging
from typing import Any, Literal

from fastapi import Query, Depends, APIRouter, HTTPException, status
from pydantic import Field, BaseModel

from dembrane.analysis import store as analysis_store
from dembrane.analysis.store import SqlAnalysisStore
from dembrane.api.rate_limit import RedisUserRateLimiter
from dembrane.map.fact_check import ASSESSMENT_RECIPE_ID
from dembrane.analysis.executor import (
    RunRequest,
    ExecutorDeps,
    cancel_run,
    request_run,
    default_deps,
)
from dembrane.analysis.map_view import (
    MAP_TYPES,
    MapViewReads,
    SqlMapViewReads,
    UnknownResultScope,
    label_of,
    pinned_lineage,
    project_detail,
    provenance_doc,
    scope_object_ids,
    current_map_snapshot,
)
from dembrane.analysis.registry import recipes_metadata
from dembrane.api.feature_flags import require_present_enabled
from dembrane.analysis.contracts import (
    Run,
    Step,
    AnalysisStore,
    ObjectRevision,
    RevisionConflict,
    AnalysisStoreError,
    ReferenceViolation,
    AnalysisValidationError,
)
from dembrane.analysis.revisions import RevisionService
from dembrane.api.v2.bff._access import ResourceAccess, resolve_project_access
from dembrane.api.dependency_auth import DependencyDirectusSession

logger = logging.getLogger("api.v2.bff.analysis")

router = APIRouter()

# As many runs as Map generations: every run can start model calls.
_run_limiter = RedisUserRateLimiter(key="analysis_run", capacity=10, window_seconds=600)

# Recipes that run only from their own feature: a fact-check assessment records
# what a fact-check worker found and must never be requested with a verdict.
INTERNAL_RECIPES = frozenset({ASSESSMENT_RECIPE_ID})
# Client idempotency keys live apart from the keys the platform makes itself.
CLIENT_KEY_PREFIX = "client:"
MAX_PAGE = 200
EDITABLE_TYPES = frozenset({"argument", "popcorn", "stakeholder", "tension"})


def get_store() -> AnalysisStore:
    return SqlAnalysisStore()


def get_reads() -> MapViewReads:
    return SqlMapViewReads()


def get_executor_deps() -> ExecutorDeps:
    return default_deps()


def _unavailable() -> HTTPException:
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Analysis storage is unavailable.")


def _not_found(what: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except ValueError:
        return False


async def _readable(project_id: str, auth: DependencyDirectusSession) -> ResourceAccess:
    access = await resolve_project_access(project_id, auth)
    access.require("project:read")
    access.require("conversation:read")
    return access


def _iso(value: Any) -> str | None:
    return value.isoformat() if hasattr(value, "isoformat") else value


def step_doc(step: Step) -> dict[str, Any]:
    return {
        "id": step.id,
        "key": step.step_key,
        "version": step.step_version,
        "kind": str(step.kind),
        "status": str(step.status),
        "attempt": step.attempt,
        "reusedStepId": step.reused_step_id,
        "validation": step.validation,
        "usage": step.usage,
        "error": step.error,
        "createdAt": _iso(step.created_at),
        "completedAt": _iso(step.completed_at),
    }


def _manifest_summary(manifest: dict[str, Any] | None) -> dict[str, Any] | None:
    if not manifest:
        return None
    return {
        "objects": len(manifest.get("objects") or []),
        "relations": len(manifest.get("relations") or []),
        "contentHash": manifest.get("contentHash"),
        "publicationSequence": manifest.get("publicationSequence"),
    }


def run_doc(run: Run, steps: list[Step] | None = None) -> dict[str, Any]:
    progress = {k: v for k, v in run.progress.items() if k != "candidateManifest"}
    inputs = run.input_manifest or {}
    doc: dict[str, Any] = {
        "id": run.id,
        "projectId": run.project_id,
        "scopeId": run.scope_id,
        "recipeId": run.recipe_id,
        "recipeVersion": run.recipe_version,
        # The immutable step and check definitions this run was made with.
        "definition": run.definition,
        "mode": str(run.mode),
        "epoch": run.epoch,
        "status": str(run.status),
        "requestOrder": run.request_order,
        "progress": progress,
        "checks": run.checks,
        "metrics": run.metrics,
        "error": run.error,
        "parameters": run.parameters,
        "inputs": {
            "fingerprint": run.input_fingerprint,
            "selectedRevisionIds": inputs.get("selectedRevisionIds") or [],
            "revisions": len(inputs.get("revisionIds") or []),
            "dependencies": inputs.get("dependencies") or {},
        },
        "dependsOn": run.depends_on,
        "output": _manifest_summary(run.output_manifest),
        "candidate": _manifest_summary(run.progress.get("candidateManifest")),
        "reusedRunId": run.reused_run_id,
        "attempt": run.attempt,
        "createdAt": _iso(run.created_at),
        "updatedAt": _iso(run.updated_at),
        "startedAt": _iso(run.started_at),
        "completedAt": _iso(run.completed_at),
    }
    if steps is not None:
        doc["steps"] = [step_doc(step) for step in steps]
    return doc


def revision_doc(revision: ObjectRevision) -> dict[str, Any]:
    return {
        **revision.envelope(),
        "revisionNumber": revision.revision_number,
        "status": str(revision.status),
        "reason": revision.reason,
        "publishedAt": _iso(revision.published_at),
        "membershipExcluded": bool(
            revision.provenance.extra.get("membershipExcluded")
        ),
    }


# ── recipes ─────────────────────────────────────────────────────────────


@router.get("/recipes")
async def list_recipes(auth: DependencyDirectusSession) -> dict[str, Any]:  # noqa: ARG001
    """Every recipe a project can run: ordered steps, output schemas and checks."""
    return {"recipes": [r for r in recipes_metadata() if r["id"] not in INTERNAL_RECIPES]}


# ── runs ────────────────────────────────────────────────────────────────


class RunCreate(BaseModel):
    recipe_id: str = Field(min_length=1, max_length=200)
    scope_key: str = Field(default="project", min_length=1, max_length=200)
    parameters: dict[str, Any] = Field(default_factory=dict)
    selected_revision_ids: list[str] = Field(default_factory=list, max_length=5000)
    mode: Literal["refresh", "regenerate", "retry"] = "refresh"
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=200)
    refresh_dependencies: bool = False
    retry_run_id: str | None = None


class RevisionEdit(BaseModel):
    expected_revision_id: str
    payload: dict[str, Any]
    reason: str | None = Field(default=None, max_length=1000)


class RevisionRollback(BaseModel):
    expected_revision_id: str
    to_revision_id: str
    reason: str | None = Field(default=None, max_length=1000)


class MembershipDecision(BaseModel):
    expected_revision_id: str
    excluded: bool
    reason: str | None = Field(default=None, max_length=1000)


@router.post("/projects/{project_id}/runs", status_code=status.HTTP_202_ACCEPTED)
async def request_analysis_run(project_id: str, body: RunCreate, auth: DependencyDirectusSession) -> dict[str, Any]:
    access = await _readable(project_id, auth)
    access.require("project:update")
    if body.recipe_id in INTERNAL_RECIPES:
        raise HTTPException(status_code=422, detail="This recipe runs only from its own feature.")
    await _run_limiter.check(auth.user_id)
    try:
        outcome = await request_run(
            RunRequest(
                project_id=project_id,
                recipe_id=body.recipe_id,
                scope_key=body.scope_key,
                mode=body.mode,
                parameters=body.parameters,
                selected_revision_ids=tuple(body.selected_revision_ids),
                idempotency_key=f"{CLIENT_KEY_PREFIX}{body.idempotency_key}" if body.idempotency_key else None,
                requested_by=auth.user_id,
                refresh_dependencies=body.refresh_dependencies,
                retry_run_id=body.retry_run_id,
            ),
            store=get_store(),
            deps=get_executor_deps(),
        )
    except AnalysisValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    return {
        "run": run_doc(outcome.run),
        "outcome": outcome.outcome,
        "dependencies": [run_doc(run) for run in outcome.dependencies],
    }


async def _run(run_id: str, auth: DependencyDirectusSession) -> tuple[Run, ResourceAccess]:
    if not _is_uuid(run_id):
        raise _not_found("Run")
    try:
        run = await get_store().get_run(run_id)
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    if run is None:
        raise _not_found("Run")
    return run, await _readable(run.project_id, auth)


@router.get("/runs/{run_id}")
async def get_analysis_run(run_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    """A run with its steps, check outcomes, version references, usage and progress."""
    run, _access = await _run(run_id, auth)
    try:
        steps = await get_store().get_steps(run.id)
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    return {"run": run_doc(run, steps)}


async def _project_runs(
    store: AnalysisStore, project_id: str, *, offset: int, limit: int
) -> tuple[list[Run], int]:
    """Bounded project history without widening the shared store contract yet.

    The in-memory store branch keeps the API unit-testable. Production uses
    the SQL store's existing cursor and row mapper; this stays local to the
    BFF until run-history reads are needed by another service.
    """
    in_memory = getattr(store, "runs", None)
    if isinstance(in_memory, dict):
        rows = [run for run in in_memory.values() if run.project_id == project_id]
        rows.sort(key=lambda run: (str(run.created_at or ""), run.id), reverse=True)
        return rows[offset : offset + limit], len(rows)
    if not isinstance(store, SqlAnalysisStore):
        raise AnalysisStoreError("run history is unavailable")
    async with store._cursor() as cursor:  # noqa: SLF001 - local BFF read adapter
        await cursor.execute(
            "SELECT COUNT(*) AS total FROM analysis_run WHERE project_id = %s",
            (project_id,),
        )
        count = await cursor.fetchone()
        await cursor.execute(
            f"""SELECT {analysis_store.RUN_COLUMNS} FROM analysis_run
                WHERE project_id = %s
                ORDER BY created_at DESC, id DESC
                OFFSET %s LIMIT %s""",
            (project_id, offset, limit),
        )
        rows = await cursor.fetchall()
    return [analysis_store._run(row) for row in rows], int((count or {}).get("total", 0))


@router.get("/projects/{project_id}/runs")
async def list_analysis_runs(
    project_id: str,
    auth: DependencyDirectusSession,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=MAX_PAGE),
) -> dict[str, Any]:
    """Newest-first processing history for one readable project."""
    access = await _readable(project_id, auth)
    try:
        store = get_store()
        runs, total = await _project_runs(store, project_id, offset=offset, limit=limit)
        scopes = {
            run.scope_id: await store.get_scope(run.scope_id)
            for run in runs
        }
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "canRun": access.allows("project:update"),
        "runs": [
            {
                **run_doc(run),
                "scopeKey": scopes[run.scope_id].scope_key
                if scopes.get(run.scope_id)
                else None,
            }
            for run in runs
        ],
    }


@router.post("/runs/{run_id}/cancel")
async def cancel_analysis_run(run_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    run, access = await _run(run_id, auth)
    access.require("project:update")
    try:
        cancelled = await cancel_run(run.id, store=get_store(), deps=get_executor_deps())
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    return {"run": run_doc(cancelled or run)}


# ── objects ─────────────────────────────────────────────────────────────


@router.get("/projects/{project_id}/objects")
async def list_analysis_objects(
    project_id: str,
    auth: DependencyDirectusSession,
    type: str | None = Query(default=None),  # noqa: A002
    scope: str | None = Query(default=None),
    snapshot_id: str | None = Query(default=None),
    membership: Literal["active", "withdrawn", "all"] = Query(default="active"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=MAX_PAGE),
) -> dict[str, Any]:
    """One page of the objects a map snapshot pins (the current one unless
    `snapshot_id` names another), with counts per type: the list an over-budget
    scope shows instead of a graph. No vectors."""
    access = await _readable(project_id, auth)
    if type is not None and type not in MAP_TYPES:
        raise HTTPException(status_code=422, detail=f"unknown object type {type!r}")
    store = get_store()
    try:
        if snapshot_id:
            snapshot = await store.get_snapshot(snapshot_id)
            if snapshot is None or snapshot.project_id != project_id:
                raise _not_found("Snapshot")
        else:
            snapshot = await current_map_snapshot(project_id, store=store, reads=get_reads(), follow=False)
        if snapshot is None:
            entries = []
        else:
            entries = [
                o
                for o in snapshot.manifest.get("objects") or []
                if o.get("type") in MAP_TYPES
            ]
        if membership != "active":
            current = await store.current_revisions(project_id)
            withdrawn = [
                {
                    "objectId": revision.object_id,
                    "revisionId": revision.id,
                    "type": revision.type,
                }
                for revision in current.values()
                if revision.type in MAP_TYPES
                and revision.provenance.extra.get("membershipExcluded")
            ]
            if membership == "withdrawn":
                entries = withdrawn
            else:
                active_ids = {str(entry["objectId"]) for entry in entries}
                entries.extend(
                    entry
                    for entry in withdrawn
                    if str(entry["objectId"]) not in active_ids
                )
        if scope and snapshot is not None:
            members = await scope_object_ids(snapshot, scope, store=store)
            entries = [o for o in entries if str(o["objectId"]) in members]
        counts = {t: 0 for t in MAP_TYPES}
        for entry in entries:
            counts[str(entry["type"])] += 1
        if type is not None:
            entries = [o for o in entries if o["type"] == type]
        entries.sort(key=lambda o: (MAP_TYPES.index(str(o["type"])), str(o["objectId"])))
        page = entries[offset : offset + limit]
        revisions = await store.get_revisions(project_id, [str(o["revisionId"]) for o in page])
    except UnknownResultScope as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    items = []
    for entry in page:
        revision = revisions.get(str(entry["revisionId"]))
        if revision is None:
            items.append({"objectId": entry["objectId"], "revisionId": entry["revisionId"], "type": entry["type"], "missing": True})
            continue
        items.append(
            {
                "objectId": revision.object_id,
                "revisionId": revision.id,
                "type": revision.type,
                "label": label_of(revision),
                "payload": revision.payload,
                "membershipExcluded": bool(
                    revision.provenance.extra.get("membershipExcluded")
                ),
                "detail": project_detail(revision),
                "attributes": revision.attributes,
                "provenance": {
                    **provenance_doc(revision),
                    "sourceRefs": [
                        source.as_json() for source in revision.provenance.source_refs
                    ],
                },
            }
        )
    return {
        "snapshotId": snapshot.id if snapshot else None,
        "counts": counts,
        "total": len(entries),
        "offset": offset,
        "limit": limit,
        "canEdit": access.allows("project:update"),
        "items": items,
    }


@router.get("/projects/{project_id}/objects/{object_id}/revisions")
async def get_object_history(project_id: str, object_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    """Every published revision of one object, oldest first."""
    await _readable(project_id, auth)
    store = get_store()
    try:
        record = await store.get_object(object_id) if _is_uuid(object_id) else None
        if record is None or record.project_id != project_id:
            raise _not_found("Object")
        ids = await get_reads().revision_history(project_id, object_id)
        revisions = await store.get_revisions(project_id, ids)
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    return {
        "object": {
            "id": record.id,
            "type": record.type,
            "currentRevisionId": record.current_revision_id,
            "revisionCount": record.revision_count,
        },
        "revisions": [
            revision_doc(revision)
            for rid in ids
            if (revision := revisions.get(rid)) is not None
        ],
    }


async def _editable_object(
    project_id: str, object_id: str, auth: DependencyDirectusSession
) -> tuple[Any, ResourceAccess]:
    access = await _readable(project_id, auth)
    access.require("project:update")
    try:
        record = await get_store().get_object(object_id) if _is_uuid(object_id) else None
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    if record is None or record.project_id != project_id:
        raise _not_found("Object")
    if record.type not in EDITABLE_TYPES:
        raise HTTPException(status_code=422, detail="This result type is read-only.")
    return record, access


def _revision_conflict(exc: RevisionConflict) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "message": "This result changed while you were reviewing it.",
            "objectId": exc.object_id,
            "expectedRevisionId": exc.expected_revision_id,
            "current": revision_doc(exc.current) if exc.current else None,
        },
    )


@router.post(
    "/projects/{project_id}/objects/{object_id}/revisions",
    dependencies=[Depends(require_present_enabled)],
)
async def edit_analysis_object(
    project_id: str,
    object_id: str,
    body: RevisionEdit,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    await _editable_object(project_id, object_id, auth)
    try:
        revision = await RevisionService(get_store()).author_edit(
            project_id=project_id,
            object_id=object_id,
            expected_revision_id=body.expected_revision_id,
            payload=body.payload,
            actor_id=auth.user_id,
            reason=body.reason,
        )
    except RevisionConflict as exc:
        raise _revision_conflict(exc) from exc
    except ReferenceViolation as exc:
        raise _not_found("Revision") from exc
    except AnalysisValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"revision": revision_doc(revision)}


@router.post(
    "/projects/{project_id}/objects/{object_id}/rollback",
    dependencies=[Depends(require_present_enabled)],
)
async def rollback_analysis_object(
    project_id: str,
    object_id: str,
    body: RevisionRollback,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    await _editable_object(project_id, object_id, auth)
    try:
        revision = await RevisionService(get_store()).rollback(
            project_id=project_id,
            object_id=object_id,
            to_revision_id=body.to_revision_id,
            expected_revision_id=body.expected_revision_id,
            actor_id=auth.user_id,
            reason=body.reason,
        )
    except RevisionConflict as exc:
        raise _revision_conflict(exc) from exc
    except ReferenceViolation as exc:
        raise _not_found("Revision") from exc
    except AnalysisValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"revision": revision_doc(revision)}


@router.post(
    "/projects/{project_id}/objects/{object_id}/membership",
    dependencies=[Depends(require_present_enabled)],
)
async def set_analysis_object_membership(
    project_id: str,
    object_id: str,
    body: MembershipDecision,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    await _editable_object(project_id, object_id, auth)
    try:
        revision = await RevisionService(get_store()).set_excluded(
            project_id=project_id,
            object_id=object_id,
            expected_revision_id=body.expected_revision_id,
            excluded=body.excluded,
            actor_id=auth.user_id,
            reason=body.reason,
        )
    except RevisionConflict as exc:
        raise _revision_conflict(exc) from exc
    except ReferenceViolation as exc:
        raise _not_found("Revision") from exc
    except AnalysisValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"revision": revision_doc(revision)}


@router.get("/snapshots/{snapshot_id}/revisions/{revision_id}/lineage")
async def get_pinned_lineage(snapshot_id: str, revision_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    """The exact revisions behind one revision a snapshot pins, as pinned."""
    store = get_store()
    try:
        snapshot = await store.get_snapshot(snapshot_id)
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    if snapshot is None:
        raise _not_found("Snapshot")
    await _readable(snapshot.project_id, auth)
    try:
        lineage = await pinned_lineage(snapshot, revision_id, store=store)
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    if lineage is None:
        raise _not_found("Revision")
    return lineage
