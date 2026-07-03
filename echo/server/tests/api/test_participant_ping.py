from __future__ import annotations

import asyncio


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_ping_conversation_marks_seen(monkeypatch) -> None:
    import dembrane.api.participant as participant

    seen: list[tuple[str, object]] = []

    async def _fake_mark(conversation_id: str, *, telemetry=None) -> None:
        seen.append((conversation_id, telemetry))

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)

    result = _run(participant.ping_conversation("conv-1"))

    assert result == {"ok": True}
    assert seen == [("conv-1", None)]


def test_ping_conversation_persists_and_publishes_telemetry(monkeypatch) -> None:
    import dembrane.api.participant as participant

    seen: list[tuple[str, object]] = []
    published: list[str] = []

    async def _fake_mark(conversation_id: str, *, telemetry=None) -> None:
        seen.append((conversation_id, telemetry))

    async def _fake_publish(project_id: str) -> None:
        published.append(project_id)

    registered: list[tuple[str, str]] = []

    async def _fake_register(
        project_id: str, conversation_id: str, *, score: float
    ) -> None:  # noqa: ARG001
        registered.append((project_id, conversation_id))

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)
    monkeypatch.setattr(participant, "publish_monitor_dirty", _fake_publish)
    monkeypatch.setattr(participant, "register_active_conversation", _fake_register)

    body = participant.ConversationPingRequest(
        project_id="proj-9",
        state="paused",
        mode="voice",
        # An unknown state would be dropped; a valid one is kept.
        network=participant.ConversationNetworkTelemetry(effective_type="3g", online=True),
        battery=participant.ConversationBatteryTelemetry(level=0.4, charging=False),
    )
    result = _run(participant.ping_conversation("conv-1", body))

    assert result == {"ok": True}
    assert seen[0][0] == "conv-1"
    telemetry = seen[0][1]
    assert telemetry["state"] == "paused"
    assert telemetry["mode"] == "voice"
    assert telemetry["network"] == {"effective_type": "3g", "online": True}
    assert telemetry["battery"] == {"level": 0.4, "charging": False}
    assert published == ["proj-9"]
    assert registered == [("proj-9", "conv-1")]


def test_ping_conversation_drops_unknown_state(monkeypatch) -> None:
    import dembrane.api.participant as participant

    seen: list[object] = []

    async def _fake_mark(conversation_id: str, *, telemetry=None) -> None:  # noqa: ARG001
        seen.append(telemetry)

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)

    body = participant.ConversationPingRequest(state="bogus", mode="carrier-pigeon")
    _run(participant.ping_conversation("conv-1", body))

    # Unknown state + unknown mode are both dropped, leaving an empty (None) payload.
    assert seen == [None]


def test_ping_conversation_swallows_redis_errors(monkeypatch) -> None:
    """A Redis blip must never break the participant's recording loop."""
    import dembrane.api.participant as participant

    async def _boom(conversation_id: str, *, telemetry=None) -> None:  # noqa: ARG001
        raise RuntimeError("redis down")

    monkeypatch.setattr(participant, "mark_conversation_seen", _boom)

    result = _run(participant.ping_conversation("conv-1"))

    assert result == {"ok": False}


def test_ping_visitor_sanitises_and_publishes(monkeypatch) -> None:
    import dembrane.api.participant as participant

    marked: list[tuple[str, str, object]] = []
    published: list[str] = []

    async def _fake_mark(project_id, visitor_id, *, telemetry=None, score=None):  # noqa: ANN001, ARG001
        marked.append((project_id, visitor_id, telemetry))

    async def _fake_publish(project_id: str) -> None:
        published.append(project_id)

    monkeypatch.setattr(participant, "mark_visitor_seen", _fake_mark)
    monkeypatch.setattr(participant, "publish_monitor_dirty", _fake_publish)

    body = participant.VisitorPingRequest(
        stage="mic_skipped",
        name="Ada",
        tags=["Table 3", "  "],
        tags_preselected=True,
        scan_count=2,
    )
    result = _run(participant.ping_visitor("proj-1", "vis-1", body))

    assert result == {"ok": True}
    project_id, visitor_id, telemetry = marked[0]
    assert (project_id, visitor_id) == ("proj-1", "vis-1")
    assert telemetry["stage"] == "mic_skipped"
    assert telemetry["name"] == "Ada"
    assert telemetry["tags"] == ["Table 3"]  # blank tag dropped
    assert telemetry["tags_preselected"] is True
    assert telemetry["scan_count"] == 2
    assert published == ["proj-1"]


def test_ping_visitor_drops_unknown_stage(monkeypatch) -> None:
    import dembrane.api.participant as participant

    marked: list[object] = []

    async def _fake_mark(project_id, visitor_id, *, telemetry=None, score=None):  # noqa: ANN001, ARG001
        marked.append(telemetry)

    async def _fake_publish(project_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(participant, "mark_visitor_seen", _fake_mark)
    monkeypatch.setattr(participant, "publish_monitor_dirty", _fake_publish)

    body = participant.VisitorPingRequest(stage="banana")
    _run(participant.ping_visitor("proj-1", "vis-1", body))
    # Unknown stage dropped -> empty telemetry -> None passed to mark.
    assert marked == [None]
