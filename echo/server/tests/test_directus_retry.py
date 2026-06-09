"""Retry behavior of the Directus HTTP clients.

Regression tests for the retry off-by-one that turned every persistently
failing (but "recoverable", e.g. 500) Directus response into an 11-second
stall: 1s + 2s backoff, then a swallowed raise_for_status, an extra 8s
sleep, and a 4th request. Desired contract:

- at most `max_retries` requests total
- backoff sleeps only between attempts (1s, 2s for the default 3 attempts)
- after exhausting retries on a recoverable status, return the last
  response so callers can interpret the Directus error envelope
- transport errors raise after exhausting retries
"""

from unittest.mock import patch

import httpx
import pytest
import requests

from dembrane.directus import make_request_with_retry
from dembrane.directus_async import AsyncDirectusClient


class _CountingTransport(httpx.AsyncBaseTransport):
    def __init__(self, status_code: int = 500):
        self.requests = 0
        self.status_code = status_code

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ARG002
        self.requests += 1
        return httpx.Response(self.status_code, json={"errors": [{"message": "boom"}]})


@pytest.mark.asyncio
async def test_async_persistent_500_returns_last_response_after_3_attempts():
    transport = _CountingTransport(500)
    client = AsyncDirectusClient(url="http://directus.test", token="t")
    client._client = httpx.AsyncClient(  # noqa: SLF001 — inject mock transport
        base_url="http://directus.test", transport=transport
    )

    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    with patch("dembrane.directus_async.asyncio.sleep", side_effect=fake_sleep):
        response = await client._request("SEARCH", "/items/whatever")  # noqa: SLF001

    assert response.status_code == 500
    assert transport.requests == 3
    assert sleeps == [1.0, 2.0]


@pytest.mark.asyncio
async def test_async_success_does_not_sleep():
    transport = _CountingTransport(200)
    client = AsyncDirectusClient(url="http://directus.test", token="t")
    client._client = httpx.AsyncClient(  # noqa: SLF001
        base_url="http://directus.test", transport=transport
    )

    with patch("dembrane.directus_async.asyncio.sleep") as sleep_mock:
        response = await client._request("SEARCH", "/items/whatever")  # noqa: SLF001

    assert response.status_code == 200
    assert transport.requests == 1
    sleep_mock.assert_not_called()


class _FailingTransport(httpx.AsyncBaseTransport):
    def __init__(self):
        self.requests = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ARG002
        self.requests += 1
        raise httpx.ConnectError("connection refused")


@pytest.mark.asyncio
async def test_async_persistent_transport_error_raises_after_3_attempts():
    transport = _FailingTransport()
    client = AsyncDirectusClient(url="http://directus.test", token="t")
    client._client = httpx.AsyncClient(  # noqa: SLF001
        base_url="http://directus.test", transport=transport
    )

    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    with patch("dembrane.directus_async.asyncio.sleep", side_effect=fake_sleep):
        with pytest.raises(httpx.ConnectError):
            await client._request("SEARCH", "/items/whatever")  # noqa: SLF001

    assert transport.requests == 3
    assert sleeps == [1.0, 2.0]


class _SyncClientStub:
    temporary_token = None
    refresh_token = None
    email = None
    password = None


def test_sync_persistent_500_returns_last_response_after_3_attempts():
    calls = {"n": 0}

    def fake_request(method, url, **kwargs):  # noqa: ARG001
        calls["n"] += 1
        response = requests.Response()
        response.status_code = 500
        response._content = b'{"errors": [{"message": "boom"}]}'  # noqa: SLF001
        return response

    sleeps: list[float] = []

    with (
        patch("dembrane.directus.requests.request", side_effect=fake_request),
        patch("dembrane.directus.time.sleep", side_effect=sleeps.append),
    ):
        response = make_request_with_retry(
            _SyncClientStub(), "SEARCH", "http://directus.test/items/whatever"
        )

    assert response is not None, "must never fall through and return None"
    assert response.status_code == 500
    assert calls["n"] == 3
    assert sleeps == [1.0, 2.0]


def test_sync_persistent_transport_error_raises_after_3_attempts():
    calls = {"n": 0}

    def fake_request(method, url, **kwargs):  # noqa: ARG001
        calls["n"] += 1
        raise requests.exceptions.ConnectionError("connection refused")

    sleeps: list[float] = []

    with (
        patch("dembrane.directus.requests.request", side_effect=fake_request),
        patch("dembrane.directus.time.sleep", side_effect=sleeps.append),
    ):
        with pytest.raises(requests.exceptions.ConnectionError):
            make_request_with_retry(
                _SyncClientStub(), "SEARCH", "http://directus.test/items/whatever"
            )

    assert calls["n"] == 3
    assert sleeps == [1.0, 2.0]


# --- get_item record-level 403 FORBIDDEN handling ---
# Directus answers a missing single item with 403; get_item maps that to None
# (so `if not item: raise 404` fires) but still raises on a 401 token failure.

from dembrane.directus import DirectusBadRequest  # noqa: E402


class _BodyTransport(httpx.AsyncBaseTransport):
    def __init__(self, status_code: int, body: dict):
        self.requests = 0
        self.status_code = status_code
        self.body = body

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ARG002
        self.requests += 1
        return httpx.Response(self.status_code, json=self.body)


def _client_with(transport: httpx.AsyncBaseTransport) -> AsyncDirectusClient:
    client = AsyncDirectusClient(url="http://directus.test", token="t")
    client._client = httpx.AsyncClient(  # noqa: SLF001
        base_url="http://directus.test", transport=transport
    )
    return client


@pytest.mark.asyncio
async def test_get_item_returns_none_on_forbidden_record():
    transport = _BodyTransport(403, {"errors": [{"extensions": {"code": "FORBIDDEN"}}]})
    client = _client_with(transport)

    with patch("dembrane.directus_async.asyncio.sleep") as sleep_mock:
        result = await client.get_item("conversation", "does-not-exist")

    assert result is None
    assert transport.requests == 1  # no retry tail on a deterministic FORBIDDEN
    sleep_mock.assert_not_called()


@pytest.mark.asyncio
async def test_get_item_returns_data_on_success():
    transport = _BodyTransport(200, {"data": {"id": "abc"}})
    client = _client_with(transport)

    result = await client.get_item("conversation", "abc")

    assert result == {"id": "abc"}
    assert transport.requests == 1


@pytest.mark.asyncio
async def test_get_item_raises_on_token_failure_not_treated_as_not_found():
    # A 401 (bad/expired admin token) must NOT be silently turned into None;
    # otherwise an auth outage would mask every record as "not found".
    transport = _BodyTransport(401, {"errors": [{"extensions": {"code": "INVALID_CREDENTIALS"}}]})
    client = _client_with(transport)

    with patch("dembrane.directus_async.asyncio.sleep"):
        with pytest.raises(DirectusBadRequest):
            await client.get_item("conversation", "abc")

    assert transport.requests == 3  # 401 stays recoverable -> retried, then raises


@pytest.mark.asyncio
async def test_get_item_raises_on_non_forbidden_403():
    # A 403 whose code is not FORBIDDEN is a real error, not existence-hiding.
    transport = _BodyTransport(403, {"errors": [{"extensions": {"code": "SOMETHING_ELSE"}}]})
    client = _client_with(transport)

    with patch("dembrane.directus_async.asyncio.sleep"):
        with pytest.raises(DirectusBadRequest):
            await client.get_item("conversation", "abc")
