from __future__ import annotations

import asyncio
from typing import Any

import pytest

import dembrane.popcorn.service as service


class _Directus:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, dict[str, Any]]] = {}
        self.updates: list[tuple[str, str, dict[str, Any]]] = []

    async def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        rows = self.rows.setdefault(collection, {})
        row = {"id": data.get("id") or str(len(rows) + 1), **data}
        rows[str(row["id"])] = row
        return {"data": row}

    async def update_item(
        self, collection: str, item_id: str, data: dict[str, Any]
    ) -> dict[str, Any]:
        self.updates.append((collection, item_id, data))
        self.rows.setdefault(collection, {}).setdefault(item_id, {"id": item_id}).update(data)
        return {"data": self.rows[collection][item_id]}

    async def get_item(self, collection: str, item_id: str) -> dict[str, Any] | None:
        return self.rows.get(collection, {}).get(item_id)


@pytest.fixture
def directus(monkeypatch) -> _Directus:
    fake = _Directus()
    monkeypatch.setattr(service, "async_directus", fake)
    dispatched: list[tuple[str, str]] = []

    async def _dispatch(loop_id: str, tick_kind: str = "manual") -> None:
        dispatched.append((loop_id, tick_kind))

    monkeypatch.setattr(service, "dispatch_popcorn_tick_now_with_safety", _dispatch)
    fake.dispatched = dispatched  # type: ignore[attr-defined]

    async def _cancel(loop_id: str) -> int:  # noqa: ARG001
        return 0

    monkeypatch.setattr(service, "cancel_pending_popcorn_ticks", _cancel)
    return fake


def _create() -> dict[str, Any]:
    return asyncio.run(
        service.create_popcorn(
            project_id="p1", title="Town hall", client=None, acting_directus_user_id="u1"
        )
    )


def test_a_new_session_is_manual_and_reads_once(directus: _Directus) -> None:
    loop = _create()["loop"]
    assert loop["status"] == "paused" and loop["expires_at"]
    assert directus.dispatched == [(str(loop["id"]), "manual")]  # type: ignore[attr-defined]
    payload = service.loop_payload(loop, None)
    assert payload and payload["mode"] == "manual"


def test_live_sets_an_expiry_and_stop_returns_to_manual(directus: _Directus) -> None:
    loop = _create()["loop"]
    live = asyncio.run(service.go_live(loop, hours=1))
    assert live["status"] == "active"
    expires = service._parse_dt(live["expires_at"])
    assert expires is not None
    assert 55 * 60 < (expires - service._now()).total_seconds() <= 60 * 60
    assert service.loop_payload(live, None)["mode"] == "live"  # type: ignore[index]
    assert directus.dispatched[-1] == (str(loop["id"]), "manual")  # type: ignore[attr-defined]
    stopped = asyncio.run(service.stop_live(live))
    assert stopped["status"] == "paused"
    assert service.loop_payload(stopped, None)["mode"] == "manual"  # type: ignore[index]
    with pytest.raises(ValueError):
        asyncio.run(service.go_live(loop, hours=3))


def test_legacy_statuses_read_as_manual() -> None:
    for status in ("expired", "ended", "stopped", "paused", None):
        payload = service.loop_payload({"id": "l", "status": status}, None)
        assert payload and payload["mode"] == "manual", status


def test_rerun_is_a_tick_of_its_own_kind(directus: _Directus) -> None:
    """The wipe happens inside the tick, under the run lock; the request
    only dispatches it and never writes the state."""
    loop = _create()["loop"]
    asyncio.run(service.request_rerun(loop))
    assert directus.dispatched[-1] == (str(loop["id"]), "rerun")  # type: ignore[attr-defined]
    assert not [d for c, _i, d in directus.updates if c == "agent_loop" and "popcorn_state" in d]


def test_readiness_counts_transcribed_conversations_and_words(monkeypatch) -> None:
    async def _gather(*, project_id: str, acting_directus_user_id: str) -> list[dict[str, Any]]:  # noqa: ARG001
        return [{"id": "a", "text": "one two three"}, {"id": "b", "text": "four five"}]

    monkeypatch.setattr(service, "gather_transcripts", _gather)
    assert asyncio.run(service.readiness(project_id="p", acting_directus_user_id="u")) == {
        "conversations": 2,
        "words": 5,
    }


def test_room_files_strip_what_the_host_alone_may_see() -> None:
    files = {
        "session.json": {
            "title": "T",
            "host": {"tabs": {}, "flow": "flow/"},
            "transcripts": [{"id": "c1", "label": "Priya", "short": "Priya", "time": "t"}],
        },
        "popcorn/c1.json": {
            "transcript": "c1",
            "validated": True,
            "coverage": {"chars": 1, "clipped": 0},
            "items": [
                {"id": "p", "phrase": "x", "quoteId": "q1", "source": {"text": "s", "url": "u"}}
            ],
        },
        "quotes.json": {"quotes": [{"id": "q1", "transcript": "c1", "text": "x", "url": "u"}]},
        "tensions.json": {"tensions": []},
    }
    room = service.room_files(files, neutral_labels=True)
    assert "host" not in room["session.json"]
    assert room["session.json"]["transcripts"][0]["label"] == "Conversation 1"
    assert room["session.json"]["transcripts"][0]["time"] == "t"
    assert "coverage" not in room["popcorn/c1.json"]
    assert room["popcorn/c1.json"]["items"] == [{"id": "p", "phrase": "x", "quoteId": "q1"}]
    assert room["quotes.json"]["quotes"] == [{"id": "q1", "transcript": "c1", "text": "x"}]
    assert room["tensions.json"] == {"tensions": []}
    named = service.room_files(files, neutral_labels=False)
    assert named["session.json"]["transcripts"][0]["label"] == "Priya"


def test_both_deliveries_share_a_request_id_and_the_backup_is_persisted_first(monkeypatch):
    scheduled: list[dict[str, Any]] = []
    dispatched: list[tuple[str, str, str | None]] = []

    async def _schedule(**kwargs):
        scheduled.append(kwargs)
        return "task-id"

    def _dispatch(loop_id: str, tick_kind: str, request_id: str | None = None):
        assert scheduled  # A failed send must still leave a durable backup.
        dispatched.append((loop_id, tick_kind, request_id))

    monkeypatch.setattr(service, "schedule_task", _schedule)
    monkeypatch.setattr(service, "dispatch_popcorn_tick_now", _dispatch)
    asyncio.run(service.dispatch_popcorn_tick_now_with_safety("loop1", "rerun"))
    payload = scheduled[0]["payload"]
    assert payload["request_id"] and payload["tick_kind"] == "rerun"
    assert dispatched == [("loop1", "rerun", payload["request_id"])]
    asyncio.run(service.dispatch_popcorn_tick_now_with_safety("loop1", "rerun"))
    assert scheduled[1]["payload"]["request_id"] != payload["request_id"]
