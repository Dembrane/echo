"""GET /v2/feedback/attachments: staff-only signed-URL redirect."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.feedback import router as feedback_router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

pytestmark = pytest.mark.asyncio


def _build_app(is_admin: bool) -> FastAPI:
    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id="du-1", is_admin=is_admin)

    app.dependency_overrides[require_directus_session] = _auth
    app.include_router(feedback_router, prefix="/v2/feedback")
    return app


def _client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_non_staff_forbidden() -> None:
    async with _client(_build_app(is_admin=False)) as c:
        resp = await c.get("/v2/feedback/attachments/r1/0-shot.png")
    assert resp.status_code == 403


async def test_staff_gets_redirect() -> None:
    with (
        patch("dembrane.api.v2.feedback.get_file_size_bytes_from_s3", return_value=123),
        patch(
            "dembrane.api.v2.feedback.get_signed_url",
            return_value="https://s3.example.com/signed",
        ),
    ):
        async with _client(_build_app(is_admin=True)) as c:
            resp = await c.get("/v2/feedback/attachments/r1/0-shot.png")
    assert resp.status_code == 307
    assert resp.headers["location"] == "https://s3.example.com/signed"


async def test_missing_object_404() -> None:
    with patch(
        "dembrane.api.v2.feedback.get_file_size_bytes_from_s3",
        side_effect=Exception("NoSuchKey"),
    ):
        async with _client(_build_app(is_admin=True)) as c:
            resp = await c.get("/v2/feedback/attachments/r1/0-missing.png")
    assert resp.status_code == 404


async def test_dot_dot_in_filename_rejected_before_s3() -> None:
    # Encoded slashes never match the route, so cover the guard with a single segment.
    with patch("dembrane.api.v2.feedback.get_file_size_bytes_from_s3") as head:
        async with _client(_build_app(is_admin=True)) as c:
            resp = await c.get("/v2/feedback/attachments/r1/..secret.png")
    assert resp.status_code == 400
    head.assert_not_called()
