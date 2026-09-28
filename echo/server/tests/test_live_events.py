"""Server-sent events over Redis pub/sub, with a fake Redis."""

from __future__ import annotations

import gc
import asyncio
from typing import Any

import pytest
from fastapi import HTTPException
from redis.exceptions import ConnectionError as RedisConnectionError

from dembrane import live_events
from dembrane.map.events import project_channel, publish_map_event


class FakePubSub:
    def __init__(self, messages: list[Any]) -> None:
        self.messages = list(messages)
        self.subscribed: list[str] = []
        self.unsubscribed: list[str] = []
        self.closed = False
        self.error: BaseException | None = None
        # What happened in order, the stream's side and the browser's side.
        self.log: list[str] = []

    async def subscribe(self, *channels: str) -> None:
        # Redis answers a subscribe later than the call returns control.
        await asyncio.sleep(0)
        self.subscribed.extend(channels)
        self.log.append("subscribed")

    async def unsubscribe(self, *channels: str) -> None:
        self.unsubscribed.extend(channels)

    async def aclose(self) -> None:
        self.closed = True

    async def get_message(
        self, ignore_subscribe_messages: bool = False, timeout: float = 0.0  # noqa: ARG002
    ) -> Any:
        if self.error is not None:
            raise self.error
        return self.messages.pop(0) if self.messages else None


class FakeRedis:
    def __init__(self, pubsub: FakePubSub) -> None:
        self._pubsub = pubsub
        self.published: list[tuple[str, str]] = []
        self.pubsubs = 0

    def pubsub(self) -> FakePubSub:
        self.pubsubs += 1
        return self._pubsub

    async def publish(self, channel: str, data: str) -> int:
        self.published.append((channel, data))
        return 1


class FakeRequest:
    def __init__(self, disconnect_after: int) -> None:
        self.calls = 0
        self.disconnect_after = disconnect_after

    async def is_disconnected(self) -> bool:
        self.calls += 1
        return self.calls > self.disconnect_after


def _use(monkeypatch: pytest.MonkeyPatch, redis: Any) -> None:
    async def _client() -> Any:
        return redis

    monkeypatch.setattr(live_events, "get_redis_client", _client)


async def _collect(response: Any, log: list[str] | None = None) -> list[str]:
    chunks: list[str] = []
    async for chunk in response.body_iterator:
        text = chunk if isinstance(chunk, str) else chunk.decode("utf-8")
        if log is not None:
            log.append(f"sent {text.split(chr(10))[0]}")
        chunks.append(text)
    return chunks


def test_decode_event_maps_bare_nudges_to_updates_and_json_to_dicts() -> None:
    assert live_events.decode_event(b"1") == {"type": "update"}
    assert live_events.decode_event("not json") == {"type": "update"}
    assert live_events.decode_event(b"[1, 2]") == {"type": "update"}
    assert live_events.decode_event(b'{"type": "progress", "done": 2}') == {"type": "progress", "done": 2}
    assert live_events.decode_event('{"type": "ready"}') == {"type": "ready"}


def test_format_sse_names_the_event_and_sends_compact_json() -> None:
    assert live_events.format_sse({"type": "progress", "done": 1}) == (
        'event: progress\ndata: {"type":"progress","done":1}\n\n'
    )
    assert live_events.format_sse({"done": 1}).startswith("event: update\ndata: ")
    assert live_events.format_sse({"type": "x"}, name="named").startswith("event: named\n")


@pytest.mark.asyncio
async def test_read_skips_empty_messages() -> None:
    pubsub = FakePubSub([None, {"type": "message", "data": None}, {"data": b'{"type":"ready"}'}])
    assert await live_events.read(pubsub) is None  # type: ignore[arg-type]
    assert await live_events.read(pubsub) is None  # type: ignore[arg-type]
    assert await live_events.read(pubsub) == {"type": "ready"}  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_sse_stream_subscribes_before_connected_transforms_filters_and_stops_on_disconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pubsub = FakePubSub(
        [
            {"type": "message", "data": b'{"type":"progress","done":1}'},
            {"type": "message", "data": b'{"type":"private","secret":"s"}'},
            {"type": "message", "data": b"1"},
        ]
    )
    _use(monkeypatch, FakeRedis(pubsub))

    def _transform(event: dict[str, Any]) -> dict[str, Any] | None:
        if event["type"] == "private":
            return None
        return {**event, "seen": True}

    # Three messages, one empty read, then the client is gone.
    request = FakeRequest(disconnect_after=4)
    response = live_events.sse_response(
        request, ["map:project:p1", "map:project:p2"], transform=_transform  # type: ignore[arg-type]
    )
    chunks = await _collect(response, pubsub.log)

    # The page reloads on `connected`, so Redis must already be listening then.
    assert pubsub.log[:2] == ["subscribed", "sent event: connected"]
    assert response.media_type == "text/event-stream"
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    assert chunks == [
        live_events.format_sse({"type": "connected"}),
        live_events.format_sse({"type": "progress", "done": 1, "seen": True}),
        live_events.format_sse({"type": "update", "seen": True}),
    ]
    assert "secret" not in "".join(chunks)
    assert pubsub.subscribed == ["map:project:p1", "map:project:p2"]
    assert pubsub.unsubscribed == ["map:project:p1", "map:project:p2"]
    assert pubsub.closed
    assert request.calls == 5


@pytest.mark.asyncio
async def test_sse_stream_sends_keep_alives_while_quiet(monkeypatch: pytest.MonkeyPatch) -> None:
    pubsub = FakePubSub([])
    _use(monkeypatch, FakeRedis(pubsub))

    response = live_events.sse_response(
        FakeRequest(disconnect_after=1), ["c"], heartbeat_seconds=0.0  # type: ignore[arg-type]
    )

    assert await _collect(response) == [
        live_events.format_sse({"type": "connected"}),
        ": keep-alive\n\n",
    ]
    assert pubsub.closed


@pytest.mark.asyncio
async def test_sse_stream_ends_cleanly_when_redis_drops(monkeypatch: pytest.MonkeyPatch) -> None:
    pubsub = FakePubSub([])
    pubsub.error = RedisConnectionError("gone")
    _use(monkeypatch, FakeRedis(pubsub))

    response = live_events.sse_response(FakeRequest(disconnect_after=10), ["c"])  # type: ignore[arg-type]

    assert await _collect(response) == [live_events.format_sse({"type": "connected"})]
    assert pubsub.unsubscribed == ["c"] and pubsub.closed


@pytest.mark.asyncio
async def test_sse_stream_ends_when_access_is_withdrawn(monkeypatch: pytest.MonkeyPatch) -> None:
    pubsub = FakePubSub([])
    _use(monkeypatch, FakeRedis(pubsub))
    answers = [True, False]

    async def _allowed() -> bool:
        return answers.pop(0)

    response = live_events.sse_response(
        FakeRequest(disconnect_after=10), ["c"], heartbeat_seconds=0.0, still_allowed=_allowed  # type: ignore[arg-type]
    )

    # Allowed at the first heartbeat, withdrawn by the second: the stream ends.
    assert await _collect(response) == [
        live_events.format_sse({"type": "connected"}),
        ": keep-alive\n\n",
    ]
    assert answers == [] and pubsub.unsubscribed == ["c"] and pubsub.closed

    # A check that cannot answer ends it too; the connect check decides again.
    broken = FakePubSub([])
    _use(monkeypatch, FakeRedis(broken))

    async def _unreachable() -> bool:
        raise RuntimeError("directus down")

    response = live_events.sse_response(
        FakeRequest(disconnect_after=10), ["c"], heartbeat_seconds=0.0, still_allowed=_unreachable  # type: ignore[arg-type]
    )
    assert await _collect(response) == [live_events.format_sse({"type": "connected"})]
    assert broken.closed


@pytest.mark.asyncio
async def test_sse_streams_are_bounded_per_process_and_per_key(monkeypatch: pytest.MonkeyPatch) -> None:
    streams = live_events._OpenStreams()
    monkeypatch.setattr(live_events, "open_streams", streams)
    redis = FakeRedis(FakePubSub([]))
    _use(monkeypatch, redis)

    def _open(key: str, **caps: Any) -> Any:
        return live_events.sse_response(FakeRequest(disconnect_after=0), ["c"], key=key, **caps)  # type: ignore[arg-type]

    first = _open("token:198.51.100.1", max_streams=2, max_streams_per_key=1)
    with pytest.raises(HTTPException) as refused:
        _open("token:198.51.100.1", max_streams=2, max_streams_per_key=1)
    assert refused.value.status_code == 429
    second = _open("token:198.51.100.2", max_streams=2, max_streams_per_key=1)
    with pytest.raises(HTTPException) as full:
        _open("token:198.51.100.3", max_streams=2, max_streams_per_key=1)
    assert full.value.status_code == 429
    # A refusal never reaches Redis.
    assert redis.pubsubs == 0
    assert streams.total == 2

    # A stream that ends gives its slot back, and the viewer may open again.
    await _collect(first)
    assert streams.by_key == {"token:198.51.100.2": 1}
    again = _open("token:198.51.100.1", max_streams=2, max_streams_per_key=1)
    assert streams.total == 2

    # So does a response that was never sent, once it is collected.
    del second, again
    gc.collect()
    assert streams.total == 0 and streams.by_key == {}


@pytest.mark.asyncio
async def test_publish_is_best_effort(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis(FakePubSub([]))
    _use(monkeypatch, redis)

    await live_events.publish("map:project:p1", {"type": "ready", "result_id": "r1"})
    await live_events.publish("", {"type": "ignored"})
    await publish_map_event("p2", {"type": "fact_check", "claim_key": "k"})
    await publish_map_event("", {"type": "ignored"})

    assert redis.published == [
        ("map:project:p1", '{"type":"ready","result_id":"r1"}'),
        (project_channel("p2"), '{"type":"fact_check","claim_key":"k"}'),
    ]
    assert project_channel("p2") == "map:project:p2"

    async def _broken() -> Any:
        raise RuntimeError("redis down")

    monkeypatch.setattr(live_events, "get_redis_client", _broken)
    await live_events.publish("map:project:p1", {"type": "ready"})
