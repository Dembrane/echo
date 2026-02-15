import httpx
import pytest

from echo_client import EchoClient


def test_echo_client_sets_authorization_header():
    client = EchoClient(bearer_token="abc123")
    try:
        assert client._client.headers.get("Authorization") == "Bearer abc123"
    finally:
        # Async close is tested in integration; this test only checks header wiring.
        pass


def test_echo_client_without_token_has_no_authorization_header():
    client = EchoClient(bearer_token=None)
    try:
        assert client._client.headers.get("Authorization") is None
    finally:
        pass


class _FakeAsyncClient:
    def __init__(self, *, base_url, headers, timeout):
        self.base_url = base_url
        self.headers = headers
        self.timeout = timeout
        self.calls: list[dict[str, object]] = []

    async def aclose(self) -> None:
        return None

    async def get(self, path: str, params=None):  # noqa: ANN001
        self.calls.append({"path": path, "params": params})
        request = httpx.Request("GET", f"{self.base_url}{path}", params=params)
        if path == "/home/search":
            return httpx.Response(
                status_code=200,
                request=request,
                json={"conversations": [], "projects": [], "transcripts": [], "chats": []},
            )
        if path.startswith("/conversations/") and path.endswith("/transcript"):
            return httpx.Response(status_code=200, request=request, json="transcript text")
        return httpx.Response(status_code=200, request=request, json={"ok": True})


@pytest.mark.asyncio
async def test_search_home_uses_expected_path_and_query_params(monkeypatch):
    monkeypatch.setattr("echo_client.httpx.AsyncClient", _FakeAsyncClient)

    client = EchoClient(bearer_token="token-1")
    payload = await client.search_home(query="climate", limit=7)

    assert payload["conversations"] == []
    assert client._client.calls[0]["path"] == "/home/search"
    assert client._client.calls[0]["params"] == {"query": "climate", "limit": 7}
    assert client._client.headers.get("Authorization") == "Bearer token-1"


@pytest.mark.asyncio
async def test_get_conversation_transcript_uses_expected_path(monkeypatch):
    monkeypatch.setattr("echo_client.httpx.AsyncClient", _FakeAsyncClient)

    client = EchoClient(bearer_token="token-1")
    transcript = await client.get_conversation_transcript("conversation-123")

    assert transcript == "transcript text"
    assert client._client.calls[0]["path"] == "/conversations/conversation-123/transcript"
    assert client._client.headers.get("Authorization") == "Bearer token-1"
