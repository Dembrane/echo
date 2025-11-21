from __future__ import annotations

import pytest
from httpx import AsyncClient, ASGITransport

from tests.common import (
    create_project,
    delete_project,
    create_conversation,
    delete_conversation,
    create_conversation_chunk,
    delete_conversation_chunk,
)
from dembrane.main import app
from dembrane.directus import DirectusBadRequest, directus
from dembrane.api.dependency_auth import DirectusSession, require_directus_session


def _make_test_session() -> DirectusSession:
    """
    Build a reusable DirectusSession for dependency overrides during tests.
    """
    return DirectusSession(
        user_id="test-admin",
        is_admin=True,
        access_token=directus.get_token(),
        client=directus,
    )


@pytest.fixture
def anyio_backend() -> str:
    # Keep pytest-asyncio on asyncio backend
    return "asyncio"


@pytest.fixture(autouse=True)
def patch_thread_pool(monkeypatch):
    """Execute blocking helpers synchronously during tests."""

    original_run_in_thread_pool = __import__(
        "dembrane.async_helpers", fromlist=["run_in_thread_pool"]
    ).run_in_thread_pool

    async def _immediate(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr("dembrane.async_helpers.run_in_thread_pool", _immediate)
    monkeypatch.setattr("dembrane.api.conversation.run_in_thread_pool", _immediate)
    try:
        yield
    finally:
        monkeypatch.setattr(
            "dembrane.async_helpers.run_in_thread_pool", original_run_in_thread_pool
        )
        monkeypatch.setattr(
            "dembrane.api.conversation.run_in_thread_pool", original_run_in_thread_pool
        )


@pytest.fixture
async def api_client(monkeypatch):  # pyright: ignore[reportUnusedParameter]  # noqa: ARG001
    async def _override_session():
        return _make_test_session()

    app.dependency_overrides[require_directus_session] = _override_session
    transport = ASGITransport(app=app)

    try:
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield client
    finally:
        app.dependency_overrides.pop(require_directus_session, None)


@pytest.mark.anyio
async def test_conversation_counts_endpoint(api_client: AsyncClient) -> None:
    project = create_project("e2e-project", "en")
    conversation = create_conversation(project["id"], "e2e-conversation")

    chunk_processed = create_conversation_chunk(
        conversation["id"],
        transcript="hello world",
        additional_data={"error": None},
    )
    chunk_pending = create_conversation_chunk(
        conversation["id"],
        transcript=None,
        additional_data={"error": None},
    )

    response = await api_client.get(f"/api/conversations/{conversation['id']}/counts")
    assert response.status_code == 200, response.json()
    payload = response.json()

    assert payload["total"] == 2
    assert payload["processed"] == 1
    assert payload["pending"] == 1
    assert payload["error"] == 0
    assert payload["ok"] == 1

    delete_conversation_chunk(chunk_processed["id"])
    delete_conversation_chunk(chunk_pending["id"])
    delete_conversation(conversation["id"])
    delete_project(project["id"])


@pytest.mark.anyio
async def test_delete_conversation_endpoint(api_client: AsyncClient) -> None:
    project = create_project("e2e-delete-project", "en")
    conversation = create_conversation(project["id"], "e2e-delete-conversation")

    response = await api_client.delete(f"/api/conversations/{conversation['id']}")
    assert response.status_code == 200, response.json()
    assert response.json()["status"] == "success"

    # Directus should no longer return the deleted conversation
    with pytest.raises(DirectusBadRequest):
        directus.get_item("conversation", conversation["id"])

    delete_project(project["id"])
