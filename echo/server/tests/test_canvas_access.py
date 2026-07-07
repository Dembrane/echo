from __future__ import annotations

import pytest

from dembrane.canvas import access as canvas_access


@pytest.mark.asyncio
async def test_resolve_canvas_reader_context_returns_narrow_ids(monkeypatch) -> None:
    async def _fake_get_app_user_or_raise(directus_user_id: str) -> dict:
        assert directus_user_id == "directus-user-1"
        return {"id": "app-user-1"}

    async def _fake_get_item(collection: str, item_id: str) -> dict:
        assert collection == "project"
        assert item_id == "project-1"
        return {"id": "project-1", "workspace_id": "workspace-1", "deleted_at": None}

    async def _fake_get_user_project_access(**kwargs) -> tuple[str, str]:
        assert kwargs["project_id"] == "project-1"
        assert kwargs["user_id"] == "app-user-1"
        assert kwargs["directus_user_id"] == "directus-user-1"
        return "reader", "workspace"

    monkeypatch.setattr(canvas_access, "get_app_user_or_raise", _fake_get_app_user_or_raise)
    monkeypatch.setattr(canvas_access.async_directus, "get_item", _fake_get_item)
    monkeypatch.setattr(canvas_access, "get_user_project_access", _fake_get_user_project_access)

    context = await canvas_access.resolve_canvas_reader_context(
        acting_directus_user_id="directus-user-1",
        project_id="project-1",
    )

    assert context == canvas_access.CanvasReaderContext(
        project_id="project-1",
        workspace_id="workspace-1",
        directus_user_id="directus-user-1",
        app_user_id="app-user-1",
    )


@pytest.mark.asyncio
async def test_resolve_canvas_reader_context_fails_closed_without_access(monkeypatch) -> None:
    async def _fake_get_app_user_or_raise(_directus_user_id: str) -> dict:
        return {"id": "app-user-1"}

    async def _fake_get_item(_collection: str, _item_id: str) -> dict:
        return {"id": "project-1", "workspace_id": "workspace-1", "deleted_at": None}

    async def _fake_get_user_project_access(**_kwargs) -> None:
        return None

    monkeypatch.setattr(canvas_access, "get_app_user_or_raise", _fake_get_app_user_or_raise)
    monkeypatch.setattr(canvas_access.async_directus, "get_item", _fake_get_item)
    monkeypatch.setattr(canvas_access, "get_user_project_access", _fake_get_user_project_access)

    with pytest.raises(canvas_access.CanvasReaderAccessDenied):
        await canvas_access.resolve_canvas_reader_context(
            acting_directus_user_id="directus-user-1",
            project_id="project-1",
        )

