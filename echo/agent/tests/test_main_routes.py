from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

import main


class _DummyLangGraphAgent:
    def __init__(self, **_kwargs):
        pass


class _DummyEndpoint:
    def __init__(self, agents):
        self.agents = agents


async def _fake_handler(request, _endpoint):
    return JSONResponse(
        {
            "path": request.scope.get("path_params", {}).get("path"),
            "authorization": request.headers.get("authorization"),
        }
    )


def test_copilotkit_root_post_rewrites_to_default_path(monkeypatch):
    monkeypatch.setattr(main, "copilotkit_handler", _fake_handler)
    monkeypatch.setattr(main, "LangGraphAgent", _DummyLangGraphAgent)
    monkeypatch.setattr(main, "CopilotKitRemoteEndpoint", _DummyEndpoint)

    client = TestClient(main.app)
    response = client.post(
        "/copilotkit/project-1",
        headers={"Authorization": "Bearer token-1"},
        json={},
    )

    assert response.status_code == 200
    assert response.json()["path"] == "agent/default"
    assert response.json()["authorization"] == "Bearer token-1"


def test_copilotkit_forwards_reach_back_headers_to_graph(monkeypatch):
    graph_calls = []

    def _fake_create_agent_graph(**kwargs):
        graph_calls.append(kwargs)
        return object()

    monkeypatch.setattr(main, "copilotkit_handler", _fake_handler)
    monkeypatch.setattr(main, "LangGraphAgent", _DummyLangGraphAgent)
    monkeypatch.setattr(main, "CopilotKitRemoteEndpoint", _DummyEndpoint)
    monkeypatch.setattr(main, "create_agent_graph", _fake_create_agent_graph)

    client = TestClient(main.app)
    response = client.post(
        "/copilotkit/project-1",
        headers={
            "Authorization": "Bearer token-1",
            "X-Dembrane-Chat-Id": "chat-1",
            "X-Dembrane-App-User-Id": "app-user-1",
            "X-Dembrane-Message-Id": "run-event-1",
        },
        json={},
    )

    assert response.status_code == 200
    assert graph_calls[0]["chat_id"] == "chat-1"
    assert graph_calls[0]["app_user_id"] == "app-user-1"
    assert graph_calls[0]["message_id"] == "run-event-1"


def test_copilotkit_nested_path_is_preserved(monkeypatch):
    monkeypatch.setattr(main, "copilotkit_handler", _fake_handler)
    monkeypatch.setattr(main, "LangGraphAgent", _DummyLangGraphAgent)
    monkeypatch.setattr(main, "CopilotKitRemoteEndpoint", _DummyEndpoint)

    client = TestClient(main.app)
    response = client.post(
        "/copilotkit/project-1/agent/custom",
        headers={"Authorization": "Bearer token-1"},
        json={},
    )

    assert response.status_code == 200
    assert response.json()["path"] == "agent/custom"


def test_copilotkit_requires_auth_header():
    client = TestClient(main.app)
    response = client.post("/copilotkit/project-1", json={})
    assert response.status_code == 401
