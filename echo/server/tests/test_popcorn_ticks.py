from __future__ import annotations

import asyncio
from typing import Any

import pytest

import dembrane.popcorn.ticks as ticks
import dembrane.scheduled_tasks as scheduled_tasks


class _FakeDirectus:
    def __init__(self) -> None:
        self.items: dict[str, dict[str, dict[str, Any]]] = {
            "agent_loop": {
                "loop1": {
                    "id": "loop1",
                    "project_id": "p1",
                    "report_id": "r1",
                    "status": "active",
                    "expires_at": "2099-01-01T00:00:00+00:00",
                    "cadence_minutes": 2,
                    "acting_directus_user_id": "du1",
                    "failure_count": 0,
                    "caps": {"kind": "popcorn"},
                    "popcorn_state": None,
                }
            },
            "project": {"p1": {"id": "p1", "is_canvas_enabled": True}},
        }
        self.conversations = [
            {"id": "c1", "participant_name": "Table 1", "created_at": "2026-09-03T09:00:00+00:00"},
            {"id": "c2", "participant_name": "", "created_at": "2026-09-03T09:05:00+00:00"},
            {"id": "c3", "participant_name": "Silent", "created_at": "2026-09-03T09:06:00+00:00"},
        ]
        self.chunks = [
            {
                "id": "k1",
                "conversation_id": "c1",
                "transcript": "Nobody joins for the desks.",
                "timestamp": 1,
            },
            {
                "id": "k2",
                "conversation_id": "c1",
                "transcript": "The kettle is the real reception.",
                "timestamp": 2,
            },
            {
                "id": "k3",
                "conversation_id": "c2",
                "transcript": "Quiet is a service we sell.",
                "timestamp": 1,
            },
        ]
        self.created: dict[str, list[dict[str, Any]]] = {}
        self.updated: list[tuple[str, str, dict[str, Any]]] = []
        self.state_writes: list[dict[str, Any]] = []
        self.scheduled_tasks: list[dict[str, Any]] = []

    async def get_item(self, collection: str, item_id: str) -> dict[str, Any] | None:
        return self.items.get(collection, {}).get(item_id)

    async def get_items(self, collection: str, params: dict) -> list[dict[str, Any]]:
        if collection == "conversation":
            return list(self.conversations)
        if collection == "conversation_chunk":
            return list(self.chunks)
        if collection == "agent_loop":
            return list(self.items["agent_loop"].values())
        if collection == "scheduled_task":
            return list(self.scheduled_tasks)
        return []

    async def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        self.created.setdefault(collection, []).append(data)
        return {"data": data}

    async def update_item(self, collection: str, item_id: str, data: dict[str, Any]) -> dict:
        self.updated.append((collection, item_id, data))
        if collection == "agent_loop" and "popcorn_state" in data:
            # Snapshot the write so incremental publication is observable.
            import copy

            self.state_writes.append(copy.deepcopy(data["popcorn_state"]))
        self.items.setdefault(collection, {}).setdefault(item_id, {}).update(data)
        return {"data": self.items[collection][item_id]}


@pytest.fixture
def fake(monkeypatch) -> _FakeDirectus:
    fake = _FakeDirectus()
    monkeypatch.setattr(ticks, "async_directus", fake)
    # The tick reaches settings and version snapshots through the service module.
    import dembrane.popcorn.service as service

    monkeypatch.setattr(service, "async_directus", fake)

    async def _reader(**kwargs):  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "resolve_canvas_reader_context", _reader)

    async def _claim(loop_id: str) -> bool:  # noqa: ARG001
        return True

    async def _release(loop_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "_claim_run_lock", _claim)
    monkeypatch.setattr(ticks, "_release_run_lock", _release)
    monkeypatch.setattr(ticks, "_renew_run_lock", _release)
    monkeypatch.setattr(ticks, "_mark_alive", _release)
    monkeypatch.setattr(ticks, "_clear_alive", _release)

    async def _not_alive(loop_id: str) -> bool:  # noqa: ARG001
        return False

    monkeypatch.setattr(ticks, "_tick_alive", _not_alive)

    enqueued: list[tuple[str, str]] = []

    async def _enqueue(loop_id: str, when=None, tick_kind: str = "scheduled") -> str:  # noqa: ARG001
        enqueued.append((loop_id, tick_kind))
        return "task"

    monkeypatch.setattr(ticks, "enqueue_popcorn_tick", _enqueue)
    fake.enqueued = enqueued  # type: ignore[attr-defined]

    nudges: list[str] = []

    async def _nudge(report_id: str) -> None:
        nudges.append(report_id)

    monkeypatch.setattr(ticks, "publish_generation_nudge", _nudge)
    fake.nudges = nudges  # type: ignore[attr-defined]

    class _Flags:
        enable_canvas = True

    class _Settings:
        feature_flags = _Flags()

    monkeypatch.setattr(ticks, "get_settings", lambda: _Settings())
    return fake


def _install_models(monkeypatch, *, calls: list[str], fail_for: set[str] | None = None) -> None:
    async def _extract(
        *, transcript_id: str, transcript: str, host_note: str = ""
    ) -> dict[str, Any]:  # noqa: ARG001
        calls.append(f"popcorn:{transcript_id}")
        if fail_for and transcript_id in fail_for:
            raise RuntimeError("model down")
        first = transcript.split(".")[0]
        return {"items": [{"phrase": first, "weight": 2}]}

    async def _pipeline(sources: dict[str, str], book: Any) -> dict[str, Any]:  # noqa: ARG001
        calls.append("analysis:tensions")
        qids = book.add_all([{"transcript": "c1", "text": "Nobody joins for the desks."}])
        return {
            "tensions": {
                "tensions": [
                    {
                        "id": "x1",
                        "poleA": "keep the desks",
                        "poleB": "boil the kettle",
                        "knot": "Keep the desks and nobody comes; drop them and there is nowhere to sit.",
                        "toResolve": "Which one goes first?",
                        "quoteIds": qids,
                    }
                ]
            },
            "gate_flags": [],
            "counts": {"positions": 2, "candidates": 1, "cross_table": 1, "verified": 1, "kept": 1},
        }

    monkeypatch.setattr(ticks, "run_tensions_pipeline", _pipeline)

    def _group(name: str, rung: str, stake: float, mentions: float) -> dict[str, Any]:
        return {
            "name": name,
            "role": "r" * 5,
            "stake": "s" * 5,
            "rung": rung,
            "stakeWeight": stake,
            "mentionsWeight": mentions,
            "quotes": [],
        }

    _relation = {
        "between": ["Members", "Staff"],
        "label": "told after the fact",
        "intensity": 0.7,
        "sentiment": -0.4,
        "unowned": True,
        "detail": "Decisions arrive as announcements.",
        "aspects": [],
    }

    async def _analysis(
        *, kind: str, corpus: str, feedback: list[str] | None = None
    ) -> dict[str, Any]:  # noqa: ARG001
        calls.append(f"analysis:{kind}" + (":retry" if feedback else ""))
        if feedback is None and getattr(_analysis, "joined_first", False):
            _analysis.joined_first = False  # type: ignore[attr-defined]
            return {
                "stakeholders": [
                    _group("Members/AI", "voiced", 0.9, 0.8),
                    _group("Staff", "named", 0.4, 0.2),
                ],
                "relations": [{**_relation, "between": ["Members/AI", "Staff"]}],
            }
        return {
            "stakeholders": [
                _group("Members", "voiced", 0.9, 0.8),
                _group("Staff", "named", 0.4, 0.2),
            ],
            "relations": [_relation],
        }

    async def _validate(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:
        calls.append(f"validate:{transcript_id}")
        # The sentence the phrase came from, full stop and all, is its evidence.
        for line in transcript.split("\n"):
            if phrase in line:
                return {"grounded": True, "quote": line.strip(), "reason": "said as such"}
        return {"grounded": False, "quote": "", "reason": "not in the transcript"}

    async def _classify(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:  # noqa: ARG001
        calls.append(f"kind:{transcript_id}")
        return {
            "kind": "observation",
            "qualifiers": [],
            "question_form": False,
            "target": "",
            "reason": "reports what happens",
        }

    async def _rewrite(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:  # noqa: ARG001
        calls.append(f"question:{transcript_id}")
        return {"phrase": phrase + "?"}

    monkeypatch.setattr(ticks, "extract_popcorn", _extract)
    monkeypatch.setattr(ticks, "run_analysis", _analysis)
    monkeypatch.setattr(ticks, "validate_phrase", _validate)
    monkeypatch.setattr(ticks, "classify_phrase", _classify)
    monkeypatch.setattr(ticks, "rewrite_question", _rewrite)


def test_first_tick_pops_every_transcript_then_analyses(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)

    result = asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    assert result["status"] == "ok"

    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    # The silent conversation has no transcript yet, so it is not on the deck.
    assert state["order"] == ["c1", "c2"]
    assert state["conversations"]["c1"]["label"] == "Table 1"
    assert state["conversations"]["c2"]["label"] == "Conversation 2"
    assert state["conversations"]["c1"]["items"][0]["phrase"] == "Nobody joins for the desks"
    assert state["conversations"]["c1"]["items"][0]["id"].startswith("p-c1-")
    assert state["conversations"]["c2"]["done"] is True
    # The second pass rooted each phrase in its sentence and gave it a kind; the
    # tension's quote is the same sentence, so the registry holds it once.
    c1, c2 = state["conversations"]["c1"], state["conversations"]["c2"]
    assert c1["items"][0]["quoteId"] == "q1" and c2["items"][0]["quoteId"] == "q2"
    assert c1["items"][0]["kind"] == "observation" and c1["items"][0]["question"] is False
    assert c1["validated_fingerprint"] == c1["fingerprint"]
    assert c1["revision"] == 2  # one write for the phrases, one for the second pass
    assert state["analysis"]["tensions"]["tensions"][0]["quoteIds"] == ["q1"]
    assert "quotes" not in state["analysis"]
    assert [q["transcript"] for q in state["quotes"]] == ["c1", "c2"]
    assert state["quotes"][0]["text"] == "Nobody joins for the desks."
    assert len(state["analysis"]["stakeholders"]["stakeholders"]) == 2
    # Every changed run is saved as a replayable version.
    versions = fake.created["canvas_generation"]
    assert len(versions) == 1 and '"files"' in versions[0]["content_html"]

    # Session first (so the legend shows before any phrase), one write per
    # extractor completion, one per second pass, then the analysis.
    assert len(fake.state_writes) == 6
    assert fake.state_writes[0]["conversations"]["c1"]["done"] is False
    assert fake.state_writes[0]["analysis"] is None
    # The phrases were on the stage before their quotes existed.
    first_phrase_writes = [w for w in fake.state_writes if w["conversations"]["c1"].get("done")]
    assert "quoteId" not in first_phrase_writes[0]["conversations"]["c1"]["items"][0]
    assert fake.nudges.count("r1") == 6  # type: ignore[attr-defined]

    # Both popcorn extractors ran before any second-pass call, then both analyses.
    assert sorted(c for c in calls if c.startswith("popcorn")) == ["popcorn:c1", "popcorn:c2"]
    last_fast = max(calls.index("popcorn:c1"), calls.index("popcorn:c2"))
    first_slow = min(i for i, c in enumerate(calls) if c.startswith(("validate", "kind")))
    assert last_fast < first_slow
    assert sorted(c for c in calls if c.startswith("analysis")) == [
        "analysis:stakeholders",
        "analysis:tensions",
    ]
    # Each view is stamped with the session it read.
    fps = state["analysis"]["fingerprints"]
    assert set(fps) == {"tensions", "stakeholders"} and len(set(fps.values())) == 1

    runs = fake.created["agent_loop_run"]
    assert runs[-1]["status"] == "ok"
    assert "2 of 2 conversations re-read" in runs[-1]["detail"]
    # Booked once when the read starts and again when it ends.
    assert fake.enqueued == [("loop1", "scheduled"), ("loop1", "scheduled")]  # type: ignore[attr-defined]


def test_second_tick_only_rereads_changed_conversations(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    calls.clear()

    # Nothing changed: a scheduled tick is a no-op and never calls a model.
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "no_op"
    assert calls == []

    # A new chunk lands on c2 only.
    fake.chunks.append(
        {
            "id": "k4",
            "conversation_id": "c2",
            "transcript": "Every door we lock costs us a story.",
            "timestamp": 2,
        }
    )
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "ok"
    assert [c for c in calls if c.startswith("popcorn")] == ["popcorn:c2"]
    # The re-read returned the same phrase: its kind and quote carried over,
    # so the second pass had nothing to ask.
    assert [c for c in calls if c.startswith("validate")] == []
    assert sorted(c for c in calls if c.startswith("analysis")) == [
        "analysis:stakeholders",
        "analysis:tensions",
    ]
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    assert state["conversations"]["c2"]["revision"] == 4
    assert state["conversations"]["c1"]["revision"] == 2
    assert state["run"] == 2
    # The unchanged conversation is still validated; the re-read one is again.
    for cid in ("c1", "c2"):
        conv = state["conversations"][cid]
        assert conv["validated_fingerprint"] == conv["fingerprint"]
    # Quote ids the deck already held survived the tick.
    assert state["conversations"]["c1"]["items"][0]["quoteId"] == "q1"


def test_a_quiet_tick_still_pays_the_second_pass_it_owes(fake: _FakeDirectus, monkeypatch) -> None:
    """A session read before the second pass existed (state version 1) gets
    its evidence and kinds on the next scheduled tick, transcripts unchanged."""
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    for conv in state["conversations"].values():
        conv.pop("validated_fingerprint", None)  # as an older run left it
        for item in conv["items"]:
            item.pop("kind", None)
    calls.clear()

    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "ok"
    assert [c for c in calls if c.startswith("popcorn")] == []  # nothing re-read
    assert sorted(c for c in calls if c.startswith("validate")) == ["validate:c1", "validate:c2"]
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    assert all(
        c["validated_fingerprint"] == c["fingerprint"] for c in state["conversations"].values()
    )
    assert state["conversations"]["c1"]["items"][0]["kind"] == "observation"

    # Paid in full: the next quiet tick is a no-op again.
    calls.clear()
    assert asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))["status"] == "no_op"
    assert calls == []


def test_a_failed_second_pass_call_keeps_the_conversation_owed(
    fake: _FakeDirectus, monkeypatch
) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    attempts: dict[str, int] = {}

    async def _flaky_validate(
        *, transcript_id: str, transcript: str, phrase: str
    ) -> dict[str, Any]:  # noqa: ARG001
        attempts[transcript_id] = attempts.get(transcript_id, 0) + 1
        calls.append(f"validate:{transcript_id}")
        if transcript_id == "c2" and attempts["c2"] == 1:
            raise RuntimeError("quota")
        return {"grounded": True, "quote": transcript.split("\n")[0], "reason": "r"}

    monkeypatch.setattr(ticks, "validate_phrase", _flaky_validate)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    c1, c2 = state["conversations"]["c1"], state["conversations"]["c2"]
    # c1 is complete and stamped; c2 kept its kind, has no quote, and is still owed.
    assert c1["validated_fingerprint"] == c1["fingerprint"]
    assert c2.get("validated_fingerprint") != c2["fingerprint"]
    assert c2["items"][0]["kind"] == "observation" and "quoteId" not in c2["items"][0]
    assert c2["items"][0]["review"]["errors"] == ["evidence: quota"]

    # The next quiet tick retries only c2's failed phrase, then stamps it.
    calls.clear()
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "ok"
    assert calls.count("validate:c1") == 0 and calls.count("validate:c2") == 1
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    c2 = state["conversations"]["c2"]
    assert c2["validated_fingerprint"] == c2["fingerprint"]
    assert c2["items"][0]["quoteId"] and "errors" not in c2["items"][0]["review"]


def test_the_last_conversation_vanishing_clears_the_deck(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    assert fake.items["agent_loop"]["loop1"]["popcorn_state"]["analysis"]
    fake.chunks.clear()  # every transcript is gone
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "no_op"
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    assert state["conversations"] == {} and state["order"] == []
    assert state["analysis"] is None and state["quotes"] == []


def test_a_joined_stakeholder_name_is_sent_back_once(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    ticks.run_analysis.joined_first = True  # type: ignore[attr-defined]
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    assert result["status"] == "ok"
    assert [c for c in calls if c.startswith("analysis:stakeholders")] == [
        "analysis:stakeholders",
        "analysis:stakeholders:retry",
    ]
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    assert [s["name"] for s in state["analysis"]["stakeholders"]["stakeholders"]] == [
        "Members",
        "Staff",
    ]
    assert "asked again" in fake.created["agent_loop_run"][-1]["detail"]


def test_a_previous_view_goes_when_a_cited_conversation_is_gone_and_its_new_run_fails(
    fake: _FakeDirectus, monkeypatch
) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    assert state["analysis"]["tensions"]["tensions"][0]["quoteIds"]  # cites c1's words

    async def _broken_pipeline(sources: dict[str, str], book: Any) -> dict[str, Any]:  # noqa: ARG001
        raise RuntimeError("quota")

    monkeypatch.setattr(ticks, "run_tensions_pipeline", _broken_pipeline)
    fake.chunks[:] = [
        c for c in fake.chunks if c["conversation_id"] != "c1"
    ]  # c1's transcript is gone
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "ok"
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    # The tensions slide cited c1 and could not be redone: gone. The
    # stakeholders slide was redone and stays, on its own.
    assert state["analysis"]["tensions"] is None
    assert "tensions" not in state["analysis"]["fingerprints"]
    assert len(state["analysis"]["stakeholders"]["stakeholders"]) == 2
    detail = fake.created["agent_loop_run"][-1]["detail"]
    assert "tensions: FAILED quota" in detail and "tensions: previous slide dropped" in detail


def test_a_stuck_stakeholders_call_fails_the_slide_instead_of_the_tick(
    fake: _FakeDirectus, monkeypatch
) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)

    async def _stuck(
        *, kind: str, corpus: str, feedback: list[str] | None = None
    ) -> dict[str, Any]:  # noqa: ARG001
        await asyncio.sleep(30)
        return {}

    monkeypatch.setattr(ticks, "run_analysis", _stuck)
    monkeypatch.setattr(ticks, "STAKEHOLDERS_TIMEOUT_SECONDS", 0.05)
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    assert result["status"] == "ok"
    assert "stakeholders: FAILED" in fake.created["agent_loop_run"][-1]["detail"]


def test_failed_extractor_does_not_stall_the_stage(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls, fail_for={"c2"})
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    assert result["status"] == "ok"
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    assert state["conversations"]["c2"]["done"] is True
    assert state["conversations"]["c2"]["items"] == []
    assert "model down" in state["conversations"]["c2"]["error"]
    assert "FAILED" in fake.created["agent_loop_run"][-1]["detail"]


def test_each_analysis_view_is_committed_on_its_own(fake: _FakeDirectus, monkeypatch) -> None:
    """Astra's finding: a failed stakeholders call used to discard the new
    tensions with it. Now the tensions land, the previous stakeholders stay,
    and the next tick redoes only the stale view."""
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    previous = fake.items["agent_loop"]["loop1"]["popcorn_state"]["analysis"]

    async def _broken(
        *, kind: str, corpus: str, feedback: list[str] | None = None
    ) -> dict[str, Any]:  # noqa: ARG001
        raise RuntimeError("quota")

    monkeypatch.setattr(ticks, "run_analysis", _broken)
    fake.chunks.append({"id": "k5", "conversation_id": "c1", "transcript": "More.", "timestamp": 3})
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "ok"
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    analysis = state["analysis"]
    assert analysis["stakeholders"] == previous["stakeholders"]
    assert analysis["fingerprints"]["stakeholders"] == previous["fingerprints"]["stakeholders"]
    assert analysis["fingerprints"]["tensions"] != previous["fingerprints"]["tensions"]
    assert analysis["updated"]["tensions"] > analysis["updated"]["stakeholders"]
    assert "stakeholders: FAILED quota" in fake.created["agent_loop_run"][-1]["detail"]

    # Nothing changed, but the stakeholders view is stale: only it is redone.
    _install_models(monkeypatch, calls=calls)
    calls.clear()
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "ok"
    assert [c for c in calls if c.startswith(("popcorn", "validate"))] == []
    assert calls == ["analysis:stakeholders"]  # the fresh tensions view is left alone
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    assert len(set(state["analysis"]["fingerprints"].values())) == 1
    assert asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))["status"] == "no_op"


def test_a_transcript_past_the_cap_is_still_read_when_it_grows(
    fake: _FakeDirectus, monkeypatch
) -> None:
    """Astra's reproduction: the transcript was clipped before it was
    fingerprinted, so speech after the cap never changed the fingerprint and
    was never read. The fingerprint now covers the whole transcript and the
    model reads its most recent window."""
    calls: list[str] = []
    seen: dict[str, str] = {}
    _install_models(monkeypatch, calls=calls)
    monkeypatch.setattr(ticks, "MAX_CHARS_PER_CONVERSATION", 200)

    async def _extract(
        *, transcript_id: str, transcript: str, host_note: str = ""
    ) -> dict[str, Any]:  # noqa: ARG001
        calls.append(f"popcorn:{transcript_id}")
        seen[transcript_id] = transcript
        return {
            "items": [{"phrase": transcript.strip().split("\n")[-1].split(".")[0], "weight": 2}]
        }

    monkeypatch.setattr(ticks, "extract_popcorn", _extract)
    fake.chunks[:] = [
        {
            "id": "k1",
            "conversation_id": "c1",
            "transcript": "Hi, I'm Priya.\n" + ("filler " * 60).strip(),
            "timestamp": 1,
        },
    ]
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    assert len(seen["c1"]) <= 200 and "Priya" not in seen["c1"]
    assert state["conversations"]["c1"]["clipped"] > 0
    fake.chunks.append(
        {
            "id": "k2",
            "conversation_id": "c1",
            "transcript": "A new position after the cap.",
            "timestamp": 2,
        }
    )
    calls.clear()
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "ok"
    assert calls.count("popcorn:c1") == 1 and "A new position after the cap" in seen["c1"]
    assert state["conversations"]["c1"]["items"][0]["phrase"] == "A new position after the cap"


def test_analysis_budget_is_shared_so_short_transcripts_keep_everything() -> None:
    """Astra's reproduction: eight transcripts of 640,000 characters kept
    340,000 under a 600,000 budget, because every one got the same quota."""
    lengths = {f"t{i}": 150_000 for i in range(4)} | {f"s{i}": 10_000 for i in range(4)}
    quota = ticks.allocate_chars(lengths, 600_000)
    assert sum(quota.values()) == 600_000
    assert all(quota[f"s{i}"] == 10_000 for i in range(4))
    assert all(quota[f"t{i}"] == 140_000 for i in range(4))
    assert ticks.allocate_chars({"a": 5, "b": 7}, 100) == {"a": 5, "b": 7}
    assert ticks.model_window("x" * 10, cap=20) == "x" * 10
    # The window starts at the first line break inside it, when one is near.
    assert ticks.model_window("early\nlate\n" + "x" * 20, cap=25) == "x" * 20
    assert ticks.model_window("late" * 10, cap=25) == ("late" * 10)[-25:]


def test_the_second_pass_and_the_analysis_run_side_by_side(
    fake: _FakeDirectus, monkeypatch
) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    analysed = asyncio.Event()

    async def _validate(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:  # noqa: ARG001
        # A second pass that had to finish before the analysis would wait here forever.
        await asyncio.wait_for(analysed.wait(), 2)
        return {"grounded": True, "quote": transcript.split("\n")[0], "reason": "r"}

    async def _pipeline(sources: dict[str, str], book: Any) -> dict[str, Any]:  # noqa: ARG001
        analysed.set()
        return {"tensions": {"tensions": []}, "gate_flags": [], "counts": {}}

    monkeypatch.setattr(ticks, "validate_phrase", _validate)
    monkeypatch.setattr(ticks, "run_tensions_pipeline", _pipeline)

    async def run() -> dict[str, Any]:
        return await asyncio.wait_for(ticks.run_popcorn_tick("loop1", "manual"), 5)

    assert asyncio.run(run())["status"] == "ok"
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    assert state["conversations"]["c1"]["items"][0]["quoteId"]


def test_a_phrase_without_a_passage_leaves_the_deck(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)

    async def _no_passage(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:  # noqa: ARG001
        if transcript_id == "c2":
            return {"grounded": False, "quote": "", "reason": "nothing like it was said"}
        return {"grounded": True, "quote": transcript.split("\n")[0], "reason": "r"}

    monkeypatch.setattr(ticks, "validate_phrase", _no_passage)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    c2 = state["conversations"]["c2"]
    assert c2["items"] == [] and c2["validated_fingerprint"] == c2["fingerprint"]
    assert c2["review"]["dropped"][0]["phrase"] == "Quiet is a service we sell"
    assert c2["review"]["dropped"][0]["reason"] == "nothing like it was said"
    assert "held back" in fake.created["agent_loop_run"][-1]["detail"]
    from dembrane.popcorn.service import state_counts

    counts = state_counts(state)
    assert counts["phrases"] == 1 and counts["validated"] == 1 and counts["held_back"] == 1


def test_a_scheduled_tick_past_expiry_returns_the_loop_to_manual(
    fake: _FakeDirectus, monkeypatch
) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    loop = fake.items["agent_loop"]["loop1"]
    loop["expires_at"] = "2000-01-01T00:00:00+00:00"
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "no_op"
    assert loop["status"] == "paused" and calls == []
    assert "Live ended" in fake.created["agent_loop_run"][-1]["detail"]


def test_a_manual_tick_ignores_expiry_and_books_nothing(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    loop = fake.items["agent_loop"]["loop1"]
    loop["status"] = "paused"
    loop["expires_at"] = "2000-01-01T00:00:00+00:00"
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    assert result["status"] == "ok" and loop["status"] == "paused"
    assert sorted(c for c in calls if c.startswith("popcorn")) == ["popcorn:c1", "popcorn:c2"]
    # Manual mode books nothing.
    assert fake.enqueued == []  # type: ignore[attr-defined]


def test_a_rerun_tick_wipes_the_state_and_reads_everything_again(
    fake: _FakeDirectus, monkeypatch
) -> None:
    """Nothing changed, the loop is manual and past its expiry: a rerun still
    wipes phrases, quotes and analysis under the lock and re-reads every
    conversation. The run counter goes on so the saved runs stay in order."""
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    loop = fake.items["agent_loop"]["loop1"]
    loop["status"] = "paused"
    loop["expires_at"] = "2000-01-01T00:00:00+00:00"
    assert asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))["status"] == "no_op"
    before = loop["popcorn_state"]
    assert before["run"] == 1 and before["conversations"]["c1"]["items"]
    calls.clear()
    fake.state_writes.clear()
    fake.enqueued.clear()  # type: ignore[attr-defined]

    result = asyncio.run(ticks.run_popcorn_tick("loop1", "rerun"))
    assert result["status"] == "ok"
    assert sorted(c for c in calls if c.startswith("popcorn")) == ["popcorn:c1", "popcorn:c2"]
    assert "analysis:tensions" in calls
    # The first write of the rerun is the wiped state: every conversation
    # reading, no phrase, no analysis, no quotes, the counter one on.
    first = fake.state_writes[0]
    assert first["run"] == 2 and first["analysis"] is None and first["quotes"] == []
    assert all(not c["items"] and not c["done"] for c in first["conversations"].values())
    after = loop["popcorn_state"]
    assert after["run"] == 2 and after["conversations"]["c1"]["items"][0]["quoteId"]
    assert "rerun: the previous state wiped" in fake.created["agent_loop_run"][-1]["detail"]
    assert loop["status"] == "paused" and fake.enqueued == []  # type: ignore[attr-defined]


def test_a_read_on_request_cancels_its_safety_row_in_any_mode(
    fake: _FakeDirectus, monkeypatch
) -> None:
    """Sameer's finding: a manual session's safety row survived the read and
    ran it again a minute later; for a rerun that meant a second wipe."""
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    cancelled: list[str] = []

    async def _cancel(*, task_type: str, payload_match: dict[str, Any]) -> int:
        cancelled.append(f"{task_type}:{payload_match.get('loop_id')}")
        return 1

    monkeypatch.setattr(scheduled_tasks, "cancel_pending_tasks", _cancel)
    fake.items["agent_loop"]["loop1"]["status"] = "paused"
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    assert "popcorn_tick:loop1" in cancelled
    assert fake.enqueued == []  # type: ignore[attr-defined]


def test_a_refresh_with_nothing_new_is_a_no_op(fake: _FakeDirectus, monkeypatch) -> None:
    """Sameer's finding: a refresh re-ran the analysis and saved a version for
    nothing new. Refresh reads what changed and finishes what is owed; only
    a rerun goes on regardless."""
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    calls.clear()
    versions = len(fake.created.get("canvas_generation", []))
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    assert result["status"] == "no_op" and calls == []
    assert len(fake.created.get("canvas_generation", [])) == versions
    # A stale view alone is enough for a refresh to do something.
    fake.items["agent_loop"]["loop1"]["popcorn_state"]["analysis"]["fingerprints"].pop("tensions")
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    assert result["status"] == "ok" and calls == ["analysis:tensions"]


def test_a_re_read_carries_the_evidence_forward_by_phrase_id(
    fake: _FakeDirectus, monkeypatch
) -> None:
    """Sameer's finding: a re-read replaced the whole item list, so every
    phrase lost its kind and quote and was checked again, and a held-back
    phrase came back until it was dropped again."""
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)

    async def _validate(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:  # noqa: ARG001
        calls.append(f"validate:{transcript_id}")
        if transcript_id == "c2":
            return {"grounded": False, "quote": "", "reason": "nothing like it was said"}
        for line in transcript.split("\n"):
            if phrase in line:
                return {"grounded": True, "quote": line.strip(), "reason": "r"}
        return {"grounded": False, "quote": "", "reason": "not there"}

    monkeypatch.setattr(ticks, "validate_phrase", _validate)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    c1, c2 = state["conversations"]["c1"], state["conversations"]["c2"]
    assert c1["items"][0]["quoteId"] == "q1" and c1["items"][0]["kind"] == "observation"
    assert (
        c2["items"] == [] and c2["review"]["dropped"][0]["phrase"] == "Quiet is a service we sell"
    )
    calls.clear()

    # Both transcripts grow; the extractor returns the same first sentence.
    fake.chunks.append(
        {"id": "k4", "conversation_id": "c1", "transcript": "More said.", "timestamp": 3}
    )
    fake.chunks.append(
        {"id": "k5", "conversation_id": "c2", "transcript": "And more.", "timestamp": 3}
    )
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "ok"
    assert sorted(c for c in calls if c.startswith("popcorn")) == ["popcorn:c1", "popcorn:c2"]
    # Nothing was validated again: c1's phrase kept its kind and its quote,
    # c2's phrase stayed held back without a call.
    assert [c for c in calls if c.startswith(("validate", "kind"))] == []
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    c1, c2 = state["conversations"]["c1"], state["conversations"]["c2"]
    assert c1["items"][0]["quoteId"] == "q1" and c1["items"][0]["kind"] == "observation"
    assert c1["items"][0]["rooted"] is True
    assert c1["validated_fingerprint"] == c1["fingerprint"]
    assert c2["items"] == [] and len(c2["review"]["dropped"]) == 1
    detail = fake.created["agent_loop_run"][-1]["detail"]
    assert "1 carried over" in detail and "1 held back again" in detail
