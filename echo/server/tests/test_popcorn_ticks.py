from __future__ import annotations

import asyncio
from typing import Any
from datetime import datetime, timezone, timedelta

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

    async def _analysis(*, kind: str, corpus: str) -> dict[str, Any]:  # noqa: ARG001
        calls.append(f"analysis:{kind}")
        if kind == "tensions":
            return {
                "tensions": [
                    {
                        "poleA": "desks",
                        "poleB": "kettle",
                        "narrative": "n" * 40,
                        "toResolve": "which one?",
                        "quotes": [{"transcript": "c1", "text": "Nobody joins for the desks."}],
                    }
                ]
            }
        return {
            "stakeholders": [
                {
                    "name": "Members",
                    "role": "r" * 5,
                    "stake": "s" * 5,
                    "rung": "voiced",
                    "stakeWeight": 0.9,
                    "mentionsWeight": 0.8,
                    "quotes": [],
                },
                {
                    "name": "Staff",
                    "role": "r" * 5,
                    "stake": "s" * 5,
                    "rung": "named",
                    "stakeWeight": 0.4,
                    "mentionsWeight": 0.2,
                    "quotes": [],
                },
            ],
            "relations": [],
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
    assert calls.index("analysis:tensions") > max(
        i for i, c in enumerate(calls) if c.startswith(("validate", "kind"))
    )

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
    # Only the re-read conversation gets the second pass again.
    assert [c for c in calls if c.startswith("validate")] == ["validate:c2"]
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


def test_failed_analysis_keeps_previous_block(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    previous = fake.items["agent_loop"]["loop1"]["popcorn_state"]["analysis"]

    async def _broken(*, kind: str, corpus: str) -> dict[str, Any]:  # noqa: ARG001
        raise RuntimeError("quota")

    monkeypatch.setattr(ticks, "run_analysis", _broken)
    fake.chunks.append({"id": "k5", "conversation_id": "c1", "transcript": "More.", "timestamp": 3})
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "ok"
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    assert state["analysis"] == previous
    assert "tensions: FAILED quota" in fake.created["agent_loop_run"][-1]["detail"]


def test_non_popcorn_loop_is_refused(fake: _FakeDirectus) -> None:
    fake.items["agent_loop"]["loop1"]["caps"] = {}
    with pytest.raises(RuntimeError):
        asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))


def test_disabled_project_no_ops(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    fake.items["project"]["p1"]["is_canvas_enabled"] = False
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    assert result["status"] == "disabled"
    assert calls == []


def test_reconcile_missing_popcorn_tick_tasks_enqueues_active_loop(
    fake: _FakeDirectus, monkeypatch
) -> None:
    now = datetime(2026, 9, 4, 12, 0, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(ticks, "_now", lambda: now)
    fake.scheduled_tasks = []

    enqueued: list[tuple[str, str]] = []

    async def _enqueue(loop: dict[str, Any], when: Any = None) -> None:  # noqa: ARG001
        enqueued.append((str(loop["id"]), "scheduled"))

    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    count = asyncio.run(ticks.reconcile_missing_popcorn_tick_tasks())
    assert count == 1
    assert enqueued == [("loop1", "scheduled")]


def test_reconcile_missing_popcorn_tick_tasks_skips_covered_loop(
    fake: _FakeDirectus, monkeypatch
) -> None:
    now = datetime(2026, 9, 4, 12, 0, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(ticks, "_now", lambda: now)
    fake.scheduled_tasks = [
        {
            "id": "task_sched",
            "task_type": scheduled_tasks.TASK_POPCORN_TICK,
            "status": scheduled_tasks.STATUS_SCHEDULED,
            "payload": {"loop_id": "loop1"},
        }
    ]

    enqueued: list[tuple[str, str]] = []

    async def _enqueue(loop: dict[str, Any], when: Any = None) -> None:  # noqa: ARG001
        enqueued.append((str(loop["id"]), "scheduled"))

    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    count = asyncio.run(ticks.reconcile_missing_popcorn_tick_tasks())
    assert count == 0
    assert enqueued == []


def test_reconcile_leaves_a_long_tick_alone_while_it_beats(
    fake: _FakeDirectus, monkeypatch
) -> None:
    now = datetime(2026, 9, 4, 12, 0, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(ticks, "_now", lambda: now)
    fake.scheduled_tasks = [
        {
            "id": "slow_second_pass",
            "task_type": scheduled_tasks.TASK_POPCORN_TICK,
            "status": scheduled_tasks.STATUS_PROCESSING,
            "claimed_at": (now - timedelta(minutes=10)).isoformat(),
            "payload": {"loop_id": "loop1"},
        }
    ]

    async def _alive(loop_id: str) -> bool:  # noqa: ARG001
        return True

    monkeypatch.setattr(ticks, "_tick_alive", _alive)
    enqueued: list[Any] = []

    async def _enqueue(loop: dict[str, Any], when: Any = None) -> None:  # noqa: ARG001
        enqueued.append(loop["id"])

    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)
    assert asyncio.run(ticks.reconcile_missing_popcorn_tick_tasks()) == 0
    assert enqueued == []
    assert not any(
        patch.get("status") == scheduled_tasks.STATUS_FAILED for _, _, patch in fake.updated
    )


def test_reconcile_missing_popcorn_tick_tasks_rescues_stale_processing(
    fake: _FakeDirectus, monkeypatch
) -> None:
    now = datetime(2026, 9, 4, 12, 0, 0, tzinfo=timezone.utc)
    stale_claimed = (now - timedelta(minutes=10)).isoformat()
    monkeypatch.setattr(ticks, "_now", lambda: now)
    fake.scheduled_tasks = [
        {
            "id": "stale_popcorn_task",
            "task_type": scheduled_tasks.TASK_POPCORN_TICK,
            "status": scheduled_tasks.STATUS_PROCESSING,
            "claimed_at": stale_claimed,
            "payload": {"loop_id": "loop1"},
        }
    ]

    enqueued: list[tuple[str, str]] = []

    async def _enqueue(loop: dict[str, Any], when: Any = None) -> None:  # noqa: ARG001
        enqueued.append((str(loop["id"]), "scheduled"))

    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    count = asyncio.run(ticks.reconcile_missing_popcorn_tick_tasks())
    assert count == 1
    assert enqueued == [("loop1", "scheduled")]
    assert any(
        col == "scheduled_task"
        and item_id == "stale_popcorn_task"
        and patch.get("status") == scheduled_tasks.STATUS_FAILED
        for col, item_id, patch in fake.updated
    )
