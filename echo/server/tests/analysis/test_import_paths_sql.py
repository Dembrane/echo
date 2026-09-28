"""The import paths against Postgres: a fixed object id unique across
projects, embedding references checked in the write's transaction, and an
imported relation validated, written once however many imports race, and
pinnable by a snapshot."""

from __future__ import annotations

import uuid
import asyncio
from typing import Any

import pytest

from dembrane.analysis.store import SqlAnalysisStore
from tests.analysis.conftest import execute, new_project
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.contracts import (
    ScopeKind,
    NewRelation,
    NewSnapshot,
    RelationBasis,
    ObjectRevision,
    RelationStatus,
    ReferenceViolation,
    AnalysisValidationError,
)
from dembrane.analysis.revisions import RevisionService
from tests.analysis.test_import_paths import TENSION, NAMESPACE, argument

pytestmark = pytest.mark.integration


async def _vector(store: SqlAnalysisStore, project: str, config: str) -> str:
    embedding_id, _ = await store.save_embedding(
        project_id=project,
        input_hash=uuid.uuid4().hex,
        config_key=config,
        model="fixture/embedding",
        dims=4,
        vector=[1.0, 0.5, 0.25, 0.125],
    )
    return embedding_id


@pytest.mark.asyncio
async def test_sql_imports_fix_object_ids_and_check_embedding_refs(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    revisions = RevisionService(store)
    project, other = await new_project(pg_dsn), await new_project(pg_dsn)
    fixed = str(uuid.uuid5(NAMESPACE, f"{project}:node-1"))
    refs = {"embeddingId": await _vector(store, project, "config-a"), "configKey": "config-a"}

    async def imported(
        lineage: str,
        *,
        object_id: str | None = None,
        embedding_refs: dict[str, Any] | None = None,
        project_id: str = project,
    ) -> ObjectRevision:
        return await revisions.import_revision(
            project_id=project_id,
            type_id="argument",
            lineage_key=lineage,
            payload=argument(),
            import_key=lineage,
            object_id=object_id,
            embedding_refs=embedding_refs,
        )

    revision = await imported("legacy:node-1", object_id=fixed, embedding_refs=refs)
    assert (revision.object_id, revision.embedding_refs) == (fixed, refs)
    assert (await imported("legacy:node-1", object_id=fixed, embedding_refs=refs)).id == revision.id
    with pytest.raises(ReferenceViolation, match="under another id"):
        await imported("legacy:node-1", object_id=str(uuid.uuid4()))
    with pytest.raises(ReferenceViolation, match="names another object"):
        await imported("legacy:node-2", object_id=fixed)
    with pytest.raises(ReferenceViolation, match="names another object"):
        await imported("legacy:node-1", object_id=fixed, project_id=other)
    with pytest.raises(AnalysisValidationError, match="not a uuid"):
        await imported("legacy:node-3", object_id="node-3")

    with pytest.raises(ReferenceViolation, match="not this project's"):
        await imported("legacy:node-4", embedding_refs={"embeddingId": await _vector(store, other, "config-a")})
    with pytest.raises(ReferenceViolation, match="not this project's"):
        await imported("legacy:node-5", embedding_refs={"embeddingId": str(uuid.uuid4())})
    with pytest.raises(ReferenceViolation, match="another configuration"):
        await imported("legacy:node-6", embedding_refs={**refs, "configKey": "config-b"})


@pytest.mark.asyncio
async def test_sql_imported_relations_are_validated_written_once_and_pinnable(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    revisions = RevisionService(store)
    project = await new_project(pg_dsn)
    pole = await revisions.import_revision(
        project_id=project, type_id="argument", lineage_key="legacy:a", payload=argument(), import_key="a"
    )
    tension = await revisions.import_revision(
        project_id=project, type_id="tension", lineage_key="legacy:t", payload=TENSION, import_key="t"
    )

    async def relate(type_id: str = "supports_pole_a", **kwargs: Any) -> Any:
        return await revisions.import_relation(
            project_id=project,
            type_id=type_id,
            from_revision_id=pole.id,
            to_revision_id=tension.id,
            basis="extracted",
            import_key="legacy:relation",
            **kwargs,
        )

    first, second = await asyncio.gather(relate(), relate())
    assert first.id == second.id
    assert (first.status, first.run_id) == (RelationStatus.PUBLISHED, None)
    rows = await execute(
        pg_dsn,
        "SELECT count(*) FROM analysis_relation WHERE to_revision_id = %s AND type = 'supports_pole_a'",
        (tension.id,),
    )
    assert rows[0][0] == 1

    fixed = str(uuid.uuid5(NAMESPACE, f"{project}:relation-b"))
    assert (await relate("supports_pole_b", relation_id=fixed)).id == fixed
    assert (await relate("supports_pole_b", relation_id=fixed)).id == fixed
    with pytest.raises(ReferenceViolation, match="names another relation"):
        await relate("supports_pole_a", relation_id=fixed)

    unpublished = NewRelation(
        project_id=project,
        type="supports_pole_a",
        basis=RelationBasis.EXTRACTED,
        from_revision_id=str(uuid.uuid4()),
        to_revision_id=tension.id,
        from_object_id=pole.object_id,
        to_object_id=tension.object_id,
        attributes={},
        provenance={},
        content_hash="d" * 64,
    )
    with pytest.raises(ReferenceViolation, match="published revisions"):
        await store.import_relation(unpublished)

    view = await store.ensure_scope(project_id=project, kind=ScopeKind.VIEW, owner_id="test.view", scope_key="project")
    manifest = {
        "objects": [{"objectId": r.object_id, "revisionId": r.id, "type": r.type} for r in (pole, tension)],
        "relations": [{"relationId": first.id, "type": first.type, "from": pole.id, "to": tension.id}],
    }
    snapshot = await store.publish_snapshot(
        NewSnapshot(
            project_id=project, scope_id=view.id, view_id="test.view", manifest=manifest, content_hash=content_hash(manifest)
        ),
        expected_previous_id=None,
    )
    assert snapshot.manifest["relations"][0]["relationId"] == first.id
