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
from datetime import datetime, timezone
from dataclasses import replace, dataclass

from fastapi import Query, Depends, APIRouter, HTTPException, status
from pydantic import Field, BaseModel

from dembrane.analysis import store as analysis_store, types
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
    ARGUMENT_TYPES,
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
    Origin,
    AnalysisStore,
    ObjectRevision,
    RevisionStatus,
    RevisionConflict,
    AnalysisStoreError,
    ReferenceViolation,
    AnalysisValidationError,
)
from dembrane.analysis.revisions import WORDING_KINDS, RevisionService
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
EDITABLE_TYPES = frozenset(
    {"argument", "deduplicated_argument", "popcorn", "stakeholder", "tension"}
)
# The words of a finding, and nothing else. Evidence, quotes, consolidation and
# the rest of a payload are what the analysis found; a host rewords a finding,
# never its grounds. Enforced here for every client, never by a form alone.
EDITABLE_FIELDS: dict[str, frozenset[str]] = {
    "argument": frozenset({"statement"}),
    "deduplicated_argument": frozenset({"statement"}),
    "popcorn": frozenset({"phrase"}),
    "stakeholder": frozenset({"name", "role", "stake"}),
    "tension": frozenset({"poleA", "poleB", "knot", "toResolve"}),
}


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
        # Null on generated revisions and on everything written before the
        # audit trail asked: the history reads that as "not recorded".
        "changeKind": revision.change_kind,
        "actorId": revision.actor_id,
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
    # A whole payload with the reworded field in it, or a patch of allowlisted
    # fields applied onto the revision the host was reading. Either way only
    # allowlisted fields may end up different.
    payload: dict[str, Any] | None = None
    patch: dict[str, Any] | None = None
    reason: str | None = Field(default=None, max_length=1000)
    change_kind: str | None = Field(default=None, max_length=16)


class RevisionRollback(BaseModel):
    expected_revision_id: str
    to_revision_id: str
    reason: str | None = Field(default=None, max_length=1000)
    change_kind: str | None = Field(default=None, max_length=16)


class MembershipDecision(BaseModel):
    expected_revision_id: str
    excluded: bool
    reason: str | None = Field(default=None, max_length=1000)
    change_kind: str | None = Field(default=None, max_length=16)


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


# ── what needs the host's eye ───────────────────────────────────────────

# One phrase per risen row, in the order the spec names them: what is new,
# then what rests on thin evidence, then a fact-check that disagrees, then a
# rewording by someone else.
ATTENTION_ORDER = ("new", "one_conversation", "one_quote", "fact_check", "reworded")
VERDICTS_THAT_DISAGREE = ("false", "contested")


def _attention_rank(phrase: str | None) -> int:
    """Risen rows first, in the order of their phrases; everything else after,
    in the order it already had."""
    return ATTENTION_ORDER.index(phrase) if phrase in ATTENTION_ORDER else len(ATTENTION_ORDER)


@dataclass(frozen=True)
class AuthoredMark:
    """What one object's history says about hands on it: when it first
    appeared, and the last time a host reworded it."""

    first_at: datetime | None = None
    last_wording_at: datetime | None = None
    last_wording_by: str | None = None
    wording_count: int = 0

    @property
    def edited(self) -> bool:
        return self.wording_count > 0


def _utc(value: Any) -> datetime | None:
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _is_wording(revision: ObjectRevision) -> bool:
    """An authored revision that changed the words.

    A kind says so outright. A revision from before the audit trail says so by
    what it is not: a membership decision records `membershipExcluded`, a
    rollback records `rollbackOf`, and an edit records neither. A legacy edit
    of an already withdrawn finding carries the withdrawal forward and is the
    one case this reads as no edit; nothing written from now on is ambiguous.
    """
    if revision.status != RevisionStatus.PUBLISHED or revision.provenance.origin != Origin.AUTHORED:
        return False
    if revision.change_kind is not None:
        return revision.change_kind in WORDING_KINDS
    extra = revision.provenance.extra or {}
    return bool(extra.get("authoredFrom")) and "rollbackOf" not in extra and "membershipExcluded" not in extra


# The same rule in SQL, over a `json` provenance column.
_WORDING_SQL = """(origin = 'authored' AND (
        change_kind IN ('typo', 'clarity', 'meaning')
        OR (change_kind IS NULL
            AND provenance -> 'extra' ->> 'authoredFrom' IS NOT NULL
            AND provenance -> 'extra' ->> 'rollbackOf' IS NULL
            AND provenance -> 'extra' ->> 'membershipExcluded' IS NULL)))"""


async def _authored_marks(
    store: AnalysisStore, project_id: str, object_ids: list[str]
) -> dict[str, AuthoredMark]:
    """Per object: when it appeared and who last reworded it.

    One read for the whole list, because the attention sort runs before
    pagination. The in-memory branch keeps the BFF unit-testable; production
    groups the revision rows in one statement. Like `_project_runs`, this stays
    a local read adapter until another service needs it.
    """
    wanted = set(object_ids)
    if not wanted:
        return {}
    in_memory = getattr(store, "revisions", None)
    if isinstance(in_memory, dict):
        marks: dict[str, AuthoredMark] = {}
        for revision in in_memory.values():
            if revision.project_id != project_id or revision.object_id not in wanted:
                continue
            if revision.status != RevisionStatus.PUBLISHED:
                continue
            mark = marks.get(revision.object_id, AuthoredMark())
            at = _utc(revision.created_at)
            first = mark.first_at if mark.first_at and at and mark.first_at <= at else at or mark.first_at
            if not _is_wording(revision):
                marks[revision.object_id] = replace(mark, first_at=first)
                continue
            newer = mark.last_wording_at is None or (at is not None and at >= mark.last_wording_at)
            marks[revision.object_id] = AuthoredMark(
                first_at=first,
                last_wording_at=at if newer else mark.last_wording_at,
                last_wording_by=revision.actor_id if newer else mark.last_wording_by,
                wording_count=mark.wording_count + 1,
            )
        return marks
    if not isinstance(store, SqlAnalysisStore):
        raise AnalysisStoreError("object history is unavailable")
    async with store._cursor() as cursor:  # noqa: SLF001 - local BFF read adapter
        await cursor.execute(
            f"""SELECT object_id::text AS object_id,
                       MIN(created_at) AS first_at,
                       MAX(created_at) FILTER (WHERE {_WORDING_SQL}) AS last_wording_at,
                       COUNT(*) FILTER (WHERE {_WORDING_SQL}) AS wording_count,
                       (array_agg(actor_id ORDER BY created_at DESC, revision_number DESC)
                            FILTER (WHERE {_WORDING_SQL}))[1] AS last_wording_by
                FROM analysis_object_revision
                WHERE project_id = %s AND status = 'published'
                  AND object_id = ANY(%s::uuid[])
                GROUP BY object_id""",
            (project_id, sorted(wanted)),
        )
        rows = await cursor.fetchall()
    return {
        str(row["object_id"]): AuthoredMark(
            first_at=_utc(row["first_at"]),
            last_wording_at=_utc(row["last_wording_at"]),
            last_wording_by=row["last_wording_by"],
            wording_count=int(row["wording_count"] or 0),
        )
        for row in rows
    }


def _evidence_counts(revision: ObjectRevision) -> tuple[int, int]:
    """How much a finding rests on: quotes, and the conversations they come
    from. An argument and a phrase carry evidence per conversation; a tension
    and a stakeholder carry quotes that each name their own."""
    payload = revision.payload
    quotes = 0
    conversations: set[str] = set()
    for item in payload.get("evidence") or []:
        if not isinstance(item, dict):
            continue
        quotes += len(item.get("quotes") or [])
        if item.get("conversationId"):
            conversations.add(str(item["conversationId"]))
    for quote in payload.get("quotes") or []:
        if not isinstance(quote, dict):
            continue
        quotes += 1
        if quote.get("conversationId"):
            conversations.add(str(quote["conversationId"]))
    return quotes, len(conversations)


async def _verdicts(
    store: AnalysisStore, project_id: str, revisions: list[ObjectRevision]
) -> dict[str, str]:
    """The latest fact-check verdict per revision, for the revisions that can
    have one. An assessment of superseded wording is not this revision's."""
    ids = [r.id for r in revisions if r.type in ARGUMENT_TYPES]
    if not ids:
        return {}
    assessments = await store.assessments_for(project_id, ids)
    out: dict[str, str] = {}
    for revision_id, assessment in assessments.items():
        verdict = str(assessment.payload.get("verdict") or "")
        if verdict in ("true", "false", "contested", "unknown"):
            out[revision_id] = verdict
    return out


def _attention(
    *,
    revision: ObjectRevision | None,
    mark: AuthoredMark,
    verdict: str | None,
    last_opened: datetime | None,
    viewer: str | None,
) -> tuple[str | None, str | None]:
    if revision is None:
        # A row whose revision the store could not answer for says "missing",
        # and nothing else.
        return None, None
    quotes, conversations = _evidence_counts(revision)
    if last_opened and mark.first_at and mark.first_at > last_opened:
        return "new", None
    if conversations <= 1:
        return "one_conversation", None
    if quotes <= 1:
        return "one_quote", None
    if verdict in VERDICTS_THAT_DISAGREE:
        return "fact_check", None
    if (
        last_opened
        and mark.last_wording_at
        and mark.last_wording_at > last_opened
        and mark.last_wording_by
        and mark.last_wording_by != viewer
    ):
        return "reworded", mark.last_wording_by
    return None, None


# ── objects ─────────────────────────────────────────────────────────────


@router.get("/projects/{project_id}/objects")
async def list_analysis_objects(
    project_id: str,
    auth: DependencyDirectusSession,
    type: str | None = Query(default=None),  # noqa: A002
    scope: str | None = Query(default=None),
    snapshot_id: str | None = Query(default=None),
    membership: Literal["active", "withdrawn", "all"] = Query(default="active"),
    sort: Literal["default", "attention"] = Query(default="default"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=MAX_PAGE),
) -> dict[str, Any]:
    """One page of the objects a map snapshot pins (the current one unless
    `snapshot_id` names another), with counts per type: the list an over-budget
    scope shows instead of a graph. No vectors.

    `sort=attention` raises the rows that need this host's eye, within each
    type and before paging, so the phrase and the page agree. The order is set
    by what the store says now: a row the host deals with loses its phrase on
    the next read, and keeps its place until the list is opened again.
    """
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
        attention: dict[str, tuple[str | None, str | None]] = {}
        if sort == "attention" and entries:
            # Everything the sort reads, for every row, in three reads: the
            # revisions, their histories and their fact-checks.
            revisions = await store.get_revisions(
                project_id, [str(o["revisionId"]) for o in entries]
            )
            marks = await _authored_marks(
                store, project_id, [str(o["objectId"]) for o in entries]
            )
            verdicts = await _verdicts(store, project_id, list(revisions.values()))
            last_opened = await _read_last_opened(store, project_id, auth.user_id)
            for entry in entries:
                revision = revisions.get(str(entry["revisionId"]))
                attention[str(entry["objectId"])] = _attention(
                    revision=revision,
                    mark=marks.get(str(entry["objectId"]), AuthoredMark()),
                    verdict=verdicts.get(str(entry["revisionId"])),
                    last_opened=last_opened,
                    viewer=auth.user_id,
                )
            entries.sort(
                key=lambda o: (
                    MAP_TYPES.index(str(o["type"])),
                    _attention_rank(attention.get(str(o["objectId"]), (None, None))[0]),
                )
            )
            page = entries[offset : offset + limit]
        else:
            page = entries[offset : offset + limit]
            revisions = await store.get_revisions(
                project_id, [str(o["revisionId"]) for o in page]
            )
            marks = await _authored_marks(
                store, project_id, [str(o["objectId"]) for o in page]
            )
            verdicts = await _verdicts(store, project_id, list(revisions.values()))
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
        mark = marks.get(revision.object_id, AuthoredMark())
        quotes, conversations = _evidence_counts(revision)
        phrase, actor = attention.get(str(entry["objectId"]), (None, None))
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
                # What the row says about hands and grounds. `edited` is the
                # public mark's own word: a host changed the words, whatever
                # kind of change they called it.
                "lastAuthoredAt": _iso(mark.last_wording_at),
                "lastAuthoredBy": mark.last_wording_by,
                "edited": mark.edited,
                "quoteCount": quotes,
                "conversationCount": conversations,
                "verdict": verdicts.get(revision.id),
                "attention": phrase,
                "attentionActor": actor,
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


async def _edited_payload(
    project_id: str, record: Any, body: RevisionEdit
) -> dict[str, Any]:
    """The payload this edit writes, with only the words changed.

    The host sends either a patch of allowlisted fields or the whole payload
    with one field reworded; both are measured against the revision they were
    reading, and any other difference is refused by name. Payloads are compared
    as their type normalises them, so trimmed whitespace is not a change.
    """
    allowed = EDITABLE_FIELDS.get(record.type, frozenset())
    if (body.payload is None) == (body.patch is None):
        raise HTTPException(
            status_code=422, detail="Send either the payload or a patch of fields to change."
        )
    try:
        base = (await get_store().get_revisions(project_id, [body.expected_revision_id])).get(
            body.expected_revision_id
        )
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    if base is None or base.object_id != record.id:
        raise _not_found("Revision")
    if body.patch is not None:
        refused = sorted(set(body.patch) - allowed)
        if refused:
            raise HTTPException(
                status_code=422,
                detail=f"{refused[0]} cannot be edited here.",
            )
        return {**base.payload, **body.patch}
    try:
        wanted = types.validate_payload(record.type, body.payload)
    except AnalysisValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    changed = sorted(
        key
        for key in set(wanted) | set(base.payload)
        if wanted.get(key) != base.payload.get(key)
    )
    refused = [key for key in changed if key not in allowed]
    if refused:
        raise HTTPException(status_code=422, detail=f"{refused[0]} cannot be edited here.")
    return wanted


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
    record, _access = await _editable_object(project_id, object_id, auth)
    payload = await _edited_payload(project_id, record, body)
    try:
        revision = await RevisionService(get_store()).author_edit(
            project_id=project_id,
            object_id=object_id,
            expected_revision_id=body.expected_revision_id,
            payload=payload,
            actor_id=auth.user_id,
            reason=body.reason,
            change_kind=body.change_kind,
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
            change_kind=body.change_kind,
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
            change_kind=body.change_kind,
        )
    except RevisionConflict as exc:
        raise _revision_conflict(exc) from exc
    except ReferenceViolation as exc:
        raise _not_found("Revision") from exc
    except AnalysisValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"revision": revision_doc(revision)}


# ── when this host last opened the list ─────────────────────────────────
#
# One row per host per project, in `analysis_last_opened`: the smallest thing
# that can answer "what is new since I last looked". It is the host's own
# state, not the project's, so reading the project is enough to read and write
# it, and a host who has never opened the list has no row: on a first visit
# nothing is new.


async def _read_last_opened(
    store: AnalysisStore, project_id: str, user_id: str | None
) -> datetime | None:
    if not user_id:
        return None
    in_memory = getattr(store, "last_opened", None)
    if isinstance(in_memory, dict):
        return _utc(in_memory.get((project_id, user_id)))
    if not isinstance(store, SqlAnalysisStore):
        raise AnalysisStoreError("last opened is unavailable")
    async with store._cursor() as cursor:  # noqa: SLF001 - local BFF read adapter
        await cursor.execute(
            """SELECT opened_at FROM analysis_last_opened
               WHERE project_id = %s AND user_id = %s""",
            (project_id, user_id),
        )
        row = await cursor.fetchone()
    return _utc((row or {}).get("opened_at"))


async def _write_last_opened(
    store: AnalysisStore, project_id: str, user_id: str, opened_at: datetime
) -> datetime:
    in_memory = getattr(store, "last_opened", None)
    if isinstance(in_memory, dict):
        in_memory[(project_id, user_id)] = opened_at
        return opened_at
    if not isinstance(store, SqlAnalysisStore):
        raise AnalysisStoreError("last opened is unavailable")
    async with store._transaction() as cursor:  # noqa: SLF001 - local BFF write adapter
        await cursor.execute(
            """INSERT INTO analysis_last_opened (id, project_id, user_id, opened_at)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (project_id, user_id)
               DO UPDATE SET opened_at = EXCLUDED.opened_at
               RETURNING opened_at""",
            (str(uuid.uuid4()), project_id, user_id, opened_at),
        )
        row = await cursor.fetchone()
    return _utc((row or {}).get("opened_at")) or opened_at


@router.get("/projects/{project_id}/results/last-opened")
async def get_results_last_opened(
    project_id: str, auth: DependencyDirectusSession
) -> dict[str, Any]:
    """When this host last opened the results list of this project. Null the
    first time, and then nothing is new."""
    await _readable(project_id, auth)
    try:
        opened_at = await _read_last_opened(get_store(), project_id, auth.user_id)
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    return {"openedAt": _iso(opened_at)}


@router.put("/projects/{project_id}/results/last-opened")
async def set_results_last_opened(
    project_id: str, auth: DependencyDirectusSession
) -> dict[str, Any]:
    """Mark the list opened now. The time is the server's: a clock the host
    cannot set decides what counts as new."""
    await _readable(project_id, auth)
    if not auth.user_id:
        raise _not_found("Host")
    try:
        opened_at = await _write_last_opened(
            get_store(), project_id, auth.user_id, datetime.now(timezone.utc)
        )
    except AnalysisStoreError as exc:
        raise _unavailable() from exc
    return {"openedAt": _iso(opened_at)}


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
