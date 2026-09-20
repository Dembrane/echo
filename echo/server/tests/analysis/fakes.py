"""An in-memory `AnalysisStore` with the guards the SQL enforces.

Ownership (lease, deadline, writer fence, request order), idempotency keys,
dedupe of equivalent in-flight work, reuse fencing, write-once inputs,
immutable completed steps, staged rows invisible until publication, and the
publication and snapshot checks, on a clock the test controls. Transactions
restore every table on an exception, so `fault` injection proves rollback the
way the SQL store's does.
"""

from __future__ import annotations

import copy
import math
import uuid
from typing import Any, Callable
from datetime import datetime, timedelta
from collections import Counter
from dataclasses import replace

from tests.map_fakes import FakeClock
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
    Relation,
    Snapshot,
    StepKind,
    RunStatus,
    ScopeKind,
    StepWrite,
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


def _identity(run: Run) -> str:
    return content_hash(
        {"recipeVersion": run.recipe_version, "definition": run.definition, "parameters": run.parameters, "context": run.context}
    )


TABLES = ("scopes", "runs", "keys", "steps", "objects", "revisions", "relations", "snapshots", "outbox", "embeddings")


class FakeAnalysisStore:
    def __init__(
        self,
        *,
        clock: FakeClock | None = None,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        fault: Callable[[str], None] | None = None,
    ) -> None:
        self.clock = clock or FakeClock()
        self.lease_seconds = lease_seconds
        self.fault = fault or (lambda _point: None)
        self.scopes: dict[str, Scope] = {}
        self.runs: dict[str, Run] = {}
        self.keys: dict[tuple[str, str], str] = {}
        self.steps: dict[str, Step] = {}
        self.objects: dict[str, ObjectRecord] = {}
        self.revisions: dict[str, ObjectRevision] = {}
        self.relations: dict[str, Relation] = {}
        self.snapshots: dict[str, Snapshot] = {}
        self.outbox: dict[str, OutboxEvent] = {}
        self.embeddings: dict[str, dict[str, Any]] = {}
        # (project_id, user_id) -> when this host last opened the results list.
        self.last_opened: dict[tuple[str, str], datetime] = {}
        self.calls: Counter[str] = Counter()
        self.raise_on: dict[str, BaseException] = {}

    # ── plumbing ────────────────────────────────────────────────────────

    def _enter(self, name: str) -> None:
        self.calls[name] += 1
        if name in self.raise_on:
            raise self.raise_on[name]

    def _snapshot_tables(self) -> dict[str, Any]:
        return {name: dict(getattr(self, name)) for name in TABLES}

    def _restore(self, saved: dict[str, Any]) -> None:
        for name, table in saved.items():
            setattr(self, name, table)

    def _live(self, run: Run) -> bool:
        return run.lease_expires_at is not None and run.lease_expires_at > self.clock.peek()

    def _owner(self, run_id: str, lease: str) -> Run | None:
        run = self.runs.get(run_id)
        if run is None or run.status != RunStatus.RUNNING or run.lease != lease or not self._live(run):
            return None
        scope = self.scopes[run.scope_id]
        if scope.writer != Writer.ANALYSIS or scope.writer_fence != run.writer_fence:
            return None
        if scope.current_request_order is not None and scope.current_request_order >= run.request_order:
            return None
        now = self.clock.now()
        run = replace(run, lease_expires_at=now + timedelta(seconds=self.lease_seconds), updated_at=now)
        self.runs[run_id] = run
        return run

    # ── scopes ──────────────────────────────────────────────────────────

    async def ensure_scope(self, *, project_id: str, kind: ScopeKind, owner_id: str, scope_key: str) -> Scope:
        self._enter("ensure_scope")
        found = await self.find_scope(project_id=project_id, kind=kind, owner_id=owner_id, scope_key=scope_key)
        if found:
            return found
        now = self.clock.now()
        scope = Scope(
            id=str(uuid.uuid4()),
            project_id=project_id,
            kind=kind,
            scope_key=scope_key,
            recipe_id=owner_id if kind == ScopeKind.PRODUCER else None,
            view_id=owner_id if kind == ScopeKind.VIEW else None,
            created_at=now,
            updated_at=now,
        )
        self.scopes[scope.id] = scope
        return scope

    async def find_scope(self, *, project_id: str, kind: ScopeKind, owner_id: str, scope_key: str) -> Scope | None:
        for scope in self.scopes.values():
            owner = scope.recipe_id if kind == ScopeKind.PRODUCER else scope.view_id
            if (scope.project_id, scope.kind, owner, scope.scope_key) == (project_id, kind, owner_id, scope_key):
                return scope
        return None

    async def get_scope(self, scope_id: str) -> Scope | None:
        return self.scopes.get(scope_id)

    # ── runs ────────────────────────────────────────────────────────────

    async def create_run(self, new: NewRun) -> tuple[Run, bool]:
        self._enter("create_run")
        mapped = self.keys.get((new.project_id, new.idempotency_key))
        if mapped:
            return self.runs[mapped], False
        scope = self.scopes.get(new.scope_id)
        if scope is None or scope.project_id != new.project_id or scope.kind != ScopeKind.PRODUCER or scope.recipe_id != new.recipe_id:
            raise ReferenceViolation(f"scope {new.scope_id} is not a {new.recipe_id} scope of this project")
        if scope.writer != Writer.ANALYSIS:
            raise WriterNotOwner(f"scope {scope.id} is written by {scope.writer}")
        if new.status in ACTIVE_RUN_STATUSES:
            active = await self.active_run(scope.id, new.request_fingerprint)
            if active:
                self.keys[(new.project_id, new.idempotency_key)] = active.id
                return active, False
        if new.reused_run_id is not None:
            if scope.current_run_id != new.reused_run_id:
                raise ReuseOutdated(scope.current_run_id)
            for entry in (new.output_manifest or {}).get("objects") or []:
                record = self.objects.get(str(entry["objectId"]))
                if record is None or record.current_revision_id != entry["revisionId"]:
                    raise ReuseOutdated(scope.current_run_id)
        now = self.clock.now()
        order = scope.next_request_order
        epoch = new.epoch if new.epoch is not None else scope.generation_epoch + 1
        scope = replace(scope, next_request_order=order + 1, generation_epoch=max(scope.generation_epoch, epoch), updated_at=now)
        run = Run(
            id=str(uuid.uuid4()),
            project_id=new.project_id,
            scope_id=scope.id,
            recipe_id=new.recipe_id,
            recipe_version=new.recipe_version,
            definition=copy.deepcopy(new.definition),
            mode=new.mode,
            epoch=epoch,
            idempotency_key=new.idempotency_key,
            request_order=order,
            request_fingerprint=new.request_fingerprint,
            status=new.status,
            input_fingerprint=new.input_fingerprint,
            input_manifest=copy.deepcopy(new.input_manifest),
            parameters=copy.deepcopy(new.parameters),
            context=copy.deepcopy(new.context),
            depends_on=list(new.depends_on),
            progress={"stage": str(new.status)},
            writer_fence=scope.writer_fence,
            output_manifest=copy.deepcopy(new.output_manifest),
            metrics=copy.deepcopy(new.metrics),
            reused_run_id=new.reused_run_id,
            requested_by=new.requested_by,
            created_at=now,
            updated_at=now,
            completed_at=now if new.status == RunStatus.READY else None,
        )
        if new.status == RunStatus.READY and new.reused_run_id is not None:
            scope = replace(scope, current_run_id=run.id, current_request_order=order)
        self.scopes[scope.id] = scope
        self.runs[run.id] = run
        self.keys[(new.project_id, new.idempotency_key)] = run.id
        return run, True

    async def get_run(self, run_id: str) -> Run | None:
        return self.runs.get(run_id)

    async def run_by_idempotency_key(self, project_id: str, key: str) -> Run | None:
        mapped = self.keys.get((project_id, key))
        return self.runs.get(mapped) if mapped else None

    async def active_run(self, scope_id: str, request_fingerprint: str) -> Run | None:
        rows = [
            r
            for r in self.runs.values()
            if r.scope_id == scope_id and r.request_fingerprint == request_fingerprint and r.status in ACTIVE_RUN_STATUSES
        ]
        return max(rows, key=lambda r: r.request_order) if rows else None

    async def latest_run(self, scope_id: str, statuses: tuple[RunStatus, ...]) -> Run | None:
        rows = [r for r in self.runs.values() if r.scope_id == scope_id and r.status in statuses]
        return max(rows, key=lambda r: r.request_order) if rows else None

    async def set_execution_ref(self, run_id: str, execution_ref: str) -> None:
        if run_id in self.runs:
            self.runs[run_id] = replace(self.runs[run_id], execution_ref=execution_ref)

    async def claim_run(self, run_id: str, lease: str, *, max_running: int | None) -> ClaimResult:
        self._enter("claim_run")
        run = self.runs.get(run_id)
        if run is None:
            return ClaimResult("inactive")
        scope = self.scopes[run.scope_id]
        fenced = scope.writer != Writer.ANALYSIS or scope.writer_fence != run.writer_fence
        claimable = run.status == RunStatus.QUEUED or (run.status == RunStatus.RUNNING and not self._live(run))
        if claimable and not fenced:
            running = sum(
                1
                for other in self.runs.values()
                if other.recipe_id == run.recipe_id and other.status == RunStatus.RUNNING and other.id != run.id and self._live(other)
            )
            if max_running is None or running < max_running:
                now = self.clock.now()
                run = replace(
                    run,
                    status=RunStatus.RUNNING,
                    lease=lease,
                    attempt=run.attempt + 1,
                    lease_expires_at=now + timedelta(seconds=self.lease_seconds),
                    started_at=run.started_at or now,
                    updated_at=now,
                    error=None,
                    progress={**run.progress, "stage": "running"},
                )
                self.runs[run.id] = run
                return ClaimResult("claimed", run)
        if run.status == RunStatus.QUEUED and fenced:
            run = replace(run, status=RunStatus.FAILED, error="Another writer owns this scope now.", completed_at=self.clock.now())
            self.runs[run.id] = run
            return ClaimResult("inactive", run)
        if run.status == RunStatus.QUEUED:
            return ClaimResult("busy", run)
        return ClaimResult("inactive", run)

    async def pin_inputs(self, run_id: str, lease: str, *, input_manifest: dict[str, Any], input_fingerprint: str) -> bool:
        if content_hash(input_manifest) != input_fingerprint:
            raise AnalysisValidationError("the input fingerprint is not the manifest's hash")
        run = self._owner(run_id, lease)
        if run is None:
            return False
        if run.input_manifest is not None:
            if run.input_fingerprint != input_fingerprint:
                raise AnalysisValidationError("this run's inputs are already pinned to other revisions")
            return True
        self.runs[run_id] = replace(run, input_manifest=copy.deepcopy(input_manifest), input_fingerprint=input_fingerprint)
        return True

    async def heartbeat_run(self, run_id: str, lease: str, progress: dict[str, Any]) -> bool:
        self._enter("heartbeat_run")
        run = self._owner(run_id, lease)
        if run is None:
            return False
        self.runs[run_id] = replace(run, progress=copy.deepcopy(progress))
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
        if status in (RunStatus.READY, RunStatus.QUEUED, RunStatus.RUNNING, RunStatus.WAITING_FOR_INPUTS):
            raise ValueError(f"finish_run cannot set {status}")
        run = self.runs.get(run_id)
        if run is None or run.status != RunStatus.RUNNING or run.lease != lease:
            return False
        scope = self.scopes[run.scope_id]
        overtaken = scope.current_request_order is not None and scope.current_request_order >= run.request_order
        if status == RunStatus.SUPERSEDED:
            if not overtaken:
                return False
        elif overtaken or not self._live(run) or scope.writer != Writer.ANALYSIS or scope.writer_fence != run.writer_fence:
            return False
        progress = {**run.progress, "stage": str(status)}
        if candidate_manifest is not None:
            progress["candidateManifest"] = copy.deepcopy(candidate_manifest)
        now = self.clock.now()
        self.runs[run_id] = replace(
            run,
            status=status,
            error=error,
            checks=copy.deepcopy(checks) if checks is not None else run.checks,
            metrics=copy.deepcopy(metrics) if metrics is not None else run.metrics,
            progress=progress,
            completed_at=None if status == RunStatus.NEEDS_REVIEW else now,
            updated_at=now,
        )
        return True

    async def cancel_run(self, run_id: str) -> Run | None:
        run = self.runs.get(run_id)
        if run is None:
            return None
        if run.status in (*ACTIVE_RUN_STATUSES, RunStatus.NEEDS_REVIEW):
            run = replace(run, status=RunStatus.CANCELLED, completed_at=self.clock.now())
            self.runs[run_id] = run
        return run

    async def requeue_run(self, run_id: str, *, idempotency_key: str | None = None) -> Run | None:
        run = self.runs.get(run_id)
        if run is None:
            return None
        if idempotency_key and (run.project_id, idempotency_key) in self.keys:
            return self.runs[self.keys[(run.project_id, idempotency_key)]]
        if run.status == RunStatus.FAILED:
            active = await self.active_run(run.scope_id, run.request_fingerprint)
            if active is not None:
                raise RetryConflict(active)
            run = replace(
                run,
                status=RunStatus.QUEUED,
                lease=None,
                lease_expires_at=None,
                error=None,
                completed_at=None,
                updated_at=self.clock.now(),
                progress={**run.progress, "stage": "queued"},
            )
            self.runs[run_id] = run
        if idempotency_key:
            self.keys[(run.project_id, idempotency_key)] = run.id
        return run

    async def wake_waiting_runs(self, project_id: str | None) -> WakeResult:
        self._enter("wake_waiting_runs")
        woken: list[Run] = []
        failed: list[Run] = []
        waiting = sorted(
            (r for r in self.runs.values() if r.status == RunStatus.WAITING_FOR_INPUTS and (project_id is None or r.project_id == project_id)),
            key=lambda r: r.created_at or self.clock.peek(),
        )
        for run in waiting:
            resolved: list[str] = []
            substituted: dict[str, str] = {}
            broken = not run.depends_on
            pending = False
            for dep_id in run.depends_on:
                dep = self.runs.get(dep_id)
                if dep is None or dep.status in (RunStatus.FAILED, RunStatus.CANCELLED):
                    broken = True
                    break
                if dep.status == RunStatus.READY and dep.output_manifest is not None:
                    resolved.append(dep_id)
                elif dep.status == RunStatus.SUPERSEDED:
                    scope = self.scopes[dep.scope_id]
                    replacement = self.runs.get(scope.current_run_id or "")
                    if (
                        replacement is None
                        or scope.current_request_order is None
                        or scope.current_request_order < dep.request_order
                        or _identity(replacement) != _identity(dep)
                    ):
                        broken = True
                        break
                    resolved.append(scope.current_run_id)
                    substituted[dep_id] = scope.current_run_id
                else:
                    pending = True
                    resolved.append(dep_id)
            if broken:
                status = RunStatus.FAILED
            elif pending:
                continue
            else:
                status = RunStatus.QUEUED
            progress = {**run.progress, "stage": str(status)}
            if substituted:
                progress["reresolved"] = {**dict(run.progress.get("reresolved") or {}), **substituted}
            updated = replace(
                run,
                status=status,
                error="A recipe this run depends on did not finish." if broken else None,
                depends_on=run.depends_on if broken else resolved,
                progress=progress,
                completed_at=self.clock.now() if broken else None,
                updated_at=self.clock.now(),
            )
            self.runs[run.id] = updated
            if status == RunStatus.QUEUED:
                woken.append(updated)
            elif status == RunStatus.FAILED:
                failed.append(updated)
        return WakeResult(woken=tuple(woken), failed=tuple(failed))

    async def expire_stale_runs(self) -> list[str]:
        expired = []
        for run in list(self.runs.values()):
            if run.status == RunStatus.RUNNING and not self._live(run):
                self.runs[run.id] = replace(run, status=RunStatus.FAILED, error="The run stopped without finishing.", completed_at=self.clock.now())
                expired.append(run.id)
        return expired

    async def redispatch_queued_runs(self, older_than_seconds: int, limit: int) -> list[Run]:
        cutoff = self.clock.peek() - timedelta(seconds=older_than_seconds)
        out = []
        for run in sorted(self.runs.values(), key=lambda r: r.updated_at or cutoff):
            if run.status == RunStatus.QUEUED and run.updated_at is not None and run.updated_at < cutoff and len(out) < limit:
                touched = replace(run, updated_at=self.clock.now())
                self.runs[run.id] = touched
                out.append(touched)
        return out

    # ── steps ───────────────────────────────────────────────────────────

    async def get_steps(self, run_id: str) -> list[Step]:
        return sorted((s for s in self.steps.values() if s.run_id == run_id), key=lambda s: s.created_at or self.clock.peek())

    async def get_step(self, step_id: str) -> Step | None:
        return self.steps.get(step_id)

    async def find_reusable_step(self, project_id: str, cache_key: str) -> Step | None:
        rows = [
            s
            for s in self.steps.values()
            if s.project_id == project_id and s.cache_key == cache_key and s.status == StepStatus.COMPLETED and s.reused_step_id is None
        ]
        return max(rows, key=lambda s: s.completed_at or self.clock.peek()) if rows else None

    async def checkpoint_step(self, run_id: str, lease: str, write: StepWrite) -> Step | None:
        self._enter("checkpoint_step")
        run = self._owner(run_id, lease)
        if run is None:
            return None
        existing = next((s for s in self.steps.values() if s.run_id == run_id and s.step_key == write.step_key), None)
        if existing is not None and existing.status == StepStatus.COMPLETED:
            if existing.cache_key == write.cache_key:
                return existing
            raise StepConflict(f"step {write.step_key} already completed with other inputs")
        now = self.clock.now()
        step = Step(
            id=existing.id if existing else str(uuid.uuid4()),
            project_id=run.project_id,
            run_id=run_id,
            step_key=write.step_key,
            step_version=write.step_version,
            kind=write.kind,
            cache_key=write.cache_key,
            status=write.status,
            attempt=(existing.attempt + (1 if existing.lease != lease else 0)) if existing else 1,
            lease=lease,
            reused_step_id=write.reused_step_id,
            checkpoint=copy.deepcopy(write.checkpoint),
            output=copy.deepcopy(write.output),
            validation=copy.deepcopy(list(write.validation)),
            usage=copy.deepcopy(write.usage),
            error=write.error,
            created_at=existing.created_at if existing else now,
            updated_at=now,
            completed_at=now if write.status == StepStatus.COMPLETED else None,
        )
        self.steps[step.id] = step
        return step

    # ── objects, revisions, relations ───────────────────────────────────

    async def ensure_object(
        self, *, project_id: str, type: str, lineage_key: str, scope_id: str | None, object_id: str | None = None
    ) -> ObjectRecord:
        if object_id is not None:
            try:
                object_id = str(uuid.UUID(str(object_id)))
            except ValueError:
                raise AnalysisValidationError(f"object id {object_id!r} is not a uuid") from None
        for record in self.objects.values():
            if (record.project_id, record.type, record.lineage_key) == (project_id, type, lineage_key):
                if object_id is not None and record.id != object_id:
                    raise ReferenceViolation(f"object {lineage_key!r} already exists under another id")
                return record
        if object_id is not None and object_id in self.objects:
            raise ReferenceViolation(f"object id {object_id} names another object")
        now = self.clock.now()
        record = ObjectRecord(
            id=object_id or str(uuid.uuid4()), project_id=project_id, type=type, lineage_key=lineage_key, scope_id=scope_id, created_at=now, updated_at=now
        )
        self.objects[record.id] = record
        return record

    async def get_object(self, object_id: str) -> ObjectRecord | None:
        return self.objects.get(object_id)

    async def get_revisions(self, project_id: str, revision_ids: list[str]) -> dict[str, ObjectRevision]:
        return {rid: self.revisions[rid] for rid in revision_ids if rid in self.revisions and self.revisions[rid].project_id == project_id}

    async def current_revisions(
        self, project_id: str, scope_ids: list[str] | None = None
    ) -> dict[str, ObjectRevision]:
        return {
            record.id: self.revisions[record.current_revision_id]
            for record in self.objects.values()
            if record.project_id == project_id
            and (scope_ids is None or record.scope_id in scope_ids)
            and record.current_revision_id is not None
            and record.current_revision_id in self.revisions
        }

    def _new_revision(self, new: NewRevision, number: int, status: RevisionStatus, revision_id: str | None = None) -> ObjectRevision:
        now = self.clock.now()
        return ObjectRevision(
            id=revision_id or new.revision_id or str(uuid.uuid4()),
            object_id=new.object_id,
            project_id=new.project_id,
            type=new.type,
            schema_version=new.schema_version,
            revision_number=number,
            status=status,
            payload=copy.deepcopy(new.payload),
            attributes=copy.deepcopy(new.attributes),
            provenance=new.provenance,
            content_hash=new.content_hash,
            run_id=new.run_id,
            parent_revision_id=new.parent_revision_id,
            embedding_refs=copy.deepcopy(new.embedding_refs),
            actor_id=new.actor_id,
            reason=new.reason,
            change_kind=new.change_kind,
            created_at=now,
            published_at=now if status == RevisionStatus.PUBLISHED else None,
        )

    async def stage_revision(self, run_id: str, lease: str, new: NewRevision) -> ObjectRevision | None:
        self._enter("stage_revision")
        if new.status not in (RevisionStatus.STAGED, RevisionStatus.CANDIDATE):
            raise ValueError("stage_revision writes staged or candidate revisions only")
        if new.run_id != run_id or new.provenance.run_id != run_id:
            raise ReferenceViolation("a staged revision names the run that stages it")
        run = self._owner(run_id, lease)
        if run is None:
            return None
        record = self.objects.get(new.object_id)
        if record is None or record.project_id != new.project_id or record.type != new.type or run.project_id != new.project_id:
            raise ReferenceViolation(f"object {new.object_id} is not a {new.type} of this project")
        existing = next(
            (v for v in self.revisions.values() if v.run_id == run_id and v.object_id == new.object_id and v.status in (RevisionStatus.STAGED, RevisionStatus.CANDIDATE)),
            None,
        )
        if existing is not None:
            revision = replace(self._new_revision(new, existing.revision_number, new.status, existing.id), created_at=existing.created_at)
        else:
            record = replace(record, revision_count=record.revision_count + 1)
            self.objects[record.id] = record
            revision = self._new_revision(new, record.revision_count, new.status)
        self.revisions[revision.id] = revision
        return revision

    async def append_revision(self, new: NewRevision, *, expected_revision_id: str | None) -> ObjectRevision:
        self._enter("append_revision")
        if new.origin == Origin.GENERATED:
            raise ValueError("generated revisions publish through their run")
        saved = self._snapshot_tables()
        try:
            record = self.objects.get(new.object_id)
            if record is None or record.project_id != new.project_id or record.type != new.type:
                raise ReferenceViolation(f"object {new.object_id} is not a {new.type} of this project")
            if record.scope_id is None:
                raise ReferenceViolation(f"object {new.object_id} has no scope to publish its edits in")
            if new.embedding_refs is not None:
                embedding = self.embeddings.get(str(new.embedding_refs.get("embeddingId") or ""))
                if embedding is None or embedding["project_id"] != new.project_id:
                    raise ReferenceViolation("the revision references an embedding that is not this project's")
                wanted_config = new.embedding_refs.get("configKey")
                if wanted_config and embedding["config_key"] != wanted_config:
                    raise ReferenceViolation("the revision references an embedding of another configuration")
            if new.revision_id and new.revision_id in self.revisions:
                return self.revisions[new.revision_id]
            if record.current_revision_id != expected_revision_id:
                current = self.revisions.get(record.current_revision_id or "")
                raise RevisionConflict(new.object_id, expected_revision_id, current)
            record = replace(record, revision_count=record.revision_count + 1)
            revision = self._new_revision(new, record.revision_count, RevisionStatus.PUBLISHED)
            self.revisions[revision.id] = revision
            self.objects[record.id] = replace(record, current_revision_id=revision.id)
            scope = self.scopes[record.scope_id]
            sequence = scope.publication_sequence + 1
            self.scopes[scope.id] = replace(scope, publication_sequence=sequence)
            self._event(
                scope,
                sequence,
                "revision_published",
                payload={
                    "objectId": record.id,
                    "revisionId": revision.id,
                    "type": record.type,
                    "origin": str(new.origin),
                    "recipeId": new.provenance.recipe_id,
                    "membershipExcluded": bool(
                        new.provenance.extra.get("membershipExcluded")
                    ),
                },
            )
            self.fault("append:outbox")
            return revision
        except BaseException:
            self._restore(saved)
            raise

    async def stage_relation(self, run_id: str, lease: str, new: NewRelation) -> Relation | None:
        self._enter("stage_relation")
        if new.run_id != run_id:
            raise ReferenceViolation("a staged relation names the run that stages it")
        run = self._owner(run_id, lease)
        if run is None:
            return None
        for end, obj in ((new.from_revision_id, new.from_object_id), (new.to_revision_id, new.to_object_id)):
            revision = self.revisions.get(end)
            if revision is None or revision.project_id != run.project_id or revision.object_id != obj:
                raise ReferenceViolation("a relation endpoint is not a revision of its object in this project")
        existing = next(
            (
                r
                for r in self.relations.values()
                if r.run_id == run_id and r.status == RelationStatus.STAGED and (r.type, r.from_revision_id, r.to_revision_id) == (new.type, new.from_revision_id, new.to_revision_id)
            ),
            None,
        )
        relation = Relation(
            id=existing.id if existing else str(uuid.uuid4()),
            project_id=run.project_id,
            type=new.type,
            basis=new.basis,
            status=RelationStatus.STAGED,
            from_revision_id=new.from_revision_id,
            to_revision_id=new.to_revision_id,
            from_object_id=new.from_object_id,
            to_object_id=new.to_object_id,
            attributes=copy.deepcopy(new.attributes),
            provenance=copy.deepcopy(new.provenance),
            content_hash=new.content_hash,
            run_id=run_id,
            created_at=existing.created_at if existing else self.clock.now(),
        )
        self.relations[relation.id] = relation
        return relation

    async def import_relation(self, new: NewRelation, *, relation_id: str | None = None) -> Relation:
        self._enter("import_relation")
        if new.run_id is not None:
            raise ReferenceViolation("an imported relation belongs to no run")
        if relation_id is not None:
            try:
                relation_id = str(uuid.UUID(str(relation_id)))
            except ValueError:
                raise AnalysisValidationError(f"relation id {relation_id!r} is not a uuid") from None
            existing = self.relations.get(relation_id)
            if existing is not None:
                same = (existing.project_id, existing.type, existing.from_revision_id, existing.to_revision_id, existing.content_hash, existing.run_id)
                if same != (new.project_id, new.type, new.from_revision_id, new.to_revision_id, new.content_hash, None):
                    raise ReferenceViolation(f"relation id {relation_id} names another relation")
                return existing
        else:
            for existing in self.relations.values():
                if existing.run_id is None and existing.status == RelationStatus.PUBLISHED and (
                    existing.project_id, existing.type, existing.from_revision_id, existing.to_revision_id, existing.content_hash
                ) == (new.project_id, new.type, new.from_revision_id, new.to_revision_id, new.content_hash):
                    return existing
        for end, obj in ((new.from_revision_id, new.from_object_id), (new.to_revision_id, new.to_object_id)):
            revision = self.revisions.get(end)
            if revision is None or revision.project_id != new.project_id or revision.object_id != obj or revision.status != RevisionStatus.PUBLISHED:
                raise ReferenceViolation("an imported relation connects published revisions of its objects in this project")
        now = self.clock.now()
        relation = Relation(
            id=relation_id or str(uuid.uuid4()),
            project_id=new.project_id,
            type=new.type,
            basis=new.basis,
            status=RelationStatus.PUBLISHED,
            from_revision_id=new.from_revision_id,
            to_revision_id=new.to_revision_id,
            from_object_id=new.from_object_id,
            to_object_id=new.to_object_id,
            attributes=copy.deepcopy(new.attributes),
            provenance=copy.deepcopy(new.provenance),
            content_hash=new.content_hash,
            run_id=None,
            created_at=now,
            published_at=now,
        )
        self.relations[relation.id] = relation
        return relation

    async def run_candidates(self, run_id: str) -> tuple[list[ObjectRevision], list[Relation]]:
        revisions = [v for v in self.revisions.values() if v.run_id == run_id and v.status in (RevisionStatus.STAGED, RevisionStatus.CANDIDATE)]
        relations = [r for r in self.relations.values() if r.run_id == run_id and r.status == RelationStatus.STAGED]
        return revisions, relations

    async def get_relations(self, project_id: str, relation_ids: list[str]) -> dict[str, Relation]:
        return {rid: self.relations[rid] for rid in relation_ids if rid in self.relations and self.relations[rid].project_id == project_id}

    async def assessments_for(self, project_id: str, revision_ids: list[str]) -> dict[str, ObjectRevision]:
        out: dict[str, ObjectRevision] = {}
        wanted = set(revision_ids)
        for relation in self.relations.values():
            if relation.project_id != project_id or relation.type != "assesses" or relation.status != RelationStatus.PUBLISHED:
                continue
            if relation.to_revision_id not in wanted:
                continue
            assessment = self.revisions.get(relation.from_revision_id)
            if assessment is None or assessment.status != RevisionStatus.PUBLISHED or assessment.type != "fact_check_assessment":
                continue
            current = out.get(relation.to_revision_id)
            if current is None or (assessment.published_at, assessment.revision_number) > (current.published_at, current.revision_number):
                extra = {**assessment.provenance.extra, "assessesRelationId": relation.id}
                out[relation.to_revision_id] = replace(assessment, provenance=replace(assessment.provenance, extra=extra))
        return out

    # ── publication ─────────────────────────────────────────────────────

    def _event(self, scope: Scope, sequence: int, event_type: str, *, run_id: str | None = None, snapshot_id: str | None = None, payload: dict[str, Any]) -> OutboxEvent:
        now = self.clock.now()
        event = OutboxEvent(
            id=str(uuid.uuid4()),
            project_id=scope.project_id,
            scope_id=scope.id,
            sequence=sequence,
            event_type=event_type,
            status=OutboxStatus.PENDING,
            run_id=run_id,
            snapshot_id=snapshot_id,
            payload={**payload, "sequence": sequence},
            next_attempt_at=now,
            created_at=now,
        )
        self.outbox[event.id] = event
        return event

    def _check_revisions(self, project_id: str, entries: list[dict[str, Any]], staged_run_id: str | None, reasons: list[str]) -> list[ObjectRevision]:
        if len({e.get("objectId") for e in entries}) != len(entries):
            reasons.append("the manifest shows more than one revision of one object")
        found: list[ObjectRevision] = []
        for entry in entries:
            revision = self.revisions.get(str(entry.get("revisionId")))
            if revision is None:
                reasons.append(f"revision {entry.get('revisionId')} does not exist")
            elif revision.project_id != project_id:
                reasons.append(f"revision {revision.id} belongs to another project")
            elif revision.object_id != entry.get("objectId") or revision.type != entry.get("type"):
                reasons.append(f"revision {revision.id} is not a {entry.get('type')} of object {entry.get('objectId')}")
            elif revision.status == RevisionStatus.PUBLISHED or (revision.status == RevisionStatus.STAGED and staged_run_id and revision.run_id == staged_run_id):
                found.append(revision)
            else:
                reasons.append(f"revision {revision.id} is {revision.status}, not publishable here")
        return found

    def _check_relations(self, project_id: str, entries: list[dict[str, Any]], endpoints: set[str], staged_run_id: str | None, reasons: list[str]) -> None:
        for entry in entries:
            relation = self.relations.get(str(entry.get("relationId")))
            if relation is None or relation.project_id != project_id:
                reasons.append(f"relation {entry.get('relationId')} does not exist in this project")
                continue
            if (relation.type, relation.from_revision_id, relation.to_revision_id) != (entry.get("type"), entry.get("from"), entry.get("to")):
                reasons.append(f"relation {relation.id} does not match its manifest entry")
                continue
            if not (relation.status == RelationStatus.PUBLISHED or (relation.status == RelationStatus.STAGED and relation.run_id == staged_run_id)):
                reasons.append(f"relation {relation.id} is {relation.status}, not publishable here")
                continue
            for end in (relation.from_revision_id, relation.to_revision_id):
                if end not in endpoints:
                    reasons.append(f"relation {relation.id} points at revision {end}, which is not in this output")

    async def publish_run(self, run_id: str, lease: str, *, manifest: dict[str, Any], checks: list[dict[str, Any]], metrics: dict[str, Any]) -> PublishResult:
        self._enter("publish_run")
        saved = self._snapshot_tables()
        try:
            run = self.runs.get(run_id)
            if run is None:
                return PublishResult("inactive")
            scope = self.scopes[run.scope_id]
            if run.status != RunStatus.RUNNING or run.lease != lease or not self._live(run) or scope.writer != Writer.ANALYSIS or scope.writer_fence != run.writer_fence:
                return PublishResult("inactive")
            if scope.current_request_order is not None and scope.current_request_order >= run.request_order:
                self.runs[run_id] = replace(run, status=RunStatus.SUPERSEDED, completed_at=self.clock.now())
                return PublishResult("superseded")
            self.fault("publish:locked")
            reasons: list[str] = []
            pinned = {str(r) for r in (run.input_manifest or {}).get("revisionIds") or []}
            inputs = manifest.get("inputs") or {}
            if run.input_manifest is None:
                reasons.append("the run's inputs were never pinned")
            elif sorted(str(r) for r in inputs.get("revisionIds") or []) != sorted(pinned) or inputs.get("fingerprint") != run.input_fingerprint:
                reasons.append("the manifest's inputs are not the run's pinned inputs")
            elif content_hash(dict(inputs.get("dependencies") or {})) != content_hash(dict(run.input_manifest.get("dependencies") or {})):
                reasons.append("the manifest's input dependencies are not the run's pinned dependencies")
            objects = list(manifest.get("objects") or [])
            entries = self._check_revisions(run.project_id, objects, run_id, reasons)
            published_inputs = {rid for rid in pinned if rid in self.revisions and self.revisions[rid].project_id == run.project_id and self.revisions[rid].status == RevisionStatus.PUBLISHED}
            if len(published_inputs) != len(pinned):
                reasons.append("pinned input revisions are not published in this project")
            self._check_relations(run.project_id, list(manifest.get("relations") or []), {str(o.get("revisionId")) for o in objects} | published_inputs, run_id, reasons)
            staged = [v for v in entries if v.status == RevisionStatus.STAGED]
            for revision in entries:
                prov = revision.provenance
                own = revision.status == RevisionStatus.STAGED
                if own and (prov.run_id, prov.recipe_id, prov.recipe_version) != (run.id, run.recipe_id, run.recipe_version):
                    reasons.append(f"revision {revision.id} names another run or recipe in its provenance")
                if own and any(rid not in pinned for rid in prov.input_revision_ids):
                    reasons.append(f"revision {revision.id} cites revisions that are not pinned inputs")
                ref = revision.embedding_refs or {}
                if ref.get("embeddingId"):
                    row = self.embeddings.get(str(ref["embeddingId"]))
                    if row is None or row["project_id"] != run.project_id:
                        reasons.append(f"revision {revision.id} references an embedding that is not this project's")
                    elif ref.get("configKey") and row["config_key"] != ref["configKey"]:
                        reasons.append(f"revision {revision.id} references an embedding of another configuration")
            for outcome in checks:
                if outcome.get("status") in ("failed", "needs_review"):
                    reasons.append(f"check {outcome.get('check')} is {outcome.get('status')}")
            steps = [s for s in self.steps.values() if s.run_id == run_id]
            for step in steps:
                if step.status != StepStatus.COMPLETED:
                    reasons.append(f"step {step.step_key} is {step.status}")
                for outcome in step.validation:
                    if outcome.get("status") in ("failed", "needs_review"):
                        reasons.append(f"step {step.step_key} recorded check {outcome.get('check')} as {outcome.get('status')}")
            completed = [s.step_key for s in steps if s.status == StepStatus.COMPLETED]
            for declared in (run.definition or {}).get("steps") or []:
                if declared.get("kind") == str(StepKind.CHECK) and not any(k == declared["key"] or k.startswith(f"{declared['key']}:") for k in completed):
                    reasons.append(f"required check step {declared['key']} did not run")
            if reasons:
                raise PublicationRejected(reasons)
            conflicts = sorted(
                v.object_id
                for v in entries
                if self.objects[v.object_id].current_revision_id != (v.parent_revision_id if v.status == RevisionStatus.STAGED else v.id)
            )
            if conflicts:
                return PublishResult("conflict", conflicts=tuple(conflicts))
            self.fault("publish:validated")
            staged_ids = {v.id for v in staged}
            relation_ids = {str(r.get("relationId")) for r in manifest.get("relations") or []}
            now = self.clock.now()
            for revision in list(self.revisions.values()):
                if revision.run_id != run_id:
                    continue
                if revision.id in staged_ids:
                    self.revisions[revision.id] = replace(revision, status=RevisionStatus.PUBLISHED, published_at=now)
                    self.objects[revision.object_id] = replace(self.objects[revision.object_id], current_revision_id=revision.id)
                elif revision.status in (RevisionStatus.STAGED, RevisionStatus.CANDIDATE):
                    self.revisions[revision.id] = replace(revision, status=RevisionStatus.DISCARDED)
            for relation in list(self.relations.values()):
                if relation.run_id == run_id and relation.status == RelationStatus.STAGED:
                    status = RelationStatus.PUBLISHED if relation.id in relation_ids else RelationStatus.DISCARDED
                    self.relations[relation.id] = replace(relation, status=status, published_at=now if status == RelationStatus.PUBLISHED else None)
            self.fault("publish:heads")
            sequence = scope.publication_sequence + 1
            self.runs[run_id] = replace(
                run,
                status=RunStatus.READY,
                output_manifest={**copy.deepcopy(manifest), "publicationSequence": sequence},
                checks=copy.deepcopy(checks),
                metrics=copy.deepcopy(metrics),
                progress={**run.progress, "stage": "ready"},
                completed_at=now,
            )
            self.scopes[scope.id] = replace(scope, current_run_id=run_id, current_request_order=run.request_order, publication_sequence=sequence)
            event = self._event(
                scope,
                sequence,
                "run_published",
                run_id=run_id,
                payload={"recipeId": run.recipe_id, "recipeVersion": run.recipe_version, "scopeKey": scope.scope_key, "runId": run_id, "manifestHash": manifest.get("contentHash")},
            )
            self.fault("publish:outbox")
            return PublishResult("ready", event_id=event.id, sequence=sequence)
        except BaseException:
            self._restore(saved)
            raise

    # ── snapshots ───────────────────────────────────────────────────────

    async def publish_snapshot(self, new: NewSnapshot, *, expected_previous_id: str | None) -> Snapshot:
        self._enter("publish_snapshot")
        saved = self._snapshot_tables()
        try:
            scope = self.scopes.get(new.scope_id)
            if scope is None or scope.project_id != new.project_id or scope.kind != ScopeKind.VIEW:
                raise ReferenceViolation(f"view scope {new.scope_id} does not exist in this project")
            if new.source_event_id is not None:
                for snapshot in self.snapshots.values():
                    if snapshot.scope_id == scope.id and snapshot.source_event_id == new.source_event_id:
                        return snapshot
            if scope.current_snapshot_id != expected_previous_id:
                raise SnapshotConflict(scope.id, expected_previous_id, scope.current_snapshot_id)
            current = self.snapshots.get(scope.current_snapshot_id or "")
            if current is not None and current.content_hash == new.content_hash:
                return current
            reasons: list[str] = []
            objects = list(new.manifest.get("objects") or [])
            self._check_revisions(new.project_id, objects, None, reasons)
            displayed = {str(o.get("revisionId")) for o in objects}
            self._check_relations(new.project_id, list(new.manifest.get("relations") or []), displayed, None, reasons)
            for entry in new.manifest.get("assessments") or []:
                relation = self.relations.get(str(entry.get("relationId")))
                assessment = self.revisions.get(str(entry.get("revisionId")))
                if (
                    relation is None
                    or relation.project_id != new.project_id
                    or relation.type != "assesses"
                    or relation.status != RelationStatus.PUBLISHED
                    or assessment is None
                    or assessment.type != "fact_check_assessment"
                    or assessment.status != RevisionStatus.PUBLISHED
                    or (relation.from_revision_id, relation.to_revision_id) != (str(entry.get("revisionId")), str(entry.get("targetRevisionId")))
                ):
                    reasons.append(f"assessment entry {entry.get('relationId')} is not that assessment of that revision")
                elif relation.to_revision_id not in displayed:
                    reasons.append("an assessment names a revision the snapshot does not display")
            for producer in new.manifest.get("producers") or []:
                if producer.get("runId"):
                    run = self.runs.get(str(producer["runId"]))
                    if run is None or run.project_id != new.project_id or run.status != RunStatus.READY:
                        reasons.append("a producer output is not a ready run of this project")
            if reasons:
                raise PublicationRejected(reasons)
            self.fault("snapshot:validated")
            snapshot = Snapshot(
                id=str(uuid.uuid4()),
                project_id=new.project_id,
                scope_id=scope.id,
                view_id=new.view_id,
                manifest=copy.deepcopy(new.manifest),
                content_hash=new.content_hash,
                manifest_version=new.manifest_version,
                parent_snapshot_id=scope.current_snapshot_id,
                settings=copy.deepcopy(new.settings),
                versions=copy.deepcopy(new.versions),
                embedding_config=copy.deepcopy(new.embedding_config),
                created_by=new.created_by,
                source_event_id=new.source_event_id,
                created_at=self.clock.now(),
            )
            self.snapshots[snapshot.id] = snapshot
            sequence = scope.publication_sequence + 1
            self.scopes[scope.id] = replace(scope, current_snapshot_id=snapshot.id, publication_sequence=sequence)
            self.fault("snapshot:advanced")
            self._event(scope, sequence, "snapshot_published", snapshot_id=snapshot.id, payload={"viewId": new.view_id, "snapshotId": snapshot.id})
            return snapshot
        except BaseException:
            self._restore(saved)
            raise

    async def get_snapshot(self, snapshot_id: str) -> Snapshot | None:
        return self.snapshots.get(snapshot_id)

    # ── outbox ──────────────────────────────────────────────────────────

    async def claim_outbox(
        self, *, claim: str, limit: int, claim_seconds: int, event_id: str | None = None, dead: bool = False
    ) -> list[OutboxEvent]:
        self._enter("claim_outbox")
        now = self.clock.peek()
        due = sorted(
            (
                e
                for e in self.outbox.values()
                if (e.status == OutboxStatus.DEAD if dead else e.status in (OutboxStatus.PENDING, OutboxStatus.DISPATCHING))
                and (e.next_attempt_at or e.created_at or now) <= now
                and (event_id is None or e.id == event_id)
            ),
            key=lambda e: e.created_at or now,
        )[:limit]
        claimed = []
        for event in due:
            updated = replace(event, status=OutboxStatus.DISPATCHING, claim=claim, attempts=event.attempts + 1, next_attempt_at=self.clock.now() + timedelta(seconds=claim_seconds))
            self.outbox[event.id] = updated
            claimed.append(updated)
        return claimed

    async def mark_consumer_done(self, event_id: str, claim: str, consumer: str) -> bool:
        event = self.outbox.get(event_id)
        if event is None or event.claim != claim or event.status != OutboxStatus.DISPATCHING:
            return False
        self.outbox[event_id] = replace(event, consumers={**event.consumers, consumer: self.clock.now().isoformat()})
        return True

    async def finish_outbox(self, event_id: str, claim: str) -> bool:
        event = self.outbox.get(event_id)
        if event is None or event.claim != claim or event.status != OutboxStatus.DISPATCHING:
            return False
        self.outbox[event_id] = replace(event, status=OutboxStatus.DELIVERED, delivered_at=self.clock.now(), last_error=None)
        return True

    async def retry_outbox(self, event_id: str, claim: str, *, error: str, delay_seconds: int, max_attempts: int) -> bool:
        event = self.outbox.get(event_id)
        if event is None or event.claim != claim or event.status != OutboxStatus.DISPATCHING:
            return False
        self.outbox[event_id] = replace(
            event,
            status=OutboxStatus.DEAD if event.attempts >= max_attempts else OutboxStatus.PENDING,
            next_attempt_at=self.clock.now() + timedelta(seconds=delay_seconds),
            last_error=error,
            claim=None,
        )
        return True

    # ── embeddings ──────────────────────────────────────────────────────

    async def load_embeddings(self, project_id: str, config_key: str, input_hashes: list[str]) -> dict[str, tuple[str, list[float]]]:
        self._enter("load_embeddings")
        wanted = set(input_hashes)
        return {
            row["input_hash"]: (row["id"], list(row["embedding"]))
            for row in self.embeddings.values()
            if row["project_id"] == project_id and row["config_key"] == config_key and row["input_hash"] in wanted
        }

    async def save_embedding(self, *, project_id: str, input_hash: str, config_key: str, model: str, dims: int, vector: list[float]) -> tuple[str, list[float]]:
        self._enter("save_embedding")
        if dims <= 0 or len(vector) != dims or not all(math.isfinite(float(v)) for v in vector) or not any(float(v) for v in vector):
            raise AnalysisStoreError("the database rejected the vector")
        for row in self.embeddings.values():
            if (row["project_id"], row["input_hash"], row["config_key"]) == (project_id, input_hash, config_key):
                return str(row["id"]), list(row["embedding"])
        row = {"id": str(uuid.uuid4()), "project_id": project_id, "input_hash": input_hash, "config_key": config_key, "model": model, "dims": dims, "embedding": [float(v) for v in vector]}
        self.embeddings[row["id"]] = row
        return str(row["id"]), list(row["embedding"])

    async def vectors_by_ids(self, project_id: str, ids: list[str]) -> dict[str, list[float]]:
        return {i: list(self.embeddings[i]["embedding"]) for i in ids if i in self.embeddings and self.embeddings[i]["project_id"] == project_id}
