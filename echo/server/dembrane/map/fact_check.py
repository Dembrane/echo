"""Fact-checks for Map claims.

One state per claim revision (statement plus evidence) per project, shared by
every renderer and panel. The API moves a claim to processing and dispatches a
worker; the worker investigates with search grounding and writes the verdict
only if its attempt is still the current one, so a cancelled or superseded
check that finishes late changes nothing. An execution failure is an error
state, never an `unknown` verdict.

A check names its claim by a v1 result and node id, or by a map snapshot and
the exact revision id it displays. `map_fact_check` stays the operational
current state. A completed check of a snapshot revision is also recorded as a
`fact_check_assessment` revision with an `assesses` relation to that exact
revision, through the analysis executor (`ASSESSMENT_RECIPE_ID`, a
deterministic record of the answer the worker already has, never a second
model call), and the map view advances to a successor snapshot; the snapshot
the check was started from keeps resolving the assessment it pinned.
"""

from __future__ import annotations

import re
import logging
from typing import Any, Callable, Awaitable
from dataclasses import replace, dataclass

from pydantic import Field, BaseModel, ConfigDict

from dembrane.map.store import MapStore, SqlMapStore
from dembrane.map.recipe import normalize_text
from dembrane.analysis.types import AssessmentSource
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.executor import (
    RunRequest,
    StepResult,
    ExecutorDeps,
    RecipeFailed,
    RecipeContext,
    default_deps,
    default_store,
    execute_inline,
)
from dembrane.analysis.map_view import (
    MapViewReads,
    claim_of,
    default_reads,
    is_v2_manifest,
    advance_map_view,
    snapshot_revision,
)
from dembrane.analysis.registry import Recipe, StepDef, register_recipe
from dembrane.analysis.contracts import (
    Run,
    RunMode,
    StepKind,
    CheckStatus,
    CheckOutcome,
    AnalysisStore,
    ObjectRevision,
)

logger = logging.getLogger("dembrane.map.fact_check")

# A check still processing after this long is treated as abandoned (its worker
# died), and a new request may start it again.
STALE_SECONDS = 15 * 60
# A worker holds its attempt against a second delivery of the same message for
# a little longer than the actor may run (task_map_fact_check's time limit is
# ten minutes), so a duplicate never pays for a second search.
ACQUIRE_SECONDS = 11 * 60

ASSESSMENT_RECIPE_ID = "map.fact_check_assessment"
ASSESSMENT_RECIPE_VERSION = "fact-check-assessment-v1"


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def fact_check_state(row: dict[str, Any] | None) -> dict[str, Any]:
    """The prototype's FactCheckState shape, from a stored row."""
    if not row:
        return {"status": "idle"}
    status = row.get("status")
    if status == "processing":
        return {"status": "processing", "startedAt": _iso(row.get("started_at"))}
    if status == "done":
        return {
            "status": "done",
            "verdict": row.get("verdict") or "unknown",
            "justification": row.get("justification") or "",
            "sources": row.get("sources") or [],
            "checkedAt": _iso(row.get("completed_at")),
        }
    if status == "error":
        return {
            "status": "error",
            "message": row.get("error") or "The fact-check failed.",
            "at": _iso(row.get("completed_at") or row.get("updated_at")),
        }
    return {"status": "idle"}


def assessment_state(assessment: ObjectRevision) -> dict[str, Any]:
    """A pinned assessment revision in the FactCheckState shape."""
    payload = assessment.payload
    return {
        "status": "done",
        "verdict": payload.get("verdict") or "unknown",
        "justification": payload.get("justification") or "",
        "sources": payload.get("sources") or [],
        "checkedAt": _iso(assessment.published_at or assessment.created_at),
        "assessmentRevisionId": assessment.id,
    }


def find_argument(manifest: dict[str, Any] | None, node_id: str) -> dict[str, Any] | None:
    for argument in (manifest or {}).get("arguments") or []:
        if argument.get("id") == node_id:
            return argument
    return None


# ── recording a completed check as an assessment revision ───────────────


class AssessmentParameters(BaseModel):
    """What the fact-check worker found, recorded as it was answered."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    statement: str = Field(min_length=1)
    claimKey: str = Field(min_length=1)
    verdict: str = Field(min_length=1)
    justification: str = ""
    sources: list[AssessmentSource] = Field(default_factory=list)
    model: str | None = None
    promptVersion: str | None = None


async def _record_assessment(ctx: RecipeContext) -> None:
    (claim,) = await ctx.input_revisions()
    parameters = dict(ctx.parameters)

    async def statement_matches() -> StepResult:
        found = claim_of(claim)
        matches = (
            found is not None
            and normalize_text(found[0]) == normalize_text(parameters["statement"])
            and found[2] == parameters["claimKey"]
        )
        return StepResult(
            output={"matches": matches},
            validation=(
                CheckOutcome(
                    check="statement-matches",
                    status=CheckStatus.PASSED if matches else CheckStatus.FAILED,
                    evidence={"revisionId": claim.id, "claimKey": parameters["claimKey"]},
                ),
            ),
        )

    checked = await ctx.step(
        "statement-matches", statement_matches, inputs={"revision": claim.id, "claimKey": parameters["claimKey"]}
    )
    if not checked["matches"]:
        raise RecipeFailed("The claim changed before its check was recorded.")

    async def record() -> StepResult:
        return StepResult(output={k: parameters[k] for k in ("verdict", "justification", "sources")})

    await ctx.step("record", record, inputs={"revision": claim.id, "answer": content_hash(parameters)})
    assessment = await ctx.emit(
        "fact_check_assessment",
        claim.id,
        {
            "verdict": parameters["verdict"],
            "justification": parameters["justification"],
            "sources": parameters["sources"],
            "statement": parameters["statement"],
            "claimKey": parameters["claimKey"],
            "model": parameters.get("model"),
            "promptVersion": parameters.get("promptVersion"),
        },
        input_revision_ids=[claim.id],
    )
    await ctx.relate("assesses", assessment, claim, basis="extracted")


ASSESSMENT_RECIPE = Recipe(
    id=ASSESSMENT_RECIPE_ID,
    version=ASSESSMENT_RECIPE_VERSION,
    name="Fact-check assessment",
    purpose="Records a completed fact-check of one exact claim revision as an assessment of it.",
    input_types=("argument", "deduplicated_argument"),
    steps=(
        StepDef("statement-matches", "1", StepKind.CHECK, "The checked statement and evidence are this revision's", check_version="1"),
        StepDef("record", "1", StepKind.DETERMINISTIC, "Record the answer the fact-check worker saved"),
    ),
    output_types=("fact_check_assessment",),
    execute=_record_assessment,
    parameters_model=AssessmentParameters,
    scope_key_pattern=re.compile(r"^revision:[0-9a-f-]{36}$"),
)


def ensure_assessment_recipe() -> Recipe:
    return register_recipe(ASSESSMENT_RECIPE, replace=True)


ensure_assessment_recipe()


async def record_assessment(
    project_id: str,
    revision_id: str,
    check: dict[str, Any],
    *,
    store: AnalysisStore,
    deps: ExecutorDeps,
) -> tuple[Run, str | None]:
    """Record one completed check of one revision. Returns the run and the
    publication event id (None when an identical record was reused). A repeated
    call for the same attempt returns the same run."""
    ensure_assessment_recipe()
    published: list[str] = []
    forward = deps.enqueue_outbox

    def enqueue(event_id: str) -> None:
        published.append(event_id)
        if forward is not None:
            forward(event_id)

    outcome = await execute_inline(
        RunRequest(
            project_id=project_id,
            recipe_id=ASSESSMENT_RECIPE_ID,
            scope_key=f"revision:{revision_id}",
            mode=RunMode.REFRESH,
            parameters={
                "statement": check["statement"],
                "claimKey": check["claim_key"],
                "verdict": check["verdict"],
                "justification": check.get("justification") or "",
                "sources": check.get("sources") or [],
                "model": check.get("model"),
                "promptVersion": check.get("prompt_version"),
            },
            selected_revision_ids=(revision_id,),
            idempotency_key=f"map-fact-check:{check['id']}:{check['attempt']}",
            requested_by=check.get("requested_by"),
        ),
        store=store,
        deps=replace(deps, enqueue_outbox=enqueue),
    )
    return outcome.run, (published[0] if published else None)


# ── the worker ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CheckedClaim:
    statement: str
    quotes: list[str]
    claim_key: str
    # The exact revision, when the check was started from a snapshot.
    revision: ObjectRevision | None = None


async def _project_context(project_id: str) -> tuple[str, str]:
    from dembrane.directus_async import async_directus

    project = await async_directus.get_item("project", project_id) or {}
    return str(project.get("name") or ""), str(project.get("context") or "")


async def acquire_attempt(fact_check_id: str, attempt: int, redis: Any | None = None) -> bool:
    """Take one attempt for this worker. False when another delivery of the
    same message already took it. When Redis cannot answer, the check runs: the
    attempt guard on the verdict still keeps a single result."""
    key = f"map:fact_check:{fact_check_id}:{attempt}:worker"
    try:
        if redis is None:
            from dembrane.redis_async import get_redis_client

            redis = await get_redis_client()
        return bool(await redis.set(key, "1", nx=True, ex=ACQUIRE_SECONDS))
    except Exception as exc:
        logger.warning(
            "map fact-check %s attempt %s: could not acquire it (%s), running anyway",
            fact_check_id,
            attempt,
            type(exc).__name__,
        )
        return True


async def mark_interrupted(
    fact_check_id: str, attempt: int, *, store: MapStore | None = None
) -> bool:
    """A worker that lost its check (the loop was reset, the time limit hit)
    leaves an error for this attempt instead of a check stuck processing."""
    store = store or SqlMapStore()
    return await store.fail_fact_check(
        fact_check_id, attempt, "The fact-check was interrupted. Try again."
    )


async def _claim_to_check(
    project_id: str,
    result_id: str,
    node_id: str,
    *,
    store: MapStore,
    analysis_store: Callable[[], AnalysisStore],
) -> CheckedClaim | None:
    """The claim a job names: a node of a v1 result, or a revision displayed
    by a map snapshot (named directly or through its v2 result)."""
    result = await store.get_result(result_id)
    if result is not None and not is_v2_manifest(result.get("manifest")):
        argument = find_argument(result.get("manifest"), node_id)
        if result["project_id"] != project_id or not argument or not argument.get("claim_key"):
            return None
        quotes = [q for item in argument.get("evidence") or [] for q in item.get("quotes") or []]
        return CheckedClaim(argument["statement"], quotes, argument["claim_key"])
    if result is not None and result["project_id"] != project_id:
        return None
    snapshot_id = str(result["manifest"]["snapshotId"]) if result is not None else result_id
    analysis = analysis_store()
    snapshot = await analysis.get_snapshot(snapshot_id)
    if snapshot is None or snapshot.project_id != project_id:
        return None
    revision = await snapshot_revision(snapshot, node_id, store=analysis)
    claim = claim_of(revision) if revision is not None else None
    if revision is None or claim is None:
        return None
    return CheckedClaim(claim[0], claim[1], claim[2], revision)


async def run_fact_check(
    fact_check_id: str,
    attempt: int,
    result_id: str,
    node_id: str,
    *,
    store: MapStore | None = None,
    check: Callable[..., Awaitable[dict[str, Any]]] | None = None,
    project_context: Callable[[str], Awaitable[tuple[str, str]]] | None = None,
    publish: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None,
    redis: Any | None = None,
    analysis_store: AnalysisStore | None = None,
    reads: MapViewReads | None = None,
    executor_deps: ExecutorDeps | None = None,
) -> str:
    """Run one attempt. Returns done, error or stale."""
    from dembrane.map import model
    from dembrane.map.events import publish_map_event

    store = store or SqlMapStore()
    check = check or model.factcheck_claim
    project_context = project_context or _project_context
    publish = publish or publish_map_event
    analysis: AnalysisStore | None = analysis_store

    def _analysis() -> AnalysisStore:
        nonlocal analysis
        analysis = analysis or default_store()
        return analysis

    row = await store.get_fact_check(fact_check_id)
    if not row or row["status"] != "processing" or int(row["attempt"]) != int(attempt):
        return "stale"
    project_id = row["project_id"]
    claim = await _claim_to_check(project_id, result_id, node_id, store=store, analysis_store=_analysis)
    if claim is None or claim.claim_key != row["claim_key"]:
        written = await store.fail_fact_check(
            fact_check_id, attempt, "The claim is no longer part of this map."
        )
        return "error" if written else "stale"

    if not await acquire_attempt(fact_check_id, attempt, redis):
        logger.info("map fact-check %s attempt %s is already running", fact_check_id, attempt)
        return "stale"

    event = {"type": "fact_check", "claim_key": row["claim_key"]}
    try:
        name, context = await project_context(project_id)
        outcome = await check(
            statement=claim.statement,
            evidence=claim.quotes,
            project_name=name,
            project_context=context,
        )
    except Exception as exc:
        logger.warning(
            "map fact-check %s attempt %s failed: %s", fact_check_id, attempt, type(exc).__name__
        )
        written = await store.fail_fact_check(
            fact_check_id, attempt, "The fact-check could not finish. Try again."
        )
        if written:
            await publish(project_id, event)
        return "error" if written else "stale"

    written = await store.complete_fact_check(
        fact_check_id,
        attempt,
        verdict=outcome["verdict"],
        justification=outcome["justification"],
        sources=outcome.get("sources") or [],
        model=model.model_identity(),
        prompt_version=model.FACTCHECK_PROMPT_VERSION,
    )
    if not written:
        logger.info("map fact-check %s attempt %s finished after it was superseded", fact_check_id, attempt)
        return "stale"
    if claim.revision is not None:
        completed = await store.get_fact_check(fact_check_id)
        await _record(
            project_id,
            claim.revision,
            completed or {},
            store=_analysis(),
            reads=reads or default_reads(),
            deps=executor_deps or default_deps(),
            publish=publish,
        )
    await publish(project_id, event)
    logger.info(
        "map fact-check %s attempt %s: %s with %d sources",
        fact_check_id,
        attempt,
        outcome["verdict"],
        len(outcome.get("sources") or []),
    )
    return "done"


async def _record(
    project_id: str,
    revision: ObjectRevision,
    completed: dict[str, Any],
    *,
    store: AnalysisStore,
    reads: MapViewReads,
    deps: ExecutorDeps,
    publish: Callable[[str, dict[str, Any]], Awaitable[None]],
) -> None:
    """The verdict is saved already; recording it as a revision and advancing
    the map view are retried by nothing here, so a failure is logged and the
    check still counts as done. The map view catches up on its next read."""
    if completed.get("status") != "done":
        return
    try:
        run, event_id = await record_assessment(project_id, revision.id, completed, store=store, deps=deps)
        if event_id is not None:
            await advance_map_view(project_id, store=store, reads=reads, source_event_id=event_id, publish=publish)
        logger.info("map fact-check of revision %s recorded by analysis run %s (%s)", revision.id, run.id, run.status)
    except Exception as exc:  # noqa: BLE001
        logger.warning("map fact-check of revision %s not recorded as an assessment: %s", revision.id, type(exc).__name__)
