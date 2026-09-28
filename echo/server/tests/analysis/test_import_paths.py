"""Paths into the analysis store outside a run, found while importing v1 Map
results: a worker that only dispatches loads the view hooks itself, an import
carries embedding references and a fixed object id, and an imported relation
is published under a run's validation."""

from __future__ import annotations

import os
import sys
import uuid
import subprocess
from typing import Any
from pathlib import Path

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.contracts import (
    ScopeKind,
    NewSnapshot,
    ObjectRevision,
    RelationStatus,
    ReferenceViolation,
    AnalysisValidationError,
)
from dembrane.analysis.revisions import RevisionService

PROJECT = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
C1 = "aaaaaaaa-0000-4000-8000-000000000001"
SERVER = Path(__file__).resolve().parents[2]
NAMESPACE = uuid.UUID("6f1c7d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f")

TENSION = {
    "poleA": "Trams are better.",
    "poleB": "Buses are cheaper.",
    "knot": "Both cannot hold at once.",
    "toResolve": "Which comes first?",
    "quotes": [{"text": "Trams are better.", "pole": "A"}, {"text": "Buses are cheaper.", "pole": "B"}],
}


def argument(statement: str = "Trams are better.") -> dict[str, Any]:
    return {
        "statement": statement,
        "epistemicKind": "argument",
        "valence": "positive",
        "evidence": [{"conversationId": C1, "quotes": [statement]}],
    }


# ── 1. the dispatcher loads the view hooks ──────────────────────────────

FRESH_WORKER = """
import sys
import asyncio

import dembrane.analysis.outbox as outbox
from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.contracts import ScopeKind

assert "dembrane.analysis.map_view" not in sys.modules, "the map view was imported before any dispatch"
assert not outbox._snapshot_hooks
store = FakeAnalysisStore()
outbox.default_store = lambda: store
outbox.default_deps = lambda: Recorder().deps()


async def main() -> None:
    project = sys.argv[1]
    scope = await store.ensure_scope(project_id=project, kind=ScopeKind.PRODUCER, owner_id="arguments", scope_key="project")
    first = store._event(scope, 1, "revision_published", payload={})
    await outbox.run_dispatch(first.id)
    map_view = sys.modules["dembrane.analysis.map_view"]
    assert map_view.map_view_hook in outbox._snapshot_hooks
    advanced = []

    async def advance(project_id, **kwargs):
        advanced.append((project_id, kwargs["source_event_id"]))

    map_view.advance_map_view = advance
    second = store._event(scope, 2, "run_published", payload={"recipeId": "arguments", "scopeKey": "project"})
    report = await outbox.run_dispatch(second.id)
    assert report.delivered == 1, report
    assert advanced == [(project, second.id)], advanced
    print("the map view hook ran")


asyncio.run(main())
"""


def test_a_worker_that_only_dispatches_runs_the_map_view_hook() -> None:
    path = os.pathsep.join(p for p in (str(SERVER), os.environ.get("PYTHONPATH")) if p)
    done = subprocess.run(
        [sys.executable, "-c", FRESH_WORKER, PROJECT],
        cwd=SERVER,
        env={**os.environ, "PYTHONPATH": path},
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert done.returncode == 0, done.stderr[-4000:]
    assert "the map view hook ran" in done.stdout


# ── 2. an import carries embedding references ───────────────────────────


async def _vector(store: FakeAnalysisStore, project: str, config: str) -> str:
    embedding_id, _ = await store.save_embedding(
        project_id=project,
        input_hash=uuid.uuid4().hex,
        config_key=config,
        model="fixture/embedding",
        dims=2,
        vector=[1.0, 0.5],
    )
    return embedding_id


@pytest.mark.asyncio
async def test_an_import_carries_embedding_refs_of_its_project_and_configuration() -> None:
    store = FakeAnalysisStore()
    revisions = RevisionService(store)
    refs = {"embeddingId": await _vector(store, PROJECT, "config-a"), "configKey": "config-a"}

    async def imported(lineage: str, embedding_refs: dict[str, Any] | None) -> ObjectRevision:
        return await revisions.import_revision(
            project_id=PROJECT,
            type_id="argument",
            lineage_key=lineage,
            payload=argument(),
            import_key="legacy",
            embedding_refs=embedding_refs,
        )

    first = await imported("legacy:1", refs)
    assert first.embedding_refs == refs
    assert (await imported("legacy:1", refs)).id == first.id

    # The same content under another configuration's vector is a new head.
    moved = {"embeddingId": await _vector(store, PROJECT, "config-b"), "configKey": "config-b"}
    second = await imported("legacy:1", moved)
    assert second.id != first.id and second.embedding_refs == moved

    with pytest.raises(ReferenceViolation, match="not this project's"):
        await imported("legacy:2", {"embeddingId": await _vector(store, OTHER, "config-a"), "configKey": "config-a"})
    with pytest.raises(ReferenceViolation, match="not this project's"):
        await imported("legacy:3", {"embeddingId": str(uuid.uuid4()), "configKey": "config-a"})
    with pytest.raises(ReferenceViolation, match="another configuration"):
        await imported("legacy:4", {**refs, "configKey": "config-b"})
    with pytest.raises(AnalysisValidationError, match="names its embedding"):
        await imported("legacy:5", {"configKey": "config-a"})


# ── 3. an import fixes its object id ────────────────────────────────────


@pytest.mark.asyncio
async def test_an_import_can_fix_its_object_id() -> None:
    store = FakeAnalysisStore()
    revisions = RevisionService(store)
    fixed = str(uuid.uuid5(NAMESPACE, "legacy:node-1"))

    async def imported(lineage: str, object_id: str) -> ObjectRevision:
        return await revisions.import_revision(
            project_id=PROJECT,
            type_id="argument",
            lineage_key=lineage,
            payload=argument(),
            import_key=lineage,
            object_id=object_id,
        )

    revision = await imported("legacy:node-1", fixed)
    assert revision.object_id == fixed
    assert (await imported("legacy:node-1", fixed)).id == revision.id
    with pytest.raises(ReferenceViolation, match="under another id"):
        await imported("legacy:node-1", str(uuid.uuid5(NAMESPACE, "elsewhere")))
    with pytest.raises(ReferenceViolation, match="names another object"):
        await imported("legacy:node-2", fixed)
    with pytest.raises(AnalysisValidationError, match="not a uuid"):
        await imported("legacy:node-3", "node-3")


# ── 4. an imported relation ─────────────────────────────────────────────


async def _pole_and_tension(revisions: RevisionService, project: str) -> tuple[ObjectRevision, ObjectRevision]:
    pole = await revisions.import_revision(
        project_id=project, type_id="argument", lineage_key="legacy:a", payload=argument(), import_key="a"
    )
    tension = await revisions.import_revision(
        project_id=project, type_id="tension", lineage_key="legacy:t", payload=TENSION, import_key="t"
    )
    return pole, tension


@pytest.mark.asyncio
async def test_an_imported_relation_is_validated_published_once_and_pinnable() -> None:
    store = FakeAnalysisStore()
    revisions = RevisionService(store)
    pole, tension = await _pole_and_tension(revisions, PROJECT)

    async def relate(type_id: str = "supports_pole_a", **kwargs: Any) -> Any:
        ends = {"from_revision_id": pole.id, "to_revision_id": tension.id, **kwargs}
        return await revisions.import_relation(
            project_id=PROJECT, type_id=type_id, basis="extracted", import_key="legacy:relation", **ends
        )

    relation = await relate()
    assert relation.status == RelationStatus.PUBLISHED and relation.run_id is None
    assert (relation.provenance["origin"], relation.provenance["importKey"]) == ("imported", "legacy:relation")
    assert (await relate()).id == relation.id

    fixed = str(uuid.uuid5(NAMESPACE, "legacy:relation-b"))
    assert (await relate("supports_pole_b", relation_id=fixed)).id == fixed
    assert (await relate("supports_pole_b", relation_id=fixed)).id == fixed
    with pytest.raises(ReferenceViolation, match="names another relation"):
        await relate("supports_pole_a", relation_id=fixed)

    with pytest.raises(AnalysisValidationError):
        await relate(from_revision_id=tension.id, to_revision_id=pole.id)
    foreign, _ = await _pole_and_tension(revisions, OTHER)
    with pytest.raises(ReferenceViolation, match="own project"):
        await relate(from_revision_id=foreign.id)

    view = await store.ensure_scope(project_id=PROJECT, kind=ScopeKind.VIEW, owner_id="test.view", scope_key="project")
    manifest = {
        "objects": [{"objectId": r.object_id, "revisionId": r.id, "type": r.type} for r in (pole, tension)],
        "relations": [{"relationId": relation.id, "type": relation.type, "from": pole.id, "to": tension.id}],
    }
    snapshot = await store.publish_snapshot(
        NewSnapshot(
            project_id=PROJECT, scope_id=view.id, view_id="test.view", manifest=manifest, content_hash=content_hash(manifest)
        ),
        expected_previous_id=None,
    )
    assert snapshot.manifest["relations"][0]["relationId"] == relation.id
