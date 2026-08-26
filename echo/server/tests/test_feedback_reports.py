"""POST /v2/feedback/reports: validation, S3 storage, support_request outbox, cleanup."""

from __future__ import annotations

import io
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, HTTPException

from dembrane.api.v2.feedback import (
    router as feedback_router,
    _safe_filename,
    _attachment_link_base,
    _resolve_report_scope,
)
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _signed_preview_url():
    with patch(
        "dembrane.api.v2.feedback.get_signed_url",
        return_value="https://s3.example.com/signed-preview",
    ) as m:
        yield m


def _build_app() -> FastAPI:
    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id="du-1", is_admin=False)

    app.dependency_overrides[require_directus_session] = _auth
    app.include_router(feedback_router, prefix="/v2/feedback")
    return app


def _client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


_PROFILE = {"email": "host@example.com", "display_name": "Test Host"}
_SESSION = DirectusSession(user_id="du-1", is_admin=False)


def _patches(create_side_effect=None):
    settings = MagicMock()
    settings.urls.api_base_url = "https://api.example.com"
    directus = MagicMock()
    directus.create_item = AsyncMock(
        return_value={"data": {"id": "sr-1"}},
        side_effect=create_side_effect,
    )
    return settings, directus


def _scope_patch(workspace_id="w-1", project_id="p-1"):
    """The endpoint drops ids it cannot verify, so tests stub the resolver."""
    return patch(
        "dembrane.api.v2.feedback._resolve_report_scope",
        new=AsyncMock(return_value=(workspace_id, project_id)),
    )


def _created_row(directus: MagicMock) -> dict:
    return directus.create_item.call_args.args[1]


def _form(message="Something broke", **overrides):
    form = {
        "message": message,
        "page_url": "https://dashboard.dembrane.com/en/projects/p1",
        "locale": "en-US",
        "user_agent": "test-agent",
        "session_replay_url": "https://eu.posthog.com/replay/abc",
    }
    form.update(overrides)
    return form


def _png(name="shot.png", size=100):
    return ("attachments", (name, io.BytesIO(b"x" * size), "image/png"))


async def test_requires_auth():
    app = FastAPI()
    app.include_router(feedback_router, prefix="/v2/feedback")
    async with _client(app) as c:
        resp = await c.post("/v2/feedback/reports", data=_form())
    assert resp.status_code in (401, 403)


async def test_happy_path_writes_support_request_and_stores_s3():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.save_to_s3_from_file_like") as save_mock,
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post("/v2/feedback/reports", data=_form(), files=[_png()])
    assert resp.status_code == 201
    body = resp.json()
    assert body["attachment_count"] == 1
    assert body["support_request_id"] == "sr-1"
    assert save_mock.call_count == 1
    key = save_mock.call_args.args[1]
    assert key.startswith(f"feedback/{body['report_id']}/")

    assert directus.create_item.call_args.args[0] == "support_request"
    row = _created_row(directus)
    assert row["status"] == "new"
    assert row["directus_user_id"] == "du-1"
    message = row["message"]
    assert "host@example.com" in message
    assert "Something broke" in message
    assert "Session replay: https://eu.posthog.com/replay/abc" in message
    # Server-built blocks must precede the reporter's free text.
    assert message.index("Attachments:") < message.index("Message:")
    assert message.index("Session replay:") < message.index("Message:")
    assert message.index("Message:") < message.index("Something broke")
    assert f"/api/v2/feedback/attachments/{body['report_id']}/" in message
    assert "Page: https://dashboard.dembrane.com/en/projects/p1" in row["page_context"]
    assert "Locale: en-US" in row["page_context"]


async def test_verified_scope_ids_are_persisted():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
        _scope_patch(),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post(
                "/v2/feedback/reports",
                data=_form(workspace_id="w-1", project_id="p-1"),
            )
    assert resp.status_code == 201
    row = _created_row(directus)
    assert row["workspace_id"] == "w-1"
    assert row["project_id"] == "p-1"


async def test_unverified_scope_ids_are_dropped():
    settings, directus = _patches()
    for scope in (_scope_patch(None, None),):
        with (
            patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
            patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
            patch(
                "dembrane.api.v2.feedback.get_directus_user_profile",
                new=AsyncMock(return_value=_PROFILE),
            ),
            patch("dembrane.api.v2.feedback.async_directus", new=directus),
            scope,
        ):
            async with _client(_build_app()) as c:
                resp = await c.post(
                    "/v2/feedback/reports",
                    data=_form(workspace_id="w-9", project_id="p-9"),
                )
        # A scope the caller cannot reach costs the ids, never the report.
        assert resp.status_code == 201
        row = _created_row(directus)
        assert row["workspace_id"] is None
        assert row["project_id"] is None


async def test_no_attachments_omits_attachment_block():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post("/v2/feedback/reports", data=_form())
    assert resp.status_code == 201
    assert resp.json()["attachment_count"] == 0
    assert "Attachments:" not in _created_row(directus)["message"]


async def test_untrusted_replay_url_is_dropped():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post(
                "/v2/feedback/reports",
                data=_form(session_replay_url="https://evilposthog.com/replay/1"),
            )
    assert resp.status_code == 201
    assert "Session replay" not in _created_row(directus)["message"]


async def test_non_http_page_url_is_dropped():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post(
                "/v2/feedback/reports",
                data=_form(page_url="javascript:alert(1)"),
            )
    assert resp.status_code == 201
    page_context = _created_row(directus)["page_context"]
    assert "Page:" not in page_context
    assert "Locale: en-US" in page_context


async def test_rejects_wrong_mime():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post(
                "/v2/feedback/reports",
                data=_form(),
                files=[("attachments", ("a.pdf", io.BytesIO(b"x"), "application/pdf"))],
            )
    assert resp.status_code == 400
    assert directus.create_item.call_count == 0


async def test_rejects_too_many_files():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post(
                "/v2/feedback/reports",
                data=_form(),
                files=[_png(f"s{i}.png") for i in range(5)],
            )
    assert resp.status_code == 400


async def test_rejects_empty_message():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post("/v2/feedback/reports", data=_form(message="  "))
    assert resp.status_code == 400


async def test_rejects_oversize_message():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post("/v2/feedback/reports", data=_form(message="x" * 5001))
    assert resp.status_code == 400
    assert directus.create_item.call_count == 0


async def test_directus_failure_cleans_up_s3_and_returns_502():
    settings, directus = _patches(create_side_effect=RuntimeError("directus down"))
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.save_to_s3_from_file_like"),
        patch("dembrane.api.v2.feedback.delete_from_s3") as delete_mock,
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post("/v2/feedback/reports", data=_form(), files=[_png()])
    assert resp.status_code == 502
    assert delete_mock.call_count == 1


async def test_filename_with_spaces_is_allow_listed():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.save_to_s3_from_file_like") as save_mock,
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post(
                "/v2/feedback/reports",
                data=_form(),
                files=[_png("Screenshot 2026-08-24 at 10#11%2F.png")],
            )
    assert resp.status_code == 201
    report_id = resp.json()["report_id"]
    key = save_mock.call_args.args[1]
    assert key == f"feedback/{report_id}/0-Screenshot_2026-08-24_at_10_11_2F.png"
    link = f"https://api.example.com/api/v2/feedback/attachments/{report_id}/0-Screenshot_2026-08-24_at_10_11_2F.png"
    assert f"staff link, no expiry: {link}" in _created_row(directus)["message"]
    assert "- https://s3.example.com/signed-preview" in _created_row(directus)["message"]


async def test_dot_runs_are_collapsed_not_rejected():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.save_to_s3_from_file_like") as save_mock,
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post("/v2/feedback/reports", data=_form(), files=[_png("a..b.png")])
    assert resp.status_code == 201
    report_id = resp.json()["report_id"]
    assert save_mock.call_args.args[1] == f"feedback/{report_id}/0-a.b.png"


def test_safe_filename_collapses_and_falls_back():
    assert _safe_filename("a..b.png") == "a.b.png"
    assert _safe_filename("...") == "image"
    assert _safe_filename(None) == "image"


def test_attachment_link_base_tolerates_trailing_api():
    for configured in (
        "https://api.example.com",
        "https://api.example.com/api",
        "https://api.example.com/api/",
    ):
        assert _attachment_link_base(configured) == "https://api.example.com"


async def test_attachment_link_has_one_api_segment_either_way():
    for configured in ("https://api.example.com", "https://api.example.com/api"):
        settings, directus = _patches()
        settings.urls.api_base_url = configured
        with (
            patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
            patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
            patch(
                "dembrane.api.v2.feedback.get_directus_user_profile",
                new=AsyncMock(return_value=_PROFILE),
            ),
            patch("dembrane.api.v2.feedback.save_to_s3_from_file_like"),
            patch("dembrane.api.v2.feedback.async_directus", new=directus),
        ):
            async with _client(_build_app()) as c:
                resp = await c.post("/v2/feedback/reports", data=_form(), files=[_png()])
        assert resp.status_code == 201
        report_id = resp.json()["report_id"]
        link = f"https://api.example.com/api/v2/feedback/attachments/{report_id}/0-shot.png"
        message = _created_row(directus)["message"]
        assert f"staff link, no expiry: {link}" in message
        assert "- https://s3.example.com/signed-preview" in message
        assert message.count("/api/v2/") == 1


async def test_upload_carries_the_validated_content_type():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.save_to_s3_from_file_like") as save_mock,
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post("/v2/feedback/reports", data=_form(), files=[_png()])
    assert resp.status_code == 201
    assert save_mock.call_args.kwargs["content_type"] == "image/png"


async def test_oversize_attachment_is_rejected_before_any_upload():
    settings, directus = _patches()
    oversize = 10 * 1024 * 1024 + 1
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.save_to_s3_from_file_like") as save_mock,
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post("/v2/feedback/reports", data=_form(), files=[_png(size=oversize)])
    assert resp.status_code == 400
    assert "10MB" in resp.json()["detail"]
    save_mock.assert_not_called()
    assert directus.create_item.call_count == 0


async def test_rate_limit_is_not_spent_on_an_invalid_request():
    settings, directus = _patches()
    limiter = AsyncMock()
    limiter.check = AsyncMock(side_effect=HTTPException(status_code=429, detail="Slow down."))
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=limiter),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch("dembrane.api.v2.feedback.save_to_s3_from_file_like"),
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            bad = await c.post(
                "/v2/feedback/reports",
                data=_form(),
                files=[("attachments", ("a.pdf", io.BytesIO(b"x"), "application/pdf"))],
            )
            checks_after_bad = limiter.check.call_count
            good = await c.post("/v2/feedback/reports", data=_form())
    assert bad.status_code == 400
    assert checks_after_bad == 0
    assert good.status_code == 429


async def test_unsanitizable_filename_returns_400_and_cleans_up():
    # Defense in depth: the key sanitizer still gets to veto a name.
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch(
            "dembrane.api.v2.feedback.get_sanitized_s3_key",
            side_effect=["0-ok.png", ValueError("path traversal detected")],
        ),
        patch("dembrane.api.v2.feedback.save_to_s3_from_file_like"),
        patch("dembrane.api.v2.feedback.delete_from_s3") as delete_mock,
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            resp = await c.post(
                "/v2/feedback/reports",
                data=_form(),
                files=[_png("ok.png"), _png("shot.png")],
            )
    assert resp.status_code == 400
    assert delete_mock.call_count == 1
    assert directus.create_item.call_count == 0


async def test_unexpected_upload_error_cleans_up_earlier_object():
    settings, directus = _patches()
    with (
        patch("dembrane.api.v2.feedback.get_settings", return_value=settings),
        patch("dembrane.api.v2.feedback._RATE_LIMITER", new=AsyncMock()),
        patch(
            "dembrane.api.v2.feedback.get_directus_user_profile",
            new=AsyncMock(return_value=_PROFILE),
        ),
        patch(
            "dembrane.api.v2.feedback.save_to_s3_from_file_like",
            side_effect=[None, RuntimeError("s3 down")],
        ),
        patch("dembrane.api.v2.feedback.delete_from_s3") as delete_mock,
        patch("dembrane.api.v2.feedback.async_directus", new=directus),
    ):
        async with _client(_build_app()) as c:
            with pytest.raises(RuntimeError):
                await c.post(
                    "/v2/feedback/reports",
                    data=_form(),
                    files=[_png("a.png"), _png("b.png")],
                )
    assert delete_mock.call_count == 1
    assert directus.create_item.call_count == 0


# ─── Scope resolution ─────────────────────────────────────────────────────────


async def test_scope_derives_workspace_from_the_project_row():
    # The client's workspace_id is ignored; the project row is authoritative.
    access = MagicMock(workspace_id="w-real")
    with patch(
        "dembrane.api.v2.feedback.resolve_project_access",
        new=AsyncMock(return_value=access),
    ):
        assert await _resolve_report_scope("w-spoofed", "p-1", _SESSION) == ("w-real", "p-1")


async def test_scope_dropped_when_project_access_raises():
    with patch(
        "dembrane.api.v2.feedback.resolve_project_access",
        new=AsyncMock(side_effect=HTTPException(status_code=404, detail="Project not found")),
    ):
        assert await _resolve_report_scope("w-1", "p-1", _SESSION) == (None, None)


async def test_workspace_only_scope_needs_membership():
    app_user = AsyncMock(return_value={"id": "au-1"})
    with (
        patch("dembrane.api.v2.feedback.get_app_user_or_raise", new=app_user),
        patch(
            "dembrane.api.v2.feedback.user_can_access",
            new=AsyncMock(return_value=("admin", "direct")),
        ),
    ):
        assert await _resolve_report_scope("w-1", None, _SESSION) == ("w-1", None)
    with (
        patch("dembrane.api.v2.feedback.get_app_user_or_raise", new=app_user),
        patch("dembrane.api.v2.feedback.user_can_access", new=AsyncMock(return_value=None)),
    ):
        assert await _resolve_report_scope("w-1", None, _SESSION) == (None, None)


async def test_scope_ignores_oversized_ids():
    assert await _resolve_report_scope("w" * 256, "p" * 256, _SESSION) == (None, None)
