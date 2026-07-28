"""list_workspace_projects must enrich page + pinned in one pass."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.v2 import workspace_projects as wp_mod


class _Ctx:
    workspace_id = "ws-1"
    app_user_id = "au-1"
    role = "admin"

    def require_policy(self, _p):
        return None

    def has_policy(self, _p):
        return True


def _rows(prefix, n, pinned=False):
    return [
        {
            "id": f"{prefix}{i}",
            "name": f"P {i}",
            "visibility": "workspace",
            "pin_order": i if pinned else None,
            "conversations_count": 0,
        }
        for i in range(n)
    ]


@pytest.mark.asyncio
async def test_single_enrich_pass_over_union():
    async def _get_items(collection, payload):
        query = payload["query"]
        if collection == "project" and "aggregate" in query:
            return [{"count": {"id": 3}}]
        if collection == "project" and "pin_order" in str(query.get("filter", {})):
            return _rows("pin", 2, pinned=True)
        if collection == "project":
            return _rows("page", 2)
        raise AssertionError(collection)

    preview_mock = AsyncMock(return_value={})
    hours_mock = AsyncMock(return_value={})
    with (
        patch.object(wp_mod, "_shared_private_project_ids", new=AsyncMock(return_value=set())),
        patch.object(wp_mod.async_directus, "get_items", new=AsyncMock(side_effect=_get_items)),
        patch.object(wp_mod, "_build_access_previews", new=preview_mock),
        patch.object(wp_mod, "_project_audio_hours", new=hours_mock),
    ):
        # Explicit kwargs: direct calls keep Query(...) objects as defaults.
        res = await wp_mod.list_workspace_projects(
            auth=type("A", (), {"user_id": "du-1"})(),
            ctx=_Ctx(),
            search=None,
            offset=0,
            limit=15,
        )

    assert preview_mock.await_count == 1
    assert hours_mock.await_count == 1
    enriched_ids = set(preview_mock.await_args.kwargs["project_ids"])
    assert enriched_ids == {"page0", "page1", "pin0", "pin1"}
    assert [p.id for p in res.projects] == ["page0", "page1"]
    assert [p.id for p in res.pinned] == ["pin0", "pin1"]
    assert res.total_count == 3
