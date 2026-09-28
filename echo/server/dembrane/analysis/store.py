"""SQL persistence for the analysis lifecycle.

Ownership. Every worker write (heartbeat, input pinning, step checkpoint,
staged revision or relation) runs in one short transaction that locks the
run's scope (`FOR SHARE`, which also waits for a writer transfer) and then
the run (`FOR UPDATE`), in the same
order publication locks them (`FOR UPDATE` on both), and proceeds only while
the run is running under the lease, before its lease deadline, under its
scope's current writer fence, and not overtaken by a newer ready request. A
write that passes extends the lease deadline. So a checkpoint either commits
before a newer publication in its scope or sees it and refuses.

Requests. A request's idempotency key is resolved, and recorded against the
run that answers it, in the same transaction that allocates the scope's next
request order: the key that created a run, a key that joined equivalent work
in flight, a key that retried a failed run and a refresh that reuses the
current ready run all keep returning their run.

Publication and snapshot advancement are single transactions that lock their
scope row first. Nothing here is held open across a model call.

The collections are Directus-managed; unique keys, partial indexes, CHECK
constraints and the same-project and immutability triggers are SQL-only (see
`directus/migrations/add_analysis_constraints.sql`). Callers check project
access before reaching this module.
"""

from __future__ import annotations

import uuid
import logging
from typing import Any, Callable, AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import replace

import psycopg
from psycopg.types.json import Json

from dembrane.analysis import db
from dembrane.map.store import SqlMapStore, MapStoreError
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.contracts import (
    ACTIVE_RUN_STATUSES,
    DEFAULT_LEASE_SECONDS,
    Run,
    Step,
    Scope,
    NewRun,
    Origin,
    Writer,
    RunMode,
    Relation,
    Snapshot,
    StepKind,
    RunStatus,
    ScopeKind,
    StepWrite,
    Provenance,
    StepStatus,
    WakeResult,
    ClaimResult,
    NewRelation,
    NewRevision,
    NewSnapshot,
    OutboxEvent,
    ObjectRecord,
    OutboxStatus,
    StepConflict,
    PublishResult,
    RelationBasis,
    RetryConflict,
    ReuseOutdated,
    ObjectRevision,
    RelationStatus,
    RevisionStatus,
    WriterNotOwner,
    RevisionConflict,
    SnapshotConflict,
    AnalysisStoreError,
    ReferenceViolation,
    PublicationRejected,
    AnalysisValidationError,
)

logger = logging.getLogger("dembrane.analysis.store")

ACTIVE = tuple(str(status) for status in ACTIVE_RUN_STATUSES)
WAKE_BATCH = 200


def _select(alias: str, uuids: tuple[str, ...], plain: tuple[str, ...]) -> str:
    prefix = f"{alias}." if alias else ""
    return ", ".join(
        [f"{prefix}{name}::text AS {name}" for name in uuids] + [f"{prefix}{name}" for name in plain]
    )


SCOPE_UUIDS = ("id", "project_id", "current_run_id", "current_snapshot_id")
SCOPE_PLAIN = (
    "kind", "recipe_id", "view_id", "scope_key", "next_request_order", "generation_epoch",
    "publication_sequence", "current_request_order", "writer", "writer_fence", "created_at",
    "updated_at",
)  # fmt: skip
RUN_UUIDS = ("id", "project_id", "scope_id", "reused_run_id")
RUN_PLAIN = (
    "recipe_id", "recipe_version", "definition", "mode", "epoch", "idempotency_key",
    "request_order", "request_fingerprint", "input_fingerprint", "hash_version", "input_manifest",
    "parameters", "context", "depends_on", "status", "progress", "lease", "lease_expires_at",
    "attempt", "writer_fence", "execution_ref", "output_manifest", "checks", "metrics", "error",
    "requested_by", "created_at", "updated_at", "started_at", "completed_at",
)  # fmt: skip
STEP_UUIDS = ("id", "project_id", "run_id", "reused_step_id")
STEP_PLAIN = (
    "step_key", "step_version", "kind", "cache_key", "hash_version", "status", "attempt", "lease",
    "checkpoint", "output", "validation", "usage", "error", "created_at", "updated_at",
    "completed_at",
)  # fmt: skip
OBJECT_UUIDS = ("id", "project_id", "scope_id", "current_revision_id")
OBJECT_PLAIN = ("type", "lineage_key", "revision_count", "created_at", "updated_at")
REVISION_UUIDS = ("id", "project_id", "object_id", "run_id", "parent_revision_id")
REVISION_PLAIN = (
    "revision_number", "type", "schema_version", "status", "origin", "payload", "attributes",
    "provenance", "content_hash", "hash_version", "embedding_refs", "actor_id", "reason",
    "change_kind", "created_at", "published_at",
)  # fmt: skip
RELATION_UUIDS = (
    "id", "project_id", "from_revision_id", "to_revision_id", "from_object_id", "to_object_id",
    "run_id",
)  # fmt: skip
RELATION_PLAIN = (
    "type", "basis", "status", "attributes", "provenance", "content_hash", "hash_version",
    "created_at", "published_at",
)  # fmt: skip
SNAPSHOT_UUIDS = ("id", "project_id", "scope_id", "parent_snapshot_id", "source_event_id")
SNAPSHOT_PLAIN = (
    "view_id", "manifest_version", "manifest", "settings", "versions", "embedding_config",
    "content_hash", "hash_version", "created_by", "created_at",
)  # fmt: skip
OUTBOX_UUIDS = ("id", "project_id", "scope_id", "run_id", "snapshot_id")
OUTBOX_PLAIN = (
    "sequence", "event_type", "payload", "status", "attempts", "claim", "next_attempt_at",
    "consumers", "last_error", "created_at", "delivered_at",
)  # fmt: skip

SCOPE_COLUMNS = _select("", SCOPE_UUIDS, SCOPE_PLAIN)
RUN_COLUMNS = _select("", RUN_UUIDS, RUN_PLAIN)
RUN_COLUMNS_R = _select("r", RUN_UUIDS, RUN_PLAIN)
STEP_COLUMNS = _select("", STEP_UUIDS, STEP_PLAIN)
OBJECT_COLUMNS = _select("", OBJECT_UUIDS, OBJECT_PLAIN)
REVISION_COLUMNS = _select("", REVISION_UUIDS, REVISION_PLAIN)
REVISION_COLUMNS_V = _select("v", REVISION_UUIDS, REVISION_PLAIN)
RELATION_COLUMNS = _select("", RELATION_UUIDS, RELATION_PLAIN)
SNAPSHOT_COLUMNS = _select("", SNAPSHOT_UUIDS, SNAPSHOT_PLAIN)
OUTBOX_COLUMNS_O = _select("o", OUTBOX_UUIDS, OUTBOX_PLAIN)


def _is_uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def _uuids(values: list[str]) -> list[str]:
    return [str(value) for value in values if _is_uuid(value)]


def _json(value: Any) -> Json | None:
    return None if value is None else Json(value)


# ── row mapping ─────────────────────────────────────────────────────────


def _scope(row: dict[str, Any]) -> Scope:
    return Scope(
        id=row["id"],
        project_id=row["project_id"],
        kind=ScopeKind(row["kind"]),
        scope_key=row["scope_key"],
        recipe_id=row["recipe_id"],
        view_id=row["view_id"],
        next_request_order=row["next_request_order"],
        generation_epoch=row["generation_epoch"],
        publication_sequence=row["publication_sequence"],
        current_run_id=row["current_run_id"],
        current_request_order=row["current_request_order"],
        current_snapshot_id=row["current_snapshot_id"],
        writer=Writer(row["writer"]),
        writer_fence=row["writer_fence"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _run(row: dict[str, Any]) -> Run:
    return Run(
        id=row["id"],
        project_id=row["project_id"],
        scope_id=row["scope_id"],
        recipe_id=row["recipe_id"],
        recipe_version=row["recipe_version"],
        definition=row["definition"] or {},
        mode=RunMode(row["mode"]),
        epoch=row["epoch"],
        idempotency_key=row["idempotency_key"],
        request_order=row["request_order"],
        request_fingerprint=row["request_fingerprint"],
        status=RunStatus(row["status"]),
        input_fingerprint=row["input_fingerprint"],
        hash_version=row["hash_version"],
        input_manifest=row["input_manifest"],
        parameters=row["parameters"] or {},
        context=row["context"] or {},
        depends_on=list(row["depends_on"] or []),
        progress=row["progress"] or {},
        lease=row["lease"],
        lease_expires_at=row["lease_expires_at"],
        attempt=row["attempt"],
        writer_fence=row["writer_fence"],
        execution_ref=row["execution_ref"],
        output_manifest=row["output_manifest"],
        checks=list(row["checks"] or []),
        metrics=row["metrics"] or {},
        error=row["error"],
        reused_run_id=row["reused_run_id"],
        requested_by=row["requested_by"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        started_at=row["started_at"],
        completed_at=row["completed_at"],
    )


def _step(row: dict[str, Any]) -> Step:
    return Step(
        id=row["id"],
        project_id=row["project_id"],
        run_id=row["run_id"],
        step_key=row["step_key"],
        step_version=row["step_version"],
        kind=StepKind(row["kind"]),
        cache_key=row["cache_key"],
        status=StepStatus(row["status"]),
        attempt=row["attempt"],
        hash_version=row["hash_version"],
        lease=row["lease"],
        reused_step_id=row["reused_step_id"],
        checkpoint=row["checkpoint"],
        output=row["output"],
        validation=list(row["validation"] or []),
        usage=row["usage"] or {},
        error=row["error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        completed_at=row["completed_at"],
    )


def _object(row: dict[str, Any]) -> ObjectRecord:
    return ObjectRecord(
        id=row["id"],
        project_id=row["project_id"],
        type=row["type"],
        lineage_key=row["lineage_key"],
        scope_id=row["scope_id"],
        current_revision_id=row["current_revision_id"],
        revision_count=row["revision_count"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _revision(row: dict[str, Any]) -> ObjectRevision:
    return ObjectRevision(
        id=row["id"],
        object_id=row["object_id"],
        project_id=row["project_id"],
        type=row["type"],
        schema_version=row["schema_version"],
        revision_number=row["revision_number"],
        status=RevisionStatus(row["status"]),
        payload=row["payload"] or {},
        attributes=row["attributes"] or {},
        provenance=Provenance.from_json(row["provenance"] or {"origin": row["origin"]}),
        content_hash=row["content_hash"],
        hash_version=row["hash_version"],
        run_id=row["run_id"],
        parent_revision_id=row["parent_revision_id"],
        embedding_refs=row["embedding_refs"],
        actor_id=row["actor_id"],
        reason=row["reason"],
        change_kind=row.get("change_kind"),
        created_at=row["created_at"],
        published_at=row["published_at"],
    )


def _relation(row: dict[str, Any]) -> Relation:
    return Relation(
        id=row["id"],
        project_id=row["project_id"],
        type=row["type"],
        basis=RelationBasis(row["basis"]),
        status=RelationStatus(row["status"]),
        from_revision_id=row["from_revision_id"],
        to_revision_id=row["to_revision_id"],
        from_object_id=row["from_object_id"],
        to_object_id=row["to_object_id"],
        attributes=row["attributes"] or {},
        provenance=row["provenance"] or {},
        content_hash=row["content_hash"],
        hash_version=row["hash_version"],
        run_id=row["run_id"],
        created_at=row["created_at"],
        published_at=row["published_at"],
    )


def _snapshot(row: dict[str, Any]) -> Snapshot:
    return Snapshot(
        id=row["id"],
        project_id=row["project_id"],
        scope_id=row["scope_id"],
        view_id=row["view_id"],
        manifest=row["manifest"] or {},
        content_hash=row["content_hash"],
        manifest_version=row["manifest_version"],
        parent_snapshot_id=row["parent_snapshot_id"],
        settings=row["settings"] or {},
        versions=row["versions"] or {},
        embedding_config=row["embedding_config"],
        hash_version=row["hash_version"],
        created_by=row["created_by"],
        source_event_id=row["source_event_id"],
        created_at=row["created_at"],
    )


def _outbox(row: dict[str, Any]) -> OutboxEvent:
    return OutboxEvent(
        id=row["id"],
        project_id=row["project_id"],
        scope_id=row["scope_id"],
        sequence=row["sequence"],
        event_type=row["event_type"],
        status=OutboxStatus(row["status"]),
        run_id=row["run_id"],
        snapshot_id=row["snapshot_id"],
        payload=row["payload"] or {},
        attempts=row["attempts"],
        claim=row["claim"],
        next_attempt_at=row["next_attempt_at"],
        consumers=row["consumers"] or {},
        last_error=row["last_error"],
        created_at=row["created_at"],
        delivered_at=row["delivered_at"],
    )


class _KeyTaken(Exception):
    """Another request bound this idempotency key first."""


async def _lease_live(cursor: db.Cursor, run_id: str) -> bool:
    """Whether the run's lease deadline is still ahead on the wall clock, read
    after the caller took its locks: `now()` is the transaction's start, which
    can be long before a lock wait ended."""
    await cursor.execute(
        "SELECT lease_expires_at > clock_timestamp() AS live FROM analysis_run WHERE id = %s", (run_id,)
    )
    row = await cursor.fetchone()
    return bool(row and row["live"])


async def _head_conflicts(cursor: db.Cursor, expected: dict[str, str | None]) -> list[str]:
    """Objects whose current head is not the expected revision. Every object
    row is locked, in id order, as publication locks them."""
    if not expected:
        return []
    await cursor.execute(
        """SELECT id::text AS id, current_revision_id::text AS current_revision_id
           FROM analysis_object WHERE id = ANY(%s::uuid[]) ORDER BY id FOR UPDATE""",
        (sorted(expected),),
    )
    heads = {row["id"]: row["current_revision_id"] for row in await cursor.fetchall()}
    return sorted(object_id for object_id, revision_id in expected.items() if heads.get(object_id) != revision_id)


def _computation_identity(row: dict[str, Any]) -> str:
    """What a run computes, apart from its inputs: two runs with the same
    identity over the same inputs are interchangeable dependencies."""
    return content_hash(
        {
            "recipeVersion": row["recipe_version"],
            "definition": row["definition"] or {},
            "parameters": row["parameters"] or {},
            "context": row["context"] or {},
        }
    )


class SqlAnalysisStore:
    """`lease_seconds` is how long a claim or checkpoint keeps a run its
    worker's. `fault`, for tests only, is called with a named point inside the
    publication, append and snapshot transactions; raising there proves the
    whole transaction rolls back."""

    def __init__(
        self,
        dsn: str | None = None,
        *,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        fault: Callable[[str], None] | None = None,
    ) -> None:
        self._dsn = dsn
        self._lease_seconds = lease_seconds
        self._fault = fault or (lambda _point: None)
        self._embeddings = SqlMapStore(dsn)

    @asynccontextmanager
    async def _cursor(self) -> AsyncIterator[db.Cursor]:
        try:
            async with db.autocommit_cursor(self._dsn, AnalysisStoreError) as cursor:
                yield cursor
        except psycopg.errors.CheckViolation as exc:
            raise ReferenceViolation(str(exc).strip()) from exc

    @asynccontextmanager
    async def _transaction(self) -> AsyncIterator[db.Cursor]:
        try:
            async with db.transaction(self._dsn, AnalysisStoreError) as cursor:
                yield cursor
        except psycopg.errors.CheckViolation as exc:
            raise ReferenceViolation(str(exc).strip()) from exc

    @asynccontextmanager
    async def _owned(self, run_id: str, lease: str) -> AsyncIterator[tuple[db.Cursor, dict[str, Any] | None]]:
        """A transaction in which the run is this worker's, or None as the
        owner. Locks the scope, then the run; extends the lease deadline."""
        async with self._transaction() as cursor:
            owner: dict[str, Any] | None = None
            if _is_uuid(run_id) and lease:
                await cursor.execute("SELECT scope_id FROM analysis_run WHERE id = %s", (run_id,))
                located = await cursor.fetchone()
                if located is not None:
                    # FOR SHARE conflicts with every update of the scope row: a
                    # writer transfer (a fence change) or a publication waits
                    # for this checkpoint, or this checkpoint for it.
                    await cursor.execute(
                        """SELECT writer, writer_fence, current_request_order FROM analysis_scope
                           WHERE id = %s FOR SHARE""",
                        (located["scope_id"],),
                    )
                    scope = await cursor.fetchone()
                    await cursor.execute(
                        """SELECT id::text AS id, project_id::text AS project_id,
                                  scope_id::text AS scope_id, recipe_id, recipe_version,
                                  request_order, writer_fence, input_manifest, input_fingerprint
                           FROM analysis_run
                           WHERE id = %s AND lease = %s AND status = 'running'
                           FOR UPDATE""",
                        (run_id, lease),
                    )
                    run = await cursor.fetchone()
                    if (
                        scope is not None
                        and run is not None
                        and await _lease_live(cursor, run_id)
                        and scope["writer"] == Writer.ANALYSIS
                        and scope["writer_fence"] == run["writer_fence"]
                        and (
                            scope["current_request_order"] is None
                            or scope["current_request_order"] < run["request_order"]
                        )
                    ):
                        await cursor.execute(
                            """UPDATE analysis_run
                               SET lease_expires_at = clock_timestamp() + make_interval(secs => %s),
                                   updated_at = now()
                               WHERE id = %s""",
                            (self._lease_seconds, run_id),
                        )
                        owner = run
            yield cursor, owner

    # ── scopes ──────────────────────────────────────────────────────────

    async def ensure_scope(
        self, *, project_id: str, kind: ScopeKind, owner_id: str, scope_key: str
    ) -> Scope:
        existing = await self.find_scope(
            project_id=project_id, kind=kind, owner_id=owner_id, scope_key=scope_key
        )
        if existing:
            return existing
        owner = "recipe_id" if kind == ScopeKind.PRODUCER else "view_id"
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""INSERT INTO analysis_scope
                        (id, project_id, kind, {owner}, scope_key, next_request_order,
                         generation_epoch, publication_sequence, writer, writer_fence,
                         created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, 1, 0, 0, 'analysis', 0, now(), now())
                    ON CONFLICT (project_id, {owner}, scope_key) WHERE kind = %s DO NOTHING
                    RETURNING {SCOPE_COLUMNS}""",
                (str(uuid.uuid4()), project_id, str(kind), owner_id, scope_key, str(kind)),
            )
            row = await cursor.fetchone()
        if row:
            return _scope(row)
        found = await self.find_scope(
            project_id=project_id, kind=kind, owner_id=owner_id, scope_key=scope_key
        )
        if found is None:
            raise AnalysisStoreError("scope vanished after a conflicting insert")
        return found

    async def find_scope(
        self, *, project_id: str, kind: ScopeKind, owner_id: str, scope_key: str
    ) -> Scope | None:
        owner = "recipe_id" if kind == ScopeKind.PRODUCER else "view_id"
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""SELECT {SCOPE_COLUMNS} FROM analysis_scope
                    WHERE project_id = %s AND kind = %s AND {owner} = %s AND scope_key = %s""",
                (project_id, str(kind), owner_id, scope_key),
            )
            row = await cursor.fetchone()
        return _scope(row) if row else None

    async def get_scope(self, scope_id: str) -> Scope | None:
        if not _is_uuid(scope_id):
            return None
        async with self._cursor() as cursor:
            await cursor.execute(f"SELECT {SCOPE_COLUMNS} FROM analysis_scope WHERE id = %s", (scope_id,))
            row = await cursor.fetchone()
        return _scope(row) if row else None

    # ── runs ────────────────────────────────────────────────────────────

    @staticmethod
    async def _remember_key(cursor: db.Cursor, *, project_id: str, key: str, run: Run, mode: str) -> None:
        await cursor.execute(
            """INSERT INTO analysis_request_key (id, project_id, idempotency_key, run_id, scope_id, mode, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, now())""",
            (str(uuid.uuid4()), project_id, key, run.id, run.scope_id, mode),
        )

    async def create_run(self, new: NewRun) -> tuple[Run, bool]:
        """Resolve a request under its scope lock: the run its key already
        answers, an equivalent run in flight (the key is recorded against it),
        or a new run with the scope's next request order. A reuse run is made
        the scope's current output, so it fences every older request."""
        for _ in range(3):
            try:
                async with self._transaction() as cursor:
                    await cursor.execute(
                        f"""SELECT {RUN_COLUMNS_R} FROM analysis_request_key AS k
                            JOIN analysis_run AS r ON r.id = k.run_id
                            WHERE k.project_id = %s AND k.idempotency_key = %s""",
                        (new.project_id, new.idempotency_key),
                    )
                    mapped = await cursor.fetchone()
                    if mapped is not None:
                        return _run(mapped), False
                    await cursor.execute(
                        f"""SELECT {SCOPE_COLUMNS} FROM analysis_scope
                            WHERE id = %s AND project_id = %s AND kind = 'producer' AND recipe_id = %s
                            FOR UPDATE""",
                        (new.scope_id, new.project_id, new.recipe_id),
                    )
                    scope_row = await cursor.fetchone()
                    if scope_row is None:
                        raise ReferenceViolation(f"scope {new.scope_id} is not a {new.recipe_id} scope of this project")
                    scope = _scope(scope_row)
                    if scope.writer != Writer.ANALYSIS:
                        raise WriterNotOwner(f"scope {scope.id} is written by {scope.writer}")
                    if new.status in ACTIVE_RUN_STATUSES:
                        await cursor.execute(
                            f"""SELECT {RUN_COLUMNS} FROM analysis_run
                                WHERE scope_id = %s AND request_fingerprint = %s AND status = ANY(%s)
                                ORDER BY request_order DESC LIMIT 1""",
                            (scope.id, new.request_fingerprint, list(ACTIVE)),
                        )
                        active = await cursor.fetchone()
                        if active is not None:
                            joined = _run(active)
                            await self._remember_key(
                                cursor, project_id=new.project_id, key=new.idempotency_key, run=joined, mode=str(new.mode)
                            )
                            return joined, False
                    if new.reused_run_id is not None:
                        if scope.current_run_id != new.reused_run_id:
                            raise ReuseOutdated(scope.current_run_id)
                        # The reused output must still be what its objects say:
                        # an edit since its publication makes it stale, exactly
                        # as publication's expected-head check would find.
                        expected: dict[str, str | None] = {
                            str(o["objectId"]): str(o["revisionId"])
                            for o in (new.output_manifest or {}).get("objects") or []
                        }
                        if await _head_conflicts(cursor, expected):
                            raise ReuseOutdated(scope.current_run_id)
                    order = scope.next_request_order
                    epoch = new.epoch if new.epoch is not None else scope.generation_epoch + 1
                    await cursor.execute(
                        """UPDATE analysis_scope
                           SET next_request_order = %s, generation_epoch = GREATEST(generation_epoch, %s),
                               updated_at = now()
                           WHERE id = %s""",
                        (order + 1, epoch, scope.id),
                    )
                    await cursor.execute(
                        f"""INSERT INTO analysis_run
                                (id, project_id, scope_id, recipe_id, recipe_version, definition, mode,
                                 epoch, idempotency_key, request_order, request_fingerprint,
                                 input_fingerprint, hash_version, input_manifest, parameters, context,
                                 depends_on, status, progress, attempt, writer_fence, output_manifest,
                                 metrics, reused_run_id, requested_by, created_at, updated_at,
                                 completed_at)
                            VALUES (%(id)s, %(project_id)s, %(scope_id)s, %(recipe_id)s,
                                    %(recipe_version)s, %(definition)s, %(mode)s, %(epoch)s,
                                    %(idempotency_key)s, %(order)s, %(request_fingerprint)s,
                                    %(input_fingerprint)s, 'c14n-v1', %(input_manifest)s,
                                    %(parameters)s, %(context)s, %(depends_on)s, %(status)s,
                                    %(progress)s, 0, %(writer_fence)s, %(output_manifest)s,
                                    %(metrics)s, %(reused_run_id)s, %(requested_by)s, now(), now(),
                                    CASE WHEN %(ready)s THEN now() END)
                            RETURNING {RUN_COLUMNS}""",
                        {
                            "id": str(uuid.uuid4()),
                            "project_id": new.project_id,
                            "scope_id": scope.id,
                            "recipe_id": new.recipe_id,
                            "recipe_version": new.recipe_version,
                            "definition": Json(new.definition),
                            "mode": str(new.mode),
                            "epoch": epoch,
                            "idempotency_key": new.idempotency_key,
                            "order": order,
                            "request_fingerprint": new.request_fingerprint,
                            "input_fingerprint": new.input_fingerprint,
                            "input_manifest": _json(new.input_manifest),
                            "parameters": Json(new.parameters),
                            "context": Json(new.context),
                            "depends_on": Json(list(new.depends_on)),
                            "status": str(new.status),
                            "progress": Json({"stage": str(new.status)}),
                            "writer_fence": scope.writer_fence,
                            "output_manifest": _json(new.output_manifest),
                            "metrics": Json(new.metrics),
                            "reused_run_id": new.reused_run_id,
                            "requested_by": new.requested_by,
                            "ready": new.status == RunStatus.READY,
                        },
                    )
                    row = await cursor.fetchone()
                    assert row is not None
                    run = _run(row)
                    if new.status == RunStatus.READY and new.reused_run_id is not None:
                        await cursor.execute(
                            """UPDATE analysis_scope
                               SET current_run_id = %s, current_request_order = %s, updated_at = now()
                               WHERE id = %s""",
                            (run.id, order, scope.id),
                        )
                    await self._remember_key(
                        cursor, project_id=new.project_id, key=new.idempotency_key, run=run, mode=str(new.mode)
                    )
                    return run, True
            except psycopg.errors.UniqueViolation:
                # The same key was accepted concurrently (in another scope's
                # transaction), or equivalent work raced in: resolve again.
                continue
        raise AnalysisStoreError("could not create or find the run after three attempts")

    async def _one_run(self, where: str, params: tuple[Any, ...]) -> Run | None:
        async with self._cursor() as cursor:
            await cursor.execute(f"SELECT {RUN_COLUMNS} FROM analysis_run WHERE {where}", params)
            row = await cursor.fetchone()
        return _run(row) if row else None

    async def get_run(self, run_id: str) -> Run | None:
        if not _is_uuid(run_id):
            return None
        return await self._one_run("id = %s", (run_id,))

    async def run_by_idempotency_key(self, project_id: str, key: str) -> Run | None:
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""SELECT {RUN_COLUMNS_R} FROM analysis_request_key AS k
                    JOIN analysis_run AS r ON r.id = k.run_id
                    WHERE k.project_id = %s AND k.idempotency_key = %s""",
                (project_id, key),
            )
            row = await cursor.fetchone()
        return _run(row) if row else None

    async def active_run(self, scope_id: str, request_fingerprint: str) -> Run | None:
        return await self._one_run(
            "scope_id = %s AND request_fingerprint = %s AND status = ANY(%s)"
            " ORDER BY request_order DESC LIMIT 1",
            (scope_id, request_fingerprint, list(ACTIVE)),
        )

    async def latest_run(self, scope_id: str, statuses: tuple[RunStatus, ...]) -> Run | None:
        return await self._one_run(
            "scope_id = %s AND status = ANY(%s) ORDER BY request_order DESC LIMIT 1",
            (scope_id, [str(status) for status in statuses]),
        )

    async def set_execution_ref(self, run_id: str, execution_ref: str) -> None:
        async with self._cursor() as cursor:
            await cursor.execute(
                "UPDATE analysis_run SET execution_ref = %s WHERE id = %s",
                (execution_ref[:128], run_id),
            )

    async def claim_run(self, run_id: str, lease: str, *, max_running: int | None) -> ClaimResult:
        """Start a queued run, or take over one whose lease deadline passed,
        under a new lease. With a running limit, counting and claiming are
        serialised per recipe by a transaction-scoped advisory lock, so the
        limit holds under concurrent claims. A run whose scope changed writer
        since it was accepted fails instead."""
        if not _is_uuid(run_id):
            return ClaimResult("inactive")
        async with self._transaction() as cursor:
            if max_running is not None:
                await cursor.execute("SELECT recipe_id FROM analysis_run WHERE id = %s", (run_id,))
                located = await cursor.fetchone()
                if located is None:
                    return ClaimResult("inactive")
                await cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                    (f"analysis_recipe_running:{located['recipe_id']}",),
                )
            await cursor.execute(
                f"""UPDATE analysis_run AS r
                    SET status = 'running', lease = %(lease)s, attempt = r.attempt + 1,
                        lease_expires_at = clock_timestamp() + make_interval(secs => %(lease_seconds)s),
                        started_at = COALESCE(r.started_at, now()), updated_at = now(),
                        error = NULL,
                        progress = (COALESCE(r.progress::jsonb, '{{}}'::jsonb)
                                    || jsonb_build_object('stage', 'running'))::json
                    WHERE r.id = %(run_id)s
                      AND (r.status = 'queued'
                           OR (r.status = 'running'
                               AND COALESCE(r.lease_expires_at, '-infinity') < clock_timestamp()))
                      AND EXISTS (SELECT 1 FROM analysis_scope AS s
                                  WHERE s.id = r.scope_id AND s.writer = 'analysis'
                                    AND s.writer_fence = r.writer_fence)
                      AND (%(max_running)s::int IS NULL OR (
                           SELECT count(*) FROM analysis_run AS o
                           WHERE o.recipe_id = r.recipe_id AND o.status = 'running'
                             AND o.id <> r.id AND o.lease_expires_at > clock_timestamp()
                          ) < %(max_running)s::int)
                    RETURNING {RUN_COLUMNS_R}""",
                {
                    "lease": lease,
                    "run_id": run_id,
                    "lease_seconds": self._lease_seconds,
                    "max_running": max_running,
                },
            )
            row = await cursor.fetchone()
            if row:
                return ClaimResult("claimed", _run(row))
            await cursor.execute(
                f"""UPDATE analysis_run AS r
                    SET status = 'failed', error = 'Another writer owns this scope now.',
                        completed_at = now(), updated_at = now()
                    WHERE r.id = %s AND r.status = 'queued'
                      AND NOT EXISTS (SELECT 1 FROM analysis_scope AS s
                                      WHERE s.id = r.scope_id AND s.writer = 'analysis'
                                        AND s.writer_fence = r.writer_fence)
                    RETURNING {RUN_COLUMNS_R}""",
                (run_id,),
            )
            fenced = await cursor.fetchone()
        if fenced:
            return ClaimResult("inactive", _run(fenced))
        current = await self.get_run(run_id)
        if current and current.status == RunStatus.QUEUED:
            return ClaimResult("busy", current)
        return ClaimResult("inactive", current)

    async def pin_inputs(
        self, run_id: str, lease: str, *, input_manifest: dict[str, Any], input_fingerprint: str
    ) -> bool:
        """Write a run's input manifest once. Pinning the identical manifest
        again is a no-op; a different one is refused."""
        if content_hash(input_manifest) != input_fingerprint:
            raise AnalysisValidationError("the input fingerprint is not the manifest's hash")
        async with self._owned(run_id, lease) as (cursor, owner):
            if owner is None:
                return False
            if owner["input_manifest"] is not None:
                if owner["input_fingerprint"] != input_fingerprint:
                    raise AnalysisValidationError("this run's inputs are already pinned to other revisions")
                return True
            await cursor.execute(
                "UPDATE analysis_run SET input_manifest = %s, input_fingerprint = %s WHERE id = %s",
                (Json(input_manifest), input_fingerprint, run_id),
            )
            return True

    async def heartbeat_run(self, run_id: str, lease: str, progress: dict[str, Any]) -> bool:
        async with self._owned(run_id, lease) as (cursor, owner):
            if owner is None:
                return False
            await cursor.execute(
                "UPDATE analysis_run SET progress = %s WHERE id = %s", (Json(progress), run_id)
            )
            return True

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
    ) -> bool:
        """End a running run without publishing it: failed, needs review or
        cancelled only while it is still this worker's (lease, wall-clock
        deadline, writer fence, not overtaken). Settling as superseded is the
        one exception: it needs the lease and a newer ready request in the
        scope, and nothing else."""
        if status in (RunStatus.READY, RunStatus.QUEUED, RunStatus.RUNNING, RunStatus.WAITING_FOR_INPUTS):
            raise ValueError(f"finish_run cannot set {status}")
        if not _is_uuid(run_id) or not lease:
            return False
        progress_extra: dict[str, Any] = {"stage": str(status)}
        if candidate_manifest is not None:
            progress_extra["candidateManifest"] = candidate_manifest
        async with self._transaction() as cursor:
            await cursor.execute("SELECT scope_id FROM analysis_run WHERE id = %s", (run_id,))
            located = await cursor.fetchone()
            if located is None:
                return False
            await cursor.execute(
                "SELECT writer, writer_fence, current_request_order FROM analysis_scope WHERE id = %s FOR SHARE",
                (located["scope_id"],),
            )
            scope = await cursor.fetchone()
            await cursor.execute(
                """SELECT request_order, writer_fence FROM analysis_run
                   WHERE id = %s AND lease = %s AND status = 'running' FOR UPDATE""",
                (run_id, lease),
            )
            run = await cursor.fetchone()
            if scope is None or run is None:
                return False
            overtaken = (
                scope["current_request_order"] is not None
                and scope["current_request_order"] >= run["request_order"]
            )
            if status == RunStatus.SUPERSEDED:
                allowed = overtaken
            else:
                allowed = (
                    not overtaken
                    and scope["writer"] == Writer.ANALYSIS
                    and scope["writer_fence"] == run["writer_fence"]
                    and await _lease_live(cursor, run_id)
                )
            if not allowed:
                return False
            await cursor.execute(
                """UPDATE analysis_run
                   SET status = %s, error = %s,
                       checks = COALESCE(%s::json, checks),
                       metrics = COALESCE(%s::json, metrics),
                       progress = (COALESCE(progress::jsonb, '{}'::jsonb) || %s::jsonb)::json,
                       completed_at = CASE WHEN %s THEN NULL ELSE now() END,
                       updated_at = now()
                   WHERE id = %s""",
                (
                    str(status),
                    error[:4000] if error else None,
                    _json(checks),
                    _json(metrics),
                    Json(progress_extra),
                    status == RunStatus.NEEDS_REVIEW,
                    run_id,
                ),
            )
            return True

    async def cancel_run(self, run_id: str) -> Run | None:
        if not _is_uuid(run_id):
            return None
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""UPDATE analysis_run
                    SET status = 'cancelled', completed_at = now(), updated_at = now()
                    WHERE id = %s AND status = ANY(%s)
                    RETURNING {RUN_COLUMNS}""",
                (run_id, [*ACTIVE, "needs_review"]),
            )
            row = await cursor.fetchone()
        return _run(row) if row else await self.get_run(run_id)

    async def requeue_run(self, run_id: str, *, idempotency_key: str | None = None) -> Run | None:
        """Bind a retry request to its run, atomically. Returns the run the key
        already answers; else the failed run queued again with its saved steps
        and pinned inputs (its lease cleared, so the next claim writes under a
        new one); else the run as it stands when it is no longer failed. An
        equivalent run in flight refuses the retry with `RetryConflict`: it is
        never returned in the failed run's place. Two retries racing with one
        key both return the run the first one bound."""
        if not _is_uuid(run_id):
            return None
        for _ in range(3):
            try:
                async with self._transaction() as cursor:
                    await cursor.execute(f"SELECT {RUN_COLUMNS} FROM analysis_run WHERE id = %s", (run_id,))
                    located = await cursor.fetchone()
                    if located is None:
                        return None
                    target = _run(located)
                    if idempotency_key:
                        await cursor.execute(
                            f"""SELECT {RUN_COLUMNS_R} FROM analysis_request_key AS k
                                JOIN analysis_run AS r ON r.id = k.run_id
                                WHERE k.project_id = %s AND k.idempotency_key = %s""",
                            (target.project_id, idempotency_key),
                        )
                        mapped = await cursor.fetchone()
                        if mapped is not None:
                            return _run(mapped)
                    await cursor.execute("SELECT id FROM analysis_scope WHERE id = %s FOR UPDATE", (target.scope_id,))
                    await cursor.execute(f"SELECT {RUN_COLUMNS} FROM analysis_run WHERE id = %s FOR UPDATE", (run_id,))
                    locked = await cursor.fetchone()
                    assert locked is not None
                    run = _run(locked)
                    if run.status == RunStatus.FAILED:
                        await cursor.execute(
                            f"""SELECT {RUN_COLUMNS} FROM analysis_run
                                WHERE scope_id = %s AND request_fingerprint = %s AND status = ANY(%s)
                                ORDER BY request_order DESC LIMIT 1""",
                            (run.scope_id, run.request_fingerprint, list(ACTIVE)),
                        )
                        active = await cursor.fetchone()
                        if active is not None:
                            raise RetryConflict(_run(active))
                        await cursor.execute(
                            f"""UPDATE analysis_run
                                SET status = 'queued', lease = NULL, lease_expires_at = NULL, error = NULL,
                                    completed_at = NULL, updated_at = now(),
                                    progress = (COALESCE(progress::jsonb, '{{}}'::jsonb)
                                                || jsonb_build_object('stage', 'queued'))::json
                                WHERE id = %s
                                RETURNING {RUN_COLUMNS}""",
                            (run_id,),
                        )
                        row = await cursor.fetchone()
                        assert row is not None
                        run = _run(row)
                    if idempotency_key:
                        await cursor.execute(
                            """INSERT INTO analysis_request_key
                                   (id, project_id, idempotency_key, run_id, scope_id, mode, created_at)
                               VALUES (%s, %s, %s, %s, %s, 'retry', now())
                               ON CONFLICT (project_id, idempotency_key) DO NOTHING
                               RETURNING id""",
                            (str(uuid.uuid4()), run.project_id, idempotency_key, run.id, run.scope_id),
                        )
                        if await cursor.fetchone() is None:
                            # Rolls this transaction back, requeue included.
                            raise _KeyTaken()
                    return run
            except (_KeyTaken, psycopg.errors.UniqueViolation):
                continue
        raise AnalysisStoreError("could not bind the retry after three attempts")

    async def wake_waiting_runs(self, project_id: str | None) -> WakeResult:
        """Settle waiting runs against their dependencies' durable rows.

        Only settleable waiters are selected (no dependency still queued,
        waiting, running or in review), so a batch is never filled by runs
        that cannot move while a runnable one waits behind them. All
        dependencies ready with a manifest: queued. A dependency failed,
        cancelled or gone: failed. A superseded dependency is re-resolved to
        its scope's current ready run when that run is newer and computes the
        same thing (recipe version, definition, parameters and context; the
        substitution is recorded in the waiting run's progress), and fails the
        waiting run otherwise. A second caller finds nothing left to change."""
        woken: list[Run] = []
        failed: list[Run] = []
        async with self._transaction() as cursor:
            await cursor.execute(
                f"""SELECT {RUN_COLUMNS_R} FROM analysis_run AS r
                    WHERE r.status = 'waiting_for_inputs'
                      AND (%(project_id)s::uuid IS NULL OR r.project_id = %(project_id)s::uuid)
                      AND NOT EXISTS (
                          SELECT 1
                          FROM jsonb_array_elements_text(COALESCE(r.depends_on::jsonb, '[]'::jsonb)) AS dep(run_id)
                          JOIN analysis_run AS d ON d.id::text = dep.run_id
                          WHERE d.status IN ('queued', 'waiting_for_inputs', 'running', 'needs_review')
                             OR (d.status = 'ready' AND d.output_manifest IS NULL))
                    ORDER BY r.created_at LIMIT %(limit)s
                    FOR UPDATE OF r SKIP LOCKED""",
                {"project_id": project_id, "limit": WAKE_BATCH},
            )
            waiting = [_run(row) for row in await cursor.fetchall()]
            for run in waiting:
                deps = _uuids(run.depends_on)
                await cursor.execute(
                    """SELECT id::text AS id, status, scope_id::text AS scope_id, request_order,
                              output_manifest IS NOT NULL AS has_manifest,
                              recipe_version, definition, parameters, context
                       FROM analysis_run WHERE id = ANY(%s::uuid[])""",
                    (deps,),
                )
                rows = {row["id"]: row for row in await cursor.fetchall()}
                resolved: list[str] = []
                substituted: dict[str, str] = {}
                broken = len(deps) != len(run.depends_on) or not deps
                pending = False
                for dep in deps:
                    row = rows.get(dep)
                    if row is None or row["status"] in ("failed", "cancelled"):
                        broken = True
                        break
                    if row["status"] == "ready" and row["has_manifest"]:
                        resolved.append(dep)
                    elif row["status"] == "superseded":
                        await cursor.execute(
                            """SELECT r.id::text AS id, s.current_request_order, r.recipe_version,
                                      r.definition, r.parameters, r.context
                               FROM analysis_scope AS s JOIN analysis_run AS r ON r.id = s.current_run_id
                               WHERE s.id = %s""",
                            (row["scope_id"],),
                        )
                        current = await cursor.fetchone()
                        if (
                            current is None
                            or current["current_request_order"] is None
                            or current["current_request_order"] < row["request_order"]
                            or _computation_identity(current) != _computation_identity(row)
                        ):
                            broken = True
                            break
                        resolved.append(current["id"])
                        substituted[dep] = current["id"]
                    else:
                        pending = True
                        resolved.append(dep)
                if broken:
                    status, error = "failed", "A recipe this run depends on did not finish with a usable output."
                elif pending:
                    continue
                else:
                    status, error = "queued", None
                progress = {**run.progress, "stage": status}
                if substituted:
                    progress["reresolved"] = {**dict(run.progress.get("reresolved") or {}), **substituted}
                await cursor.execute(
                    f"""UPDATE analysis_run
                        SET status = %s, error = %s, depends_on = %s, progress = %s,
                            completed_at = CASE WHEN %s THEN now() END, updated_at = now()
                        WHERE id = %s
                        RETURNING {RUN_COLUMNS}""",
                    (
                        status,
                        error,
                        Json(run.depends_on if broken else resolved),
                        Json(progress),
                        status == "failed",
                        run.id,
                    ),
                )
                updated = await cursor.fetchone()
                assert updated is not None
                if status == "queued":
                    woken.append(_run(updated))
                else:
                    failed.append(_run(updated))
        return WakeResult(woken=tuple(woken), failed=tuple(failed))

    async def expire_stale_runs(self) -> list[str]:
        async with self._cursor() as cursor:
            await cursor.execute(
                """UPDATE analysis_run
                   SET status = 'failed', error = 'The run stopped without finishing.',
                       completed_at = now(), updated_at = now()
                   WHERE status = 'running' AND lease_expires_at < clock_timestamp()
                   RETURNING id::text AS id"""
            )
            return [row["id"] for row in await cursor.fetchall()]

    async def redispatch_queued_runs(self, older_than_seconds: int, limit: int) -> list[Run]:
        """Queued runs nobody has claimed for a while (a lost message, a worker
        that deferred under backpressure). Touched so the next sweep waits
        again; a duplicate message is harmless because only one claim wins."""
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""UPDATE analysis_run AS r SET updated_at = now()
                    WHERE r.id IN (
                        SELECT id FROM analysis_run
                        WHERE status = 'queued'
                          AND updated_at < now() - make_interval(secs => %s)
                        ORDER BY updated_at LIMIT %s
                        FOR UPDATE SKIP LOCKED)
                    RETURNING {RUN_COLUMNS_R}""",
                (older_than_seconds, limit),
            )
            return [_run(row) for row in await cursor.fetchall()]

    # ── steps ───────────────────────────────────────────────────────────

    async def get_steps(self, run_id: str) -> list[Step]:
        if not _is_uuid(run_id):
            return []
        async with self._cursor() as cursor:
            await cursor.execute(
                f"SELECT {STEP_COLUMNS} FROM analysis_step WHERE run_id = %s ORDER BY created_at",
                (run_id,),
            )
            return [_step(row) for row in await cursor.fetchall()]

    async def get_step(self, step_id: str) -> Step | None:
        if not _is_uuid(step_id):
            return None
        async with self._cursor() as cursor:
            await cursor.execute(f"SELECT {STEP_COLUMNS} FROM analysis_step WHERE id = %s", (step_id,))
            row = await cursor.fetchone()
        return _step(row) if row else None

    async def find_reusable_step(self, project_id: str, cache_key: str) -> Step | None:
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""SELECT {STEP_COLUMNS} FROM analysis_step
                    WHERE project_id = %s AND cache_key = %s AND status = 'completed'
                      AND reused_step_id IS NULL
                    ORDER BY completed_at DESC LIMIT 1""",
                (project_id, cache_key),
            )
            row = await cursor.fetchone()
        return _step(row) if row else None

    async def checkpoint_step(self, run_id: str, lease: str, write: StepWrite) -> Step | None:
        """Save a step's state under the run's lease. A completed step is an
        immutable artifact: the same completed write again returns it, and a
        write with another cache key raises `StepConflict`."""
        async with self._owned(run_id, lease) as (cursor, owner):
            if owner is None:
                return None
            await cursor.execute(
                f"SELECT {STEP_COLUMNS} FROM analysis_step WHERE run_id = %s AND step_key = %s FOR UPDATE",
                (run_id, write.step_key),
            )
            existing = await cursor.fetchone()
            if existing is not None and existing["status"] == "completed":
                if existing["cache_key"] == write.cache_key:
                    return _step(existing)
                raise StepConflict(f"step {write.step_key} already completed with other inputs")
            params = {
                "run_id": run_id,
                "lease": lease,
                "project_id": owner["project_id"],
                "step_key": write.step_key,
                "step_version": write.step_version,
                "kind": str(write.kind),
                "cache_key": write.cache_key,
                "status": str(write.status),
                "reused_step_id": write.reused_step_id,
                "checkpoint": _json(write.checkpoint),
                "output": _json(write.output),
                "validation": Json(list(write.validation)),
                "usage": Json(write.usage),
                "error": write.error[:4000] if write.error else None,
                "completed": write.status == StepStatus.COMPLETED,
            }
            if existing is None:
                await cursor.execute(
                    f"""INSERT INTO analysis_step
                            (id, project_id, run_id, step_key, step_version, kind, cache_key,
                             hash_version, status, attempt, lease, reused_step_id, checkpoint, output,
                             validation, usage, error, created_at, updated_at, completed_at)
                        VALUES (%(id)s, %(project_id)s, %(run_id)s, %(step_key)s, %(step_version)s,
                                %(kind)s, %(cache_key)s, 'c14n-v1', %(status)s, 1, %(lease)s,
                                %(reused_step_id)s, %(checkpoint)s, %(output)s, %(validation)s,
                                %(usage)s, %(error)s, now(), now(),
                                CASE WHEN %(completed)s THEN now() END)
                        RETURNING {STEP_COLUMNS}""",
                    {**params, "id": str(uuid.uuid4())},
                )
            else:
                await cursor.execute(
                    f"""UPDATE analysis_step SET
                            step_version = %(step_version)s, kind = %(kind)s, cache_key = %(cache_key)s,
                            status = %(status)s,
                            attempt = attempt + CASE WHEN lease IS DISTINCT FROM %(lease)s THEN 1 ELSE 0 END,
                            lease = %(lease)s, reused_step_id = %(reused_step_id)s,
                            checkpoint = %(checkpoint)s, output = %(output)s,
                            validation = %(validation)s, usage = %(usage)s, error = %(error)s,
                            updated_at = now(),
                            completed_at = CASE WHEN %(completed)s THEN now() END
                        WHERE run_id = %(run_id)s AND step_key = %(step_key)s
                        RETURNING {STEP_COLUMNS}""",
                    params,
                )
            row = await cursor.fetchone()
            return _step(row) if row else None

    # ── objects and revisions ───────────────────────────────────────────

    async def ensure_object(
        self,
        *,
        project_id: str,
        type: str,
        lineage_key: str,
        scope_id: str | None,
        object_id: str | None = None,
    ) -> ObjectRecord:
        """The object of this lineage, created when new. A fixed `object_id`
        (a deterministic import id) must name this lineage's object: an
        existing object under another id, or that id already naming another
        object, is a `ReferenceViolation`."""
        if object_id is not None:
            if not _is_uuid(object_id):
                raise AnalysisValidationError(f"object id {object_id!r} is not a uuid")
            object_id = str(uuid.UUID(str(object_id)))
        async with self._cursor() as cursor:
            # No conflict target: a taken id is caught below, never raised.
            await cursor.execute(
                f"""INSERT INTO analysis_object
                        (id, project_id, type, lineage_key, scope_id, revision_count, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, 0, now(), now())
                    ON CONFLICT DO NOTHING
                    RETURNING {OBJECT_COLUMNS}""",
                (object_id or str(uuid.uuid4()), project_id, type, lineage_key, scope_id),
            )
            row = await cursor.fetchone()
            if row is None:
                await cursor.execute(
                    f"""SELECT {OBJECT_COLUMNS} FROM analysis_object
                        WHERE project_id = %s AND type = %s AND lineage_key = %s""",
                    (project_id, type, lineage_key),
                )
                row = await cursor.fetchone()
        if row is None:
            if object_id is not None:
                raise ReferenceViolation(f"object id {object_id} names another object")
            raise AnalysisStoreError("object vanished after a conflicting insert")
        record = _object(row)
        if object_id is not None and record.id != object_id:
            raise ReferenceViolation(f"object {lineage_key!r} already exists under another id")
        return record

    async def get_object(self, object_id: str) -> ObjectRecord | None:
        if not _is_uuid(object_id):
            return None
        async with self._cursor() as cursor:
            await cursor.execute(f"SELECT {OBJECT_COLUMNS} FROM analysis_object WHERE id = %s", (object_id,))
            row = await cursor.fetchone()
        return _object(row) if row else None

    async def get_revisions(self, project_id: str, revision_ids: list[str]) -> dict[str, ObjectRevision]:
        ids = _uuids(revision_ids)
        if not ids:
            return {}
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""SELECT {REVISION_COLUMNS} FROM analysis_object_revision
                    WHERE project_id = %s AND id = ANY(%s::uuid[])""",
                (project_id, ids),
            )
            return {row["id"]: _revision(row) for row in await cursor.fetchall()}

    async def current_revisions(
        self, project_id: str, scope_ids: list[str] | None = None
    ) -> dict[str, ObjectRevision]:
        """Every published head in a project, keyed by object identity."""
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""SELECT {_select('r', REVISION_UUIDS, REVISION_PLAIN)}
                    FROM analysis_object AS o
                    JOIN analysis_object_revision AS r ON r.id = o.current_revision_id
                    WHERE o.project_id = %s AND r.status = 'published'
                      AND (%s::uuid[] IS NULL OR o.scope_id = ANY(%s::uuid[]))""",
                (project_id, scope_ids, scope_ids),
            )
            rows = await cursor.fetchall()
        return {revision.object_id: revision for row in rows if (revision := _revision(row))}

    @staticmethod
    def _revision_params(new: NewRevision, revision_id: str, number: int, status: str) -> dict[str, Any]:
        return {
            "id": revision_id,
            "project_id": new.project_id,
            "object_id": new.object_id,
            "number": number,
            "type": new.type,
            "schema_version": new.schema_version,
            "status": status,
            "published": status == "published",
            "origin": str(new.origin),
            "payload": Json(new.payload),
            "attributes": Json(new.attributes),
            "provenance": Json(new.provenance.as_json()),
            "content_hash": new.content_hash,
            "run_id": new.run_id,
            "parent_revision_id": new.parent_revision_id,
            "embedding_refs": _json(new.embedding_refs),
            "actor_id": new.actor_id,
            "reason": new.reason,
            "change_kind": new.change_kind,
        }

    _INSERT_REVISION = f"""INSERT INTO analysis_object_revision
            (id, project_id, object_id, revision_number, type, schema_version, status, origin,
             payload, attributes, provenance, content_hash, hash_version, run_id,
             parent_revision_id, embedding_refs, actor_id, reason, change_kind, created_at,
             published_at)
        VALUES (%(id)s, %(project_id)s, %(object_id)s, %(number)s, %(type)s, %(schema_version)s,
                %(status)s, %(origin)s, %(payload)s, %(attributes)s, %(provenance)s,
                %(content_hash)s, 'c14n-v1', %(run_id)s, %(parent_revision_id)s,
                %(embedding_refs)s, %(actor_id)s, %(reason)s, %(change_kind)s, now(),
                CASE WHEN %(published)s THEN now() END)
        RETURNING {REVISION_COLUMNS}"""

    async def stage_revision(self, run_id: str, lease: str, new: NewRevision) -> ObjectRevision | None:
        """Stage (or, on a replay, replace) this run's candidate revision of an
        object. Invisible to published reads until the run publishes."""
        if new.status not in (RevisionStatus.STAGED, RevisionStatus.CANDIDATE):
            raise ValueError("stage_revision writes staged or candidate revisions only")
        if new.run_id != run_id or new.provenance.run_id != run_id:
            raise ReferenceViolation("a staged revision names the run that stages it")
        async with self._owned(run_id, lease) as (cursor, owner):
            if owner is None:
                return None
            if owner["project_id"] != new.project_id:
                raise ReferenceViolation("a run stages revisions of its own project only")
            await cursor.execute(
                """SELECT id::text AS id FROM analysis_object_revision
                   WHERE run_id = %s AND object_id = %s AND status IN ('staged', 'candidate')
                   FOR UPDATE""",
                (run_id, new.object_id),
            )
            existing = await cursor.fetchone()
            if existing:
                await cursor.execute(
                    f"""UPDATE analysis_object_revision
                        SET status = %(status)s, schema_version = %(schema_version)s,
                            payload = %(payload)s, attributes = %(attributes)s,
                            provenance = %(provenance)s, content_hash = %(content_hash)s,
                            parent_revision_id = %(parent_revision_id)s,
                            embedding_refs = %(embedding_refs)s
                        WHERE id = %(id)s
                        RETURNING {REVISION_COLUMNS}""",
                    self._revision_params(new, existing["id"], 0, str(new.status)),
                )
                row = await cursor.fetchone()
                return _revision(row) if row else None
            await cursor.execute(
                """UPDATE analysis_object SET revision_count = revision_count + 1, updated_at = now()
                   WHERE id = %s AND project_id = %s AND type = %s
                   RETURNING revision_count""",
                (new.object_id, new.project_id, new.type),
            )
            counted = await cursor.fetchone()
            if counted is None:
                raise ReferenceViolation(f"object {new.object_id} is not a {new.type} of this project")
            await cursor.execute(
                self._INSERT_REVISION,
                self._revision_params(
                    new, new.revision_id or str(uuid.uuid4()), counted["revision_count"], str(new.status)
                ),
            )
            row = await cursor.fetchone()
            assert row is not None
            return _revision(row)

    async def append_revision(self, new: NewRevision, *, expected_revision_id: str | None) -> ObjectRevision:
        """Publish an authored or imported revision as the object's new head,
        only when the head is still `expected_revision_id`. The object's scope
        is locked first, as publication locks it, and the head change commits
        together with its outbox event and the scope's next publication
        sequence."""
        if new.origin == Origin.GENERATED:
            raise ValueError("generated revisions publish through their run")
        async with self._transaction() as cursor:
            await cursor.execute(
                "SELECT scope_id::text AS scope_id, type FROM analysis_object WHERE id = %s AND project_id = %s",
                (new.object_id, new.project_id),
            )
            located = await cursor.fetchone()
            if located is None or located["type"] != new.type:
                raise ReferenceViolation(f"object {new.object_id} is not a {new.type} of this project")
            if located["scope_id"] is None:
                raise ReferenceViolation(f"object {new.object_id} has no scope to publish its edits in")
            if new.embedding_refs is not None:
                # As publication checks a run's revisions: this project's
                # vector, of the configuration the reference names.
                embedding_id = str(new.embedding_refs.get("embeddingId") or "")
                if not _is_uuid(embedding_id):
                    raise ReferenceViolation("an embedding reference names an embedding id")
                await cursor.execute(
                    "SELECT project_id::text AS project_id, config_key FROM map_embedding WHERE id = %s",
                    (embedding_id,),
                )
                embedding = await cursor.fetchone()
                if embedding is None or embedding["project_id"] != new.project_id:
                    raise ReferenceViolation("the revision references an embedding that is not this project's")
                wanted_config = new.embedding_refs.get("configKey")
                if wanted_config and embedding["config_key"] != wanted_config:
                    raise ReferenceViolation("the revision references an embedding of another configuration")
            await cursor.execute(
                f"SELECT {SCOPE_COLUMNS} FROM analysis_scope WHERE id = %s FOR UPDATE", (located["scope_id"],)
            )
            scope_row = await cursor.fetchone()
            assert scope_row is not None
            scope = _scope(scope_row)
            await cursor.execute(f"SELECT {OBJECT_COLUMNS} FROM analysis_object WHERE id = %s FOR UPDATE", (new.object_id,))
            locked = await cursor.fetchone()
            assert locked is not None
            if new.revision_id:
                await cursor.execute(
                    f"SELECT {REVISION_COLUMNS} FROM analysis_object_revision WHERE id = %s",
                    (new.revision_id,),
                )
                already = await cursor.fetchone()
                if already is not None:
                    if already["object_id"] != new.object_id:
                        raise ReferenceViolation(f"revision {new.revision_id} belongs to another object")
                    return _revision(already)
            if locked["current_revision_id"] != expected_revision_id:
                current = None
                if locked["current_revision_id"]:
                    await cursor.execute(
                        f"SELECT {REVISION_COLUMNS} FROM analysis_object_revision WHERE id = %s",
                        (locked["current_revision_id"],),
                    )
                    head = await cursor.fetchone()
                    current = _revision(head) if head else None
                raise RevisionConflict(new.object_id, expected_revision_id, current)
            await cursor.execute(
                "UPDATE analysis_object SET revision_count = revision_count + 1 WHERE id = %s RETURNING revision_count",
                (new.object_id,),
            )
            counted = await cursor.fetchone()
            assert counted is not None
            await cursor.execute(
                self._INSERT_REVISION,
                self._revision_params(new, new.revision_id or str(uuid.uuid4()), counted["revision_count"], "published"),
            )
            row = await cursor.fetchone()
            assert row is not None
            await cursor.execute(
                "UPDATE analysis_object SET current_revision_id = %s, updated_at = now() WHERE id = %s",
                (row["id"], new.object_id),
            )
            sequence = scope.publication_sequence + 1
            await cursor.execute(
                "UPDATE analysis_scope SET publication_sequence = %s, updated_at = now() WHERE id = %s",
                (sequence, scope.id),
            )
            await cursor.execute(
                """INSERT INTO analysis_outbox
                       (id, project_id, scope_id, sequence, event_type, payload, status, attempts,
                        next_attempt_at, consumers, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, 'revision_published', %s, 'pending', 0, now(), '{}', now(), now())""",
                (
                    str(uuid.uuid4()),
                    new.project_id,
                    scope.id,
                    sequence,
                    Json(
                        {
                            "objectId": new.object_id,
                            "revisionId": row["id"],
                            "type": new.type,
                            "origin": str(new.origin),
                            "recipeId": new.provenance.recipe_id,
                            "membershipExcluded": bool(
                                new.provenance.extra.get("membershipExcluded")
                            ),
                            "previousRevisionId": expected_revision_id,
                            "sequence": sequence,
                        }
                    ),
                ),
            )
            self._fault("append:outbox")
            return _revision(row)

    async def stage_relation(self, run_id: str, lease: str, new: NewRelation) -> Relation | None:
        if new.run_id != run_id:
            raise ReferenceViolation("a staged relation names the run that stages it")
        async with self._owned(run_id, lease) as (cursor, owner):
            if owner is None:
                return None
            await cursor.execute(
                f"""INSERT INTO analysis_relation
                        (id, project_id, type, basis, status, from_revision_id, to_revision_id,
                         from_object_id, to_object_id, attributes, provenance, content_hash,
                         hash_version, run_id, created_at)
                    VALUES (%(id)s, %(project_id)s, %(type)s, %(basis)s, 'staged',
                            %(from_revision_id)s, %(to_revision_id)s, %(from_object_id)s,
                            %(to_object_id)s, %(attributes)s, %(provenance)s, %(content_hash)s,
                            'c14n-v1', %(run_id)s, now())
                    ON CONFLICT (run_id, type, from_revision_id, to_revision_id)
                        WHERE status = 'staged'
                    DO UPDATE SET basis = EXCLUDED.basis, attributes = EXCLUDED.attributes,
                                  provenance = EXCLUDED.provenance,
                                  content_hash = EXCLUDED.content_hash
                    RETURNING {RELATION_COLUMNS}""",
                {
                    "run_id": run_id,
                    "id": str(uuid.uuid4()),
                    "project_id": owner["project_id"],
                    "type": new.type,
                    "basis": str(new.basis),
                    "from_revision_id": new.from_revision_id,
                    "to_revision_id": new.to_revision_id,
                    "from_object_id": new.from_object_id,
                    "to_object_id": new.to_object_id,
                    "attributes": Json(new.attributes),
                    "provenance": Json(new.provenance),
                    "content_hash": new.content_hash,
                },
            )
            row = await cursor.fetchone()
            return _relation(row) if row else None

    async def import_relation(self, new: NewRelation, *, relation_id: str | None = None) -> Relation:
        """Publish an imported relation, which belongs to no run, between two
        published revisions of its objects in its project. A repeat returns the
        first row: the one under the same fixed id, or without one the same
        relation with the same content."""
        if new.run_id is not None:
            raise ReferenceViolation("an imported relation belongs to no run")
        if relation_id is not None:
            if not _is_uuid(relation_id):
                raise AnalysisValidationError(f"relation id {relation_id!r} is not a uuid")
            relation_id = str(uuid.UUID(str(relation_id)))
        identity = (new.project_id, new.type, new.from_revision_id, new.to_revision_id, new.content_hash)
        async with self._transaction() as cursor:
            # Two imports of one relation queue here instead of writing it twice.
            await cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (f"analysis_relation_import:{new.project_id}:{new.content_hash}",),
            )
            if relation_id is not None:
                await cursor.execute(f"SELECT {RELATION_COLUMNS} FROM analysis_relation WHERE id = %s", (relation_id,))
            else:
                await cursor.execute(
                    f"""SELECT {RELATION_COLUMNS} FROM analysis_relation
                        WHERE project_id = %s AND type = %s AND from_revision_id = %s
                          AND to_revision_id = %s AND content_hash = %s
                          AND run_id IS NULL AND status = 'published'
                        LIMIT 1""",
                    identity,
                )
            existing = await cursor.fetchone()
            if existing is not None:
                found = (
                    existing["project_id"],
                    existing["type"],
                    existing["from_revision_id"],
                    existing["to_revision_id"],
                    existing["content_hash"],
                )
                if found != identity or existing["run_id"] is not None:
                    raise ReferenceViolation(f"relation id {relation_id} names another relation")
                return _relation(existing)
            ends = _uuids([new.from_revision_id, new.to_revision_id])
            published: dict[str, str] = {}
            if len(ends) == 2:
                await cursor.execute(
                    """SELECT id::text AS id, object_id::text AS object_id FROM analysis_object_revision
                       WHERE project_id = %s AND status = 'published' AND id = ANY(%s::uuid[])
                       FOR SHARE""",
                    (new.project_id, ends),
                )
                published = {row["id"]: row["object_id"] for row in await cursor.fetchall()}
            if (
                published.get(new.from_revision_id) != new.from_object_id
                or published.get(new.to_revision_id) != new.to_object_id
            ):
                raise ReferenceViolation(
                    "an imported relation connects published revisions of its objects in this project"
                )
            await cursor.execute(
                f"""INSERT INTO analysis_relation
                        (id, project_id, type, basis, status, from_revision_id, to_revision_id,
                         from_object_id, to_object_id, attributes, provenance, content_hash,
                         hash_version, run_id, created_at, published_at)
                    VALUES (%(id)s, %(project_id)s, %(type)s, %(basis)s, 'published',
                            %(from_revision_id)s, %(to_revision_id)s, %(from_object_id)s,
                            %(to_object_id)s, %(attributes)s, %(provenance)s, %(content_hash)s,
                            'c14n-v1', NULL, now(), now())
                    ON CONFLICT (id) DO NOTHING
                    RETURNING {RELATION_COLUMNS}""",
                {
                    "id": relation_id or str(uuid.uuid4()),
                    "project_id": new.project_id,
                    "type": new.type,
                    "basis": str(new.basis),
                    "from_revision_id": new.from_revision_id,
                    "to_revision_id": new.to_revision_id,
                    "from_object_id": new.from_object_id,
                    "to_object_id": new.to_object_id,
                    "attributes": Json(new.attributes),
                    "provenance": Json(new.provenance),
                    "content_hash": new.content_hash,
                },
            )
            row = await cursor.fetchone()
            if row is None:
                # The fixed id was taken by another relation meanwhile.
                raise ReferenceViolation(f"relation id {relation_id} names another relation")
            return _relation(row)

    async def run_candidates(self, run_id: str) -> tuple[list[ObjectRevision], list[Relation]]:
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""SELECT {REVISION_COLUMNS} FROM analysis_object_revision
                    WHERE run_id = %s AND status IN ('staged', 'candidate')
                    ORDER BY created_at""",
                (run_id,),
            )
            revisions = [_revision(row) for row in await cursor.fetchall()]
            await cursor.execute(
                f"""SELECT {RELATION_COLUMNS} FROM analysis_relation
                    WHERE run_id = %s AND status = 'staged' ORDER BY created_at""",
                (run_id,),
            )
            relations = [_relation(row) for row in await cursor.fetchall()]
        return revisions, relations

    async def get_relations(self, project_id: str, relation_ids: list[str]) -> dict[str, Relation]:
        ids = _uuids(relation_ids)
        if not ids:
            return {}
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""SELECT {RELATION_COLUMNS} FROM analysis_relation
                    WHERE project_id = %s AND id = ANY(%s::uuid[])""",
                (project_id, ids),
            )
            return {row["id"]: _relation(row) for row in await cursor.fetchall()}

    async def assessments_for(self, project_id: str, revision_ids: list[str]) -> dict[str, ObjectRevision]:
        """The latest published assessment of each exact revision, by that
        revision's id, for assembling a new snapshot. The `assesses` relation's
        id is added to the assessment's provenance extra as
        `assessesRelationId`. Never used to read an existing snapshot, which
        pins its assessments."""
        ids = _uuids(revision_ids)
        if not ids:
            return {}
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""SELECT DISTINCT ON (rel.to_revision_id)
                           rel.to_revision_id::text AS target_revision_id,
                           rel.id::text AS relation_id, {REVISION_COLUMNS_V}
                    FROM analysis_relation AS rel
                    JOIN analysis_object_revision AS v ON v.id = rel.from_revision_id
                    WHERE rel.project_id = %s AND rel.type = 'assesses'
                      AND rel.status = 'published' AND v.status = 'published'
                      AND v.type = 'fact_check_assessment'
                      AND rel.to_revision_id = ANY(%s::uuid[])
                    ORDER BY rel.to_revision_id, v.published_at DESC, v.revision_number DESC""",
                (project_id, ids),
            )
            rows = await cursor.fetchall()
        out: dict[str, ObjectRevision] = {}
        for row in rows:
            revision = _revision(row)
            extra = {**revision.provenance.extra, "assessesRelationId": row["relation_id"]}
            out[row["target_revision_id"]] = replace(revision, provenance=replace(revision.provenance, extra=extra))
        return out

    # ── manifest validation, inside a transaction ───────────────────────

    async def _check_revisions(
        self,
        cursor: db.Cursor,
        project_id: str,
        entries: list[dict[str, Any]],
        *,
        staged_run_id: str | None,
        reasons: list[str],
    ) -> dict[str, dict[str, Any]]:
        object_ids = [str(e.get("objectId")) for e in entries]
        revision_ids = [str(e.get("revisionId")) for e in entries]
        if len(set(object_ids)) != len(object_ids):
            reasons.append("the manifest shows more than one revision of one object")
        if len(set(revision_ids)) != len(revision_ids):
            reasons.append("the manifest lists a revision twice")
        bad = [rid for rid in revision_ids if not _is_uuid(rid)]
        if bad:
            reasons.append(f"{len(bad)} revision ids are not ids")
        rows: dict[str, dict[str, Any]] = {}
        if _uuids(revision_ids):
            await cursor.execute(
                """SELECT id::text AS id, project_id::text AS project_id, object_id::text AS object_id,
                          type, status, run_id::text AS run_id,
                          parent_revision_id::text AS parent_revision_id, provenance, embedding_refs
                   FROM analysis_object_revision WHERE id = ANY(%s::uuid[])""",
                (_uuids(revision_ids),),
            )
            rows = {row["id"]: row for row in await cursor.fetchall()}
        for entry in entries:
            rid = str(entry.get("revisionId"))
            row = rows.get(rid)
            if row is None:
                if _is_uuid(rid):
                    reasons.append(f"revision {rid} does not exist")
                continue
            if row["project_id"] != project_id:
                reasons.append(f"revision {rid} belongs to another project")
            elif row["object_id"] != entry.get("objectId") or row["type"] != entry.get("type"):
                reasons.append(f"revision {rid} is not a {entry.get('type')} of object {entry.get('objectId')}")
            elif row["status"] == "published":
                continue
            elif row["status"] == "staged" and staged_run_id and row["run_id"] == staged_run_id:
                continue
            else:
                reasons.append(f"revision {rid} is {row['status']}, not publishable here")
        return rows

    async def _check_relations(
        self,
        cursor: db.Cursor,
        project_id: str,
        entries: list[dict[str, Any]],
        *,
        endpoints: set[str],
        staged_run_id: str | None,
        reasons: list[str],
    ) -> None:
        ids = [str(e.get("relationId")) for e in entries]
        if len(set(ids)) != len(ids):
            reasons.append("the manifest lists a relation twice")
        rows: dict[str, dict[str, Any]] = {}
        if _uuids(ids):
            await cursor.execute(
                """SELECT id::text AS id, project_id::text AS project_id, type, status,
                          run_id::text AS run_id, from_revision_id::text AS from_revision_id,
                          to_revision_id::text AS to_revision_id
                   FROM analysis_relation WHERE id = ANY(%s::uuid[])""",
                (_uuids(ids),),
            )
            rows = {row["id"]: row for row in await cursor.fetchall()}
        for entry in entries:
            rid = str(entry.get("relationId"))
            row = rows.get(rid)
            if row is None:
                reasons.append(f"relation {rid} does not exist")
                continue
            if row["project_id"] != project_id:
                reasons.append(f"relation {rid} belongs to another project")
                continue
            if (row["type"], row["from_revision_id"], row["to_revision_id"]) != (
                entry.get("type"),
                entry.get("from"),
                entry.get("to"),
            ):
                reasons.append(f"relation {rid} does not match its manifest entry")
                continue
            if not (
                row["status"] == "published"
                or (row["status"] == "staged" and staged_run_id and row["run_id"] == staged_run_id)
            ):
                reasons.append(f"relation {rid} is {row['status']}, not publishable here")
                continue
            for end in (row["from_revision_id"], row["to_revision_id"]):
                if end not in endpoints:
                    reasons.append(f"relation {rid} points at revision {end}, which is not in this output")

    async def _published_revision_ids(self, cursor: db.Cursor, project_id: str, ids: list[str]) -> set[str]:
        if not _uuids(ids):
            return set()
        await cursor.execute(
            """SELECT id::text AS id FROM analysis_object_revision
               WHERE project_id = %s AND status = 'published' AND id = ANY(%s::uuid[])""",
            (project_id, _uuids(ids)),
        )
        return {row["id"] for row in await cursor.fetchall()}

    async def _check_staged_references(
        self,
        cursor: db.Cursor,
        run: Run,
        entries: list[dict[str, Any]],
        pinned: set[str],
        reasons: list[str],
    ) -> None:
        """Staged revisions name this run and recipe and cite only pinned
        inputs; every output entry, staged or reused, references embeddings of
        this project and of the configuration it names."""
        embedding_refs: dict[str, dict[str, Any]] = {}
        for row in entries:
            if row["status"] == "staged":
                provenance = row["provenance"] or {}
                if (provenance.get("runId"), provenance.get("recipeId"), provenance.get("recipeVersion")) != (
                    run.id,
                    run.recipe_id,
                    run.recipe_version,
                ):
                    reasons.append(f"revision {row['id']} names another run or recipe in its provenance")
                stray = [rid for rid in provenance.get("inputRevisionIds") or [] if str(rid) not in pinned]
                if stray:
                    reasons.append(f"revision {row['id']} cites {len(stray)} revisions that are not pinned inputs")
            ref = row["embedding_refs"] or {}
            if ref.get("embeddingId"):
                embedding_refs[str(row["id"])] = ref
        wanted = _uuids([str(ref["embeddingId"]) for ref in embedding_refs.values()])
        if len(wanted) != len(embedding_refs):
            reasons.append("an embedding reference is not an id")
        found: dict[str, dict[str, Any]] = {}
        if wanted:
            await cursor.execute(
                """SELECT id::text AS id, project_id::text AS project_id, config_key
                   FROM map_embedding WHERE id = ANY(%s::uuid[])""",
                (wanted,),
            )
            found = {row["id"]: row for row in await cursor.fetchall()}
        for revision_id, ref in embedding_refs.items():
            embedding = found.get(str(ref["embeddingId"]))
            if embedding is None or embedding["project_id"] != run.project_id:
                reasons.append(f"revision {revision_id} references an embedding that is not this project's")
            elif ref.get("configKey") and embedding["config_key"] != ref["configKey"]:
                reasons.append(f"revision {revision_id} references an embedding of another configuration")

    async def _check_steps(
        self, cursor: db.Cursor, run: Run, checks: list[dict[str, Any]], reasons: list[str]
    ) -> None:
        """Every step completed, no recorded check failed, every declared check
        step ran, and no supplied outcome failed or waits for review."""
        for outcome in checks:
            if outcome.get("status") in ("failed", "needs_review"):
                reasons.append(f"check {outcome.get('check')} is {outcome.get('status')}")
        await cursor.execute(
            "SELECT step_key, status, validation FROM analysis_step WHERE run_id = %s", (run.id,)
        )
        steps = await cursor.fetchall()
        for step in steps:
            if step["status"] != "completed":
                reasons.append(f"step {step['step_key']} is {step['status']}")
            for outcome in step["validation"] or []:
                if outcome.get("status") in ("failed", "needs_review"):
                    reasons.append(f"step {step['step_key']} recorded check {outcome.get('check')} as {outcome.get('status')}")
        declared = [
            str(step.get("key"))
            for step in (run.definition or {}).get("steps") or []
            if step.get("kind") == str(StepKind.CHECK)
        ]
        keys = [str(step["step_key"]) for step in steps if step["status"] == "completed"]
        for key in declared:
            if not any(k == key or k.startswith(f"{key}:") for k in keys):
                reasons.append(f"required check step {key} did not run")

    # ── publication ─────────────────────────────────────────────────────

    async def publish_run(
        self,
        run_id: str,
        lease: str,
        *,
        manifest: dict[str, Any],
        checks: list[dict[str, Any]],
        metrics: dict[str, Any],
    ) -> PublishResult:
        """Make a run its scope's current ready output, in one transaction:
        lock the scope and the run; recheck lease, deadline, writer fence and
        request order; validate the manifest against the run's pinned inputs,
        its staged rows' provenance and embeddings, its steps and checks, and
        every entry's expected object head; publish the staged rows, advance
        the heads and append the outbox event. Everything commits together or
        nothing does."""
        run = await self.get_run(run_id)
        if run is None:
            return PublishResult("inactive")
        async with self._transaction() as cursor:
            await cursor.execute(
                f"SELECT {SCOPE_COLUMNS} FROM analysis_scope WHERE id = %s FOR UPDATE", (run.scope_id,)
            )
            scope_row = await cursor.fetchone()
            await cursor.execute(f"SELECT {RUN_COLUMNS} FROM analysis_run WHERE id = %s FOR UPDATE", (run_id,))
            run_row = await cursor.fetchone()
            if scope_row is None or run_row is None:
                return PublishResult("inactive")
            locked = _run(run_row)
            scope = _scope(scope_row)
            if (
                locked.status != RunStatus.RUNNING
                or locked.lease != lease
                or not await _lease_live(cursor, run_id)
                or scope.writer != Writer.ANALYSIS
                or scope.writer_fence != locked.writer_fence
            ):
                return PublishResult("inactive")
            if scope.current_request_order is not None and scope.current_request_order >= locked.request_order:
                await cursor.execute(
                    "UPDATE analysis_run SET status = 'superseded', completed_at = now(), updated_at = now() WHERE id = %s",
                    (run_id,),
                )
                return PublishResult("superseded")
            self._fault("publish:locked")

            reasons: list[str] = []
            pinned_manifest = locked.input_manifest
            pinned = {str(r) for r in (pinned_manifest or {}).get("revisionIds") or []}
            inputs = manifest.get("inputs") or {}
            if pinned_manifest is None:
                reasons.append("the run's inputs were never pinned")
            elif sorted(str(r) for r in inputs.get("revisionIds") or []) != sorted(pinned) or inputs.get(
                "fingerprint"
            ) != locked.input_fingerprint:
                reasons.append("the manifest's inputs are not the run's pinned inputs")
            elif content_hash(dict(inputs.get("dependencies") or {})) != content_hash(
                dict(pinned_manifest.get("dependencies") or {})
            ):
                reasons.append("the manifest's input dependencies are not the run's pinned dependencies")
            objects = list(manifest.get("objects") or [])
            revision_rows = await self._check_revisions(
                cursor, locked.project_id, objects, staged_run_id=run_id, reasons=reasons
            )
            published_inputs = await self._published_revision_ids(cursor, locked.project_id, sorted(pinned))
            if len(published_inputs) != len(pinned):
                reasons.append(f"{len(pinned) - len(published_inputs)} pinned input revisions are not published in this project")
            await self._check_relations(
                cursor,
                locked.project_id,
                list(manifest.get("relations") or []),
                endpoints={str(o.get("revisionId")) for o in objects} | published_inputs,
                staged_run_id=run_id,
                reasons=reasons,
            )
            staged = [row for row in revision_rows.values() if row["status"] == "staged"]
            entries = [row for row in revision_rows.values() if row["status"] in ("staged", "published")]
            await self._check_staged_references(cursor, locked, entries, pinned, reasons)
            await self._check_steps(cursor, locked, checks, reasons)
            if reasons:
                raise PublicationRejected(reasons)

            # Every entry expects a head: a staged revision its parent, a reused
            # revision itself. An edit that landed meanwhile is a conflict.
            conflicts = await _head_conflicts(
                cursor,
                {
                    row["object_id"]: row["parent_revision_id"] if row["status"] == "staged" else row["id"]
                    for row in entries
                },
            )
            if conflicts:
                return PublishResult("conflict", conflicts=tuple(sorted(conflicts)))
            self._fault("publish:validated")

            staged_ids = [row["id"] for row in staged]
            relation_ids = _uuids([str(r.get("relationId")) for r in manifest.get("relations") or []])
            await cursor.execute(
                """UPDATE analysis_object_revision SET status = 'published', published_at = now()
                   WHERE run_id = %s AND status = 'staged' AND id = ANY(%s::uuid[])""",
                (run_id, staged_ids),
            )
            await cursor.execute(
                "UPDATE analysis_object_revision SET status = 'discarded' WHERE run_id = %s AND status IN ('staged', 'candidate')",
                (run_id,),
            )
            await cursor.execute(
                """UPDATE analysis_relation SET status = 'published', published_at = now()
                   WHERE run_id = %s AND status = 'staged' AND id = ANY(%s::uuid[])""",
                (run_id, relation_ids),
            )
            await cursor.execute(
                "UPDATE analysis_relation SET status = 'discarded' WHERE run_id = %s AND status = 'staged'",
                (run_id,),
            )
            if staged_ids:
                await cursor.execute(
                    """UPDATE analysis_object AS o SET current_revision_id = v.id, updated_at = now()
                       FROM analysis_object_revision AS v
                       WHERE v.id = ANY(%s::uuid[]) AND o.id = v.object_id""",
                    (staged_ids,),
                )
            self._fault("publish:heads")

            sequence = scope.publication_sequence + 1
            final_manifest = {**manifest, "publicationSequence": sequence}
            await cursor.execute(
                """UPDATE analysis_run
                   SET status = 'ready', output_manifest = %s, checks = %s, metrics = %s,
                       progress = (COALESCE(progress::jsonb, '{}'::jsonb)
                                   || jsonb_build_object('stage', 'ready'))::json,
                       completed_at = now(), updated_at = now()
                   WHERE id = %s""",
                (Json(final_manifest), Json(checks), Json(metrics), run_id),
            )
            await cursor.execute(
                """UPDATE analysis_scope
                   SET current_run_id = %s, current_request_order = %s,
                       publication_sequence = %s, updated_at = now()
                   WHERE id = %s""",
                (run_id, locked.request_order, sequence, scope.id),
            )
            event_id = str(uuid.uuid4())
            await cursor.execute(
                """INSERT INTO analysis_outbox
                       (id, project_id, scope_id, sequence, event_type, run_id, payload, status,
                        attempts, next_attempt_at, consumers, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, 'run_published', %s, %s, 'pending', 0, now(), '{}',
                           now(), now())""",
                (
                    event_id,
                    locked.project_id,
                    scope.id,
                    sequence,
                    run_id,
                    Json(
                        {
                            "recipeId": locked.recipe_id,
                            "recipeVersion": locked.recipe_version,
                            "scopeKey": scope.scope_key,
                            "runId": run_id,
                            "manifestHash": manifest.get("contentHash"),
                            "sequence": sequence,
                        }
                    ),
                ),
            )
            self._fault("publish:outbox")
            return PublishResult("ready", event_id=event_id, sequence=sequence)

    # ── snapshots ───────────────────────────────────────────────────────

    async def publish_snapshot(self, new: NewSnapshot, *, expected_previous_id: str | None) -> Snapshot:
        """Insert a view snapshot and advance its view scope, only when the
        scope is still at `expected_previous_id`. A snapshot already assembled
        for the same source event is returned instead. References are validated
        here: one displayed revision per object, relations only between
        displayed revisions, and each assessment entry's exact (relation,
        assessment revision, displayed revision) tuple."""
        async with self._transaction() as cursor:
            await cursor.execute(
                f"""SELECT {SCOPE_COLUMNS} FROM analysis_scope
                    WHERE id = %s AND project_id = %s AND kind = 'view' FOR UPDATE""",
                (new.scope_id, new.project_id),
            )
            scope_row = await cursor.fetchone()
            if scope_row is None:
                raise ReferenceViolation(f"view scope {new.scope_id} does not exist in this project")
            scope = _scope(scope_row)
            if new.source_event_id is not None:
                await cursor.execute(
                    f"SELECT {SNAPSHOT_COLUMNS} FROM analysis_snapshot WHERE scope_id = %s AND source_event_id = %s",
                    (scope.id, new.source_event_id),
                )
                effect = await cursor.fetchone()
                if effect is not None:
                    return _snapshot(effect)
            if scope.current_snapshot_id != expected_previous_id:
                raise SnapshotConflict(scope.id, expected_previous_id, scope.current_snapshot_id)
            if scope.current_snapshot_id is not None:
                # Identical content is the current snapshot, returned only once
                # the expected head has been confirmed under this lock.
                await cursor.execute(
                    f"SELECT {SNAPSHOT_COLUMNS} FROM analysis_snapshot WHERE id = %s", (scope.current_snapshot_id,)
                )
                current = await cursor.fetchone()
                if current is not None and current["content_hash"] == new.content_hash:
                    return _snapshot(current)

            reasons: list[str] = []
            objects = list(new.manifest.get("objects") or [])
            await self._check_revisions(cursor, new.project_id, objects, staged_run_id=None, reasons=reasons)
            displayed = {str(o.get("revisionId")) for o in objects}
            vectors = list(new.manifest.get("vectors") or [])
            if vectors:
                config_key = (new.embedding_config or {}).get("key")
                await cursor.execute(
                    """SELECT id::text AS id, project_id::text AS project_id, config_key
                       FROM map_embedding WHERE id = ANY(%s::uuid[])""",
                    (_uuids([str(v.get("embeddingId")) for v in vectors]),),
                )
                embeddings = {row["id"]: row for row in await cursor.fetchall()}
                for entry in vectors:
                    embedding = embeddings.get(str(entry.get("embeddingId")))
                    if str(entry.get("revisionId")) not in displayed:
                        reasons.append(f"a vector names revision {entry.get('revisionId')}, which is not displayed")
                    elif (
                        embedding is None
                        or embedding["project_id"] != new.project_id
                        or (config_key and embedding["config_key"] != config_key)
                    ):
                        reasons.append(f"the vector of revision {entry.get('revisionId')} is not of this configuration")
            await self._check_relations(
                cursor,
                new.project_id,
                list(new.manifest.get("relations") or []),
                endpoints=displayed,
                staged_run_id=None,
                reasons=reasons,
            )
            assessments = list(new.manifest.get("assessments") or [])
            if assessments:
                await cursor.execute(
                    """SELECT rel.id::text AS id, rel.from_revision_id::text AS assessment,
                              rel.to_revision_id::text AS target
                       FROM analysis_relation AS rel
                       JOIN analysis_object_revision AS v ON v.id = rel.from_revision_id
                       WHERE rel.project_id = %s AND rel.type = 'assesses' AND rel.status = 'published'
                         AND v.project_id = %s AND v.status = 'published'
                         AND v.type = 'fact_check_assessment' AND rel.id = ANY(%s::uuid[])""",
                    (new.project_id, new.project_id, _uuids([str(a.get("relationId")) for a in assessments])),
                )
                tuples = {row["id"]: (row["assessment"], row["target"]) for row in await cursor.fetchall()}
                for entry in assessments:
                    expected = (str(entry.get("revisionId")), str(entry.get("targetRevisionId")))
                    if tuples.get(str(entry.get("relationId"))) != expected:
                        reasons.append(f"assessment entry {entry.get('relationId')} is not that assessment of that revision")
                    elif expected[1] not in displayed:
                        reasons.append(f"an assessment names revision {expected[1]}, which the snapshot does not display")
            producers = [p for p in new.manifest.get("producers") or [] if p.get("runId")]
            if producers:
                run_ids = _uuids([str(p.get("runId")) for p in producers])
                await cursor.execute(
                    """SELECT id::text AS id FROM analysis_run
                       WHERE project_id = %s AND status = 'ready' AND id = ANY(%s::uuid[])""",
                    (new.project_id, run_ids),
                )
                if len({row["id"] for row in await cursor.fetchall()}) != len({p.get("runId") for p in producers}):
                    reasons.append("a producer output is not a ready run of this project")
            if reasons:
                raise PublicationRejected(reasons)
            self._fault("snapshot:validated")

            snapshot_id = str(uuid.uuid4())
            await cursor.execute(
                f"""INSERT INTO analysis_snapshot
                        (id, project_id, scope_id, parent_snapshot_id, view_id, manifest_version,
                         manifest, settings, versions, embedding_config, content_hash, hash_version,
                         created_by, source_event_id, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'c14n-v1', %s, %s, now())
                    RETURNING {SNAPSHOT_COLUMNS}""",
                (
                    snapshot_id,
                    new.project_id,
                    scope.id,
                    scope.current_snapshot_id,
                    new.view_id,
                    new.manifest_version,
                    Json(new.manifest),
                    Json(new.settings),
                    Json(new.versions),
                    _json(new.embedding_config),
                    new.content_hash,
                    new.created_by,
                    new.source_event_id,
                ),
            )
            row = await cursor.fetchone()
            assert row is not None
            sequence = scope.publication_sequence + 1
            await cursor.execute(
                "UPDATE analysis_scope SET current_snapshot_id = %s, publication_sequence = %s, updated_at = now() WHERE id = %s",
                (snapshot_id, sequence, scope.id),
            )
            self._fault("snapshot:advanced")
            await cursor.execute(
                """INSERT INTO analysis_outbox
                       (id, project_id, scope_id, sequence, event_type, snapshot_id, payload, status,
                        attempts, next_attempt_at, consumers, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, 'snapshot_published', %s, %s, 'pending', 0, now(), '{}',
                           now(), now())""",
                (
                    str(uuid.uuid4()),
                    new.project_id,
                    scope.id,
                    sequence,
                    snapshot_id,
                    Json(
                        {
                            "viewId": new.view_id,
                            "scopeKey": scope.scope_key,
                            "snapshotId": snapshot_id,
                            "sequence": sequence,
                        }
                    ),
                ),
            )
            return _snapshot(row)

    async def get_snapshot(self, snapshot_id: str) -> Snapshot | None:
        if not _is_uuid(snapshot_id):
            return None
        async with self._cursor() as cursor:
            await cursor.execute(f"SELECT {SNAPSHOT_COLUMNS} FROM analysis_snapshot WHERE id = %s", (snapshot_id,))
            row = await cursor.fetchone()
        return _snapshot(row) if row else None

    # ── outbox ──────────────────────────────────────────────────────────

    async def claim_outbox(
        self,
        *,
        claim: str,
        limit: int,
        claim_seconds: int,
        event_id: str | None = None,
        dead: bool = False,
    ) -> list[OutboxEvent]:
        """Claim due events. A claim expires after `claim_seconds`, so an event
        whose dispatcher died is claimed again; SKIP LOCKED keeps two
        dispatchers from claiming the same one. `dead` claims events past
        their last attempt instead, for reconciling their internal effects."""
        if event_id is not None and not _is_uuid(event_id):
            return []
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""UPDATE analysis_outbox AS o
                    SET status = 'dispatching', claim = %(claim)s, attempts = o.attempts + 1,
                        next_attempt_at = now() + make_interval(secs => %(claim_seconds)s),
                        updated_at = now()
                    WHERE o.id IN (
                        SELECT id FROM analysis_outbox
                        WHERE status = ANY(%(statuses)s)
                          AND COALESCE(next_attempt_at, created_at) <= now()
                          AND (%(event_id)s::uuid IS NULL OR id = %(event_id)s::uuid)
                        ORDER BY created_at
                        LIMIT %(limit)s
                        FOR UPDATE SKIP LOCKED)
                    RETURNING {OUTBOX_COLUMNS_O}""",
                {
                    "claim": claim,
                    "claim_seconds": claim_seconds,
                    "event_id": event_id,
                    "limit": limit,
                    "statuses": ["dead"] if dead else ["pending", "dispatching"],
                },
            )
            return [_outbox(row) for row in await cursor.fetchall()]

    async def mark_consumer_done(self, event_id: str, claim: str, consumer: str) -> bool:
        async with self._cursor() as cursor:
            await cursor.execute(
                """UPDATE analysis_outbox
                   SET consumers = (COALESCE(consumers::jsonb, '{}'::jsonb)
                                    || jsonb_build_object(%s::text, now()))::json,
                       updated_at = now()
                   WHERE id = %s AND claim = %s AND status = 'dispatching'""",
                (consumer, event_id, claim),
            )
            return cursor.rowcount == 1

    async def finish_outbox(self, event_id: str, claim: str) -> bool:
        async with self._cursor() as cursor:
            await cursor.execute(
                """UPDATE analysis_outbox
                   SET status = 'delivered', delivered_at = now(), last_error = NULL, updated_at = now()
                   WHERE id = %s AND claim = %s AND status = 'dispatching'""",
                (event_id, claim),
            )
            return cursor.rowcount == 1

    async def retry_outbox(
        self, event_id: str, claim: str, *, error: str, delay_seconds: int, max_attempts: int
    ) -> bool:
        async with self._cursor() as cursor:
            await cursor.execute(
                """UPDATE analysis_outbox
                   SET status = CASE WHEN attempts >= %s THEN 'dead' ELSE 'pending' END,
                       next_attempt_at = now() + make_interval(secs => %s),
                       last_error = %s, claim = NULL, updated_at = now()
                   WHERE id = %s AND claim = %s AND status = 'dispatching'""",
                (max_attempts, delay_seconds, error[:2000], event_id, claim),
            )
            return cursor.rowcount == 1

    # ── embeddings, through Map's table and SQL ─────────────────────────

    async def load_embeddings(
        self, project_id: str, config_key: str, input_hashes: list[str]
    ) -> dict[str, tuple[str, list[float]]]:
        try:
            return await self._embeddings.load_embeddings(project_id, config_key, input_hashes)
        except MapStoreError as exc:
            raise AnalysisStoreError(str(exc)) from exc

    async def save_embedding(
        self,
        *,
        project_id: str,
        input_hash: str,
        config_key: str,
        model: str,
        dims: int,
        vector: list[float],
    ) -> tuple[str, list[float]]:
        try:
            return await self._embeddings.save_embedding(
                project_id=project_id,
                input_hash=input_hash,
                config_key=config_key,
                model=model,
                dims=dims,
                vector=vector,
            )
        except MapStoreError as exc:
            raise AnalysisStoreError(str(exc)) from exc

    async def vectors_by_ids(self, project_id: str, ids: list[str]) -> dict[str, list[float]]:
        try:
            return await self._embeddings.vectors_by_ids(project_id, ids)
        except MapStoreError as exc:
            raise AnalysisStoreError(str(exc)) from exc
