"""View snapshots against the in-memory store."""

from __future__ import annotations

import uuid
from dataclasses import replace

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.popcorn.bundle import (
    load_deck_objects,
    assemble_deck_snapshot,
    apply_shared_withdrawals,
)
from dembrane.analysis.executor import RunRequest, execute_inline
from dembrane.analysis.contracts import Run, RunMode, RunStatus, ScopeKind, SnapshotConflict
from dembrane.analysis.revisions import RevisionService
from dembrane.analysis.snapshots import (
    ProducerRef,
    SnapshotRequest,
    read_snapshot,
    resolve_snapshot,
    assemble_snapshot,
    following_view_hook,
)
from tests.analysis.fixture_recipes import PAIRS, WORDS, ASSESS, FixtureWorld

PROJECT = "11111111-1111-4111-8111-111111111111"
C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"


def _seed(world: FixtureWorld) -> None:
    world.sources[PROJECT] = {C1: ["Trams are better.", "Buses are cheaper."], C2: ["Bikes are healthy."]}


def _view(*recipes: str, **kwargs: object) -> SnapshotRequest:
    return SnapshotRequest(PROJECT, "map", "project", tuple(ProducerRef(r, "project") for r in recipes), **kwargs)  # type: ignore[arg-type]


async def _inline(store: FakeAnalysisStore, recipe: str, key: str, mode: str = "refresh") -> None:
    outcome = await execute_inline(RunRequest(PROJECT, recipe, "project", mode=mode, idempotency_key=key), store=store, deps=Recorder().deps())
    assert outcome.run.status == RunStatus.READY


@pytest.mark.asyncio
async def test_a_snapshot_shows_one_revision_per_object_and_lists_stale_support(world: FixtureWorld) -> None:
    _seed(world)
    store = FakeAnalysisStore()
    await _inline(store, PAIRS, "p1")
    first = await assemble_snapshot(_view(WORDS, PAIRS), store=store)
    assert len(first.manifest["objects"]) == 4 and len(first.manifest["relations"]) == 2 and first.manifest["stale"] == []

    # "Buses are cheaper." holds pole B; rewording it makes a newer revision
    # of the same argument, which the pinned tension never saw.
    world.sources[PROJECT][C1] = ["Trams are better.", "Buses are much cheaper."]
    await _inline(store, WORDS, "w2")
    second = await assemble_snapshot(_view(WORDS, PAIRS), store=store)

    assert second.parent_snapshot_id == first.id and len(second.manifest["objects"]) == 4
    assert [r["type"] for r in second.manifest["relations"]] == ["supports_pole_a"]
    # The tension's pole B edge, and the pairs output that pinned the old argument.
    kinds = sorted(s["kind"] for s in second.manifest["stale"])
    assert kinds == ["output", "relation"]
    shown = {o["revisionId"] for o in second.manifest["objects"]}
    assert all(s["displayedRevisionId"] in shown and s["pinnedRevisionId"] not in shown for s in second.manifest["stale"])

    # The earlier snapshot still reconstructs what it showed.
    contents = await read_snapshot(first, store=store)
    assert {r.payload.get("statement") for r in contents.revisions.values()} >= {"Buses are cheaper."}
    assert len(contents.relations) == 2 and contents.missing == ()
    assert (await resolve_snapshot(store=store, project_id=PROJECT, view_id="map", scope_key="project")).id == second.id  # type: ignore[union-attr]
    assert await resolve_snapshot(store=store, project_id="22222222-2222-4222-8222-222222222222", snapshot_id=first.id) is None


@pytest.mark.asyncio
async def test_identical_content_returns_the_current_snapshot_and_a_stale_expectation_conflicts(world: FixtureWorld) -> None:
    _seed(world)
    store = FakeAnalysisStore()
    await _inline(store, WORDS, "w1")
    first = await assemble_snapshot(_view(WORDS), store=store)
    assert (await assemble_snapshot(_view(WORDS), store=store)).id == first.id
    with pytest.raises(SnapshotConflict):
        await assemble_snapshot(_view(WORDS, settings={"colorBy": "type"}), store=store, expected_previous_id=None)
    changed = await assemble_snapshot(_view(WORDS, settings={"colorBy": "type"}), store=store)
    assert changed.id != first.id and changed.settings == {"colorBy": "type"}


@pytest.mark.asyncio
async def test_assessments_are_pinned_and_a_recheck_makes_a_successor(world: FixtureWorld) -> None:
    _seed(world)
    world.claims = {"Buses are cheaper."}
    store = FakeAnalysisStore()
    await _inline(store, ASSESS, "a1")
    first = await assemble_snapshot(_view(WORDS), store=store)
    (pinned,) = first.manifest["assessments"]

    world.verdict = "false"
    await _inline(store, ASSESS, "a2", mode="regenerate")
    second = await assemble_snapshot(_view(WORDS), store=store)
    (latest,) = second.manifest["assessments"]
    assert latest["targetRevisionId"] == pinned["targetRevisionId"] and latest["revisionId"] != pinned["revisionId"]
    assert second.parent_snapshot_id == first.id

    target = pinned["targetRevisionId"]
    assert (await read_snapshot(first, store=store)).assessments[target].payload["verdict"] == "true"
    assert (await read_snapshot(second, store=store)).assessments[target].payload["verdict"] == "false"


@pytest.mark.asyncio
async def test_a_following_view_records_its_source_event_and_assembles_once(world: FixtureWorld) -> None:
    _seed(world)
    store = FakeAnalysisStore()
    await _inline(store, WORDS, "w1")
    (event,) = [e for e in store.outbox.values() if e.event_type == "run_published"]
    hook = following_view_hook(recipe_ids=frozenset({WORDS}), build_request=lambda _e: _view(WORDS))

    await hook(event, store)
    await hook(event, store)  # repeated after a crash before the consumer marker
    (snapshot,) = store.snapshots.values()
    assert snapshot.source_event_id == event.id
    await hook(event.__class__(**{**event.__dict__, "payload": {"recipeId": PAIRS}}), store)
    assert len(store.snapshots) == 1


@pytest.mark.asyncio
async def test_authored_membership_survives_replacement_and_exclusion_is_reversible(
    world: FixtureWorld,
) -> None:
    _seed(world)
    store = FakeAnalysisStore()
    await _inline(store, WORDS, "w1")
    first = await assemble_snapshot(_view(WORDS), store=store)
    original = next(
        store.revisions[entry["revisionId"]]
        for entry in first.manifest["objects"]
        if store.revisions[entry["revisionId"]].payload.get("statement")
        == "Trams are better."
    )

    edited = await RevisionService(store).author_edit(
        project_id=PROJECT,
        object_id=original.object_id,
        expected_revision_id=original.id,
        payload={**original.payload, "statement": "Edited by the host."},
        actor_id="host-1",
    )
    edited_snapshot = await assemble_snapshot(_view(WORDS), store=store)
    assert edited.id in {o["revisionId"] for o in edited_snapshot.manifest["objects"]}
    assert original.id in (await read_snapshot(first, store=store)).revisions

    # A whole-scope replacement no longer emits the authored identity. Its
    # authored head remains effective membership instead of disappearing.
    world.sources[PROJECT] = {C2: ["A new result replaces the generated scope."]}
    await _inline(store, WORDS, "w2", mode="regenerate")
    replaced = await assemble_snapshot(_view(WORDS), store=store)
    assert edited.id in {o["revisionId"] for o in replaced.manifest["objects"]}

    excluded = await RevisionService(store).set_excluded(
        project_id=PROJECT,
        object_id=original.object_id,
        expected_revision_id=edited.id,
        excluded=True,
        actor_id="host-1",
        reason="Withdrawn from current results",
    )
    hidden = await assemble_snapshot(_view(WORDS), store=store)
    assert original.object_id not in {o["objectId"] for o in hidden.manifest["objects"]}

    restored = await RevisionService(store).set_excluded(
        project_id=PROJECT,
        object_id=original.object_id,
        expected_revision_id=excluded.id,
        excluded=False,
        actor_id="host-1",
        reason="Restored after review",
    )
    visible = await assemble_snapshot(_view(WORDS), store=store)
    assert restored.id in {o["revisionId"] for o in visible.manifest["objects"]}
    assert [
        event.payload["membershipExcluded"]
        for event in store.outbox.values()
        if event.event_type == "revision_published"
        and event.payload.get("objectId") == original.object_id
    ] == [False, True, False]


@pytest.mark.parametrize(
    "type_id,payload,edited_payload",
    [
        (
            "argument",
            {
                "statement": "Keep the square open.",
                "epistemicKind": "claim",
                "evidence": [],
            },
            {
                "statement": "Keep the public square open.",
                "epistemicKind": "claim",
                "evidence": [],
            },
        ),
        (
            "popcorn",
            {"phrase": "A place to meet", "question": False, "evidence": []},
            {"phrase": "A welcoming place to meet", "question": False, "evidence": []},
        ),
        (
            "tension",
            {
                "poleA": "More homes",
                "poleB": "More trees",
                "knot": "Space is limited",
                "toResolve": "How can both fit?",
                "quotes": [],
            },
            {
                "poleA": "Affordable homes",
                "poleB": "Mature trees",
                "knot": "Space is limited",
                "toResolve": "How can both fit?",
                "quotes": [],
            },
        ),
        (
            "stakeholder",
            {
                "name": "Neighbours",
                "role": "Residents",
                "stake": "A liveable street",
                "rung": "voiced",
                "weight": {"stake": 0.8, "mentions": 0.6},
                "quotes": [],
            },
            {
                "name": "Local neighbours",
                "role": "Residents",
                "stake": "A liveable street",
                "rung": "voiced",
                "weight": {"stake": 0.8, "mentions": 0.6},
                "quotes": [],
            },
        ),
    ],
)
@pytest.mark.asyncio
async def test_effective_membership_applies_edits_and_withdrawal_for_every_shared_type(
    type_id: str, payload: dict[str, object], edited_payload: dict[str, object]
) -> None:
    store = FakeAnalysisStore()
    recipe_id = f"test_{type_id}"
    scope = await store.ensure_scope(
        project_id=PROJECT,
        kind=ScopeKind.PRODUCER,
        owner_id=recipe_id,
        scope_key="project",
    )
    original = await RevisionService(store).import_revision(
        project_id=PROJECT,
        type_id=type_id,
        lineage_key=f"{type_id}:one",
        payload=payload,
        import_key=f"{type_id}:one",
        scope_id=scope.id,
        recipe_id=recipe_id,
        recipe_version="1",
    )
    run = Run(
        id=str(uuid.uuid4()),
        project_id=PROJECT,
        scope_id=scope.id,
        recipe_id=recipe_id,
        recipe_version="1",
        definition={},
        mode=RunMode.REFRESH,
        epoch=1,
        idempotency_key=f"{type_id}:run",
        request_order=1,
        request_fingerprint=f"{type_id}:fingerprint",
        status=RunStatus.READY,
        output_manifest={
            "objects": [
                {
                    "objectId": original.object_id,
                    "revisionId": original.id,
                    "type": type_id,
                }
            ],
            "relations": [],
        },
    )
    store.runs[run.id] = run
    store.scopes[scope.id] = replace(scope, current_run_id=run.id, current_request_order=1)
    request = SnapshotRequest(
        PROJECT,
        "shared",
        "project",
        (ProducerRef(recipe_id, "project"),),
    )
    historical = await assemble_snapshot(request, store=store)

    edited = await RevisionService(store).author_edit(
        project_id=PROJECT,
        object_id=original.object_id,
        expected_revision_id=original.id,
        payload=edited_payload,
        actor_id="host",
    )
    current = await assemble_snapshot(request, store=store)
    assert current.manifest["objects"][0]["revisionId"] == edited.id
    assert (await read_snapshot(historical, store=store)).revisions[original.id].payload == payload

    excluded = await RevisionService(store).set_excluded(
        project_id=PROJECT,
        object_id=original.object_id,
        expected_revision_id=edited.id,
        excluded=True,
        actor_id="host",
    )
    withdrawn = await assemble_snapshot(request, store=store)
    assert withdrawn.manifest["objects"] == []
    # Editing while withdrawn cannot accidentally restore membership.
    edited_while_hidden = await RevisionService(store).author_edit(
        project_id=PROJECT,
        object_id=original.object_id,
        expected_revision_id=excluded.id,
        payload=edited_payload,
        actor_id="host",
    )
    assert edited_while_hidden.provenance.extra["membershipExcluded"] is True
    assert (await assemble_snapshot(request, store=store)).manifest["objects"] == []


@pytest.mark.asyncio
async def test_deck_revision_publication_is_adoptable_and_withdrawal_overrides_a_pin() -> None:
    store = FakeAnalysisStore()
    scope = await store.ensure_scope(
        project_id=PROJECT,
        kind=ScopeKind.PRODUCER,
        owner_id="tensions",
        scope_key="project",
    )
    original = await RevisionService(store).import_revision(
        project_id=PROJECT,
        type_id="tension",
        lineage_key="tension:one",
        payload={
            "poleA": "More homes",
            "poleB": "More trees",
            "knot": "Space is limited",
            "toResolve": "How can both fit?",
            "quotes": [],
        },
        import_key="tension:one",
        scope_id=scope.id,
        recipe_id="tensions",
        recipe_version="1",
    )
    run = Run(
        id=str(uuid.uuid4()),
        project_id=PROJECT,
        scope_id=scope.id,
        recipe_id="tensions",
        recipe_version="1",
        definition={},
        mode=RunMode.REFRESH,
        epoch=1,
        idempotency_key="tensions:run",
        request_order=1,
        request_fingerprint="tensions:fingerprint",
        status=RunStatus.READY,
        output_manifest={
            "objects": [
                {
                    "objectId": original.object_id,
                    "revisionId": original.id,
                    "type": "tension",
                }
            ],
            "relations": [],
        },
    )
    store.runs[run.id] = run
    store.scopes[scope.id] = replace(scope, current_run_id=run.id, current_request_order=1)

    first = await assemble_deck_snapshot(PROJECT, store=store, source_event_id="run:1")
    assert first is not None
    edited = await RevisionService(store).author_edit(
        project_id=PROJECT,
        object_id=original.object_id,
        expected_revision_id=original.id,
        payload={
            "poleA": "Affordable homes",
            "poleB": "Mature trees",
            "knot": "Space is limited",
            "toResolve": "How can both fit?",
            "quotes": [],
        },
        actor_id="host",
    )
    second = await assemble_deck_snapshot(PROJECT, store=store, source_event_id="revision:1")
    assert second is not None
    assert second.id != first.id and second.parent_snapshot_id == first.id
    assert (await load_deck_objects(PROJECT, store=store)).tensions[0].id == edited.id
    assert (
        await load_deck_objects(PROJECT, store=store, snapshot_id=first.id)
    ).tensions[0].id == original.id

    excluded = await RevisionService(store).set_excluded(
        project_id=PROJECT,
        object_id=original.object_id,
        expected_revision_id=edited.id,
        excluded=True,
        actor_id="host",
    )
    third = await assemble_deck_snapshot(PROJECT, store=store, source_event_id="revision:2")
    assert third is not None and third.id != second.id
    assert (await load_deck_objects(PROJECT, store=store)).tensions == []
    # Stored pins stay reconstructable, while the audience filter enforces the
    # current withdrawal over content already pinned by a host.
    assert (
        await load_deck_objects(PROJECT, store=store, snapshot_id=first.id)
    ).tensions[0].id == original.id
    pinned = {
        "files": {
            "tensions.json": {
                "tensions": [{"objectId": original.object_id, "title": "Old wording"}]
            }
        }
    }
    filtered = await apply_shared_withdrawals(pinned, PROJECT, store=store)
    assert filtered["files"]["tensions.json"]["tensions"] == []
    assert excluded.provenance.extra["membershipExcluded"] is True
