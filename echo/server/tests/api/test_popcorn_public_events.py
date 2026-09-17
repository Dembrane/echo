"""The public popcorn stream: bounded per viewer, and re-checked while open."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

import dembrane.api.v2.popcorn_public as public

TOKEN = "Abcdefghijklmnop_1234"


class _Limiter:
    async def check(self, key: str) -> None:  # noqa: ARG002
        return None


@pytest.mark.asyncio
async def test_public_events_are_bounded_per_viewer_and_end_once_unpublished(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    published = {"on": True}
    lookups: list[str] = []

    async def _report(token: str) -> tuple[dict[str, Any], dict[str, Any]]:
        lookups.append(token)
        if not published["on"]:
            raise HTTPException(status_code=404, detail="Not found")
        return {"id": "r1"}, {"id": "p1"}

    streams: list[dict[str, Any]] = []

    def _sse(request: Any, channels: list[str], **kwargs: Any) -> str:  # noqa: ARG001
        streams.append({"channels": channels, **kwargs})
        return "stream"

    monkeypatch.setattr(public, "_published_report", _report)
    monkeypatch.setattr(public, "_page_limiter", _Limiter())
    monkeypatch.setattr(public, "_published_checks", {})
    monkeypatch.setattr(public.live_events, "sse_response", _sse)

    request = SimpleNamespace(headers={"x-forwarded-for": "203.0.113.9, 10.0.0.1"}, client=None)
    assert await public.public_popcorn_events(TOKEN, request) == "stream"  # type: ignore[arg-type]

    (stream,) = streams
    assert stream["channels"] == ["canvas:generation:r1"]
    assert stream["key"] == f"{TOKEN}:203.0.113.9"
    assert stream["max_streams"] == public._MAX_EVENT_STREAMS
    assert stream["max_streams_per_key"] == public._MAX_EVENT_STREAMS_PER_VIEWER
    assert stream["transform"]({"type": "progress", "secret": "s"}) == {"type": "update"}

    # Screens following one token share one answer for a few seconds.
    lookups.clear()
    assert await stream["still_allowed"]() is True
    assert await stream["still_allowed"]() is True
    assert lookups == [TOKEN]

    # The host turned public access off: the next check ends the stream.
    published["on"] = False
    monkeypatch.setattr(public, "_published_checks", {})
    assert await stream["still_allowed"]() is False
