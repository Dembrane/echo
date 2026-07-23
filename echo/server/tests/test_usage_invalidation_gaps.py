"""Conversation-create and project-delete must bust the usage caches."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api import project as project_mod, participant as participant_mod
from dembrane.api.dependency_auth import DirectusSession


def _auth() -> DirectusSession:
    return DirectusSession(user_id="u1", is_admin=True)


@pytest.mark.asyncio
async def test_initiate_conversation_invalidates_usage():
    body = participant_mod.InitiateConversationRequestBodySchema(name="p", pin="123456")
    invalidate = AsyncMock()
    with (
        patch.object(
            participant_mod, "run_in_thread_pool", new=AsyncMock(return_value={"id": "c1"})
        ),
        patch(
            "dembrane.api.conversation._invalidate_usage_cache_for_conversation",
            new=invalidate,
        ),
    ):
        result = await participant_mod.initiate_conversation(body, "p1")
    assert result == {"id": "c1"}
    invalidate.assert_awaited_once_with("c1")


@pytest.mark.asyncio
async def test_delete_project_invalidates_usage():
    fetched = {"workspace_id": {"id": "ws-1", "org_id": "org-1"}}
    invalidate = AsyncMock()
    with (
        patch.object(project_mod, "_verify_project_access", new=AsyncMock()),
        patch.object(project_mod, "run_in_thread_pool", new=AsyncMock()),
        patch(
            "dembrane.directus_async.async_directus.get_item",
            new=AsyncMock(return_value=fetched),
        ),
        patch(
            "dembrane.cache_utils.invalidate_workspace_and_org_usage",
            new=invalidate,
        ),
    ):
        result = await project_mod.delete_project("p1", _auth())
    assert result == {"status": "success"}
    invalidate.assert_awaited_once_with("ws-1", "org-1")


@pytest.mark.asyncio
async def test_delete_project_survives_invalidation_failure():
    with (
        patch.object(project_mod, "_verify_project_access", new=AsyncMock()),
        patch.object(project_mod, "run_in_thread_pool", new=AsyncMock()),
        patch(
            "dembrane.directus_async.async_directus.get_item",
            new=AsyncMock(side_effect=RuntimeError("directus down")),
        ),
    ):
        result = await project_mod.delete_project("p1", _auth())
    assert result == {"status": "success"}
