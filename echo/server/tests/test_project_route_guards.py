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


class _Directus:
    """Stand-in for the sync `directus` client: answers get_items from an
    in-memory table and records every write."""

    def __init__(self, tables: dict[str, list[dict]]):
        self.tables = tables
        self.deleted: list[tuple[str, str]] = []
        self.updated: list[tuple[str, str, dict]] = []

    def get_items(self, collection, params=None, *_a, **_k):
        filter_ = (params or {}).get("query", {}).get("filter", {})

        def _matches(row: dict) -> bool:
            for field, cond in filter_.items():
                value = row.get(field)
                if "_eq" in cond and str(value) != str(cond["_eq"]):
                    return False
                if "_neq" in cond and str(value) == str(cond["_neq"]):
                    return False
                if "_in" in cond and value not in cond["_in"]:
                    return False
                if "_null" in cond and (value is None) != cond["_null"]:
                    return False
            return True

        return [row for row in self.tables.get(collection, []) if _matches(row)]

    def delete_item(self, collection, item_id, *_a, **_k):
        self.deleted.append((collection, item_id))

    def update_item(self, collection, item_id, data, *_a, **_k):
        self.updated.append((collection, item_id, data))
        row = next(r for r in self.tables[collection] if str(r["id"]) == item_id)
        row.update(data)
        return {"data": row}


async def _inline(fn, *args, **kwargs):
    return fn(*args, **kwargs)


class TestDeleteConversationTags:
    def _directus(self) -> _Directus:
        return _Directus(
            {
                "conversation": [
                    {"id": "c1", "project_id": "p1"},
                    {"id": "c2", "project_id": "p2"},
                ],
                "conversation_project_tag": [
                    {"id": 1, "conversation_id": "c1"},
                    {"id": 2, "conversation_id": "c1"},
                    {"id": 3, "conversation_id": "c2"},
                ],
            }
        )

    async def _call(self, client: _Directus, role: str, conversation_id: str, tag_ids: list[int]):
        body = project_mod.DeleteConversationTagsRequest(tag_ids=tag_ids)
        with (
            patch(_RESOLVE, new=AsyncMock(return_value=_access(role))),
            patch.object(project_mod, "run_in_thread_pool", new=_inline),
            patch("dembrane.directus.directus", client),
        ):
            return await project_mod.delete_conversation_tags("p1", conversation_id, body, _auth())

    @pytest.mark.asyncio
    async def test_removes_the_conversations_own_rows(self):
        client = self._directus()
        result = await self._call(client, "member", "c1", [1, 2])
        assert result == {"status": "success", "deleted": 2}
        assert client.deleted == [
            ("conversation_project_tag", "1"),
            ("conversation_project_tag", "2"),
        ]

    @pytest.mark.asyncio
    async def test_rows_of_another_conversation_stay(self):
        client = self._directus()
        result = await self._call(client, "member", "c1", [1, 3])
        assert result == {"status": "success", "deleted": 1}
        assert client.deleted == [("conversation_project_tag", "1")]

    @pytest.mark.asyncio
    async def test_conversation_belongs_to_the_project(self):
        client = self._directus()
        with pytest.raises(HTTPException) as exc:
            await self._call(client, "member", "c2", [3])
        assert exc.value.status_code == 404
        assert client.deleted == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize("role", ["observer", "billing"])
    async def test_removal_needs_project_update(self, role: str):
        client = self._directus()
        with pytest.raises(HTTPException) as exc:
            await self._call(client, role, "c1", [1])
        assert exc.value.status_code == 403
        assert client.deleted == []


class TestUpdateReport:
    def _directus(self) -> _Directus:
        return _Directus(
            {
                "project_report": [
                    {
                        "id": 7,
                        "project_id": "p1",
                        "kind": "report",
                        "status": "archived",
                        "deleted_at": None,
                    },
                    {
                        "id": 9,
                        "project_id": "p2",
                        "kind": "report",
                        "status": "archived",
                        "deleted_at": None,
                    },
                ],
            }
        )

    async def _call(self, client: _Directus, role: str, report_id: int, **fields):
        body = project_mod.UpdateReportRequestBodySchema(**fields)
        with (
            patch(_RESOLVE, new=AsyncMock(return_value=_access(role))),
            patch.object(project_mod, "run_in_thread_pool", new=_inline),
            patch("dembrane.directus.directus", client),
        ):
            return await project_mod.update_report("p1", report_id, body, _auth())

    @pytest.mark.asyncio
    async def test_report_belongs_to_the_project(self):
        client = self._directus()
        with pytest.raises(HTTPException) as exc:
            await self._call(client, "admin", 9, content="# Title")
        assert exc.value.status_code == 404
        assert client.updated == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize("role", ["external", "member"])
    async def test_content_edit_with_project_update(self, role: str):
        client = self._directus()
        result = await self._call(client, role, 7, content="# Title", show_portal_link=True)
        assert client.updated == [
            ("project_report", "7", {"content": "# Title", "show_portal_link": True})
        ]
        assert result["content"] == "# Title"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("role", ["observer", "billing"])
    async def test_content_edit_needs_project_update(self, role: str):
        client = self._directus()
        with pytest.raises(HTTPException) as exc:
            await self._call(client, role, 7, content="# Title")
        assert exc.value.status_code == 403
        assert client.updated == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "fields",
        [
            {"status": "published"},
            {"status": "scheduled"},
            {"scheduled_at": "2999-01-01T00:00:00Z"},
        ],
    )
    async def test_publish_and_schedule_need_report_publish(self, fields: dict):
        client = self._directus()
        with pytest.raises(HTTPException) as exc:
            await self._call(client, "external", 7, **fields)
        assert exc.value.status_code == 403
        assert client.updated == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", ["archived", "cancelled", "draft"])
    async def test_other_status_changes_with_project_update(self, status: str):
        client = self._directus()
        result = await self._call(client, "external", 7, status=status)
        assert client.updated == [("project_report", "7", {"status": status})]
        assert result["status"] == status

    @pytest.mark.asyncio
    async def test_member_can_publish(self):
        client = self._directus()
        result = await self._call(client, "member", 7, status="published")
        assert client.updated == [("project_report", "7", {"status": "published"})]
        assert result["status"] == "published"
