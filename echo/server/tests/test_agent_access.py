"""Agent access: OAuth provider rules, the per-call context checks, and the
REST surface. Storage is faked in memory so no Directus or Redis is needed;
the end-to-end flow against a real stack lives outside the unit suite."""

from __future__ import annotations

import time
from typing import Any
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, HTTPException
from pydantic import AnyUrl
from mcp.shared.auth import OAuthClientInformationFull
from mcp.server.auth.provider import TokenError, AuthorizationParams

from dembrane.agent_access import SCOPE_READ, SCOPE_WRITE, FREE_TIER_MONTHLY_CALLS, oauth, store
from dembrane.api.dependency_auth import DirectusSession
from dembrane.agent_access.context import AgentContext

_ORG = "org-1"
_USER = "app-user-1"
_DIRECTUS_USER = "directus-user-1"


# ── in-memory store ────────────────────────────────────────────────────────


class FakeStore:
    """Enough of `store` to run the provider and the context checks."""

    def __init__(self) -> None:
        self.redis: dict[str, dict[str, Any]] = {}
        self.grants: dict[str, dict[str, Any]] = {}
        self.tokens: list[dict[str, Any]] = []
        self.clients: dict[str, dict[str, Any]] = {}
        self.audit: list[dict[str, Any]] = []
        self.usage: dict[str, int] = {}

    async def redis_put(self, key: str, value: dict[str, Any], ttl: int) -> None:
        self.redis[key] = value

    async def redis_get(self, key: str) -> dict[str, Any] | None:
        return self.redis.get(key)

    async def redis_take(self, key: str) -> dict[str, Any] | None:
        return self.redis.pop(key, None)

    async def redis_delete(self, key: str) -> None:
        self.redis.pop(key, None)

    async def get_client_row(self, client_id: str) -> dict[str, Any] | None:
        return self.clients.get(client_id)

    async def create_client_row(self, **kw: Any) -> None:
        self.clients[kw["client_id"]] = {
            "id": kw["client_id"],
            "client_secret_encrypted": store.encrypt_secret(kw["client_secret"])
            if kw["client_secret"]
            else None,
            "metadata": kw["metadata"],
        }

    async def touch_client(self, client_id: str) -> None:
        pass

    async def create_grant(self, **kw: Any) -> dict[str, Any]:
        row = {
            "id": f"grant-{len(self.grants) + 1}",
            "revoked_at": None,
            "last_used_at": None,
            **kw,
        }
        row["expires_at"] = kw["expires_at"].isoformat()
        self.grants[row["id"]] = row
        return row

    async def get_grant(self, grant_id: str) -> dict[str, Any] | None:
        return self.grants.get(grant_id)

    async def touch_grant(self, grant_id: str) -> None:
        pass

    async def mint_token_pair(self, grant_id: str) -> tuple[str, str, datetime]:
        now = datetime.now(timezone.utc)
        pair = f"pair-{len(self.tokens)}"
        a, r = store.mint_token("dbr_at_"), store.mint_token("dbr_rt_")
        for kind, raw, ttl in (("access", a, 3600), ("refresh", r, 86400)):
            self.tokens.append(
                {
                    "id": f"tok-{len(self.tokens)}",
                    "grant_id": grant_id,
                    "kind": kind,
                    "token_hash": store.hash_token(raw),
                    "pair_id": pair,
                    "expires_at": (now + timedelta(seconds=ttl)).isoformat(),
                    "revoked_at": None,
                }
            )
        return a, r, now + timedelta(seconds=3600)

    async def find_token(self, raw: str, kind: str) -> dict[str, Any] | None:
        h = store.hash_token(raw)
        for t in self.tokens:
            if t["token_hash"] == h and t["kind"] == kind and not t["revoked_at"]:
                return t
        return None

    async def revoke_pair(self, pair_id: str) -> None:
        for t in self.tokens:
            if t["pair_id"] == pair_id:
                t["revoked_at"] = "now"

    async def revoke_grant(self, grant_id: str) -> None:
        self.grants[grant_id]["revoked_at"] = "now"
        for t in self.tokens:
            if t["grant_id"] == grant_id:
                t["revoked_at"] = "now"

    async def usage_increment(self, org_id: str, month: str) -> int:
        self.usage[org_id] = self.usage.get(org_id, 0) + 1
        return self.usage[org_id]

    async def usage_get(self, org_id: str, month: str) -> int:
        return self.usage.get(org_id, 0)

    async def write_audit_event(self, **kw: Any) -> None:
        self.audit.append(kw)


@pytest.fixture
def fake() -> Any:
    fs = FakeStore()
    names = [n for n in dir(fs) if not n.startswith("_") and callable(getattr(fs, n))]
    with patch.multiple(store, **{n: getattr(fs, n) for n in names if hasattr(store, n)}):
        yield fs


def _client(client_id: str = "client-1", secret: str | None = None) -> OAuthClientInformationFull:
    return OAuthClientInformationFull(
        client_id=client_id,
        client_secret=secret,
        client_name="Test agent",
        redirect_uris=[AnyUrl("http://localhost:9999/cb")],
        token_endpoint_auth_method="none" if secret is None else "client_secret_post",
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
        scope="read write",
    )


async def _consent(fake: FakeStore, provider: oauth.AgentOAuthProvider, scopes: list[str]) -> str:
    """Run authorize + approve, return the auth code."""
    url = await provider.authorize(
        _client(),
        AuthorizationParams(
            state="s",
            scopes=scopes,
            code_challenge="chal",
            redirect_uri=AnyUrl("http://localhost:9999/cb"),
            redirect_uri_provided_explicitly=True,
        ),
    )
    request_id = url.split("request=")[1]
    redirect = await oauth.approve_authorize_request(
        request_id=request_id,
        app_user_id=_USER,
        directus_user_id=_DIRECTUS_USER,
        org_ids=[_ORG],
        scopes=scopes,
        expires_in_days=30,
        consent_version="test",
    )
    assert redirect.startswith("http://localhost:9999/cb?code=")
    assert "state=s" in redirect
    return redirect.split("code=")[1].split("&")[0]


# ── provider ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_authorize_parks_request_and_redirects_to_consent(fake: FakeStore) -> None:
    provider = oauth.AgentOAuthProvider()
    url = await provider.authorize(
        _client(),
        AuthorizationParams(
            state="s",
            scopes=[SCOPE_READ],
            code_challenge="chal",
            redirect_uri=AnyUrl("http://localhost:9999/cb"),
            redirect_uri_provided_explicitly=True,
        ),
    )
    assert oauth.CONSENT_PATH in url
    request_id = url.split("request=")[1]
    assert fake.redis[f"authz:{request_id}"]["client_id"] == "client-1"


@pytest.mark.asyncio
async def test_code_is_single_use_and_grant_scopes_are_capped(fake: FakeStore) -> None:
    provider = oauth.AgentOAuthProvider()
    code = await _consent(fake, provider, [SCOPE_READ])
    loaded = await provider.load_authorization_code(_client(), code)
    assert loaded is not None and loaded.scopes == [SCOPE_READ]
    tokens = await provider.exchange_authorization_code(_client(), loaded)
    assert tokens.access_token.startswith("dbr_at_") and tokens.scope == SCOPE_READ
    with pytest.raises(TokenError):
        await provider.exchange_authorization_code(_client(), loaded)


@pytest.mark.asyncio
async def test_code_for_another_client_is_invisible(fake: FakeStore) -> None:
    provider = oauth.AgentOAuthProvider()
    code = await _consent(fake, provider, [SCOPE_READ])
    assert await provider.load_authorization_code(_client("client-2"), code) is None


@pytest.mark.asyncio
async def test_refresh_rotates_and_kills_the_old_pair(fake: FakeStore) -> None:
    provider = oauth.AgentOAuthProvider()
    code = await _consent(fake, provider, [SCOPE_READ, SCOPE_WRITE])
    first = await provider.exchange_authorization_code(
        _client(),
        await provider.load_authorization_code(_client(), code),  # type: ignore[arg-type]
    )
    refresh = await provider.load_refresh_token(_client(), first.refresh_token or "")
    assert refresh is not None
    second = await provider.exchange_refresh_token(_client(), refresh, [SCOPE_READ])
    assert second.scope == SCOPE_READ
    assert await provider.load_access_token(first.access_token) is None
    assert await provider.load_refresh_token(_client(), first.refresh_token or "") is None
    assert await provider.load_access_token(second.access_token) is not None


@pytest.mark.asyncio
async def test_refresh_cannot_widen_scope(fake: FakeStore) -> None:
    provider = oauth.AgentOAuthProvider()
    code = await _consent(fake, provider, [SCOPE_READ])
    first = await provider.exchange_authorization_code(
        _client(),
        await provider.load_authorization_code(_client(), code),  # type: ignore[arg-type]
    )
    refresh = await provider.load_refresh_token(_client(), first.refresh_token or "")
    with pytest.raises(TokenError):
        await provider.exchange_refresh_token(_client(), refresh, [SCOPE_READ, SCOPE_WRITE])  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_revoked_grant_invalidates_access_token(fake: FakeStore) -> None:
    provider = oauth.AgentOAuthProvider()
    code = await _consent(fake, provider, [SCOPE_READ])
    tokens = await provider.exchange_authorization_code(
        _client(),
        await provider.load_authorization_code(_client(), code),  # type: ignore[arg-type]
    )
    assert await provider.load_access_token(tokens.access_token) is not None
    await store.revoke_grant("grant-1")
    assert await provider.load_access_token(tokens.access_token) is None


@pytest.mark.asyncio
async def test_client_secret_round_trips_encrypted(fake: FakeStore) -> None:
    provider = oauth.AgentOAuthProvider()
    await provider.register_client(_client("client-s", secret="hunter2"))
    stored = fake.clients["client-s"]["client_secret_encrypted"]
    assert stored and "hunter2" not in stored
    loaded = await provider.get_client("client-s")
    assert loaded is not None and loaded.client_secret == "hunter2"


@pytest.mark.asyncio
async def test_deny_sends_access_denied_back(fake: FakeStore) -> None:
    provider = oauth.AgentOAuthProvider()
    url = await provider.authorize(
        _client(),
        AuthorizationParams(
            state="s",
            scopes=[SCOPE_READ],
            code_challenge="chal",
            redirect_uri=AnyUrl("http://localhost:9999/cb"),
            redirect_uri_provided_explicitly=True,
        ),
    )
    redirect = await oauth.deny_authorize_request(url.split("request=")[1])
    assert "error=access_denied" in redirect and "state=s" in redirect
    with pytest.raises(ValueError):
        await oauth.deny_authorize_request("nope")


# ── context ────────────────────────────────────────────────────────────────


def _ctx(scopes: list[str] | None = None, org_ids: list[str] | None = None) -> AgentContext:
    return AgentContext(
        grant_id="grant-1",
        client_id="client-1",
        app_user_id=_USER,
        directus_user_id=_DIRECTUS_USER,
        org_ids=org_ids if org_ids is not None else [_ORG],
        scopes=scopes if scopes is not None else [SCOPE_READ],
        session=DirectusSession(user_id=_DIRECTUS_USER, is_admin=False),
    )


@pytest.mark.asyncio
async def test_require_org_hides_orgs_outside_the_grant(fake: FakeStore) -> None:
    with pytest.raises(HTTPException) as exc:
        await _ctx().require_org("other-org")
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_require_org_blocks_when_admin_switched_off(fake: FakeStore) -> None:
    with patch(
        "dembrane.agent_access.context.org_agent_access_enabled", new=AsyncMock(return_value=False)
    ):
        with pytest.raises(HTTPException) as exc:
            await _ctx().require_org(_ORG)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_free_org_hits_monthly_budget(fake: FakeStore) -> None:
    ctx = _ctx()
    fake.usage[_ORG] = FREE_TIER_MONTHLY_CALLS
    with patch("dembrane.agent_access.context.org_is_paid", new=AsyncMock(return_value=False)):
        with pytest.raises(HTTPException) as exc:
            await ctx.charge(_ORG)
    assert exc.value.status_code == 429


@pytest.mark.asyncio
async def test_paid_org_is_not_counted(fake: FakeStore) -> None:
    with patch("dembrane.agent_access.context.org_is_paid", new=AsyncMock(return_value=True)):
        await _ctx().charge(_ORG)
    assert fake.usage == {}


@pytest.mark.asyncio
async def test_record_writes_audit_with_touched_org(fake: FakeStore) -> None:
    ctx = _ctx()
    with patch(
        "dembrane.agent_access.context.org_agent_access_enabled", new=AsyncMock(return_value=True)
    ):
        await ctx.require_org(_ORG)
    await ctx.record("get_project", {"project_id": "p1"}, org_id=None, status="ok")
    assert fake.audit[-1]["org_id"] == _ORG and fake.audit[-1]["tool"] == "get_project"


def test_write_scope_required_for_update() -> None:
    with pytest.raises(HTTPException) as exc:
        _ctx([SCOPE_READ]).require_write()
    assert exc.value.status_code == 403


# ── REST surface ───────────────────────────────────────────────────────────


def _rest_app(ctx: AgentContext) -> FastAPI:
    from dembrane.api.v2.agent import router, require_agent

    app = FastAPI()

    async def _fake() -> AgentContext:
        return ctx

    app.dependency_overrides[require_agent] = _fake
    app.include_router(router, prefix="/v2/agent")
    return app


@pytest.mark.asyncio
async def test_rest_whoami_and_audit(fake: FakeStore) -> None:
    app = _rest_app(_ctx())
    with patch("dembrane.agent_access.tools.async_directus") as directus:
        directus.get_item = AsyncMock(return_value={"email": "a@b.c", "display_name": "A"})
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
            r = await ac.get("/v2/agent/whoami")
    assert r.status_code == 200 and r.json()["email"] == "a@b.c"
    assert fake.audit[-1]["tool"] == "whoami" and fake.audit[-1]["status"] == "ok"


@pytest.mark.asyncio
async def test_rest_batch_is_capped_at_50(fake: FakeStore) -> None:
    app = _rest_app(_ctx())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
        r = await ac.post("/v2/agent/conversations/batch", json={"ids": ["x"] * 51})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_rest_update_without_write_scope_is_denied_and_audited(fake: FakeStore) -> None:
    app = _rest_app(_ctx([SCOPE_READ]))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
        r = await ac.patch("/v2/agent/projects/p1", json={"name": "x"})
    assert r.status_code == 403
    assert fake.audit[-1]["tool"] == "update_project" and fake.audit[-1]["status"] == "denied"


@pytest.mark.asyncio
async def test_rest_unauthenticated_is_401() -> None:
    from dembrane.api.v2.agent import router

    app = FastAPI()
    app.include_router(router, prefix="/v2/agent")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
        r = await ac.get("/v2/agent/whoami")
    assert r.status_code == 401


# ── consent endpoint rules ─────────────────────────────────────────────────


def _session_app() -> FastAPI:
    from dembrane.api.dependency_auth import require_directus_session
    from dembrane.api.v2.agent_access import router

    app = FastAPI()

    async def _fake() -> DirectusSession:
        return DirectusSession(user_id=_DIRECTUS_USER, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake
    app.include_router(router, prefix="/v2/agent-access")
    return app


@pytest.mark.asyncio
async def test_approve_requires_consent_and_an_enabled_org(fake: FakeStore) -> None:
    app = _session_app()
    with (
        patch(
            "dembrane.api.v2.agent_access.get_app_user_or_raise",
            new=AsyncMock(return_value={"id": _USER}),
        ),
        patch("dembrane.api.v2.agent_access._my_orgs", new=AsyncMock(return_value=[])),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
            r1 = await ac.post(
                "/v2/agent-access/authorize-requests/r1/approve",
                json={
                    "org_ids": [_ORG],
                    "scopes": ["read"],
                    "expires_in_days": 90,
                    "consent_accepted": False,
                },
            )
            r2 = await ac.post(
                "/v2/agent-access/authorize-requests/r1/approve",
                json={
                    "org_ids": [_ORG],
                    "scopes": ["read"],
                    "expires_in_days": 90,
                    "consent_accepted": True,
                },
            )
            r3 = await ac.post(
                "/v2/agent-access/authorize-requests/r1/approve",
                json={
                    "org_ids": [_ORG],
                    "scopes": ["read"],
                    "expires_in_days": 7,
                    "consent_accepted": True,
                },
            )
    assert r1.status_code == 400 and "notice" in r1.json()["detail"]
    assert r2.status_code == 400 and "organisation" in r2.json()["detail"]
    assert r3.status_code == 400 and "expiry" in r3.json()["detail"].lower()


def test_grant_liveness() -> None:
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    assert store.grant_is_live({"expires_at": future, "revoked_at": None})
    assert not store.grant_is_live({"expires_at": past, "revoked_at": None})
    assert not store.grant_is_live({"expires_at": future, "revoked_at": "x"})
    assert time.time() > 0


# ── guests: workspace-only members reach their org through the workspace ───


@pytest.mark.asyncio
async def test_guest_org_ids_follow_live_direct_workspace_memberships() -> None:
    from dembrane.agent_access.context import guest_org_ids

    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    rows = [
        {"workspace_id": {"org_id": "org-a", "deleted_at": None}, "expires_at": None},
        {"workspace_id": {"org_id": "org-a", "deleted_at": None}, "expires_at": future},
        {"workspace_id": {"org_id": "org-b", "deleted_at": "x"}, "expires_at": None},
        {"workspace_id": {"org_id": "org-c", "deleted_at": None}, "expires_at": past},
        {"workspace_id": "bare-id", "expires_at": None},
    ]
    with patch("dembrane.agent_access.context.async_directus") as directus:
        directus.get_items = AsyncMock(return_value=rows)
        assert await guest_org_ids(_USER) == ["org-a"]


@pytest.mark.asyncio
async def test_consent_lists_guest_orgs_with_guest_role(fake: FakeStore) -> None:
    from dembrane.api.v2 import agent_access as mod

    with (
        patch.object(mod.async_directus, "get_items", new=AsyncMock(return_value=[])),
        patch.object(mod, "guest_org_ids", new=AsyncMock(return_value=["org-g"])),
    ):
        memberships = await mod._my_org_memberships(_USER)
    assert memberships == [{"org_id": "org-g", "role": "guest"}]
