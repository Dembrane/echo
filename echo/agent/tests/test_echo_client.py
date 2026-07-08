import httpx
import pytest

from echo_client import EchoClient, build_project_portal_link, portal_base_url_for_api_url


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


@pytest.mark.parametrize(
    ("api_url", "expected_base"),
    [
        ("https://api.echo-next.dembrane.com/api", "https://portal.echo-next.dembrane.com"),
        (
            "https://api.echo-testing.dembrane.com/api",
            "https://portal.echo-testing.dembrane.com",
        ),
        ("https://api.dembrane.com/api", "https://portal.dembrane.com"),
        ("http://localhost:8000/api", "http://localhost:5174"),
    ],
)
def test_portal_base_url_for_api_url_maps_known_environments(api_url, expected_base):
    assert portal_base_url_for_api_url(api_url) == expected_base


@pytest.mark.parametrize(
    ("language", "expected_language"),
    [("nl", "nl"), ("default", "en"), ("", "en"), (None, "en")],
)
def test_build_project_portal_link_normalizes_language(language, expected_language):
    assert (
        build_project_portal_link(
            "project-1",
            language,
            echo_api_url="https://api.echo-next.dembrane.com/api",
        )
        == f"https://portal.echo-next.dembrane.com/{expected_language}/project-1/start"
    )


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
        if path.startswith("/agentic/projects/") and path.endswith("/conversations"):
            return httpx.Response(
                status_code=200,
                request=request,
                json={
                    "project_id": "project-1",
                    "count": 1,
                    "conversations": [
                        {
                            "conversation_id": "conv-1",
                            "participant_name": "Alice",
                            "status": "done",
                            "summary": "summary",
                            "started_at": "2026-02-01T12:00:00Z",
                            "last_chunk_at": "2026-02-01T12:10:00Z",
                        }
                    ],
                },
            )
        if path.startswith("/agentic/projects/") and path.endswith("/canvases"):
            return httpx.Response(
                status_code=200,
                request=request,
                json=[
                    {
                        "id": "canvas-1",
                        "name": "Pulse wall",
                        "kind": "canvas",
                        "created_at": "2026-07-07T10:00:00Z",
                        "latest_generation_at": None,
                        "loop": {
                            "status": "active",
                            "expires_at": "2026-07-07T18:00:00Z",
                            "cadence_minutes": 5,
                        },
                    }
                ],
            )
        if path.startswith("/conversations/") and path.endswith("/transcript"):
            return httpx.Response(status_code=200, request=request, json="transcript text")
        return httpx.Response(status_code=200, request=request, json={"ok": True})

    async def post(self, path: str, json=None):  # noqa: ANN001
        self.calls.append({"path": path, "json": json})
        request = httpx.Request("POST", f"{self.base_url}{path}")
        if path.endswith("/loop/pause"):
            return httpx.Response(
                status_code=200,
                request=request,
                json={
                    "status": "paused",
                    "expires_at": "2026-07-07T18:00:00Z",
                    "cadence_minutes": 5,
                },
            )
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


@pytest.mark.asyncio
async def test_list_project_conversations_uses_expected_path(monkeypatch):
    monkeypatch.setattr("echo_client.httpx.AsyncClient", _FakeAsyncClient)

    client = EchoClient(bearer_token="token-1")
    payload = await client.list_project_conversations("project-1", limit=9)

    assert payload["project_id"] == "project-1"
    assert payload["count"] == 1
    assert client._client.calls[0]["path"] == "/agentic/projects/project-1/conversations"
    assert client._client.calls[0]["params"] == {"limit": 9}
    assert client._client.headers.get("Authorization") == "Bearer token-1"


@pytest.mark.asyncio
async def test_list_project_conversations_accepts_conversation_id_filter(monkeypatch):
    monkeypatch.setattr("echo_client.httpx.AsyncClient", _FakeAsyncClient)

    client = EchoClient(bearer_token="token-1")
    payload = await client.list_project_conversations(
        "project-1",
        limit=1,
        conversation_id="conv-1",
    )

    assert payload["project_id"] == "project-1"
    assert client._client.calls[0]["path"] == "/agentic/projects/project-1/conversations"
    assert client._client.calls[0]["params"] == {"limit": 1, "conversation_id": "conv-1"}


@pytest.mark.asyncio
async def test_list_project_conversations_accepts_transcript_query_filter(monkeypatch):
    monkeypatch.setattr("echo_client.httpx.AsyncClient", _FakeAsyncClient)

    client = EchoClient(bearer_token="token-1")
    payload = await client.list_project_conversations(
        "project-1",
        limit=5,
        transcript_query="Bad Bunny TPUSA",
    )

    assert payload["project_id"] == "project-1"
    assert client._client.calls[0]["path"] == "/agentic/projects/project-1/conversations"
    assert client._client.calls[0]["params"] == {"limit": 5, "transcript_query": "Bad Bunny TPUSA"}


@pytest.mark.asyncio
async def test_list_canvases_uses_expected_path(monkeypatch):
    monkeypatch.setattr("echo_client.httpx.AsyncClient", _FakeAsyncClient)

    client = EchoClient(bearer_token="token-1")
    payload = await client.list_canvases("project-1")

    assert payload[0]["id"] == "canvas-1"
    assert client._client.calls[0]["path"] == "/agentic/projects/project-1/canvases"


@pytest.mark.asyncio
async def test_update_canvas_loop_uses_expected_path(monkeypatch):
    monkeypatch.setattr("echo_client.httpx.AsyncClient", _FakeAsyncClient)

    client = EchoClient(bearer_token="token-1")
    payload = await client.update_canvas_loop("project-1", "canvas-1", "pause")

    assert payload["status"] == "paused"
    assert (
        client._client.calls[0]["path"]
        == "/agentic/projects/project-1/canvases/canvas-1/loop/pause"
    )
