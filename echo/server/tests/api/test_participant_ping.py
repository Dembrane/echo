from __future__ import annotations

import asyncio


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_ping_conversation_marks_seen(monkeypatch) -> None:
    import dembrane.api.participant as participant

    seen: list[str] = []

    async def _fake_mark(conversation_id: str) -> None:
        seen.append(conversation_id)

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)

    result = _run(participant.ping_conversation("conv-1"))

    assert result == {"ok": True}
    assert seen == ["conv-1"]


def test_ping_conversation_swallows_redis_errors(monkeypatch) -> None:
    """A Redis blip must never break the participant's recording loop."""
    import dembrane.api.participant as participant

    async def _boom(conversation_id: str) -> None:  # noqa: ARG001
        raise RuntimeError("redis down")

    monkeypatch.setattr(participant, "mark_conversation_seen", _boom)

    result = _run(participant.ping_conversation("conv-1"))

    assert result == {"ok": False}
