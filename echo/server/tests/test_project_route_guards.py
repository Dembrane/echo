"""The v1 project routes follow the same role presets as the v2 routes, and
a child row is only written through the project it belongs to."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from dembrane.api import project as project_mod
from dembrane.api.v2.bff._access import ResourceAccess
from dembrane.api.dependency_auth import DirectusSession

_RESOLVE = "dembrane.api.v2.bff._access.resolve_project_access"


def _auth() -> DirectusSession:
    return DirectusSession(user_id="u1", is_admin=False)


def _access(role: str, project_id: str = "p1") -> ResourceAccess:
    """A real ResourceAccess, so the role presets decide the outcome."""
    return ResourceAccess(
        app_user_id="au1",
        directus_user_id="u1",
        project_id=project_id,
        workspace_id="ws-1",
        tier="innovator",
        role=role,
        source="direct",
    )


class TestDeleteProject:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("role", ["observer", "external", "billing", "member"])
    async def test_delete_needs_project_delete(self, role: str):
        writes = AsyncMock()
        with (
            patch(_RESOLVE, new=AsyncMock(return_value=_access(role))),
            patch.object(project_mod, "run_in_thread_pool", new=writes),
            pytest.raises(HTTPException) as exc,
        ):
            await project_mod.delete_project("p1", _auth())
        assert exc.value.status_code == 403
        writes.assert_not_awaited()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("role", ["admin", "owner"])
    async def test_admin_and_owner_can_delete(self, role: str):
        writes = AsyncMock()
        with (
            patch(_RESOLVE, new=AsyncMock(return_value=_access(role))),
            patch.object(project_mod, "run_in_thread_pool", new=writes),
            patch(
                "dembrane.directus_async.async_directus.get_item",
                new=AsyncMock(return_value={"workspace_id": None}),
            ),
        ):
            result = await project_mod.delete_project("p1", _auth())
        assert result == {"status": "success"}
        collection, item_id, payload = writes.await_args.args[1:]
        assert (collection, item_id) == ("project", "p1")
        assert set(payload) == {"deleted_at"}
