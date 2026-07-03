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

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)
    monkeypatch.setattr(participant, "publish_monitor_dirty", _fake_publish)

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
