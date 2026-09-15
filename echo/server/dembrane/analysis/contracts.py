"""The shapes the analysis lifecycle passes around, and what it needs from storage.

`AnalysisStore` is implemented by `store.SqlAnalysisStore`; tests use an
in-memory one. Every store method that belongs to a running worker takes the
run's lease and refuses (returns None or False) once the run is no longer the
worker's: the lease was replaced or its deadline passed, the run was cancelled,
a newer request in its scope is ready, or the scope's writer or writer fence
changed. Those checks lock the scope before the run, the order publication
locks them in, so a checkpoint never commits after a newer publication.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Protocol
from datetime import datetime
from dataclasses import field, dataclass

from dembrane.analysis.hashing import HASH_VERSION

# How long a claimed run stays its worker's without a checkpoint. Every
# checkpoint extends it; the executor keeps it alive during long steps.
DEFAULT_LEASE_SECONDS = 20 * 60


class RunStatus(StrEnum):
    QUEUED = "queued"
    WAITING_FOR_INPUTS = "waiting_for_inputs"
    RUNNING = "running"
    NEEDS_REVIEW = "needs_review"
    READY = "ready"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SUPERSEDED = "superseded"


ACTIVE_RUN_STATUSES = (RunStatus.QUEUED, RunStatus.WAITING_FOR_INPUTS, RunStatus.RUNNING)
TERMINAL_RUN_STATUSES = (
    RunStatus.READY,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
    RunStatus.SUPERSEDED,
)


class RunMode(StrEnum):
    REFRESH = "refresh"
    REGENERATE = "regenerate"
    RETRY = "retry"


class ScopeKind(StrEnum):
    PRODUCER = "producer"
    VIEW = "view"


class StepKind(StrEnum):
    MODEL = "model"
    DETERMINISTIC = "deterministic"
    CHECK = "check"


class StepStatus(StrEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class RevisionStatus(StrEnum):
    # Written under a run, invisible to published queries until it is ready.
    STAGED = "staged"
    # A generated update over an authored head: kept for review, never current.
    CANDIDATE = "candidate"
    PUBLISHED = "published"
    DISCARDED = "discarded"


class RelationStatus(StrEnum):
    STAGED = "staged"
    PUBLISHED = "published"
    DISCARDED = "discarded"


class Origin(StrEnum):
    GENERATED = "generated"
    AUTHORED = "authored"
    IMPORTED = "imported"


class RelationBasis(StrEnum):
    EXTRACTED = "extracted"
    INFERRED = "inferred"
    AUTHORED = "authored"


class CheckStatus(StrEnum):
    PASSED = "passed"
    FAILED = "failed"
    NEEDS_REVIEW = "needs_review"


class OutboxStatus(StrEnum):
    PENDING = "pending"
    DISPATCHING = "dispatching"
    DELIVERED = "delivered"
    DEAD = "dead"


class Writer(StrEnum):
    LEGACY = "legacy"
    ANALYSIS = "analysis"


# Producer scopes that own objects no recipe produces: authored objects and
# imports without a producer scope of their own. Their publication sequence
# orders the outbox events of edits and imports.
AUTHORED_SCOPE_OWNER = "authored"
IMPORTED_SCOPE_OWNER = "imported"


# ── errors ──────────────────────────────────────────────────────────────


class AnalysisStoreError(RuntimeError):
    """The database refused or failed an analysis read or write."""


class AnalysisValidationError(ValueError):
    """A request, payload or reference is invalid. Raised before dispatch or
    before publication; nothing is written on its account."""


class ReferenceViolation(AnalysisValidationError):
    """A reference crosses a project, a scope or an object it may not."""


class PublicationRejected(AnalysisValidationError):
    """A manifest's references or checks failed validation inside publication;
    the whole transaction rolled back."""

    def __init__(self, reasons: list[str]) -> None:
        super().__init__("publication rejected: " + "; ".join(reasons[:5]))
        self.reasons = reasons


class StepConflict(AnalysisValidationError):
    """A completed step artifact was about to be rewritten with other inputs."""


class WriterNotOwner(AnalysisValidationError):
    """The scope's writer is not the analysis executor (a legacy producer owns it)."""


class ReuseOutdated(Exception):
    """The ready run a refresh meant to reuse is no longer the scope's current output."""

    def __init__(self, current_run_id: str | None) -> None:
        super().__init__(f"the scope's current run is now {current_run_id}")
        self.current_run_id = current_run_id


class RevisionConflict(Exception):
    """An edit named an expected revision that is no longer the head."""

    def __init__(self, object_id: str, expected_revision_id: str | None, current: ObjectRevision | None) -> None:
        super().__init__(f"object {object_id} has moved on from revision {expected_revision_id}")
        self.object_id = object_id
        self.expected_revision_id = expected_revision_id
        self.current = current


class SnapshotConflict(Exception):
    """A view scope advanced past the snapshot an assembly expected."""

    def __init__(self, scope_id: str, expected: str | None, current: str | None) -> None:
        super().__init__(f"view scope {scope_id} is at {current}, not {expected}")
        self.scope_id = scope_id
        self.expected = expected
        self.current = current


# ── records ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SourceRef:
    """Where evidence came from: a conversation and source version, with the
    checked quote and its location where available."""

    conversation_id: str
    source_fingerprint: str | None = None
    quote: str | None = None
    location: dict[str, Any] | None = None

    def as_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"conversationId": self.conversation_id}
        if self.source_fingerprint is not None:
            out["sourceFingerprint"] = self.source_fingerprint
        if self.quote is not None:
            out["quote"] = self.quote
        if self.location is not None:
            out["location"] = self.location
        return out

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> SourceRef:
        return cls(
            conversation_id=str(data["conversationId"]),
            source_fingerprint=data.get("sourceFingerprint"),
            quote=data.get("quote"),
            location=data.get("location"),
        )


@dataclass(frozen=True)
class Scope:
    id: str
    project_id: str
    kind: ScopeKind
    scope_key: str
    recipe_id: str | None = None
    view_id: str | None = None
    next_request_order: int = 1
    generation_epoch: int = 0
    publication_sequence: int = 0
    current_run_id: str | None = None
    current_request_order: int | None = None
    current_snapshot_id: str | None = None
    writer: Writer = Writer.ANALYSIS
    writer_fence: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True)
class Run:
    id: str
    project_id: str
    scope_id: str
    recipe_id: str
    recipe_version: str
    definition: dict[str, Any]
    mode: RunMode
    epoch: int
    idempotency_key: str
    request_order: int
    request_fingerprint: str
    status: RunStatus
    input_fingerprint: str | None = None
    hash_version: str = HASH_VERSION
    input_manifest: dict[str, Any] | None = None
    parameters: dict[str, Any] = field(default_factory=dict)
    context: dict[str, Any] = field(default_factory=dict)
    depends_on: list[str] = field(default_factory=list)
    progress: dict[str, Any] = field(default_factory=dict)
    lease: str | None = None
    lease_expires_at: datetime | None = None
    attempt: int = 0
    writer_fence: int = 0
    execution_ref: str | None = None
    output_manifest: dict[str, Any] | None = None
    checks: list[dict[str, Any]] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    reused_run_id: str | None = None
    requested_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None

    @property
    def active(self) -> bool:
        return self.status in ACTIVE_RUN_STATUSES


@dataclass(frozen=True)
class Step:
    id: str
    project_id: str
    run_id: str
    step_key: str
    step_version: str
    kind: StepKind
    cache_key: str
    status: StepStatus
    attempt: int = 1
    hash_version: str = HASH_VERSION
    lease: str | None = None
    reused_step_id: str | None = None
    checkpoint: dict[str, Any] | None = None
    output: Any = None
    validation: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    completed_at: datetime | None = None


@dataclass(frozen=True)
class ObjectRecord:
    id: str
    project_id: str
    type: str
    lineage_key: str
    scope_id: str | None = None
    current_revision_id: str | None = None
    revision_count: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True)
class Provenance:
    run_id: str | None
    origin: Origin
    recipe_id: str | None = None
    recipe_version: str | None = None
    input_revision_ids: tuple[str, ...] = ()
    source_refs: tuple[SourceRef, ...] = ()
    # Anything else a producer records about how this came to be: a legacy
    # import key, a check outcome, a lineage note for a split or merge.
    extra: dict[str, Any] = field(default_factory=dict)

    def as_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "runId": self.run_id,
            "origin": str(self.origin),
            "inputRevisionIds": list(self.input_revision_ids),
            "sourceRefs": [ref.as_json() for ref in self.source_refs],
        }
        if self.recipe_id is not None:
            out["recipeId"] = self.recipe_id
        if self.recipe_version is not None:
            out["recipeVersion"] = self.recipe_version
        if self.extra:
            out["extra"] = self.extra
        return out

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Provenance:
        return cls(
            run_id=data.get("runId"),
            origin=Origin(data["origin"]),
            recipe_id=data.get("recipeId"),
            recipe_version=data.get("recipeVersion"),
            input_revision_ids=tuple(data.get("inputRevisionIds") or ()),
            source_refs=tuple(SourceRef.from_json(ref) for ref in data.get("sourceRefs") or ()),
            extra=dict(data.get("extra") or {}),
        )


@dataclass(frozen=True)
class ObjectRevision:
    """The spec's revision envelope. Immutable once published."""

    id: str
    object_id: str
    project_id: str
    type: str
    schema_version: int
    revision_number: int
    status: RevisionStatus
    payload: dict[str, Any]
    attributes: dict[str, Any]
    provenance: Provenance
    content_hash: str
    hash_version: str = HASH_VERSION
    run_id: str | None = None
    parent_revision_id: str | None = None
    embedding_refs: dict[str, Any] | None = None
    actor_id: str | None = None
    reason: str | None = None
    created_at: datetime | None = None
    published_at: datetime | None = None

    def envelope(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "objectId": self.object_id,
            "revisionId": self.id,
            "projectId": self.project_id,
            "type": self.type,
            "schemaVersion": self.schema_version,
            "payload": self.payload,
            "attributes": self.attributes,
            "provenance": self.provenance.as_json(),
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }
        if self.actor_id is not None:
            out["actorId"] = self.actor_id
        if self.parent_revision_id is not None:
            out["parentRevisionId"] = self.parent_revision_id
        return out


@dataclass(frozen=True)
class Relation:
    id: str
    project_id: str
    type: str
    basis: RelationBasis
    status: RelationStatus
    from_revision_id: str
    to_revision_id: str
    from_object_id: str
    to_object_id: str
    attributes: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)
    content_hash: str = ""
    hash_version: str = HASH_VERSION
    run_id: str | None = None
    created_at: datetime | None = None
    published_at: datetime | None = None


@dataclass(frozen=True)
class Snapshot:
    id: str
    project_id: str
    scope_id: str
    view_id: str
    manifest: dict[str, Any]
    content_hash: str
    manifest_version: int = 1
    parent_snapshot_id: str | None = None
    settings: dict[str, Any] = field(default_factory=dict)
    versions: dict[str, Any] = field(default_factory=dict)
    embedding_config: dict[str, Any] | None = None
    hash_version: str = HASH_VERSION
    created_by: str | None = None
    source_event_id: str | None = None
    created_at: datetime | None = None


@dataclass(frozen=True)
class OutboxEvent:
    id: str
    project_id: str
    scope_id: str
    sequence: int
    event_type: str
    status: OutboxStatus
    run_id: str | None = None
    snapshot_id: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    attempts: int = 0
    claim: str | None = None
    next_attempt_at: datetime | None = None
    consumers: dict[str, Any] = field(default_factory=dict)
    last_error: str | None = None
    created_at: datetime | None = None
    delivered_at: datetime | None = None


@dataclass(frozen=True)
class CheckOutcome:
    """One check's result. Evidence is what the check actually looked at, so a
    model's assurance alone is never recorded as verification."""

    check: str
    status: CheckStatus
    version: str = "1"
    evidence: dict[str, Any] = field(default_factory=dict)
    message: str | None = None

    def as_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "check": self.check,
            "status": str(self.status),
            "version": self.version,
            "evidence": self.evidence,
        }
        if self.message is not None:
            out["message"] = self.message
        return out

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> CheckOutcome:
        return cls(
            check=str(data["check"]),
            status=CheckStatus(data["status"]),
            version=str(data.get("version") or "1"),
            evidence=dict(data.get("evidence") or {}),
            message=data.get("message"),
        )


# ── writes ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class NewRun:
    project_id: str
    scope_id: str
    recipe_id: str
    recipe_version: str
    definition: dict[str, Any]
    mode: RunMode
    idempotency_key: str
    request_fingerprint: str
    status: RunStatus
    # None: the store allocates the scope's next generation epoch (regenerate).
    epoch: int | None
    parameters: dict[str, Any] = field(default_factory=dict)
    context: dict[str, Any] = field(default_factory=dict)
    input_manifest: dict[str, Any] | None = None
    input_fingerprint: str | None = None
    # Every dependency run this run consumes: the ready ones pinned at request
    # time and the ones still in flight it waits for.
    depends_on: tuple[str, ...] = ()
    requested_by: str | None = None
    # A refresh whose inputs match the scope's current ready run: recorded as a
    # ready run carrying that run's manifest, made current under the scope lock
    # (so it fences older requests), or `ReuseOutdated` when that run is no
    # longer current.
    reused_run_id: str | None = None
    output_manifest: dict[str, Any] | None = None
    metrics: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class StepWrite:
    step_key: str
    step_version: str
    kind: StepKind
    cache_key: str
    status: StepStatus
    output: Any = None
    checkpoint: dict[str, Any] | None = None
    validation: tuple[dict[str, Any], ...] = ()
    usage: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    reused_step_id: str | None = None


@dataclass(frozen=True)
class NewRevision:
    project_id: str
    object_id: str
    type: str
    schema_version: int
    origin: Origin
    payload: dict[str, Any]
    attributes: dict[str, Any]
    provenance: Provenance
    content_hash: str
    status: RevisionStatus
    run_id: str | None = None
    parent_revision_id: str | None = None
    embedding_refs: dict[str, Any] | None = None
    actor_id: str | None = None
    reason: str | None = None
    # A fixed id makes a repeat import land on the same row.
    revision_id: str | None = None


@dataclass(frozen=True)
class NewRelation:
    project_id: str
    type: str
    basis: RelationBasis
    from_revision_id: str
    to_revision_id: str
    from_object_id: str
    to_object_id: str
    attributes: dict[str, Any]
    provenance: dict[str, Any]
    content_hash: str
    run_id: str | None = None


@dataclass(frozen=True)
class NewSnapshot:
    project_id: str
    scope_id: str
    view_id: str
    manifest: dict[str, Any]
    content_hash: str
    manifest_version: int = 1
    settings: dict[str, Any] = field(default_factory=dict)
    versions: dict[str, Any] = field(default_factory=dict)
    embedding_config: dict[str, Any] | None = None
    created_by: str | None = None
    # The outbox event this snapshot is the effect of, if any.
    source_event_id: str | None = None


@dataclass(frozen=True)
class ClaimResult:
    """`claimed`: the run is running under the new lease. `busy`: the recipe
    is at its running limit, try later. `inactive`: nothing to run."""

    outcome: str
    run: Run | None = None


@dataclass(frozen=True)
class PublishResult:
    """`ready`, `superseded` (a newer request is already ready), `inactive`
    (not this worker's any more) or `conflict` (an object head moved since
    staging; the run should go to review)."""

    outcome: str
    event_id: str | None = None
    sequence: int | None = None
    conflicts: tuple[str, ...] = ()


@dataclass(frozen=True)
class WakeResult:
    woken: tuple[Run, ...] = ()
    failed: tuple[Run, ...] = ()


# ── storage protocol ────────────────────────────────────────────────────


class AnalysisStore(Protocol):
    # scopes
    async def ensure_scope(
        self, *, project_id: str, kind: ScopeKind, owner_id: str, scope_key: str
    ) -> Scope: ...
    async def find_scope(
        self, *, project_id: str, kind: ScopeKind, owner_id: str, scope_key: str
    ) -> Scope | None: ...
    async def get_scope(self, scope_id: str) -> Scope | None: ...

    # runs
    async def create_run(self, new: NewRun) -> tuple[Run, bool]: ...
    async def get_run(self, run_id: str) -> Run | None: ...
    async def run_by_idempotency_key(self, project_id: str, key: str) -> Run | None: ...
    async def active_run(self, scope_id: str, request_fingerprint: str) -> Run | None: ...
    async def latest_run(self, scope_id: str, statuses: tuple[RunStatus, ...]) -> Run | None: ...
    async def set_execution_ref(self, run_id: str, execution_ref: str) -> None: ...
    async def claim_run(self, run_id: str, lease: str, *, max_running: int | None) -> ClaimResult: ...
    async def pin_inputs(
        self, run_id: str, lease: str, *, input_manifest: dict[str, Any], input_fingerprint: str
    ) -> bool: ...
    async def heartbeat_run(self, run_id: str, lease: str, progress: dict[str, Any]) -> bool: ...
    async def finish_run(
        self,
        run_id: str,
        lease: str,
        *,
        status: RunStatus,
        error: str | None = None,
        checks: list[dict[str, Any]] | None = None,
        metrics: dict[str, Any] | None = None,
        candidate_manifest: dict[str, Any] | None = None,
    ) -> bool: ...
    async def cancel_run(self, run_id: str) -> Run | None: ...
    async def requeue_run(self, run_id: str, *, idempotency_key: str | None = None) -> Run | None: ...
    async def wake_waiting_runs(self, project_id: str | None) -> WakeResult: ...
    async def expire_stale_runs(self) -> list[str]: ...
    async def redispatch_queued_runs(self, older_than_seconds: int, limit: int) -> list[Run]: ...

    # steps
    async def get_steps(self, run_id: str) -> list[Step]: ...
    async def get_step(self, step_id: str) -> Step | None: ...
    async def find_reusable_step(self, project_id: str, cache_key: str) -> Step | None: ...
    async def checkpoint_step(self, run_id: str, lease: str, write: StepWrite) -> Step | None: ...

    # objects, revisions, relations
    async def ensure_object(
        self, *, project_id: str, type: str, lineage_key: str, scope_id: str | None
    ) -> ObjectRecord: ...
    async def get_object(self, object_id: str) -> ObjectRecord | None: ...
    async def get_revisions(self, project_id: str, revision_ids: list[str]) -> dict[str, ObjectRevision]: ...
    async def stage_revision(self, run_id: str, lease: str, new: NewRevision) -> ObjectRevision | None: ...
    async def append_revision(
        self, new: NewRevision, *, expected_revision_id: str | None
    ) -> ObjectRevision: ...
    async def stage_relation(self, run_id: str, lease: str, new: NewRelation) -> Relation | None: ...
    async def run_candidates(self, run_id: str) -> tuple[list[ObjectRevision], list[Relation]]: ...
    async def get_relations(self, project_id: str, relation_ids: list[str]) -> dict[str, Relation]: ...
    async def assessments_for(
        self, project_id: str, revision_ids: list[str]
    ) -> dict[str, ObjectRevision]: ...

    # publication
    async def publish_run(
        self,
        run_id: str,
        lease: str,
        *,
        manifest: dict[str, Any],
        checks: list[dict[str, Any]],
        metrics: dict[str, Any],
    ) -> PublishResult: ...

    # snapshots
    async def publish_snapshot(
        self, new: NewSnapshot, *, expected_previous_id: str | None
    ) -> Snapshot: ...
    async def get_snapshot(self, snapshot_id: str) -> Snapshot | None: ...

    # outbox
    async def claim_outbox(
        self, *, claim: str, limit: int, claim_seconds: int, event_id: str | None = None
    ) -> list[OutboxEvent]: ...
    async def mark_consumer_done(self, event_id: str, claim: str, consumer: str) -> bool: ...
    async def finish_outbox(self, event_id: str, claim: str) -> bool: ...
    async def retry_outbox(
        self, event_id: str, claim: str, *, error: str, delay_seconds: int, max_attempts: int
    ) -> bool: ...

    # embeddings, over map_embedding
    async def load_embeddings(
        self, project_id: str, config_key: str, input_hashes: list[str]
    ) -> dict[str, tuple[str, list[float]]]: ...
    async def save_embedding(
        self,
        *,
        project_id: str,
        input_hash: str,
        config_key: str,
        model: str,
        dims: int,
        vector: list[float],
    ) -> tuple[str, list[float]]: ...
    async def vectors_by_ids(self, project_id: str, ids: list[str]) -> dict[str, list[float]]: ...
