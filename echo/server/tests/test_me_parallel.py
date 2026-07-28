"""get_me: same response, independent lookups extracted and gathered."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.v2 import me as me_mod


@pytest.mark.asyncio
async def test_get_me_uses_helpers_and_returns_same_shape():
    app_user = {"id": "au-1", "email": "a@x.com", "display_name": "A",
                "onboarding_answer_json": None, "settings": {}}
    profile = {"email": "a@x.com", "display_name": "A", "avatar": None}
    with (
        patch.object(me_mod, "resolve_app_user", new=AsyncMock(return_value=app_user)),
        patch.object(me_mod, "get_directus_user_profile", new=AsyncMock(return_value=profile)),
        patch.object(me_mod, "_has_pending_invites", new=AsyncMock(return_value=True)),
        patch.object(me_mod, "_has_legacy_projects", new=AsyncMock(return_value=False)),
        patch.object(me_mod, "_org_summaries", new=AsyncMock(return_value=[])),
        patch.object(
            me_mod,
            "_training_bits",
            new=AsyncMock(return_value=(me_mod.TrainingStatus(), False)),
        ),
    ):
        res = await me_mod.get_me(type("A", (), {"user_id": "du-1", "is_admin": False})())
    assert res.onboarding_completed is True
    assert res.has_pending_invites is True
    assert res.email == "a@x.com"


@pytest.mark.asyncio
async def test_pending_invites_org_fallback_only_when_no_ws_invite():
    calls = []

    async def _impl(collection, payload):
        calls.append(collection)
        return [{"id": "i1"}] if collection == "workspace_invite" else []

    with patch.object(me_mod.async_directus, "get_items", new=AsyncMock(side_effect=_impl)):
        assert await me_mod._has_pending_invites("a@x.com") is True
    assert calls == ["workspace_invite"]  # org_invite skipped on a ws hit
