import os

import pytest

os.environ.setdefault("DIRECTUS_SECRET", "test-secret")
os.environ.setdefault("DIRECTUS_TOKEN", "test-token")
os.environ.setdefault("DATABASE_URL", "postgresql://localhost/test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("STORAGE_S3_BUCKET", "test-bucket")
os.environ.setdefault("STORAGE_S3_ENDPOINT", "https://example.com")
os.environ.setdefault("STORAGE_S3_KEY", "test-key")
os.environ.setdefault("STORAGE_S3_SECRET", "test-secret")

import dembrane.api.project as project_api
from dembrane.api.dependency_auth import DirectusSession


def _auth(client) -> DirectusSession:
    return DirectusSession(
        user_id="user-1",
        is_admin=True,
        access_token="token-1",
        client=client,
    )


@pytest.mark.asyncio
async def test_get_projects_home_falls_back_when_pin_order_is_unavailable(monkeypatch) -> None:
    async def _fake_run_in_thread_pool(func, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        return func(*args, **kwargs)

    class _FakeClient:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def get_items(self, collection_name: str, payload: dict) -> list[dict] | dict[str, str]:
            assert collection_name == "project"
            self.calls.append(payload)
            query = payload["query"]

            if "aggregate" in query:
                return [{"count": {"id": "21"}}]

            if "pin_order" in query.get("fields", []):
                return {"error": 'You don\'t have permission to access field "pin_order"'}

            return [
                {
                    "id": "project-1",
                    "name": "Visible project",
                    "updated_at": "2026-03-19T17:00:00Z",
                    "language": "en",
                    "conversations_count": "2",
                    "directus_user_id": {
                        "first_name": "Admin",
                        "email": "admin@dembrane.com",
                    },
                }
            ]

    client = _FakeClient()
    monkeypatch.setattr(project_api, "run_in_thread_pool", _fake_run_in_thread_pool)

    response = await project_api.get_projects_home(
        auth=_auth(client),
        search=None,
        offset=0,
        limit=15,
    )

    assert response.is_admin is True
    assert response.total_count == 21
    assert response.has_more is False
    assert response.pinned == []
    assert len(response.projects) == 1
    assert response.projects[0].id == "project-1"
    assert response.projects[0].pin_order is None
    assert any("pin_order" in call["query"].get("fields", []) for call in client.calls)
    assert any(
        "pin_order" not in call["query"].get("fields", [])
        for call in client.calls
        if "aggregate" not in call["query"]
    )
