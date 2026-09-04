from __future__ import annotations

import asyncio
from typing import Any

import pytest

import dembrane.popcorn.ticks as ticks


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
        self.state_writes: list[dict[str, Any]] = []

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
            return []
        return []

    async def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        self.created.setdefault(collection, []).append(data)
        return {"data": data}

    async def update_item(self, collection: str, item_id: str, data: dict[str, Any]) -> dict:
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

    monkeypatch.setattr(ticks, "extract_popcorn", _extract)
    monkeypatch.setattr(ticks, "run_analysis", _analysis)


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
    # Verbatim phrases are registered first (q1, q2); the tension's quote keeps
    # its full stop, so it is a distinct registry entry after them.
    assert state["conversations"]["c1"]["items"][0]["quoteId"] == "q1"
    assert state["conversations"]["c2"]["items"][0]["quoteId"] == "q2"
    assert state["conversations"]["c1"]["validated_run"] == 1
    assert state["analysis"]["tensions"]["tensions"][0]["quoteIds"] == ["q3"]
    assert state["analysis"]["quotes"][0]["transcript"] == "c1"
    assert len(state["analysis"]["stakeholders"]["stakeholders"]) == 2
    # Every changed run is saved as a replayable version.
    versions = fake.created["canvas_generation"]
    assert len(versions) == 1 and '"files"' in versions[0]["content_html"]

    # Session first (so the legend shows before any phrase), then one write per
    # extractor completion, then the analysis.
    assert len(fake.state_writes) == 4
    assert fake.state_writes[0]["conversations"]["c1"]["done"] is False
    assert fake.state_writes[0]["analysis"] is None
    assert fake.nudges.count("r1") == 4  # type: ignore[attr-defined]

    # Both popcorn extractors ran, then both analyses.
    assert sorted(c for c in calls if c.startswith("popcorn")) == ["popcorn:c1", "popcorn:c2"]
    assert sorted(c for c in calls if c.startswith("analysis")) == [
        "analysis:stakeholders",
        "analysis:tensions",
    ]
    assert calls.index("analysis:tensions") > max(
        calls.index("popcorn:c1"), calls.index("popcorn:c2")
    )

    runs = fake.created["agent_loop_run"]
    assert runs[-1]["status"] == "ok"
    assert "2 of 2 conversations re-read" in runs[-1]["detail"]
    assert fake.enqueued == [("loop1", "scheduled")]  # type: ignore[attr-defined]


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
    assert sorted(c for c in calls if c.startswith("analysis")) == [
        "analysis:stakeholders",
        "analysis:tensions",
    ]
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    assert state["conversations"]["c2"]["revision"] == 2
    assert state["conversations"]["c1"]["revision"] == 1
    assert state["run"] == 2


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
