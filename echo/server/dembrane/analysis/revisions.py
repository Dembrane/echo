"""The one revision-writing service: generated, authored, imported, rolled back.

- Generated revisions are staged under their run and become visible only when
  the run publishes. Unchanged content reuses the object's published head.
- A generated update over an authored head is staged as a candidate: it waits
  for review and never replaces the authored text by itself.
- Authored edits name the revision they started from; a head that moved on
  meanwhile is a `RevisionConflict` carrying the current head, never
  last-write-wins.
- Rollback is a new revision with the older content, not a pointer move.
- Identity comes from the producer's lineage key, never from content
  similarity: identical text under two lineage keys is two objects.

Every object belongs to a scope whose row orders its publications: a recipe's
producer scope for generated objects, the project's `authored` scope for
objects created by hand and the `imported` scope for imports that name none.
An authored or imported head change commits with its outbox event.
"""

from __future__ import annotations

import uuid
from typing import Any, Iterable
from dataclasses import dataclass

from dembrane.analysis import types
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.contracts import (
    AUTHORED_SCOPE_OWNER,
    IMPORTED_SCOPE_OWNER,
    Run,
    Origin,
    Relation,
    ScopeKind,
    SourceRef,
    Provenance,
    NewRelation,
    NewRevision,
    ObjectRecord,
    AnalysisStore,
    RelationBasis,
    ObjectRevision,
    RevisionStatus,
    ReferenceViolation,
    AnalysisValidationError,
)


@dataclass(frozen=True)
class StagedRevision:
    object: ObjectRecord
    revision: ObjectRevision
    # The published head already says exactly this: no new revision was written.
    reused: bool
    # Staged as a candidate over an authored head.
    needs_review: bool


def revision_content_hash(
    *,
    type_id: str,
    schema_version: int,
    payload: dict[str, Any],
    attributes: dict[str, Any],
    provenance: Provenance,
) -> str:
    """What makes two revisions interchangeable: the content, its evidence and
    inputs, and the recipe version that produced it. The run id is left out, so
    an unchanged output of a later run reuses the earlier revision."""
    return content_hash(
        {
            "type": type_id,
            "schemaVersion": schema_version,
            "payload": payload,
            "attributes": attributes,
            "origin": str(provenance.origin),
            "recipeId": provenance.recipe_id,
            "recipeVersion": provenance.recipe_version,
            "inputRevisionIds": sorted(provenance.input_revision_ids),
            "sourceRefs": [ref.as_json() for ref in provenance.source_refs],
        }
    )


def _same_embedding(current: dict[str, Any] | None, wanted: dict[str, Any] | None) -> bool:
    """A head is reusable for a computation that names no vector, or the very
    vector the head already references; never once the configuration moved."""
    return wanted is None or dict(current or {}) == dict(wanted)


class RevisionService:
    def __init__(self, store: AnalysisStore) -> None:
        self.store = store

    async def _head(self, record: ObjectRecord) -> ObjectRevision | None:
        if not record.current_revision_id:
            return None
        return (await self.store.get_revisions(record.project_id, [record.current_revision_id])).get(
            record.current_revision_id
        )

    async def _scope_id(self, project_id: str, owner: str) -> str:
        scope = await self.store.ensure_scope(
            project_id=project_id, kind=ScopeKind.PRODUCER, owner_id=owner, scope_key="project"
        )
        return scope.id

    # ── generated ───────────────────────────────────────────────────────

    async def stage_generated(
        self,
        run: Run,
        lease: str,
        *,
        type_id: str,
        lineage_key: str,
        payload: dict[str, Any],
        source_refs: Iterable[SourceRef] = (),
        input_revision_ids: Iterable[str] = (),
        embedding_refs: dict[str, Any] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> StagedRevision | None:
        """Stage one generated object revision under a running run. None when
        the run is no longer this worker's."""
        definition = types.get_object_type(type_id)
        clean = types.validate_payload(type_id, payload)
        attributes = types.attributes_for(type_id, clean)
        provenance = Provenance(
            run_id=run.id,
            origin=Origin.GENERATED,
            recipe_id=run.recipe_id,
            recipe_version=run.recipe_version,
            input_revision_ids=tuple(sorted(set(input_revision_ids))),
            source_refs=tuple(source_refs),
            extra=dict(extra or {}),
        )
        hashed = revision_content_hash(
            type_id=type_id,
            schema_version=definition.schema_version,
            payload=clean,
            attributes=attributes,
            provenance=provenance,
        )
        record = await self.store.ensure_object(
            project_id=run.project_id, type=type_id, lineage_key=lineage_key, scope_id=run.scope_id
        )
        head = await self._head(record)
        if head is not None and head.content_hash == hashed and _same_embedding(head.embedding_refs, embedding_refs):
            return StagedRevision(object=record, revision=head, reused=True, needs_review=False)
        over_authored = head is not None and head.provenance.origin == Origin.AUTHORED
        revision = await self.store.stage_revision(
            run.id,
            lease,
            NewRevision(
                project_id=run.project_id,
                object_id=record.id,
                type=type_id,
                schema_version=definition.schema_version,
                origin=Origin.GENERATED,
                payload=clean,
                attributes=attributes,
                provenance=provenance,
                content_hash=hashed,
                status=RevisionStatus.CANDIDATE if over_authored else RevisionStatus.STAGED,
                run_id=run.id,
                parent_revision_id=head.id if head else None,
                embedding_refs=embedding_refs,
            ),
        )
        if revision is None:
            return None
        return StagedRevision(object=record, revision=revision, reused=False, needs_review=over_authored)

    async def stage_relation(
        self,
        run: Run,
        lease: str,
        *,
        type_id: str,
        from_revision: ObjectRevision,
        to_revision: ObjectRevision,
        basis: RelationBasis | str,
        attributes: dict[str, Any] | None = None,
        source_refs: Iterable[SourceRef] = (),
    ) -> Relation | None:
        clean = types.validate_relation(
            type_id,
            from_type=from_revision.type,
            to_type=to_revision.type,
            basis=basis,
            attributes=attributes,
        )
        if from_revision.project_id != run.project_id or to_revision.project_id != run.project_id:
            raise ReferenceViolation("a relation connects revisions of its own project only")
        if from_revision.id == to_revision.id:
            raise AnalysisValidationError("a relation connects two different revisions")
        parsed = RelationBasis(basis)
        provenance = {
            "runId": run.id,
            "recipeId": run.recipe_id,
            "recipeVersion": run.recipe_version,
            "sourceRefs": [ref.as_json() for ref in source_refs],
        }
        return await self.store.stage_relation(
            run.id,
            lease,
            NewRelation(
                project_id=run.project_id,
                type=type_id,
                basis=parsed,
                from_revision_id=from_revision.id,
                to_revision_id=to_revision.id,
                from_object_id=from_revision.object_id,
                to_object_id=to_revision.object_id,
                attributes=clean,
                provenance=provenance,
                content_hash=content_hash(
                    {
                        "type": type_id,
                        "basis": str(parsed),
                        "from": from_revision.id,
                        "to": to_revision.id,
                        "attributes": clean,
                        "sourceRefs": provenance["sourceRefs"],
                    }
                ),
                run_id=run.id,
            ),
        )

    # ── authored, imported, rolled back ─────────────────────────────────

    async def _append(
        self,
        record: ObjectRecord,
        *,
        payload: dict[str, Any],
        origin: Origin,
        expected_revision_id: str | None,
        actor_id: str | None,
        reason: str | None,
        source_refs: Iterable[SourceRef] = (),
        recipe_id: str | None = None,
        recipe_version: str | None = None,
        extra: dict[str, Any] | None = None,
        revision_id: str | None = None,
    ) -> ObjectRevision:
        definition = types.get_object_type(record.type)
        clean = types.validate_payload(record.type, payload)
        attributes = types.attributes_for(record.type, clean)
        provenance = Provenance(
            run_id=None,
            origin=origin,
            recipe_id=recipe_id,
            recipe_version=recipe_version,
            source_refs=tuple(source_refs),
            extra={**(extra or {}), **({"before": expected_revision_id} if expected_revision_id else {})},
        )
        return await self.store.append_revision(
            NewRevision(
                project_id=record.project_id,
                object_id=record.id,
                type=record.type,
                schema_version=definition.schema_version,
                origin=origin,
                payload=clean,
                attributes=attributes,
                provenance=provenance,
                content_hash=revision_content_hash(
                    type_id=record.type,
                    schema_version=definition.schema_version,
                    payload=clean,
                    attributes=attributes,
                    provenance=provenance,
                ),
                status=RevisionStatus.PUBLISHED,
                parent_revision_id=expected_revision_id,
                actor_id=actor_id,
                reason=reason,
                revision_id=revision_id,
            ),
            expected_revision_id=expected_revision_id,
        )

    async def _record(self, project_id: str, object_id: str) -> ObjectRecord:
        record = await self.store.get_object(object_id)
        if record is None or record.project_id != project_id:
            raise ReferenceViolation(f"object {object_id} is not in this project")
        return record

    async def author_edit(
        self,
        *,
        project_id: str,
        object_id: str,
        expected_revision_id: str,
        payload: dict[str, Any],
        actor_id: str,
        reason: str | None = None,
    ) -> ObjectRevision:
        """Append an authored revision. Raises `RevisionConflict` with the
        current head when `expected_revision_id` is no longer it."""
        record = await self._record(project_id, object_id)
        return await self._append(
            record,
            payload=payload,
            origin=Origin.AUTHORED,
            expected_revision_id=expected_revision_id,
            actor_id=actor_id,
            reason=reason,
        )

    async def create_authored(
        self,
        *,
        project_id: str,
        type_id: str,
        payload: dict[str, Any],
        actor_id: str,
        reason: str | None = None,
    ) -> ObjectRevision:
        record = await self.store.ensure_object(
            project_id=project_id,
            type=type_id,
            lineage_key=f"authored:{uuid.uuid4()}",
            scope_id=await self._scope_id(project_id, AUTHORED_SCOPE_OWNER),
        )
        return await self._append(
            record,
            payload=payload,
            origin=Origin.AUTHORED,
            expected_revision_id=None,
            actor_id=actor_id,
            reason=reason,
        )

    async def import_revision(
        self,
        *,
        project_id: str,
        type_id: str,
        lineage_key: str,
        payload: dict[str, Any],
        import_key: str,
        scope_id: str | None = None,
        source_refs: Iterable[SourceRef] = (),
        recipe_id: str | None = None,
        recipe_version: str | None = None,
        revision_id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> ObjectRevision:
        """Import saved history into a producer scope (the project's
        `imported` scope when none is named). A repeat import of the same
        content, or of the same fixed revision id, returns what the first one
        wrote."""
        record = await self.store.ensure_object(
            project_id=project_id,
            type=type_id,
            lineage_key=lineage_key,
            scope_id=scope_id or await self._scope_id(project_id, IMPORTED_SCOPE_OWNER),
        )
        head = await self._head(record)
        clean = types.validate_payload(type_id, payload)
        provenance = Provenance(
            run_id=None,
            origin=Origin.IMPORTED,
            recipe_id=recipe_id,
            recipe_version=recipe_version,
            source_refs=tuple(source_refs),
            extra={**(extra or {}), "importKey": import_key},
        )
        attributes = types.attributes_for(type_id, clean)
        if head is not None and head.content_hash == revision_content_hash(
            type_id=type_id,
            schema_version=types.get_object_type(type_id).schema_version,
            payload=clean,
            attributes=attributes,
            provenance=provenance,
        ):
            return head
        return await self._append(
            record,
            payload=clean,
            origin=Origin.IMPORTED,
            expected_revision_id=head.id if head else None,
            actor_id=None,
            reason=None,
            source_refs=source_refs,
            recipe_id=recipe_id,
            recipe_version=recipe_version,
            extra={**(extra or {}), "importKey": import_key},
            revision_id=revision_id,
        )

    async def rollback(
        self,
        *,
        project_id: str,
        object_id: str,
        to_revision_id: str,
        expected_revision_id: str,
        actor_id: str,
        reason: str | None = None,
    ) -> ObjectRevision:
        """A new authored revision carrying an older revision's content."""
        record = await self._record(project_id, object_id)
        target = (await self.store.get_revisions(project_id, [to_revision_id])).get(to_revision_id)
        if target is None or target.object_id != object_id or target.status != RevisionStatus.PUBLISHED:
            raise ReferenceViolation(f"revision {to_revision_id} is not a published revision of this object")
        return await self._append(
            record,
            payload=target.payload,
            origin=Origin.AUTHORED,
            expected_revision_id=expected_revision_id,
            actor_id=actor_id,
            reason=reason,
            source_refs=target.provenance.source_refs,
            extra={"rollbackOf": to_revision_id},
        )
