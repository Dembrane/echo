"""The results endpoints a host curates with: what may be reworded, what the
host says they changed, what needs their eye, and when they last looked.

Everything here is additive. A client from before the audit trail sends no
`change_kind` and no patch, and still writes.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from dataclasses import replace

import pytest

import dembrane.api.v2.bff.analysis as analysis_bff
from dembrane.api import feature_flags
from tests.map_fakes import PROJECT
from tests.analysis.helpers import Recorder
from dembrane.analysis.revisions import RevisionService
from tests.analysis.map_v2_fakes import READ, WRITE, Grants, Limiter, MapWorld, inline, asgi_call
from tests.analysis.fixture_recipes import WORDS, ASSESS, FixtureWorld

BASE = "/api/v2/bff/analysis"
C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"
C3 = "aaaaaaaa-0000-4000-8000-000000000003"


class _Env:
    def __init__(self, monkeypatch: pytest.MonkeyPatch, maps: MapWorld) -> None:
        self.maps = maps
        self.grants = Grants()
        self.rec = Recorder()
        self.limiter = Limiter()
        monkeypatch.setattr(analysis_bff, "resolve_project_access", self.grants.resolve)
        monkeypatch.setattr(analysis_bff, "get_store", lambda: maps.store)
        monkeypatch.setattr(analysis_bff, "get_reads", lambda: maps.reads)
        monkeypatch.setattr(analysis_bff, "get_executor_deps", lambda: self.rec.deps())
        monkeypatch.setattr(analysis_bff, "_run_limiter", self.limiter)

    async def call(self, method: str, path: str, json: Any = None, params: dict[str, str] | None = None) -> Any:
        return await asgi_call(analysis_bff.router, BASE, method, path, json=json, params=params)

    def revision(self, statement: str) -> Any:
        return next(
            revision
            for revision in self.maps.store.revisions.values()
            if revision.payload.get("statement") == statement
        )

    def enrich(self, statement: str, *, conversations: tuple[str, ...], quotes: int) -> Any:
        """Give one argument evidence from more than one conversation, the way
        a real extraction does. The fixture recipe roots every statement in one
        quote of one conversation, which would make every row thin."""
        revision = self.revision(statement)
        evidence = [
            {"conversationId": cid, "quotes": [f"{statement} ({cid}:{n})" for n in range(quotes)]}
            for cid in conversations
        ]
        enriched = replace(revision, payload={**revision.payload, "evidence": evidence})
        self.maps.store.revisions[revision.id] = enriched
        return enriched


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, world: FixtureWorld) -> _Env:
    world.sources[PROJECT] = {
        C1: ["Trams are better.", "Buses are cheaper."],
        C2: ["Bikes are healthy."],
    }
    monkeypatch.setattr(
        feature_flags,
        "get_settings",
        lambda: SimpleNamespace(feature_flags=SimpleNamespace(enable_present=True)),
    )
    return _Env(monkeypatch, MapWorld())


async def _prepared(env: _Env) -> Any:
    env.grants.grant(PROJECT, *WRITE)
    await inline(env.maps.store, WORDS, "words")
    return await env.maps.advance()


# ── the allowlist ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_only_the_words_may_differ_from_the_head(env: _Env) -> None:
    await _prepared(env)
    original = env.revision("Trams are better.")
    path = f"/projects/{PROJECT}/objects/{original.object_id}"

    evidence = await env.call(
        "POST",
        f"{path}/revisions",
        {
            "expected_revision_id": original.id,
            "payload": {**original.payload, "evidence": [{"conversationId": C2, "quotes": ["Invented."]}]},
        },
    )
    assert evidence.status_code == 422
    assert "evidence" in evidence.json()["detail"]

    valence = await env.call(
        "POST",
        f"{path}/revisions",
        {"expected_revision_id": original.id, "payload": {**original.payload, "valence": "negative"}},
    )
    assert valence.status_code == 422 and "valence" in valence.json()["detail"]

    # The whole payload with one field changed is what a client sends today.
    edited = await env.call(
        "POST",
        f"{path}/revisions",
        {
            "expected_revision_id": original.id,
            "payload": {**original.payload, "statement": "Trams work better here."},
            "change_kind": "clarity",
        },
    )
    assert edited.status_code == 200
    assert edited.json()["revision"]["payload"]["statement"] == "Trams work better here."
    # The evidence travelled with the finding, untouched.
    assert edited.json()["revision"]["payload"]["evidence"] == original.payload["evidence"]


@pytest.mark.asyncio
async def test_a_patch_of_allowlisted_fields_is_applied_onto_the_head(env: _Env) -> None:
    await _prepared(env)
    original = env.revision("Bikes are healthy.")
    path = f"/projects/{PROJECT}/objects/{original.object_id}"

    refused = await env.call(
        "POST",
        f"{path}/revisions",
        {"expected_revision_id": original.id, "patch": {"evidence": []}},
    )
    assert refused.status_code == 422 and "evidence" in refused.json()["detail"]

    both = await env.call(
        "POST",
        f"{path}/revisions",
        {"expected_revision_id": original.id, "patch": {"statement": "x"}, "payload": original.payload},
    )
    assert both.status_code == 422

    patched = await env.call(
        "POST",
        f"{path}/revisions",
        {
            "expected_revision_id": original.id,
            "patch": {"statement": "Cycling is healthy."},
            "change_kind": "typo",
        },
    )
    assert patched.status_code == 200
    revision = patched.json()["revision"]
    assert revision["payload"]["statement"] == "Cycling is healthy."
    assert revision["payload"]["evidence"] == original.payload["evidence"]
    assert revision["changeKind"] == "typo"


@pytest.mark.asyncio
async def test_every_allowed_field_of_every_type_may_be_reworded(env: _Env) -> None:
    env.grants.grant(PROJECT, *WRITE)
    service = RevisionService(env.maps.store)
    cases: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
        "popcorn": (
            {"phrase": "Bins overflow", "question": False, "evidence": []},
            {"phrase": "The bins overflow"},
        ),
        "tension": (
            {"poleA": "Fast", "poleB": "Safe", "knot": "Both at once.", "toResolve": "Which first?", "quotes": []},
            {"poleA": "Quick", "poleB": "Safer", "knot": "Both, really.", "toResolve": "Which comes first?"},
        ),
        "stakeholder": (
            {
                "name": "Cyclists",
                "role": "Daily riders",
                "stake": "Safe lanes",
                "rung": "voiced",
                "weight": {"stake": 0.5, "mentions": 0.5},
                "quotes": [],
            },
            {"name": "People on bikes", "role": "Riders", "stake": "Lanes that feel safe"},
        ),
        "deduplicated_argument": (
            {
                "statement": "Trams win.",
                "epistemicKind": "argument",
                "evidence": [],
                "consolidation": {"strategy": "merge", "memberCount": 2, "verification": "verified"},
            },
            {"statement": "Trams win on time."},
        ),
    }
    for type_id, (payload, patch) in cases.items():
        created = await service.create_authored(
            project_id=PROJECT, type_id=type_id, payload=payload, actor_id="du1"
        )
        path = f"/projects/{PROJECT}/objects/{created.object_id}/revisions"
        response = await env.call(
            "POST", path, {"expected_revision_id": created.id, "patch": patch, "change_kind": "clarity"}
        )
        assert response.status_code == 200, (type_id, response.json())
        for field, value in patch.items():
            assert response.json()["revision"]["payload"][field] == value
        # And the grounds of the same object cannot be touched.
        head = response.json()["revision"]
        refused = await env.call(
            "POST", path, {"expected_revision_id": head["revisionId"], "patch": {"rung": "inferred"}}
        )
        assert refused.status_code == 422


# ── what the host says they changed ─────────────────────────────────────


@pytest.mark.asyncio
async def test_the_kind_is_accepted_not_required_and_ruled_per_operation(env: _Env) -> None:
    await _prepared(env)
    original = env.revision("Trams are better.")
    path = f"/projects/{PROJECT}/objects/{original.object_id}"

    # A client from before the audit trail sends no kind, and still writes.
    legacy = await env.call(
        "POST",
        f"{path}/revisions",
        {"expected_revision_id": original.id, "payload": {**original.payload, "statement": "Trams are best."}},
    )
    assert legacy.status_code == 200 and legacy.json()["revision"]["changeKind"] is None
    head = legacy.json()["revision"]["revisionId"]

    unknown = await env.call(
        "POST",
        f"{path}/revisions",
        {"expected_revision_id": head, "patch": {"statement": "x."}, "change_kind": "vandalism"},
    )
    assert unknown.status_code == 422

    wrong = await env.call(
        "POST",
        f"{path}/revisions",
        {"expected_revision_id": head, "patch": {"statement": "x."}, "change_kind": "withdraw"},
    )
    assert wrong.status_code == 422

    unexplained = await env.call(
        "POST",
        f"{path}/revisions",
        {"expected_revision_id": head, "patch": {"statement": "Buses are better."}, "change_kind": "meaning"},
    )
    assert unexplained.status_code == 422

    too_short = await env.call(
        "POST",
        f"{path}/revisions",
        {
            "expected_revision_id": head,
            "patch": {"statement": "Buses are better."},
            "change_kind": "meaning",
            "reason": "  no  ",
        },
    )
    assert too_short.status_code == 422

    meant = await env.call(
        "POST",
        f"{path}/revisions",
        {
            "expected_revision_id": head,
            "patch": {"statement": "Buses are better."},
            "change_kind": "meaning",
            "reason": "The room said buses, not trams.",
        },
    )
    assert meant.status_code == 200
    assert meant.json()["revision"]["changeKind"] == "meaning"
    assert meant.json()["revision"]["actorId"] == "du1"
    head = meant.json()["revision"]["revisionId"]

    unreasoned = await env.call(
        "POST",
        f"{path}/membership",
        {"expected_revision_id": head, "excluded": True, "change_kind": "withdraw"},
    )
    assert unreasoned.status_code == 422

    as_restore = await env.call(
        "POST",
        f"{path}/membership",
        {"expected_revision_id": head, "excluded": True, "change_kind": "restore", "reason": "Off topic"},
    )
    assert as_restore.status_code == 422

    withdrawn = await env.call(
        "POST",
        f"{path}/membership",
        {"expected_revision_id": head, "excluded": True, "change_kind": "withdraw", "reason": "Off topic here"},
    )
    assert withdrawn.status_code == 200
    assert withdrawn.json()["revision"]["changeKind"] == "withdraw"

    restored = await env.call(
        "POST",
        f"{path}/membership",
        {"expected_revision_id": withdrawn.json()["revision"]["revisionId"], "excluded": False, "change_kind": "restore"},
    )
    assert restored.status_code == 200 and restored.json()["revision"]["changeKind"] == "restore"

    history = (await env.call("GET", f"{path}/revisions")).json()["revisions"]
    assert [revision["changeKind"] for revision in history] == [
        None,
        None,
        "meaning",
        "withdraw",
        "restore",
    ]


@pytest.mark.asyncio
async def test_a_rollback_keeps_the_finding_withdrawn(env: _Env) -> None:
    await _prepared(env)
    original = env.revision("Buses are cheaper.")
    path = f"/projects/{PROJECT}/objects/{original.object_id}"

    edited = (
        await env.call(
            "POST",
            f"{path}/revisions",
            {
                "expected_revision_id": original.id,
                "patch": {"statement": "Buses cost less."},
                "change_kind": "clarity",
            },
        )
    ).json()["revision"]
    withdrawn = (
        await env.call(
            "POST",
            f"{path}/membership",
            {
                "expected_revision_id": edited["revisionId"],
                "excluded": True,
                "change_kind": "withdraw",
                "reason": "Repeats the tram finding",
            },
        )
    ).json()["revision"]

    as_typo = await env.call(
        "POST",
        f"{path}/rollback",
        {"expected_revision_id": withdrawn["revisionId"], "to_revision_id": original.id, "change_kind": "typo"},
    )
    assert as_typo.status_code == 422

    rolled = await env.call(
        "POST",
        f"{path}/rollback",
        {
            "expected_revision_id": withdrawn["revisionId"],
            "to_revision_id": original.id,
            "change_kind": "rollback",
        },
    )
    assert rolled.status_code == 200
    revision = rolled.json()["revision"]
    assert revision["payload"]["statement"] == "Buses are cheaper."
    # Only the wording travelled back. The withdrawal was a separate decision
    # and still stands.
    assert revision["membershipExcluded"] is True
    assert revision["changeKind"] == "rollback"
    assert revision["provenance"]["extra"]["rollbackOf"] == original.id


# ── what needs the host's eye ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_list_says_what_a_finding_rests_on_and_whose_hands_were_on_it(env: _Env) -> None:
    await _prepared(env)
    env.enrich("Trams are better.", conversations=(C1, C2), quotes=2)
    original = env.revision("Trams are better.")
    await env.call(
        "POST",
        f"/projects/{PROJECT}/objects/{original.object_id}/revisions",
        {"expected_revision_id": original.id, "patch": {"statement": "Trams run better."}, "change_kind": "typo"},
    )

    page = (await env.call("GET", f"/projects/{PROJECT}/objects", params={"limit": "50"})).json()
    by_object = {item["objectId"]: item for item in page["items"]}
    edited = by_object[original.object_id]
    assert edited["edited"] is True
    assert edited["lastAuthoredBy"] == "du1"
    assert edited["lastAuthoredAt"]
    assert (edited["quoteCount"], edited["conversationCount"]) == (4, 2)
    assert edited["verdict"] is None

    untouched = by_object[env.revision("Bikes are healthy.").object_id]
    assert untouched["edited"] is False
    assert untouched["lastAuthoredAt"] is None and untouched["lastAuthoredBy"] is None
    assert (untouched["quoteCount"], untouched["conversationCount"]) == (1, 1)
    # Without sort=attention nothing is ranked, and the order is what it was.
    assert untouched["attention"] is None
    assert page["counts"]["argument"] == 3


@pytest.mark.asyncio
async def test_attention_rises_before_paging_and_counts_the_whole_type(env: _Env) -> None:
    world_sources = env.maps.store
    await _prepared(env)
    # Two findings that rest on enough to be quiet, one that does not.
    env.enrich("Trams are better.", conversations=(C1, C2), quotes=2)
    env.enrich("Buses are cheaper.", conversations=(C1, C2), quotes=2)
    thin = env.revision("Bikes are healthy.")
    trams = env.revision("Trams are better.")
    buses = env.revision("Buses are cheaper.")

    # This host looked just now: nothing that already existed is new.
    env.maps.store.last_opened[(PROJECT, "du1")] = env.maps.clock.peek()

    # A colleague rewords one of the quiet findings afterwards.
    await RevisionService(world_sources).author_edit(
        project_id=PROJECT,
        object_id=buses.object_id,
        expected_revision_id=buses.id,
        payload={**buses.payload, "statement": "Buses cost less."},
        actor_id="du2",
        change_kind="clarity",
    )

    page = (
        await env.call(
            "GET", f"/projects/{PROJECT}/objects", params={"sort": "attention", "limit": "2"}
        )
    ).json()
    risen = [(item["objectId"], item["attention"], item["attentionActor"]) for item in page["items"]]
    assert risen[0] == (thin.object_id, "one_conversation", None)
    assert risen[1] == (buses.object_id, "reworded", "du2")
    # Paging did not happen before the sort: the quiet row is on page two.
    assert page["total"] == 3 and page["counts"]["argument"] == 3
    second = (
        await env.call(
            "GET",
            f"/projects/{PROJECT}/objects",
            params={"sort": "attention", "limit": "2", "offset": "2"},
        )
    ).json()
    assert [(item["objectId"], item["attention"]) for item in second["items"]] == [
        (trams.object_id, None)
    ]
    # The host's own rewording never rises for the host who made it.
    assert all(item["attentionActor"] != "du1" for item in page["items"])


@pytest.mark.asyncio
async def test_a_finding_from_after_the_last_visit_reads_as_new(
    env: _Env, world: FixtureWorld
) -> None:
    await _prepared(env)
    env.enrich("Trams are better.", conversations=(C1, C2), quotes=2)
    env.enrich("Buses are cheaper.", conversations=(C1, C2), quotes=2)
    env.enrich("Bikes are healthy.", conversations=(C1, C2), quotes=2)
    env.maps.store.last_opened[(PROJECT, "du1")] = env.maps.clock.peek()

    # A later run reads one more conversation.
    world.sources[PROJECT][C3] = ["Ferries are slow."]
    await inline(env.maps.store, WORDS, "words-again")
    await env.maps.advance()
    env.enrich("Ferries are slow.", conversations=(C1, C3), quotes=2)

    page = (
        await env.call("GET", f"/projects/{PROJECT}/objects", params={"sort": "attention", "limit": "10"})
    ).json()
    assert page["items"][0]["attention"] == "new"
    assert page["items"][0]["payload"]["statement"] == "Ferries are slow."
    assert [item["attention"] for item in page["items"][1:]] == [None, None, None]


@pytest.mark.asyncio
async def test_a_fact_check_that_disagrees_rises_with_its_verdict(env: _Env, world: FixtureWorld) -> None:
    world.claims = {"Trams are better."}
    world.verdict = "contested"
    await _prepared(env)
    env.enrich("Trams are better.", conversations=(C1, C2), quotes=2)
    await inline(env.maps.store, ASSESS, "assess")
    await env.maps.advance()
    env.enrich("Trams are better.", conversations=(C1, C2), quotes=2)

    page = (
        await env.call("GET", f"/projects/{PROJECT}/objects", params={"sort": "attention", "limit": "10"})
    ).json()
    checked = next(
        item for item in page["items"] if item["payload"].get("statement") == "Trams are better."
    )
    assert checked["verdict"] == "contested"
    assert checked["attention"] == "fact_check"


# ── when this host last looked ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_last_opened_is_the_hosts_own_and_starts_empty(env: _Env) -> None:
    env.grants.grant(PROJECT, *READ)
    path = f"/projects/{PROJECT}/results/last-opened"
    first = await env.call("GET", path)
    assert first.status_code == 200 and first.json()["openedAt"] is None

    marked = await env.call("PUT", path)
    assert marked.status_code == 200 and marked.json()["openedAt"]
    again = await env.call("GET", path)
    assert again.json()["openedAt"] == marked.json()["openedAt"]
    # One row per host per project, written by the server's clock.
    assert list(env.maps.store.last_opened) == [(PROJECT, "du1")]

    env.grants.access.pop(PROJECT)
    assert (await env.call("GET", path)).status_code == 404
