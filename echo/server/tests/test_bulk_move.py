"""Tests for bulk-move (conversations between projects, projects between
workspaces) + the shared move_history audit log."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.move_history import append_move_entry
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

# ── move_history.append_move_entry ──────────────────────────────────────


def test_append_move_entry_appends_with_labels():
    out = append_move_entry(
        None,
        from_id="p-1",
        to_id="p-2",
        by="u-1",
        from_label="Old",
        to_label="New",
        by_label="Jane",
    )
    assert len(out) == 1
    e = out[0]
    assert e["from"] == "p-1" and e["to"] == "p-2" and e["by"] == "u-1"
    assert e["from_label"] == "Old" and e["to_label"] == "New" and e["by_label"] == "Jane"
    assert e["at"]  # ISO timestamp present


def test_append_move_entry_preserves_prior_history():
    prior = [{"from": "a", "to": "b", "by": "u", "at": "t0"}]
    out = append_move_entry(prior, from_id="b", to_id="c", by="u2")
    assert len(out) == 2
    assert out[0]["to"] == "b"  # original kept
    assert out[1]["from"] == "b" and out[1]["to"] == "c"


def test_append_move_entry_handles_non_list():
    # Legacy / unset value that isn't a list is treated as empty.
    out = append_move_entry("garbage", from_id="x", to_id="y", by=None)
    assert len(out) == 1 and out[0]["to"] == "y"


# ── bulk-move projects: all-or-nothing authorization ────────────────────


def _projects_app(monkeypatch_targets):
    from dembrane.api.v2 import projects as proj_mod

    app = FastAPI()

    async def _fake_auth():
        return DirectusSession(user_id="du-1", is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(proj_mod.router, prefix="/v2/projects")
    return app, proj_mod


@pytest.mark.asyncio
async def test_bulk_move_projects_all_or_nothing_on_permission():
    """If the user lacks admin/owner on one project's source, the whole bulk
    move is rejected and NOTHING is updated."""
    app, proj_mod = _projects_app(None)

    target_ws = {"id": "ws-dst", "deleted_at": None, "usage_context": "internal"}
    projects = {
        "p-ok": {"id": "p-ok", "workspace_id": "ws-a", "deleted_at": None},
        "p-bad": {"id": "p-bad", "workspace_id": "ws-b", "deleted_at": None},
    }

    async def fake_get_item(collection, item_id):
        if collection == "workspace":
            return target_ws
        return projects.get(item_id)

    # admin on ws-a + target; only member on ws-b → p-bad fails.
    async def fake_user_can_access(ws_id, _uid):
        return ("member", "direct") if ws_id == "ws-b" else ("admin", "direct")

    update_mock = AsyncMock(return_value={})
    with (
        patch.object(proj_mod, "get_app_user_or_raise", new=AsyncMock(return_value={"id": "au-1"})),
        patch.object(proj_mod.async_directus, "get_item", new=AsyncMock(side_effect=fake_get_item)),
        patch.object(proj_mod.async_directus, "update_item", new=update_mock),
        patch.object(proj_mod, "user_can_access", new=AsyncMock(side_effect=fake_user_can_access)),
        patch("dembrane.billing_service.same_billing_context", new=AsyncMock(return_value=True)),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://t") as client:
            r = await client.post(
                "/v2/projects/bulk-move",
                json={"project_ids": ["p-ok", "p-bad"], "target_workspace_id": "ws-dst"},
            )
    assert r.status_code == 403
    update_mock.assert_not_called()  # nothing moved


@pytest.mark.asyncio
async def test_bulk_move_projects_success_records_history():
    app, proj_mod = _projects_app(None)
    target_ws = {"id": "ws-dst", "name": "Dest WS", "deleted_at": None, "usage_context": "internal"}
    projects = {
        "p-1": {"id": "p-1", "workspace_id": "ws-a", "deleted_at": None, "move_history": []},
        "p-2": {"id": "p-2", "workspace_id": "ws-a", "deleted_at": None},
    }

    async def fake_get_item(collection, item_id):
        if collection == "workspace":
            return {"id": item_id, "name": f"WS {item_id}", "deleted_at": None} if item_id != "ws-dst" else target_ws
        return projects.get(item_id)

    update_mock = AsyncMock(return_value={})
    with (
        patch.object(proj_mod, "get_app_user_or_raise", new=AsyncMock(return_value={"id": "au-1", "display_name": "Jane"})),
        patch.object(proj_mod.async_directus, "get_item", new=AsyncMock(side_effect=fake_get_item)),
        patch.object(proj_mod.async_directus, "update_item", new=update_mock),
        patch.object(proj_mod, "user_can_access", new=AsyncMock(return_value=("owner", "direct"))),
        patch("dembrane.billing_service.same_billing_context", new=AsyncMock(return_value=True)),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://t") as client:
            r = await client.post(
                "/v2/projects/bulk-move",
                json={"project_ids": ["p-1", "p-2"], "target_workspace_id": "ws-dst"},
            )
    assert r.status_code == 200
    assert r.json()["count"] == 2
    assert update_mock.await_count == 2
    # Each update carries a move_history entry with the by_label.
    first_payload = update_mock.await_args_list[0].args[2]
    entry = first_payload["move_history"][-1]
    assert entry["to"] == "ws-dst" and entry["by_label"] == "Jane"


@pytest.mark.asyncio
async def test_bulk_move_projects_rejects_empty():
    app, proj_mod = _projects_app(None)
    with patch.object(proj_mod, "get_app_user_or_raise", new=AsyncMock(return_value={"id": "au-1"})):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://t") as client:
            r = await client.post(
                "/v2/projects/bulk-move",
                json={"project_ids": [], "target_workspace_id": "ws-dst"},
            )
    # Empty selection is rejected before any auth/work.
    assert r.status_code == 400
