"""/v2/feedback/responses: upsert, flip, clear, list, admin, access."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, HTTPException

from dembrane.api.dependency_auth import DirectusSession, require_directus_session
from dembrane.api.v2.feedback_responses import (
    ResolvedTarget,
    router,
    _resolve_chat_message,
)

pytestmark = pytest.mark.asyncio

MOD = "dembrane.api.v2.feedback_responses"


def _build_app(is_admin: bool = False) -> FastAPI:
    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id="du-1", is_admin=is_admin)

    app.dependency_overrides[require_directus_session] = _auth
    app.include_router(router, prefix="/v2/feedback")
    return app


def _client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _directus(existing: list[dict] | None = None) -> MagicMock:
    dx = MagicMock()
    dx.get_items = AsyncMock(return_value=existing or [])
    dx.create_item = AsyncMock(
        return_value={"data": {"id": "fb-1", "target_type": "chat_message", "target_id": "m-1",
                               "rating": "up", "reasons": [], "comment": None,
                               "date_created": "2026-08-27T00:00:00Z"}}
    )
    dx.update_item = AsyncMock(
        return_value={"data": {"id": "fb-1", "target_type": "chat_message", "target_id": "m-1",
                               "rating": "down", "reasons": ["incorrect"], "comment": "wrong",
                               "date_created": "2026-08-27T00:00:00Z"}}
    )
    dx.delete_item = AsyncMock(return_value=None)
    return dx


def _resolver_patch():
    return patch(
        f"{MOD}.TARGET_RESOLVERS",
        {"chat_message": AsyncMock(return_value=ResolvedTarget(
            project_id="p-1", response_snapshot="The answer", context={"project_chat_id": "c-1"}))},
    )


def _no_rate_limit():
    return patch(f"{MOD}._RATE_LIMITER", MagicMock(check=AsyncMock()))


async def test_resolve_chat_message_rejects_user_messages():
    access = MagicMock()
    with patch(
        f"{MOD}.resolve_chat_message_access",
        new=AsyncMock(return_value=(access, {"id": "m-1", "message_from": "User", "text": "hi"},
                                    {"id": "c-1", "chat_mode": "agentic"})),
    ):
        with pytest.raises(HTTPException) as exc:
            await _resolve_chat_message("m-1", DirectusSession(user_id="du-1", is_admin=False))
    assert exc.value.status_code == 400


async def test_resolve_chat_message_returns_snapshot_and_context():
    access = MagicMock()
    with patch(
        f"{MOD}.resolve_chat_message_access",
        new=AsyncMock(return_value=(
            access,
            {"id": "m-1", "message_from": "assistant", "text": "x" * 30000, "project_chat_id": "c-1"},
            {"id": "c-1", "chat_mode": "agentic", "project_id": "p-1"},
        )),
    ):
        dx = MagicMock()
        dx.get_items = AsyncMock(return_value=[{"text": "Why is the sky blue?"}])
        with patch(f"{MOD}.async_directus", dx):
            resolved = await _resolve_chat_message("m-1", DirectusSession(user_id="du-1", is_admin=False))
    access.require.assert_called_once_with("chat:use")
    assert resolved.project_id == "p-1"
    assert len(resolved.response_snapshot) == 20000
    assert resolved.context == {"project_chat_id": "c-1", "chat_mode": "agentic", "prompt": "Why is the sky blue?"}
    query = dx.get_items.await_args.args[1]["query"]
    assert query["filter"]["message_from"] == {"_in": ["user", "User"]} and query["limit"] == 1
    assert "date_created" not in query["filter"]  # message had no date_created


async def test_preceding_user_message_falls_back_to_nearest_after():
    from dembrane.api.v2.feedback_responses import _preceding_user_message

    dx = MagicMock()
    dx.get_items = AsyncMock(side_effect=[[], [{"text": "what else"}]])
    with patch(f"{MOD}.async_directus", dx):
        prompt = await _preceding_user_message("c-1", "2026-08-27T12:42:18.579+00:00")
    assert prompt == "what else"
    first = dx.get_items.await_args_list[0].args[1]["query"]
    second = dx.get_items.await_args_list[1].args[1]["query"]
    assert first["filter"]["date_created"] == {"_lte": "2026-08-27T12:42:18.579+00:00"} and first["sort"] == ["-date_created"]
    assert second["filter"]["date_created"] == {"_gt": "2026-08-27T12:42:18.579+00:00"} and second["sort"] == ["date_created"]


async def test_put_drops_replay_url_that_is_not_posthog():
    dx = _directus()
    with patch(f"{MOD}.async_directus", dx), _resolver_patch(), _no_rate_limit():
        async with _client(_build_app()) as client:
            res = await client.put("/v2/feedback/responses", json={
                "target_type": "chat_message", "target_id": "m-1", "rating": "up",
                "session_replay_url": "https://evil.example.com/replay/x"})
    assert res.status_code == 200
    assert "session_replay_url" not in dx.create_item.await_args.args[1]["context"]


async def test_resolve_chat_message_without_prompt_still_resolves():
    access = MagicMock()
    with patch(
        f"{MOD}.resolve_chat_message_access",
        new=AsyncMock(return_value=(
            access,
            {"id": "m-1", "message_from": "assistant", "text": "hi", "project_chat_id": "c-1"},
            {"id": "c-1", "chat_mode": "overview", "project_id": "p-1"},
        )),
    ):
        dx = MagicMock()
        dx.get_items = AsyncMock(side_effect=RuntimeError("directus down"))
        with patch(f"{MOD}.async_directus", dx):
            resolved = await _resolve_chat_message("m-1", DirectusSession(user_id="du-1", is_admin=False))
    assert "prompt" not in resolved.context


async def test_put_creates_row_with_snapshot_and_owner():
    dx = _directus()
    with patch(f"{MOD}.async_directus", dx), _resolver_patch(), _no_rate_limit():
        async with _client(_build_app()) as client:
            res = await client.put("/v2/feedback/responses", json={
                "target_type": "chat_message", "target_id": "m-1", "rating": "up",
                "session_replay_url": "https://eu.posthog.com/replay/x"})
    assert res.status_code == 200
    payload = dx.create_item.await_args.args[1]
    assert payload["user_id"] == "du-1"
    assert payload["project_id"] == "p-1"
    assert payload["response_snapshot"] == "The answer"
    assert payload["context"] == {"project_chat_id": "c-1", "session_replay_url": "https://eu.posthog.com/replay/x"}
    assert payload["reasons"] == [] and payload["reason"] is None
    assert res.json()["rating"] == "up"


async def test_put_flips_existing_row_and_keeps_snapshot():
    existing = [{"id": "fb-1", "rating": "up", "response_snapshot": "old"}]
    dx = _directus(existing)
    with patch(f"{MOD}.async_directus", dx), _resolver_patch(), _no_rate_limit():
        async with _client(_build_app()) as client:
            res = await client.put("/v2/feedback/responses", json={
                "target_type": "chat_message", "target_id": "m-1", "rating": "down",
                "reasons": ["incorrect"], "comment": "wrong"})
    assert res.status_code == 200
    dx.create_item.assert_not_awaited()
    args = dx.update_item.await_args.args
    assert args[1] == "fb-1"
    assert args[2] == {"rating": "down", "reasons": ["incorrect"], "reason": "incorrect", "comment": "wrong"}


async def test_put_rejects_unknown_target_type_reason_and_rating():
    dx = _directus()
    with patch(f"{MOD}.async_directus", dx), _resolver_patch(), _no_rate_limit():
        async with _client(_build_app()) as client:
            base = {"target_type": "chat_message", "target_id": "m-1", "rating": "down"}
            r1 = await client.put("/v2/feedback/responses", json={**base, "target_type": "report"})
            r2 = await client.put("/v2/feedback/responses", json={**base, "reasons": ["nope"]})
            r3 = await client.put("/v2/feedback/responses", json={**base, "rating": "meh"})
    assert (r1.status_code, r2.status_code, r3.status_code) == (400, 400, 400)


async def test_put_propagates_resolver_403():
    dx = _directus()
    resolver = AsyncMock(side_effect=HTTPException(status_code=403, detail="Forbidden"))
    with patch(f"{MOD}.async_directus", dx), patch(f"{MOD}.TARGET_RESOLVERS", {"chat_message": resolver}), _no_rate_limit():
        async with _client(_build_app()) as client:
            res = await client.put("/v2/feedback/responses", json={
                "target_type": "chat_message", "target_id": "m-1", "rating": "up"})
    assert res.status_code == 403
    dx.create_item.assert_not_awaited()


async def test_put_create_conflict_falls_back_to_update():
    dx = _directus()
    dx.create_item = AsyncMock(side_effect=RuntimeError("duplicate key"))
    dx.get_items = AsyncMock(side_effect=[[], [{"id": "fb-1", "rating": "up", "response_snapshot": "old"}]])
    with patch(f"{MOD}.async_directus", dx), _resolver_patch(), _no_rate_limit():
        async with _client(_build_app()) as client:
            res = await client.put("/v2/feedback/responses", json={
                "target_type": "chat_message", "target_id": "m-1", "rating": "up"})
    assert res.status_code == 200
    dx.update_item.assert_awaited_once()
    assert dx.update_item.await_args.args[1] == "fb-1"


async def test_put_create_failure_without_row_reraises():
    dx = _directus()
    dx.create_item = AsyncMock(side_effect=RuntimeError("duplicate key"))
    dx.get_items = AsyncMock(side_effect=[[], []])
    with patch(f"{MOD}.async_directus", dx), _resolver_patch(), _no_rate_limit():
        async with _client(_build_app()) as client:
            try:
                await client.put("/v2/feedback/responses", json={
                    "target_type": "chat_message", "target_id": "m-1", "rating": "up"})
            except RuntimeError as exc:
                assert str(exc) == "duplicate key"
            else:
                raise AssertionError("expected RuntimeError to propagate")


async def test_delete_removes_own_row_and_is_idempotent():
    dx = _directus([{"id": "fb-1"}])
    with patch(f"{MOD}.async_directus", dx), _no_rate_limit():
        async with _client(_build_app()) as client:
            r1 = await client.delete("/v2/feedback/responses/chat_message/m-1")
            dx.get_items = AsyncMock(return_value=[])
            r2 = await client.delete("/v2/feedback/responses/chat_message/m-1")
    assert (r1.status_code, r2.status_code) == (204, 204)
    dx.delete_item.assert_awaited_once_with("model_response_feedback", "fb-1")


async def test_list_own_returns_only_requested_ids_filter():
    dx = _directus([{"id": "fb-1", "target_type": "chat_message", "target_id": "m-1", "rating": "up", "reasons": []}])
    with patch(f"{MOD}.async_directus", dx):
        async with _client(_build_app()) as client:
            res = await client.get("/v2/feedback/responses", params={"target_type": "chat_message", "target_ids": "m-1,m-2"})
    assert res.status_code == 200
    assert [r["target_id"] for r in res.json()] == ["m-1"]
    query = dx.get_items.await_args.args[1]["query"]
    assert query["filter"]["user_id"] == {"_eq": "du-1"}
    assert query["filter"]["target_id"] == {"_in": ["m-1", "m-2"]}


async def test_list_own_caps_ids():
    dx = _directus()
    ids = ",".join(f"m-{i}" for i in range(501))
    with patch(f"{MOD}.async_directus", dx):
        async with _client(_build_app()) as client:
            res = await client.get("/v2/feedback/responses", params={"target_type": "chat_message", "target_ids": ids})
    assert res.status_code == 400


async def test_admin_list_requires_admin():
    dx = _directus()
    with patch(f"{MOD}.async_directus", dx):
        async with _client(_build_app(is_admin=False)) as client:
            res = await client.get("/v2/feedback/responses/admin")
    assert res.status_code == 403


async def test_admin_list_filters_and_joins():
    row = {"id": "fb-1", "target_type": "chat_message", "target_id": "m-1", "rating": "down",
           "reasons": ["incorrect"], "comment": None, "response_snapshot": "The answer",
           "context": {"project_chat_id": "c-1"}, "date_created": "2026-08-27T00:00:00Z",
           "project_id": {"id": "p-1", "name": "Proj",
                          "workspace_id": {"id": "ws-1", "name": "Civic Team", "org_id": {"name": "City of Utrecht"}}},
           "user_id": {"email": "host@example.com", "first_name": "Sam", "last_name": "Host"}}
    dx = _directus([row])
    dx.get_items = AsyncMock(side_effect=[[row], [{"count": "143"}]])
    with patch(f"{MOD}.async_directus", dx):
        async with _client(_build_app(is_admin=True)) as client:
            res = await client.get("/v2/feedback/responses/admin", params={"rating": "down", "reason": "incorrect", "chat_mode": "agentic", "page": 2, "limit": 10})
    assert res.status_code == 200
    assert res.json()["total"] == 143
    count_query = dx.get_items.await_args_list[1].args[1]["query"]
    assert count_query["aggregate"] == {"count": "id"} and count_query["filter"]["rating"] == {"_eq": "down"}
    item = res.json()["items"][0]
    assert item["project_name"] == "Proj" and item["user_email"] == "host@example.com" and item["project_id"] == "p-1"
    assert item["workspace_id"] == "ws-1" and item["workspace_name"] == "Civic Team"
    assert item["org_name"] == "City of Utrecht" and item["user_name"] == "Sam Host"
    query = dx.get_items.await_args_list[0].args[1]["query"]
    assert query["filter"]["rating"] == {"_eq": "down"}
    assert query["filter"]["reason"] == {"_eq": "incorrect"}
    assert query["filter"]["chat_mode"] == {"_eq": "agentic"}
    assert query["page"] == 2 and query["limit"] == 10 and query["sort"] == ["-date_created"]


@pytest.mark.parametrize(
    "params",
    [
        {"rating": "sideways"},
        {"target_type": "podcast"},
        {"reason": "vibes"},
        {"chat_mode": "turbo"},
        {"date_from": "yesterday"},
        {"date_to": "2026-13-45"},
    ],
)
async def test_admin_list_rejects_invalid_filters(params: dict):
    dx = _directus()
    with patch(f"{MOD}.async_directus", dx):
        async with _client(_build_app(is_admin=True)) as client:
            res = await client.get("/v2/feedback/responses/admin", params=params)
    assert res.status_code == 400
    dx.get_items.assert_not_awaited()


async def test_admin_list_accepts_iso_dates_with_trailing_z():
    dx = _directus()
    with patch(f"{MOD}.async_directus", dx):
        async with _client(_build_app(is_admin=True)) as client:
            res = await client.get(
                "/v2/feedback/responses/admin",
                params={"date_from": "2026-08-01T00:00:00Z", "date_to": "2026-08-27T23:59:59Z"},
            )
    assert res.status_code == 200
    assert dx.get_items.await_args.args[1]["query"]["filter"]["date_created"] == {
        "_gte": "2026-08-01T00:00:00Z",
        "_lte": "2026-08-27T23:59:59Z",
    }
