"""The one way a recipe runs: request, plan, queue, execute, validate, publish.

Request (`request_run`): the recipe, scope, parameters and selected input
revisions are validated and the dependency plan is built (a cycle is refused
with its path) before anything is written. Dependencies with a ready output are
pinned; a dependency already in flight is shared; a missing one is requested.
A run whose dependencies are not ready waits as `waiting_for_inputs`, holds no
worker, and is rechecked right after it is registered so a dependency that
finished in between still wakes it; the dependency's publication (or the
minute sweep) wakes it otherwise.

Modes:

- refresh: resolve the current inputs; when they match the current ready run
  exactly, record a run that reuses it (made current under the scope lock)
  and start nothing. Otherwise compute, reusing every completed step whose
  cache key still matches.
- regenerate: a new generation epoch, so model steps run again; deterministic
  steps and identical embeddings are still reused.
- retry: the same failed run, queued again with its saved steps and pinned
  inputs; the next worker takes it under a new lease.

The same idempotency key always returns the same run.

Worker (`run_worker`): claims the run under a fresh lease, pins its inputs
once, runs the recipe through a `RecipeContext` whose steps checkpoint the
actual model output and validation outcomes, validates the candidates and
publishes in one transaction (`AnalysisStore.publish_run`) that also appends
the outbox event. Every checkpoint rechecks the lease, its deadline, the
writer fence, cancellation and supersession. No transaction is held across a
model call. A failure leaves the scope's previous ready output, and every
other scope, as it was.
"""

from __future__ import annotations

import time
import uuid
import asyncio
import logging
from typing import Any, Mapping, Callable, Iterable, Awaitable, AsyncIterator
from contextlib import asynccontextmanager
from collections import Counter
from dataclasses import field, replace, dataclass

from dembrane.analysis import types
from dembrane.analysis.hashing import HASH_VERSION, fingerprint, content_hash
from dembrane.analysis.planner import PlanNode, build_plan
from dembrane.analysis.registry import (
    STEP_INSTANCE,
    Recipe,
    StepDef,
    InputRequest,
    PinnedOutput,
    UnknownRecipe,
    InvalidRecipeRequest,
    get_recipe,
)
from dembrane.analysis.contracts import (
    Run,
    Step,
    NewRun,
    Origin,
    RunMode,
    Relation,
    StepKind,
    RunStatus,
    ScopeKind,
    SourceRef,
    StepWrite,
    StepStatus,
    CheckStatus,
    CheckOutcome,
    AnalysisStore,
    ReuseOutdated,
    ObjectRevision,
    RevisionStatus,
    AnalysisStoreError,
    PublicationRejected,
    AnalysisValidationError,
)
from dembrane.analysis.revisions import StagedRevision, RevisionService

logger = logging.getLogger("dembrane.analysis.executor")

# Progress reaches the page at most this often; step completions always save.
PROGRESS_INTERVAL_SECONDS = 1.5
# A worker that finds its recipe at the running limit asks again this much later.
BUSY_RETRY_SECONDS = 30
# During a long step the lease is renewed this often, far inside its deadline.
KEEPALIVE_SECONDS = 60.0
MANIFEST_VERSION = 1
# A run publishes again this many times when hosts keep editing its objects.
PUBLISH_ATTEMPTS = 3


def live_channel(project_id: str) -> str:
    return f"analysis:project:{project_id}"


class RunStopped(Exception):
    """The run stopped being this worker's: cancelled, superseded, expired,
    fenced or retried under another lease."""


class ValidationFailed(Exception):
    def __init__(self, checks: list[CheckOutcome]) -> None:
        failed = [c.check for c in checks if c.status == CheckStatus.FAILED]
        super().__init__(f"checks failed: {', '.join(failed)}")
        self.checks = checks


class RecipeFailed(RuntimeError):
    """A failure whose message was written for the page (no participant text)."""


@dataclass
class ExecutorDeps:
    """The outside world, injectable for tests."""

    publish_event: Callable[[str, dict[str, Any]], Awaitable[None]]
    # None: nothing is sent to a worker (inline execution and tests).
    dispatch_run: Callable[[str], str] | None = None
    dispatch_run_later: Callable[[str, int], str] | None = None
    enqueue_outbox: Callable[[str], None] | None = None
    services: Mapping[str, Any] = field(default_factory=dict)
    clock: Callable[[], float] = time.monotonic
    keepalive_seconds: float = KEEPALIVE_SECONDS


def default_deps(services: Mapping[str, Any] | None = None) -> ExecutorDeps:
    from dembrane import live_events

    async def publish(project_id: str, event: dict[str, Any]) -> None:
        if project_id:
            await live_events.publish(live_channel(project_id), event)

    def dispatch(run_id: str) -> str:
        from dembrane.tasks import task_analysis_run

        return str(task_analysis_run.send(run_id).message_id)

    def dispatch_later(run_id: str, delay_ms: int) -> str:
        from dembrane.tasks import task_analysis_run

        return str(task_analysis_run.send_with_options(args=(run_id,), delay=delay_ms).message_id)

    def enqueue(event_id: str) -> None:
        from dembrane.tasks import task_analysis_outbox_dispatch

        task_analysis_outbox_dispatch.send(event_id)

    return ExecutorDeps(
        publish_event=publish,
        dispatch_run=dispatch,
        dispatch_run_later=dispatch_later,
        enqueue_outbox=enqueue,
        services=services or {},
    )


def default_store() -> AnalysisStore:
    from dembrane.analysis.store import SqlAnalysisStore

    return SqlAnalysisStore()


# ── requests ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RunRequest:
    project_id: str
    recipe_id: str
    scope_key: str
    mode: RunMode | str = RunMode.REFRESH
    parameters: Mapping[str, Any] = field(default_factory=dict)
    selected_revision_ids: tuple[str, ...] = ()
    idempotency_key: str | None = None
    requested_by: str | None = None
    # Context and sensitivity versions, voice configuration: part of every
    # cache key, never free text.
    context: Mapping[str, Any] = field(default_factory=dict)
    # Request fresh dependency runs instead of pinning their ready outputs.
    refresh_dependencies: bool = False
    # Retry: which failed run (default: the scope's latest failed run).
    retry_run_id: str | None = None


@dataclass(frozen=True)
class RequestOutcome:
    """`created`, `existing` (same key, or equivalent work in flight),
    `reused` (a refresh whose inputs match the ready output) or `requeued`."""

    run: Run
    outcome: str
    dependencies: tuple[Run, ...] = ()

    @property
    def created(self) -> bool:
        return self.outcome in ("created", "reused")


# Context keys the executor sets itself: a caller's context never replaces them.
RESERVED_CONTEXT = ("model", "selectedRevisionIds")


def computation_manifest(manifest: Mapping[str, Any] | None, partitioned: Iterable[str] = ()) -> dict[str, Any]:
    """An input manifest as it bears on computation: each dependency by the
    output it pinned (never by the run that recorded that output, so a no-op
    upstream refresh changes nothing), without the `partitioned` keys.

    A dependency is partitioned as `dependencies.<name>` (or every dependency
    as `dependencies`): it keeps its recipe and scope but not its output,
    because each step names the dependency revisions it consumes in its own
    `inputs`. Run identity and publication always use the whole manifest."""
    if manifest is None:
        return {}
    parts = set(partitioned)
    every = "dependencies" in parts
    out = {key: value for key, value in manifest.items() if key not in parts and key != "dependencies"}
    out["dependencies"] = {
        name: _dependency_computation(dependency, partitioned=every or f"dependencies.{name}" in parts)
        for name, dependency in sorted((manifest.get("dependencies") or {}).items())
    }
    return out


def _dependency_computation(dependency: Mapping[str, Any], *, partitioned: bool) -> dict[str, Any]:
    out: dict[str, Any] = {
        "recipeId": dependency.get("recipeId"),
        "scopeKey": dependency.get("scopeKey"),
        "output": None if partitioned else dependency.get("outputFingerprint") or dependency.get("manifestHash"),
    }
    # What a host withdrew changes the computation, unless each step already
    # names the revisions it consumes.
    if dependency.get("withdrawnObjectIds") and not partitioned:
        out["withdrawn"] = list(dependency["withdrawnObjectIds"])
    return out


def work_fingerprint(
    *,
    recipe_version: str,
    parameters: Mapping[str, Any],
    context: Mapping[str, Any],
    input_fingerprint: str | None,
    epoch: int | None,
    definition_hash: str | None = None,
) -> str:
    """Two runs with the same work fingerprint compute the same output: the
    recipe version and its captured step, prompt and check definitions,
    parameters, context, computation inputs and generation epoch."""
    return fingerprint(
        recipeVersion=recipe_version,
        definition=definition_hash,
        parameters=dict(parameters),
        context=dict(context),
        inputFingerprint=input_fingerprint,
        epoch=epoch,
    )


def _run_work(run: Run) -> str:
    return work_fingerprint(
        recipe_version=run.recipe_version,
        parameters=run.parameters,
        context=run.context,
        input_fingerprint=content_hash(computation_manifest(run.input_manifest)),
        epoch=run.epoch,
        definition_hash=content_hash(run.definition),
    )


def _node_context(recipe: Recipe, request: RunRequest, selected: tuple[str, ...] = ()) -> dict[str, Any]:
    context: dict[str, Any] = {**dict(request.context), "model": dict(recipe.model_config())}
    if selected:
        context["selectedRevisionIds"] = list(selected)
    return context


def _compatible(run: Run, recipe: Recipe, parameters: Mapping[str, Any], context: Mapping[str, Any]) -> bool:
    """Whether a run computes what this request would, given the same inputs:
    recipe version, captured definition, parameters and context."""
    return (
        run.recipe_version == recipe.version
        and content_hash(run.definition) == content_hash(recipe.definition())
        and content_hash(dict(run.parameters)) == content_hash(dict(parameters))
        and content_hash(dict(run.context)) == content_hash(dict(context))
    )


def _pinned(
    name: str, recipe_id: str, scope_key: str, run: Run, withdrawn: Iterable[str] = ()
) -> PinnedOutput:
    return PinnedOutput(
        name=name,
        recipe_id=recipe_id,
        scope_key=scope_key,
        scope_id=run.scope_id,
        run_id=run.id,
        manifest=run.output_manifest or {},
        withdrawn=tuple(sorted(withdrawn)),
    )


async def _pin(store: AnalysisStore, name: str, recipe_id: str, scope_key: str, run: Run) -> PinnedOutput:
    """A ready output as a consumer pins it now: an object a host excluded
    is withdrawn, so an exclusion reaches every recipe downstream."""
    objects = {str(o["objectId"]) for o in (run.output_manifest or {}).get("objects") or []}
    heads = await store.current_revisions(run.project_id, [run.scope_id]) if objects else {}
    withdrawn = [
        object_id
        for object_id, head in heads.items()
        if object_id in objects and head.provenance.extra.get("membershipExcluded")
    ]
    return _pinned(name, recipe_id, scope_key, run, withdrawn)


async def _current_ready(store: AnalysisStore, scope_id: str) -> Run | None:
    scope = await store.get_scope(scope_id)
    if scope is None or not scope.current_run_id:
        return None
    run = await store.get_run(scope.current_run_id)
    return run if run and run.status == RunStatus.READY and run.output_manifest else None


async def _validate_selection(
    store: AnalysisStore, recipe: Recipe, project_id: str, revision_ids: Iterable[str]
) -> tuple[str, ...]:
    ids = tuple(sorted(set(revision_ids)))
    if not ids:
        return ()
    found = await store.get_revisions(project_id, list(ids))
    missing = [rid for rid in ids if rid not in found]
    if missing:
        raise InvalidRecipeRequest(f"{len(missing)} selected revisions are not in this project")
    for revision in found.values():
        if revision.status != RevisionStatus.PUBLISHED:
            raise InvalidRecipeRequest(f"selected revision {revision.id} is not published")
        if revision.type not in recipe.input_types:
            raise InvalidRecipeRequest(f"recipe {recipe.id} does not accept {revision.type} inputs")
    return ids


async def _resolve_inputs(
    recipe: Recipe,
    *,
    project_id: str,
    scope_key: str,
    parameters: Mapping[str, Any],
    selected: tuple[str, ...],
    dependencies: Mapping[str, PinnedOutput],
    services: Mapping[str, Any],
) -> dict[str, Any]:
    """The run's input manifest: the recipe's own resolution (sources and
    their fingerprints), the selected revisions and every pinned dependency
    output. Its hash is the input fingerprint."""
    resolved: dict[str, Any] = {}
    if recipe.resolve_inputs is not None:
        resolved = dict(
            await recipe.resolve_inputs(
                InputRequest(
                    project_id=project_id,
                    scope_key=scope_key,
                    parameters=parameters,
                    selected_revision_ids=selected,
                    dependencies=dependencies,
                    services=services,
                )
            )
        )
    revision_ids = set(str(r) for r in resolved.pop("revisionIds", []) or [])
    revision_ids.update(selected)
    for pinned in dependencies.values():
        revision_ids.update(pinned.revision_ids)
    return {
        **resolved,
        "selectedRevisionIds": list(selected),
        "revisionIds": sorted(revision_ids),
        "dependencies": {name: pinned.as_json() for name, pinned in sorted(dependencies.items())},
    }


async def request_run(
    request: RunRequest,
    *,
    store: AnalysisStore | None = None,
    deps: ExecutorDeps | None = None,
) -> RequestOutcome:
    """Validate, plan and queue a recipe run, or return the run that already
    answers this request. Raises `AnalysisValidationError` subclasses (unknown
    recipe, invalid scope, parameters or inputs, dependency cycle) before
    anything is written."""
    store = store or default_store()
    deps = deps or default_deps()
    if request.idempotency_key:
        # An accepted key is answered before anything that can change after
        # acceptance: a selected revision deleted since must not turn a
        # repeated transport request into an error.
        existing = await store.run_by_idempotency_key(request.project_id, request.idempotency_key)
        if existing is not None:
            return RequestOutcome(existing, "existing")
    recipe = get_recipe(request.recipe_id)
    try:
        mode = RunMode(request.mode)
    except ValueError:
        raise InvalidRecipeRequest(f"{request.mode!r} is not a run mode") from None
    reserved = sorted(set(request.context) & set(RESERVED_CONTEXT))
    if reserved:
        raise InvalidRecipeRequest(f"context key {reserved[0]!r} is reserved for the executor")
    scope_key = recipe.validate_scope_key(request.scope_key)
    parameters = recipe.validate_parameters(request.parameters)
    plan = build_plan(recipe.id, scope_key, parameters)
    selected = await _validate_selection(store, recipe, request.project_id, request.selected_revision_ids)

    key = request.idempotency_key or f"auto:{uuid.uuid4()}"
    scope = await store.ensure_scope(
        project_id=request.project_id, kind=ScopeKind.PRODUCER, owner_id=recipe.id, scope_key=scope_key
    )
    if mode == RunMode.RETRY:
        return await _retry(store, deps, scope.id, request)

    pinned: dict[str, PinnedOutput] = {}
    waiting: dict[str, Run] = {}
    dependency_runs: list[Run] = []
    for node in plan.nodes[:-1]:
        node_recipe = get_recipe(node.recipe_id)
        node_scope = await store.ensure_scope(
            project_id=request.project_id,
            kind=ScopeKind.PRODUCER,
            owner_id=node.recipe_id,
            scope_key=node.scope_key,
        )
        upstream_waiting = any(dep_key in waiting for _name, dep_key in node.dependencies)
        if not request.refresh_dependencies and not upstream_waiting:
            current = await _current_ready(store, node_scope.id)
            if current is not None and _compatible(
                current, node_recipe, node.parameters, _node_context(node_recipe, request)
            ):
                pinned[node.key] = await _pin(store, node.key, node.recipe_id, node.scope_key, current)
                continue
        # Anything else is requested. Equivalent work already in flight is
        # joined by the request's own dedupe, which compares the whole
        # computation (definition, parameters, context and inputs).
        outcome = await _request_node(
            store,
            deps,
            node_recipe,
            node,
            scope_id=node_scope.id,
            mode=RunMode.REFRESH,
            key=f"{key}:{node.key}",
            selected=(),
            pinned=pinned,
            waiting=waiting,
            request=request,
        )
        dependency_runs.append(outcome.run)
        if outcome.run.status == RunStatus.READY:
            pinned[node.key] = await _pin(store, node.key, node.recipe_id, node.scope_key, outcome.run)
        else:
            waiting[node.key] = outcome.run
    root = await _request_node(
        store,
        deps,
        recipe,
        plan.root_node,
        scope_id=scope.id,
        mode=mode,
        key=key,
        selected=selected,
        pinned=pinned,
        waiting=waiting,
        request=request,
    )
    return replace(root, dependencies=tuple(dependency_runs))


async def _request_node(
    store: AnalysisStore,
    deps: ExecutorDeps,
    recipe: Recipe,
    node: PlanNode,
    *,
    scope_id: str,
    mode: RunMode,
    key: str,
    selected: tuple[str, ...],
    pinned: Mapping[str, PinnedOutput],
    waiting: Mapping[str, Run],
    request: RunRequest,
) -> RequestOutcome:
    context = _node_context(recipe, request, selected)
    parameters = dict(node.parameters)
    current = await _current_ready(store, scope_id)
    epoch: int | None = None if mode == RunMode.REGENERATE else (current.epoch if current else 0)
    blockers = [waiting[dep_key] for _name, dep_key in node.dependencies if dep_key in waiting]
    # Every dependency run this run consumes, pinned or awaited.
    depends_on = tuple(
        sorted(
            {pinned[k].run_id if k in pinned else waiting[k].id for _name, k in node.dependencies}
        )
    )
    base: dict[str, Any] = dict(
        project_id=request.project_id,
        scope_id=scope_id,
        recipe_id=recipe.id,
        recipe_version=recipe.version,
        definition=recipe.definition(),
        mode=mode,
        idempotency_key=key,
        epoch=epoch,
        parameters=parameters,
        context=context,
        requested_by=request.requested_by,
        depends_on=depends_on,
    )
    if blockers:
        new = NewRun(
            **base,
            request_fingerprint=fingerprint(
                waiting=True,
                recipeVersion=recipe.version,
                definition=content_hash(recipe.definition()),
                parameters=parameters,
                context=context,
                dependsOn=list(depends_on),
                epoch=epoch if mode == RunMode.REFRESH else key,
            ),
            status=RunStatus.WAITING_FOR_INPUTS,
        )
    else:
        dependencies = {name: replace(pinned[k], name=name) for name, k in node.dependencies}
        manifest = await _resolve_inputs(
            recipe,
            project_id=request.project_id,
            scope_key=node.scope_key,
            parameters=parameters,
            selected=selected,
            dependencies=dependencies,
            services=deps.services,
        )
        input_fingerprint = content_hash(manifest)
        work = work_fingerprint(
            recipe_version=recipe.version,
            parameters=parameters,
            context=context,
            input_fingerprint=content_hash(computation_manifest(manifest)),
            epoch=epoch,
            definition_hash=content_hash(recipe.definition()),
        )
        if mode == RunMode.REFRESH and current is not None and _run_work(current) == work:
            try:
                run, created = await store.create_run(
                    NewRun(
                        **{**base, "epoch": current.epoch},
                        request_fingerprint=fingerprint(reuse=True, key=key),
                        status=RunStatus.READY,
                        input_manifest=manifest,
                        input_fingerprint=input_fingerprint,
                        reused_run_id=current.id,
                        output_manifest=current.output_manifest,
                        metrics={"reuse": "output", "reusedRunId": current.id, "modelCalls": 0},
                    )
                )
                return RequestOutcome(run, "reused" if created else "existing")
            except ReuseOutdated:
                # Another run became current in between: compute instead.
                pass
        new = NewRun(
            **base,
            request_fingerprint=work if mode == RunMode.REFRESH else fingerprint(regenerate=True, work=work, key=key),
            status=RunStatus.QUEUED,
            input_manifest=manifest,
            input_fingerprint=input_fingerprint,
        )
    run, created = await store.create_run(new)
    if not created:
        return RequestOutcome(run, "existing")
    if run.status == RunStatus.WAITING_FOR_INPUTS:
        # A dependency may have finished between reading it and registering
        # this waiter; its wake-up would then have found nobody.
        settled = await store.wake_waiting_runs(run.project_id)
        run = next((r for r in (*settled.woken, *settled.failed) if r.id == run.id), run)
    if run.status == RunStatus.QUEUED:
        await _dispatch(store, deps, run)
    await deps.publish_event(
        run.project_id,
        {"type": str(run.status), "run_id": run.id, "recipe_id": run.recipe_id, "scope_key": node.scope_key},
    )
    return RequestOutcome(run, "created")


async def _dispatch(store: AnalysisStore, deps: ExecutorDeps, run: Run) -> None:
    if deps.dispatch_run is None:
        return
    try:
        await store.set_execution_ref(run.id, deps.dispatch_run(run.id))
    except Exception as exc:  # noqa: BLE001
        # The run stays queued; the minute sweep sends it again.
        logger.error("analysis run %s could not be dispatched: %s", run.id, type(exc).__name__)


async def _retry(store: AnalysisStore, deps: ExecutorDeps, scope_id: str, request: RunRequest) -> RequestOutcome:
    target = (
        await store.get_run(request.retry_run_id)
        if request.retry_run_id
        else await store.latest_run(scope_id, (RunStatus.FAILED,))
    )
    if target is None or target.scope_id != scope_id or target.project_id != request.project_id:
        raise InvalidRecipeRequest("there is no failed run to retry in this scope")
    # The store binds the request's key to this run in the same transaction
    # that requeues it. An equivalent run in flight refuses the retry
    # (`RetryConflict`); it never answers in the failed run's place.
    bound = await store.requeue_run(target.id, idempotency_key=request.idempotency_key)
    if bound is None:
        raise AnalysisStoreError(f"run {target.id} could not be queued again")
    if bound.id != target.id or target.status != RunStatus.FAILED or bound.status != RunStatus.QUEUED:
        return RequestOutcome(bound, "existing")
    await _dispatch(store, deps, bound)
    await deps.publish_event(bound.project_id, {"type": "queued", "run_id": bound.id, "recipe_id": bound.recipe_id})
    return RequestOutcome(bound, "requeued")


async def cancel_run(run_id: str, *, store: AnalysisStore, deps: ExecutorDeps) -> Run | None:
    """Cancel a run. Its worker stops at its next checkpoint and cannot publish;
    runs waiting on it fail."""
    run = await store.cancel_run(run_id)
    if run is not None and run.status == RunStatus.CANCELLED:
        await store.wake_waiting_runs(run.project_id)
        await deps.publish_event(run.project_id, {"type": "cancelled", "run_id": run.id, "recipe_id": run.recipe_id})
    return run


# ── execution ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class StepResult:
    """What a step computed: its actual output (a model's parsed answer or a
    deterministic transformation), usage and its own check outcomes."""

    output: Any
    usage: Mapping[str, int] = field(default_factory=dict)
    model_calls: int = 0
    validation: tuple[CheckOutcome, ...] = ()
    checkpoint: dict[str, Any] | None = None


def step_cache_key(
    recipe: Recipe,
    step: StepDef,
    run: Run,
    inputs: Any,
    *,
    scope_key: str | None = None,
    instance: str | None = None,
    upstream: Any = None,
) -> str:
    """Everything a step's result depends on: recipe and step versions with
    their prompt and check versions; the scope and instance it runs for; the
    run's inputs, always (less the recipe's partitioned keys, whose parts a
    step names in its own `inputs`), with each dependency identified by its
    output unless that dependency is partitioned too; the outputs of earlier steps it consumes; parameters, context and
    the model configuration; and the generation epoch for model steps."""
    return fingerprint(
        recipe={"id": recipe.id, "version": recipe.version},
        step=step.definition(),
        scope=scope_key,
        instance=instance,
        globalInputs=content_hash(computation_manifest(run.input_manifest, recipe.partitioned_inputs)),
        inputs=inputs,
        upstream=upstream,
        parameters=run.parameters,
        context=run.context,
        epoch=run.epoch if step.kind == StepKind.MODEL else None,
    )


class RecipeContext:
    """What a recipe's execute function works with. Every write goes through
    the store under this run's lease; a refused write raises `RunStopped`."""

    def __init__(
        self,
        *,
        store: AnalysisStore,
        deps: ExecutorDeps,
        recipe: Recipe,
        run: Run,
        lease: str,
        scope_key: str,
        dependencies: Mapping[str, PinnedOutput],
    ) -> None:
        self.store = store
        self.deps = deps
        self.recipe = recipe
        self.run = run
        self.lease = lease
        self.scope_key = scope_key
        self.dependencies = dict(dependencies)
        self.revisions = RevisionService(store)
        self.model_slots = asyncio.Semaphore(recipe.model_concurrency)
        self.metrics: Counter[str] = Counter()
        self.step_checks: list[CheckOutcome] = []
        self.objects: dict[str, StagedRevision] = {}
        self.relations: dict[str, Relation] = {}
        self._steps: dict[str, Step] = {}
        # Output hashes of the steps this run has produced so far, by row key.
        self._outputs: dict[str, str] = {}
        self._lock = asyncio.Lock()
        self._started = deps.clock()
        self._last_progress = 0.0
        self._stage = "running"

    @property
    def project_id(self) -> str:
        return self.run.project_id

    @property
    def parameters(self) -> Mapping[str, Any]:
        return self.run.parameters

    @property
    def services(self) -> Mapping[str, Any]:
        return self.deps.services

    @property
    def input_manifest(self) -> Mapping[str, Any]:
        return self.run.input_manifest or {}

    @property
    def input_revision_ids(self) -> list[str]:
        return list(self.input_manifest.get("revisionIds") or [])

    async def load_steps(self) -> None:
        self._steps = {step.step_key: step for step in await self.store.get_steps(self.run.id)}

    # progress and checkpoints

    def metrics_doc(self) -> dict[str, Any]:
        return {**dict(self.metrics), "wallSeconds": round(self.deps.clock() - self._started, 3)}

    async def progress(self, stage: str | None = None, *, force: bool = False, **counts: Any) -> None:
        """Save progress and tell the page. Throttled unless forced; always a
        lease check when it saves."""
        if stage:
            self._stage = stage
        now = self.deps.clock()
        if not force and now - self._last_progress < PROGRESS_INTERVAL_SECONDS:
            return
        self._last_progress = now
        doc = {"stage": self._stage, **counts, "metrics": self.metrics_doc()}
        if not await self.store.heartbeat_run(self.run.id, self.lease, doc):
            raise RunStopped()
        await self.deps.publish_event(
            self.project_id,
            {"type": "progress", "run_id": self.run.id, "recipe_id": self.recipe.id, **doc},
        )

    async def checkpoint(self) -> None:
        """A cancellation, supersession, fence and lease check, with no throttle."""
        await self.progress(force=True)

    @asynccontextmanager
    async def _kept_alive(self) -> AsyncIterator[None]:
        """Renew the lease while a long step computes. A renewal that is
        refused stops the run once the step returns."""
        refused = False

        async def beat() -> None:
            nonlocal refused
            while True:
                await asyncio.sleep(self.deps.keepalive_seconds)
                if not await self.store.heartbeat_run(
                    self.run.id, self.lease, {"stage": self._stage, "metrics": self.metrics_doc()}
                ):
                    refused = True
                    return

        task = asyncio.create_task(beat())
        try:
            yield
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if refused:
            raise RunStopped()

    # steps

    async def _output_of(self, step: Step) -> Any:
        if step.reused_step_id:
            original = await self.store.get_step(step.reused_step_id)
            if original is None or original.status != StepStatus.COMPLETED:
                raise AnalysisStoreError(f"reused step artifact {step.reused_step_id} is missing")
            return original.output
        return step.output

    async def step(
        self,
        key: str,
        compute: Callable[[], Awaitable[StepResult | Any]],
        *,
        instance: str | None = None,
        inputs: Any = None,
        after: Iterable[str] | None = None,
    ) -> Any:
        """Run one declared step (once per `instance` for repeated steps, such
        as one extraction per conversation), or reuse its saved artifact.

        `inputs` names what the step reads beyond the run's inputs (its part
        of a partitioned input, say); `after` names the earlier steps, by row
        key, whose outputs it consumes. A step that names neither depends on
        every output produced before it in this run.

        In order: this run's own completed step (a resumed retry), a completed
        step with the same cache key anywhere in the project (recorded as a
        reference, not a copy), or `compute`. A computed result is saved with
        its actual output and check outcomes before it is returned. One whose
        own checks failed is saved as a failed attempt, with that evidence,
        stops the run, and is never reused."""
        definition = self.recipe.step(key)
        if instance is not None and not STEP_INSTANCE.fullmatch(instance):
            raise AnalysisValidationError(f"step instance {instance!r} is not a valid key")
        row_key = f"{key}:{instance}" if instance is not None else key
        upstream: Any = None
        if after is not None:
            consumed = sorted(set(after))
            missing = [name for name in consumed if name not in self._outputs]
            if missing:
                raise AnalysisValidationError(f"step {row_key} consumes {missing[0]!r}, which has not run")
            upstream = {name: self._outputs[name] for name in consumed}
        elif inputs is None:
            upstream = dict(sorted(self._outputs.items()))
        cache_key = step_cache_key(
            self.recipe, definition, self.run, inputs, scope_key=self.scope_key, instance=instance, upstream=upstream
        )
        own = self._steps.get(row_key)
        if own is not None and own.status == StepStatus.COMPLETED and own.cache_key == cache_key:
            self.metrics["stepsResumed"] += 1
            self.step_checks.extend(CheckOutcome.from_json(c) for c in own.validation)
            return self._remember(row_key, await self._output_of(own))
        await self.checkpoint()
        cached = await self.store.find_reusable_step(self.project_id, cache_key)
        if cached is not None:
            saved = await self.store.checkpoint_step(
                self.run.id,
                self.lease,
                StepWrite(
                    step_key=row_key,
                    step_version=definition.version,
                    kind=definition.kind,
                    cache_key=cache_key,
                    status=StepStatus.COMPLETED,
                    reused_step_id=cached.id,
                    validation=tuple(cached.validation),
                    usage={"reused": True, "modelCalls": 0},
                ),
            )
            if saved is None:
                raise RunStopped()
            self._steps[row_key] = saved
            self.metrics["cacheHits"] += 1
            self.step_checks.extend(CheckOutcome.from_json(c) for c in cached.validation)
            return self._remember(row_key, cached.output)
        started = self.deps.clock()
        running = StepWrite(
            step_key=row_key,
            step_version=definition.version,
            kind=definition.kind,
            cache_key=cache_key,
            status=StepStatus.RUNNING,
        )
        if await self.store.checkpoint_step(self.run.id, self.lease, running) is None:
            raise RunStopped()
        try:
            async with self._kept_alive():
                if definition.kind == StepKind.MODEL:
                    async with self.model_slots:
                        raw = await compute()
                else:
                    raw = await compute()
        except RunStopped:
            raise
        except Exception as exc:
            await self.store.checkpoint_step(
                self.run.id,
                self.lease,
                replace(running, status=StepStatus.FAILED, error=type(exc).__name__),
            )
            raise
        result = raw if isinstance(raw, StepResult) else StepResult(output=raw)
        usage = {str(k): int(v) for k, v in dict(result.usage).items()}
        failed = [c for c in result.validation if c.status == CheckStatus.FAILED]
        async with self._lock:
            self.metrics["modelCalls"] += result.model_calls
            for name, value in usage.items():
                self.metrics[f"tokens.{name}"] += value
            self.metrics[f"steps.{definition.kind}"] += 1
        saved = await self.store.checkpoint_step(
            self.run.id,
            self.lease,
            replace(
                running,
                status=StepStatus.FAILED if failed else StepStatus.COMPLETED,
                output=result.output,
                checkpoint=result.checkpoint,
                validation=tuple(c.as_json() for c in result.validation),
                error="checks failed" if failed else None,
                usage={
                    **usage,
                    "modelCalls": result.model_calls,
                    "seconds": round(self.deps.clock() - started, 3),
                },
            ),
        )
        if saved is None:
            raise RunStopped()
        self._steps[row_key] = saved
        if failed:
            raise ValidationFailed(list(result.validation))
        self.step_checks.extend(result.validation)
        return self._remember(row_key, result.output)

    def _remember(self, row_key: str, output: Any) -> Any:
        self._outputs[row_key] = content_hash(output)
        return output

    # objects and relations

    def _lineage(self, key: str) -> str:
        return f"{self.recipe.id}/{self.scope_key}/{key}"

    async def emit(
        self,
        type_id: str,
        key: str,
        payload: dict[str, Any],
        *,
        source_refs: Iterable[SourceRef] = (),
        input_revision_ids: Iterable[str] = (),
        embedding_refs: dict[str, Any] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> ObjectRevision:
        """Stage one output object. `key` is the producer's lineage key within
        this recipe and scope: the same key is the same object across runs."""
        if type_id not in self.recipe.output_types:
            raise AnalysisValidationError(f"recipe {self.recipe.id} does not produce {type_id}")
        inputs = list(input_revision_ids)
        allowed = set(self.input_revision_ids)
        stray = [rid for rid in inputs if rid not in allowed]
        if stray:
            raise AnalysisValidationError(f"{len(stray)} input revisions are not pinned inputs of this run")
        staged = await self.revisions.stage_generated(
            self.run,
            self.lease,
            type_id=type_id,
            lineage_key=self._lineage(key),
            payload=payload,
            source_refs=source_refs,
            input_revision_ids=inputs,
            embedding_refs=embedding_refs,
            extra=extra,
        )
        if staged is None:
            raise RunStopped()
        async with self._lock:
            earlier = self.objects.get(staged.object.id)
            if earlier is not None and earlier.revision.content_hash != staged.revision.content_hash:
                raise AnalysisValidationError(f"{type_id} {key!r} was emitted twice with different content")
            self.objects[staged.object.id] = staged
            self.metrics["objectsReused" if staged.reused else "objectsStaged"] += 1
        return staged.revision

    async def relate(
        self,
        type_id: str,
        from_revision: ObjectRevision,
        to_revision: ObjectRevision,
        *,
        basis: str,
        attributes: dict[str, Any] | None = None,
        source_refs: Iterable[SourceRef] = (),
    ) -> Relation:
        """Stage a relation between two exact revisions, each an output of this
        run or a pinned input."""
        endpoints = {s.revision.id for s in self.objects.values()} | set(self.input_revision_ids)
        for end in (from_revision.id, to_revision.id):
            if end not in endpoints:
                raise AnalysisValidationError(f"revision {end} is neither an output nor a pinned input of this run")
        relation = await self.revisions.stage_relation(
            self.run,
            self.lease,
            type_id=type_id,
            from_revision=from_revision,
            to_revision=to_revision,
            basis=basis,
            attributes=attributes,
            source_refs=source_refs,
        )
        if relation is None:
            raise RunStopped()
        async with self._lock:
            self.relations[relation.id] = relation
            self.metrics["relationsStaged"] += 1
        return relation

    async def yield_to_authored(self, object_ids: Iterable[str]) -> bool:
        """Objects a host edited while this run worked keep the host's
        revision: the output names it, and a relation that pointed at this
        run's revision of the object points at it instead. False when an
        object changed any other way."""
        swapped: dict[str, ObjectRevision] = {}
        for object_id in object_ids:
            staged = self.objects.get(object_id)
            record = await self.store.get_object(object_id)
            head_id = record.current_revision_id if record else None
            head = (await self.store.get_revisions(self.project_id, [head_id])).get(head_id) if head_id else None
            if staged is None or record is None or head is None or head.provenance.origin != Origin.AUTHORED:
                return False
            swapped[staged.revision.id] = head
            self.objects[object_id] = StagedRevision(object=record, revision=head, reused=True)
        moved = [r for r in self.relations.values() if r.from_revision_id in swapped or r.to_revision_id in swapped]
        if not moved:
            return True
        known = {s.revision.id: s.revision for s in self.objects.values()}
        known.update(await self.store.get_revisions(self.project_id, list(self.input_revision_ids)))
        for relation in moved:
            del self.relations[relation.id]
            ends = [swapped.get(end) or known[end] for end in (relation.from_revision_id, relation.to_revision_id)]
            await self.relate(
                relation.type,
                ends[0],
                ends[1],
                basis=str(relation.basis),
                attributes=relation.attributes,
                source_refs=[SourceRef.from_json(ref) for ref in relation.provenance.get("sourceRefs") or []],
            )
        return True

    async def input_revisions(self, name: str | None = None) -> list[ObjectRevision]:
        """A dependency's pinned output revisions (by input name), or every
        pinned input revision, in manifest order."""
        if name is not None:
            if name not in self.dependencies:
                raise AnalysisValidationError(f"recipe {self.recipe.id} has no input named {name!r}")
            ids = self.dependencies[name].revision_ids
        else:
            ids = self.input_revision_ids
        found = await self.store.get_revisions(self.project_id, ids)
        return [found[rid] for rid in ids if rid in found]

    # validation and the manifest

    def candidate_manifest(self, checks: list[CheckOutcome]) -> dict[str, Any]:
        objects = sorted(
            (
                {"objectId": s.object.id, "revisionId": s.revision.id, "type": s.revision.type}
                for s in self.objects.values()
            ),
            key=lambda o: o["objectId"],
        )
        relations = sorted(
            (
                {
                    "relationId": r.id,
                    "type": r.type,
                    "from": r.from_revision_id,
                    "to": r.to_revision_id,
                    "contentHash": r.content_hash,
                }
                for r in self.relations.values()
            ),
            key=lambda r: r["relationId"],
        )
        body = {
            "version": MANIFEST_VERSION,
            "hashVersion": HASH_VERSION,
            "recipe": {"id": self.recipe.id, "version": self.recipe.version},
            "scope": {"id": self.run.scope_id, "key": self.scope_key},
            "epoch": self.run.epoch,
            "objects": objects,
            "relations": relations,
            "inputs": {
                "fingerprint": self.run.input_fingerprint,
                "revisionIds": sorted(self.input_revision_ids),
                "dependencies": dict(self.input_manifest.get("dependencies") or {}),
            },
        }
        return {
            **body,
            "runId": self.run.id,
            "checks": [c.as_json() for c in checks],
            "contentHash": content_hash(body),
        }

    async def validate(self) -> list[CheckOutcome]:
        checks: list[CheckOutcome] = []
        invalid: list[str] = []
        for staged in self.objects.values():
            try:
                types.validate_payload(staged.revision.type, staged.revision.payload)
            except AnalysisValidationError:
                invalid.append(staged.revision.id)
        checks.append(
            CheckOutcome(
                check="schema",
                status=CheckStatus.FAILED if invalid else CheckStatus.PASSED,
                evidence={"revisions": len(self.objects), "invalid": invalid},
            )
        )
        endpoints = {s.revision.id for s in self.objects.values()} | set(self.input_revision_ids)
        dangling = [
            r.id for r in self.relations.values() if r.from_revision_id not in endpoints or r.to_revision_id not in endpoints
        ]
        checks.append(
            CheckOutcome(
                check="references",
                status=CheckStatus.FAILED if dangling else CheckStatus.PASSED,
                evidence={"relations": len(self.relations), "dangling": dangling},
            )
        )
        embedding_ids = sorted(
            {
                str((s.revision.embedding_refs or {}).get("embeddingId"))
                for s in self.objects.values()
                if (s.revision.embedding_refs or {}).get("embeddingId")
            }
        )
        if embedding_ids:
            durable = await self.store.vectors_by_ids(self.project_id, embedding_ids)
            missing = [eid for eid in embedding_ids if eid not in durable]
            checks.append(
                CheckOutcome(
                    check="embeddings-durable",
                    status=CheckStatus.FAILED if missing else CheckStatus.PASSED,
                    evidence={"embeddings": len(embedding_ids), "missing": missing},
                )
            )
        checks.extend(self.step_checks)
        if self.recipe.validate is not None:
            checks.extend(await self.recipe.validate(self))
        return checks


def _leaf_exceptions(exc: BaseException) -> list[BaseException]:
    if isinstance(exc, BaseExceptionGroup):
        return [leaf for inner in exc.exceptions for leaf in _leaf_exceptions(inner)]
    return [exc]


def failure_message(exc: BaseException) -> str:
    """What the page may show about a failed run: plain, no content."""
    if isinstance(exc, RecipeFailed):
        return str(exc)
    if isinstance(exc, (ValidationFailed, PublicationRejected)):
        return "The output failed validation."
    if isinstance(exc, AnalysisValidationError):
        return "The recipe produced output it may not publish."
    if isinstance(exc, AnalysisStoreError):
        return "Saving the analysis failed."
    return "Running the recipe failed."


async def _pin_dependencies(store: AnalysisStore, recipe: Recipe, run: Run, scope_key: str) -> dict[str, PinnedOutput]:
    """Each dependency's exact ready output: the runs named in the pinned input
    manifest, or, for a run that waited, the dependency runs it waited on (as
    re-resolved by the wake-up). Never a newer output substituted silently."""
    plan = build_plan(recipe.id, scope_key, run.parameters)
    names = plan.root_node.dependencies
    if not names:
        return {}
    recorded: Mapping[str, Any] = (run.input_manifest or {}).get("dependencies") or {}
    if run.input_manifest is not None:
        ids = [str(d.get("runId")) for d in recorded.values()]
    else:
        ids = list(run.depends_on)
    by_scope = {r.scope_id: r for r in [await store.get_run(rid) for rid in ids] if r is not None}
    pinned: dict[str, PinnedOutput] = {}
    for name, dep_key in names:
        node = plan.node(dep_key)
        scope = await store.find_scope(
            project_id=run.project_id, kind=ScopeKind.PRODUCER, owner_id=node.recipe_id, scope_key=node.scope_key
        )
        chosen = by_scope.get(scope.id) if scope else None
        if chosen is None or chosen.status != RunStatus.READY or not chosen.output_manifest:
            raise RecipeFailed("A recipe this run depends on has no ready output.")
        if run.input_manifest is not None:
            # Replay what was withdrawn when the inputs were pinned.
            withdrawn = (recorded.get(name) or {}).get("withdrawnObjectIds") or ()
            pinned[name] = _pinned(name, node.recipe_id, node.scope_key, chosen, withdrawn)
        else:
            pinned[name] = await _pin(store, name, node.recipe_id, node.scope_key, chosen)
    return pinned


async def run_worker(
    run_id: str,
    *,
    store: AnalysisStore | None = None,
    deps: ExecutorDeps | None = None,
) -> str:
    """Run one queued run. Returns ready, needs_review, superseded, failed,
    stopped, deferred or skipped."""
    store = store or default_store()
    deps = deps or default_deps()
    existing = await store.get_run(run_id)
    if existing is None or existing.status not in (RunStatus.QUEUED, RunStatus.RUNNING):
        return "skipped"
    lease = uuid.uuid4().hex
    try:
        recipe: Recipe | None = get_recipe(existing.recipe_id)
    except UnknownRecipe:
        recipe = None
    claim = await store.claim_run(run_id, lease, max_running=recipe.max_running if recipe else None)
    if claim.outcome == "busy":
        if deps.dispatch_run_later is not None:
            deps.dispatch_run_later(run_id, BUSY_RETRY_SECONDS * 1000)
        return "deferred"
    if claim.outcome != "claimed" or claim.run is None:
        return "skipped"
    run = claim.run
    scope = await store.get_scope(run.scope_id)
    scope_key = scope.scope_key if scope else ""
    context: RecipeContext | None = None
    try:
        if recipe is None or recipe.version != run.recipe_version:
            raise RecipeFailed("This recipe version is no longer available.")
        dependencies = await _pin_dependencies(store, recipe, run, scope_key)
        if run.input_manifest is None:
            manifest = await _resolve_inputs(
                recipe,
                project_id=run.project_id,
                scope_key=scope_key,
                parameters=run.parameters,
                selected=tuple(run.context.get("selectedRevisionIds") or ()),
                dependencies=dependencies,
                services=deps.services,
            )
            pinned_fingerprint = content_hash(manifest)
            if not await store.pin_inputs(
                run.id, lease, input_manifest=manifest, input_fingerprint=pinned_fingerprint
            ):
                raise RunStopped()
            run = replace(run, input_manifest=manifest, input_fingerprint=pinned_fingerprint)
        context = RecipeContext(
            store=store,
            deps=deps,
            recipe=recipe,
            run=run,
            lease=lease,
            scope_key=scope_key,
            dependencies=dependencies,
        )
        await context.load_steps()
        return await _execute(context)
    except Exception as raised:
        return await _settle_failure(store, deps, run, lease, context, raised)


async def _execute(ctx: RecipeContext) -> str:
    store, deps, run = ctx.store, ctx.deps, ctx.run
    await ctx.progress("running", force=True)
    await ctx.recipe.execute(ctx)
    await ctx.progress("validating", force=True)
    for attempt in range(1, PUBLISH_ATTEMPTS + 1):
        checks = await ctx.validate()
        if any(c.status == CheckStatus.FAILED for c in checks):
            raise ValidationFailed(checks)
        manifest = ctx.candidate_manifest(checks)
        check_docs = [c.as_json() for c in checks]
        if any(c.status == CheckStatus.NEEDS_REVIEW for c in checks):
            return await _needs_review(ctx, manifest, check_docs)
        result = await store.publish_run(run.id, ctx.lease, manifest=manifest, checks=check_docs, metrics=ctx.metrics_doc())
        # A host edited one of this run's objects while it worked: the edit
        # stands, and the run publishes the rest around it.
        if result.outcome != "conflict" or attempt == PUBLISH_ATTEMPTS:
            break
        if not await ctx.yield_to_authored(result.conflicts):
            break
    if result.outcome == "inactive":
        raise RunStopped()
    if result.outcome == "conflict":
        check_docs.append(
            CheckOutcome(
                check="object-heads",
                status=CheckStatus.NEEDS_REVIEW,
                evidence={"objects": list(result.conflicts)},
                message="An object changed while the run was working.",
            ).as_json()
        )
        return await _needs_review(ctx, manifest, check_docs)
    if result.outcome == "superseded":
        await deps.publish_event(run.project_id, {"type": "superseded", "run_id": run.id, "recipe_id": run.recipe_id})
        return "superseded"
    if result.event_id and deps.enqueue_outbox is not None:
        try:
            deps.enqueue_outbox(result.event_id)
        except Exception as exc:  # noqa: BLE001
            # Committed already; the minute sweep dispatches it.
            logger.warning("analysis outbox %s not enqueued: %s", result.event_id, type(exc).__name__)
    logger.info(
        "analysis run %s (%s %s, project %s) ready: %d objects, %d relations, metrics %s",
        run.id,
        run.recipe_id,
        run.recipe_version,
        run.project_id,
        len(manifest["objects"]),
        len(manifest["relations"]),
        ctx.metrics_doc(),
    )
    await deps.publish_event(
        run.project_id,
        {"type": "ready", "run_id": run.id, "recipe_id": run.recipe_id, "sequence": result.sequence},
    )
    return "ready"


async def _needs_review(ctx: RecipeContext, manifest: dict[str, Any], checks: list[dict[str, Any]]) -> str:
    if not await ctx.store.finish_run(
        ctx.run.id,
        ctx.lease,
        status=RunStatus.NEEDS_REVIEW,
        checks=checks,
        metrics=ctx.metrics_doc(),
        candidate_manifest=manifest,
    ):
        raise RunStopped()
    await ctx.deps.publish_event(
        ctx.run.project_id, {"type": "needs_review", "run_id": ctx.run.id, "recipe_id": ctx.run.recipe_id}
    )
    return "needs_review"


async def _settle_stopped(store: AnalysisStore, deps: ExecutorDeps, run: Run, lease: str) -> str:
    """A worker that may no longer write: settle the run as superseded when a
    newer ready request overtook it (the one write allowed without the rest
    of ownership); otherwise leave it to its new owner or the expiry sweep."""
    current = await store.get_run(run.id)
    scope = await store.get_scope(run.scope_id)
    if (
        current is not None
        and current.status == RunStatus.RUNNING
        and current.lease == lease
        and scope is not None
        and scope.current_request_order is not None
        and scope.current_request_order >= current.request_order
    ):
        if await store.finish_run(run.id, lease, status=RunStatus.SUPERSEDED):
            await deps.publish_event(run.project_id, {"type": "superseded", "run_id": run.id})
            return "superseded"
    logger.info("analysis run %s stopped: no longer this worker's", run.id)
    return "stopped"


async def _settle_failure(
    store: AnalysisStore,
    deps: ExecutorDeps,
    run: Run,
    lease: str,
    ctx: RecipeContext | None,
    raised: BaseException,
) -> str:
    leaves = _leaf_exceptions(raised)
    if any(isinstance(leaf, RunStopped) for leaf in leaves):
        return await _settle_stopped(store, deps, run, lease)
    exc = leaves[0]
    checks = [c.as_json() for c in exc.checks] if isinstance(exc, ValidationFailed) else None
    if isinstance(exc, PublicationRejected):
        checks = [
            CheckOutcome(check="publication-references", status=CheckStatus.FAILED, evidence={"reasons": exc.reasons}).as_json()
        ]
    try:
        recorded = await store.finish_run(
            run.id,
            lease,
            status=RunStatus.FAILED,
            error=failure_message(exc),
            checks=checks,
            metrics=ctx.metrics_doc() if ctx else None,
        )
    except AnalysisStoreError:
        logger.exception("analysis run %s: could not record the failure", run.id)
        recorded = False
    if not recorded:
        return await _settle_stopped(store, deps, run, lease)
    # Only messages this package wrote are logged: a provider's error can quote
    # its input, and that input is participant-derived text.
    ours = (RecipeFailed, ValidationFailed, AnalysisValidationError, AnalysisStoreError)
    logger.error(
        "analysis run %s (%s, project %s) failed: %s: %s",
        run.id,
        run.recipe_id,
        run.project_id,
        type(exc).__name__,
        str(exc)[:500] if isinstance(exc, ours) else "(detail withheld)",
    )
    try:
        await store.wake_waiting_runs(run.project_id)
    except AnalysisStoreError:
        logger.warning("analysis run %s: dependants not settled; the sweep will", run.id)
    await deps.publish_event(run.project_id, {"type": "failed", "run_id": run.id, "recipe_id": run.recipe_id})
    return "failed"


async def execute_inline(
    request: RunRequest,
    *,
    store: AnalysisStore | None = None,
    deps: ExecutorDeps | None = None,
) -> RequestOutcome:
    """For a caller already inside a worker (the popcorn tick): the same
    request, runs, steps and publication, executed in this process instead of
    being sent to another worker. Dependency runs execute first, in plan order."""
    store = store or default_store()
    base = deps or default_deps()
    inline = replace(base, dispatch_run=None, dispatch_run_later=None)
    outcome = await request_run(request, store=store, deps=inline)
    for pending in (*outcome.dependencies, outcome.run):
        current = await store.get_run(pending.id)
        if current is None:
            continue
        if current.status == RunStatus.WAITING_FOR_INPUTS:
            await store.wake_waiting_runs(current.project_id)
            current = await store.get_run(pending.id)
        if current is not None and current.status == RunStatus.QUEUED:
            await run_worker(current.id, store=store, deps=inline)
    final = await store.get_run(outcome.run.id)
    return replace(outcome, run=final or outcome.run)
