"""Agent access: OAuth provider rules, the per-call context checks, and the
REST surface. Storage is faked in memory so no Directus or Redis is needed;
the end-to-end flow against a real stack lives outside the unit suite."""

from __future__ import annotations

import json
import time
from typing import Any
from pathlib import Path
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

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
        client_name="Test agent",
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
        directus.get_items = AsyncMock(return_value=[])
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
            r = await ac.get("/v2/agent/whoami")
    assert r.status_code == 200 and r.json()["email"] == "a@b.c"
    assert r.json()["organisations"] == [] and r.json()["build_version"]
    assert fake.audit[-1]["tool"] == "dembrane_whoami" and fake.audit[-1]["status"] == "ok"
    assert fake.usage == {}


@pytest.mark.asyncio
async def test_removed_rest_routes_are_gone(fake: FakeStore) -> None:
    app = _rest_app(_ctx())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
        batch = await ac.post("/v2/agent/conversations/batch", json={"ids": ["x"]})
        orgs = await ac.get("/v2/agent/organisations")
        docs = await ac.get("/v2/agent/docs")
    # /conversations/batch now falls into GET /conversations/{conversation_id}: no POST there.
    assert batch.status_code == 405
    assert orgs.status_code == 404 and docs.status_code == 404


@pytest.mark.asyncio
async def test_rest_update_without_write_scope_is_denied_and_audited(fake: FakeStore) -> None:
    app = _rest_app(_ctx([SCOPE_READ]))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
        r = await ac.patch("/v2/agent/projects/p1", json={"name": "x"})
    assert r.status_code == 403
    assert fake.audit[-1]["tool"] == "dembrane_update_project"
    assert fake.audit[-1]["status"] == "denied"


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


@pytest.mark.parametrize(
    ("base", "expected"),
    [
        ("http://localhost:8000", "http://localhost:8000/api/mcp"),
        ("https://api.echo-next.dembrane.com/api", "https://api.echo-next.dembrane.com/api/mcp"),
        ("https://api.dembrane.com/api/", "https://api.dembrane.com/api/mcp"),
    ],
)
def test_issuer_url_never_doubles_the_api_prefix(base: str, expected: str) -> None:
    settings = MagicMock()
    settings.urls.api_base_url = base
    with patch("dembrane.agent_access.oauth.get_settings", return_value=settings):
        assert oauth.issuer_url() == expected


# ── reporting back ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_report_issue_files_a_support_request_with_agent_source(fake: FakeStore) -> None:
    from dembrane import support_requests
    from dembrane.agent_access import tools as T

    access = MagicMock(workspace_id="ws-1", project_id="p1")
    with (
        patch.object(
            support_requests.async_directus,
            "create_item",
            new=AsyncMock(return_value={"data": {"id": "sr-1"}}),
        ) as create,
        patch(
            "dembrane.agent_access.tools._project_access",
            new=AsyncMock(return_value=(access, _ORG)),
        ),
    ):
        out = await T.report_issue(
            _ctx(), "Transcript of table 3 is empty", project_id="p1", conversation_id="c9"
        )
    assert out.id == "sr-1" and out.kind == "issue"
    collection, row = create.call_args.args
    assert (
        collection == "support_request" and row["source"] == "agent_mcp" and row["status"] == "new"
    )
    assert (
        row["project_id"] == "p1" and row["workspace_id"] == "ws-1" and row["app_user_id"] == _USER
    )
    assert row["message"].startswith("[Test agent via MCP] Transcript of table 3 is empty")
    ctx_json = json.loads(row["page_context"])
    assert (
        ctx_json["kind"] == "issue"
        and ctx_json["conversation_id"] == "c9"
        and ctx_json["grant_id"] == "grant-1"
    )


@pytest.mark.asyncio
async def test_request_tool_files_a_capability_gap_insight(fake: FakeStore) -> None:
    from dembrane import agent_insights
    from dembrane.agent_access import tools as T

    with patch.object(
        agent_insights.async_directus,
        "create_item",
        new=AsyncMock(return_value={"data": {"id": "in-2"}}),
    ) as create:
        out = await T.request_tool(
            _ctx(),
            "search_transcripts",
            "Find what a participant said about a topic",
            example="search_transcripts(project_id, 'Popcorn')",
        )
    assert out.kind == "tool_request" and out.id == "in-2"
    collection, row = create.call_args.args
    assert (
        collection == "agent_insight"
        and row["source"] == "agent_mcp"
        and row["kind"] == "capability_gap"
    )
    assert row["suggested_capability"] == "search_transcripts" and row["project_id"] is None
    assert (
        row["content"].startswith("[Test agent via MCP] Find what") and "Example:" in row["content"]
    )


@pytest.mark.asyncio
async def test_shared_writers_stamp_the_source() -> None:
    from dembrane import agent_insights, support_requests

    with patch.object(
        support_requests.async_directus,
        "create_item",
        new=AsyncMock(return_value={"data": {"id": "a"}}),
    ) as c1:
        await support_requests.file_support_request(
            source=support_requests.SOURCE_DASHBOARD, message="m", page_context={"k": 1}
        )
    row = c1.call_args.args[1]
    assert (
        row["source"] == "dashboard"
        and json.loads(row["page_context"]) == {"k": 1}
        and row["status"] == "new"
    )
    with patch.object(
        agent_insights.async_directus,
        "create_item",
        new=AsyncMock(return_value={"data": {"id": "b"}}),
    ) as c2:
        await agent_insights.file_agent_insight(
            source=agent_insights.SOURCE_ASSISTANT,
            kind="wish",
            content="  x  ",
            suggested_capability=" ",
        )
    row = c2.call_args.args[1]
    assert (
        row["source"] == "assistant"
        and row["content"] == "x"
        and row["suggested_capability"] is None
    )


@pytest.mark.asyncio
async def test_unknown_tool_is_audited_and_answered_with_a_hint(fake: FakeStore) -> None:
    from mcp.server.mcpserver.exceptions import ToolError
    from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
    from mcp.server.auth.middleware.auth_context import auth_context_var

    from dembrane.agent_access.oauth import AgentAccessToken
    from dembrane.agent_access.mcp_server import server

    fake.grants["grant-1"] = {
        "id": "grant-1",
        "client_id": "client-1",
        "client_name": "Test agent",
        "app_user_id": _USER,
        "directus_user_id": _DIRECTUS_USER,
        "org_ids": [_ORG],
        "scopes": [SCOPE_READ],
        "revoked_at": None,
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
    }
    token = AgentAccessToken(
        token="t", client_id="client-1", scopes=[SCOPE_READ], grant_id="grant-1", pair_id="pair"
    )
    reset = auth_context_var.set(AuthenticatedUser(token))
    try:
        with pytest.raises(ToolError) as exc:
            await server.call_tool("grep", {"query": "Popcorn"})
    finally:
        auth_context_var.reset(reset)
    message = str(exc.value)
    assert "Unknown tool: grep" in message
    assert "dembrane_request_tool" in message and "dembrane_list_tools" in message
    assert "dembrane_search_transcripts" in message and " grep_conversation" not in message
    assert fake.audit[-1]["tool"] == "unknown_tool" and fake.audit[-1]["params"] == {
        "requested": "grep",
        "arguments": ["query"],
    }


# ── documentation ──────────────────────────────────────────────────────────


@pytest.fixture
def docs_corpus() -> Any:
    data = {
        "users/host/index.md": "# For hosts\n\nCreate projects.\nRead transcripts here.\n",
        "users/participant/index.md": "# For participants\n\nSomeone invited you.\nYour transcript is yours.\n",
    }
    with patch("dembrane.knowledge.corpus", new=AsyncMock(return_value=data)):
        yield data


@pytest.mark.asyncio
async def test_docs_list_read_and_grep_follow_the_assistant_semantics(
    docs_corpus: dict[str, str],
) -> None:
    from dembrane import knowledge

    assert await knowledge.list_docs() == [
        {"path": "users/host/index.md", "title": "For hosts"},
        {"path": "users/participant/index.md", "title": "For participants"},
    ]
    text = await knowledge.read_doc("users/host/index.md", offset=1, limit=2)
    assert text.startswith("1: # For hosts\n2: ")
    assert "call dembrane_read_doc with offset=3" in text
    assert (await knowledge.read_doc("nope.md")).startswith("Not found: nope.md")
    hits = await knowledge.grep_docs("transcript", max_results=10)
    assert [(h["path"], h["line"]) for h in hits] == [
        ("users/host/index.md", 4),
        ("users/participant/index.md", 4),
    ]
    assert await knowledge.grep_docs("[unclosed", max_results=10) == []


def test_disk_corpus_skips_authoring_and_translation_twins(tmp_path: Path) -> None:
    from dembrane import knowledge

    (tmp_path / "a.md").write_text("# A", encoding="utf-8")
    (tmp_path / "a.nl-NL.md").write_text("# A nl", encoding="utf-8")
    (tmp_path / "_authoring").mkdir()
    (tmp_path / "_authoring" / "notes.md").write_text("# notes", encoding="utf-8")
    assert list(knowledge._disk_corpus(tmp_path)) == ["a.md"]


@pytest.mark.asyncio
async def test_docs_tools_are_audited_and_need_no_org(
    fake: FakeStore, docs_corpus: dict[str, str]
) -> None:
    app = _rest_app(_ctx(org_ids=[]))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
        r = await ac.get("/v2/agent/docs/search", params={"pattern": "invited"})
        index = await ac.get("/v2/agent/docs/search")
    assert r.status_code == 200 and r.json()["pattern"] == "invited"
    hit = r.json()["results"][0]
    assert hit == {
        "path": "users/participant/index.md",
        "title": "For participants",
        "line": 3,
        "text": "Someone invited you.",
    }
    assert fake.audit[-1]["tool"] == "dembrane_search_docs" and fake.audit[-1]["status"] == "ok"
    # No pattern: the page index, titles included, nothing line-numbered.
    assert index.status_code == 200 and index.json()["pattern"] is None
    assert [(p["path"], p["title"], p["line"]) for p in index.json()["results"]] == [
        ("users/host/index.md", "For hosts", None),
        ("users/participant/index.md", "For participants", None),
    ]
    assert fake.usage == {}


# ── shared read primitives behind the tools ────────────────────────────────


def _chunk_row(conv_id: str, text: str, *, over_cap: bool = False) -> dict[str, Any]:
    return {
        "id": f"{conv_id}-k1",
        "timestamp": "2026-09-01T10:00:00Z",
        "transcript": text,
        "conversation_id": {
            "id": conv_id,
            "project_id": "p1",
            "participant_name": f"Table {conv_id}",
            "summary": "a summary",
            "is_finished": True,
            "is_all_chunks_transcribed": True,
            "is_over_cap": over_cap,
            "created_at": "2026-09-01T09:00:00Z",
        },
    }


@pytest.mark.asyncio
async def test_search_transcripts_returns_snippets_and_keeps_locked_text_out(
    fake: FakeStore,
) -> None:
    """Through REST: the org check and one free-tier charge happen before the
    read, the audit row lands, and a locked conversation is a hit without text."""
    access = MagicMock(workspace_id="ws-1", tier="free", org_id=_ORG, project_id="p1")
    rows = [
        _chunk_row("open", "the membership fee doubles next year"),
        _chunk_row("locked", "membership secrets", over_cap=True),
    ]
    app = _rest_app(_ctx())
    with (
        patch(
            "dembrane.agent_access.tools.resolve_project_access", new=AsyncMock(return_value=access)
        ),
        patch(
            "dembrane.agent_access.context.org_agent_access_enabled",
            new=AsyncMock(return_value=True),
        ),
        patch("dembrane.agent_access.context.org_is_paid", new=AsyncMock(return_value=False)),
        patch(
            "dembrane.toolkit.conversations.workspace_over_cap_active",
            new=AsyncMock(return_value=False),
        ),
        patch("dembrane.toolkit.conversations.async_directus") as directus,
    ):
        directus.get_items = AsyncMock(return_value=rows)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
            r = await ac.get("/v2/agent/projects/p1/search", params={"query": "membership fee"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tokens"] == ["membership"] and body["has_more"] is False
    open_hit, locked_hit = body["conversations"]
    assert open_hit["id"] == "open" and open_hit["locked"] is False
    assert open_hit["matches"][0]["chunk_id"] == "open-k1"
    assert "membership fee" in open_hit["matches"][0]["snippet"]
    assert locked_hit["locked"] is True and locked_hit["matches"] == []
    assert locked_hit["summary"] is None
    assert fake.usage == {_ORG: 1}
    assert fake.audit[-1]["tool"] == "dembrane_search_transcripts"
    assert fake.audit[-1]["status"] == "ok" and fake.audit[-1]["org_id"] == _ORG


@pytest.mark.asyncio
async def test_read_transcript_pages_and_marks_has_more(fake: FakeStore) -> None:
    from dembrane.agent_access import tools as T

    access = MagicMock(workspace_id="ws-1", tier=None, org_id=_ORG, project_id="p1")
    conv = {"id": "c1", "project_id": "p1", "is_finished": True, "is_over_cap": False}
    chunks = [{"id": f"k{i}", "timestamp": f"t{i}", "transcript": f"text {i}"} for i in range(5)]

    async def _get_items(collection: str, params: dict[str, Any]) -> Any:
        query = params["query"]
        if "aggregate" in query:
            return [{"count": {"id": "5"}}]
        return chunks[query["offset"] : query["offset"] + query["limit"]]

    with (
        patch(
            "dembrane.agent_access.tools.resolve_conversation_access",
            new=AsyncMock(return_value=(access, conv)),
        ),
        patch(
            "dembrane.agent_access.context.org_agent_access_enabled",
            new=AsyncMock(return_value=True),
        ),
        patch("dembrane.agent_access.context.org_is_paid", new=AsyncMock(return_value=False)),
        patch(
            "dembrane.toolkit.conversations.workspace_over_cap_active",
            new=AsyncMock(return_value=False),
        ),
        patch("dembrane.toolkit.conversations.async_directus") as directus,
    ):
        directus.get_items = AsyncMock(side_effect=_get_items)
        page = await T.read_transcript(_ctx(), "c1", offset=2, limit=2)
        last = await T.read_transcript(_ctx(), "c1", offset=4, limit=2, format="detailed")

    # Concise chunks carry timestamp and text only; detailed adds the chunk id.
    assert [c.model_dump() for c in page.chunks] == [
        {"timestamp": "t2", "transcript": "text 2"},
        {"timestamp": "t3", "transcript": "text 3"},
    ]
    assert page.format == "concise" and page.total == 5 and page.has_more is True
    assert page.transcript_locked is False
    assert [c.model_dump() for c in last.chunks] == [
        {"id": "k4", "timestamp": "t4", "transcript": "text 4"}
    ]
    assert last.format == "detailed" and last.has_more is False
    assert fake.usage == {_ORG: 2}


@pytest.mark.asyncio
async def test_find_projects_filters_to_the_grants_orgs_and_charges_nothing(
    fake: FakeStore,
) -> None:
    from dembrane.agent_access import tools as T
    from dembrane.toolkit.projects import ProjectHit

    hits = [
        ProjectHit(
            id="p1",
            name="Members' strategy day",
            workspace_id="ws-1",
            workspace_name="Research",
            org_id=_ORG,
        ),
        ProjectHit(id="p2", name="Members' offsite", workspace_id="ws-9", org_id="org-other"),
        ProjectHit(id="p3", name="Members' legacy", workspace_id=None, org_id=None),
    ]
    with (
        patch("dembrane.toolkit.projects.find_projects", new=AsyncMock(return_value=hits)) as find,
        patch(
            "dembrane.agent_access.context.org_agent_access_enabled",
            new=AsyncMock(return_value=True),
        ),
        patch("dembrane.agent_access.tools.async_directus") as directus,
    ):
        directus.get_items = AsyncMock(return_value=[{"id": _ORG, "name": "Acme"}])
        out = await T.find_projects(_ctx(org_ids=[_ORG]), query="members", limit=10)
        narrowed = await T.find_projects(
            _ctx(org_ids=[_ORG]), query="members", workspace_id="ws-1", limit=10
        )
    assert out.query == "members" and out.workspace_id is None
    assert [p.model_dump() for p in out.projects] == [
        {
            "id": "p1",
            "name": "Members' strategy day",
            "workspace_id": "ws-1",
            "workspace_name": "Research",
            "organisation_id": _ORG,
            "organisation_name": "Acme",
            "updated_at": None,
        }
    ]
    assert find.call_args_list[0].args == ("members",)
    assert find.call_args_list[0].kwargs["limit"] == 10
    assert find.call_args_list[0].kwargs["workspace_id"] is None
    # The workspace filter reaches the toolkit and is echoed back.
    assert find.call_args_list[1].kwargs["workspace_id"] == "ws-1"
    assert narrowed.workspace_id == "ws-1" and [p.id for p in narrowed.projects] == ["p1"]
    assert fake.usage == {}


@pytest.mark.asyncio
async def test_toolkit_find_projects_workspace_filter_narrows_to_a_reachable_one() -> None:
    from dembrane.toolkit import projects as toolkit

    with (
        patch.object(toolkit, "get_app_user_or_raise", new=AsyncMock(return_value={"id": _USER})),
        patch.object(
            toolkit, "reachable_workspace_ids", new=AsyncMock(return_value=["ws-1", "ws-2"])
        ),
        patch.object(toolkit, "_workspaces_by_id", new=AsyncMock(return_value={})),
        patch.object(toolkit, "get_user_project_access", new=AsyncMock(return_value=None)),
        patch.object(toolkit, "async_directus") as directus,
    ):
        directus.get_items = AsyncMock(return_value=[])
        session = DirectusSession(user_id=_DIRECTUS_USER, is_admin=False)
        assert await toolkit.find_projects("x", limit=5, session=session, workspace_id="ws-9") == []
        assert directus.get_items.call_count == 0
        await toolkit.find_projects("x", limit=5, session=session, workspace_id="ws-2")
    flt = directus.get_items.call_args.args[1]["query"]["filter"]
    assert json.dumps(flt).count('"ws-2"') == 1 and '"ws-1"' not in json.dumps(flt)


@pytest.mark.asyncio
async def test_list_conversations_date_bounds_land_in_the_directus_filter(
    fake: FakeStore,
) -> None:
    from dembrane.agent_access import tools as T

    access = MagicMock(workspace_id="ws-1", tier=None, org_id=_ORG, project_id="p1")
    with (
        patch(
            "dembrane.agent_access.tools._project_access",
            new=AsyncMock(return_value=(access, _ORG)),
        ),
        patch(
            "dembrane.toolkit.conversations.workspace_over_cap_active",
            new=AsyncMock(return_value=False),
        ),
        patch("dembrane.toolkit.conversations.async_directus") as directus,
    ):
        directus.get_items = AsyncMock(return_value=[])
        out = await T.list_conversations(
            _ctx(), "p1", created_after="2026-08-30", created_before="2026-09-06T00:00:00Z"
        )
        with pytest.raises(HTTPException) as exc:
            await T.list_conversations(_ctx(), "p1", created_after="last week")
    assert out.conversations == [] and out.has_more is False and out.format == "concise"
    query = directus.get_items.call_args.args[1]["query"]
    assert query["filter"]["created_at"] == {"_gte": "2026-08-30", "_lte": "2026-09-06T00:00:00Z"}
    assert query["filter"]["project_id"] == {"_eq": "p1"} and query["limit"] == 101
    assert exc.value.status_code == 400


# ── the reshaped surface ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_whoami_carries_organisations_with_their_workspaces(fake: FakeStore) -> None:
    """One call answers who, where and with what role; an organisation whose
    admin switched agent access off is named but its workspaces stay hidden."""
    from dembrane.agent_access import tools as T

    other = "org-2"

    async def _get_items(collection: str, params: dict[str, Any]) -> Any:
        flt = params["query"]["filter"]
        if collection == "org":
            return [{"id": _ORG, "name": "Acme"}, {"id": other, "name": "Beta"}]
        if collection == "org_membership":
            return [{"role": "admin"}] if flt["org_id"]["_eq"] == _ORG else []
        if collection == "workspace":
            return [{"id": "ws-1", "name": "Research", "org_id": _ORG}]
        raise AssertionError(collection)

    with (
        patch("dembrane.agent_access.tools.async_directus") as directus,
        patch("dembrane.agent_access.context.guest_org_ids", new=AsyncMock(return_value=[other])),
        patch(
            "dembrane.agent_access.context.org_agent_access_enabled",
            new=AsyncMock(side_effect=lambda org_id: org_id == _ORG),
        ),
        patch(
            "dembrane.inheritance.resolve_workspace_access",
            new=AsyncMock(return_value=("member", "direct", {})),
        ),
        patch("dembrane.billing_account.billing_from_workspace", return_value={"tier": "pro"}),
    ):
        directus.get_item = AsyncMock(return_value={"email": "a@b.c", "display_name": "A"})
        directus.get_items = AsyncMock(side_effect=_get_items)
        me = await T.whoami(_ctx(org_ids=[_ORG, other]))

    assert me.email == "a@b.c" and me.scopes == [SCOPE_READ] and me.client_name == "Test agent"
    assert isinstance(me.build_version, str) and me.build_version
    assert [o.model_dump() for o in me.organisations] == [
        {
            "id": _ORG,
            "name": "Acme",
            "role": "admin",
            "agent_access_enabled": True,
            "workspaces": [{"id": "ws-1", "name": "Research", "role": "member", "tier": "pro"}],
        },
        {
            "id": other,
            "name": "Beta",
            "role": "guest",
            "agent_access_enabled": False,
            "workspaces": [],
        },
    ]
    assert fake.usage == {}


def _conversation_row(cid: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": cid,
        "project_id": "p1",
        "title": f"Title {cid}",
        "participant_name": f"Table {cid}",
        "summary": f"Summary {cid}",
        "duration": 60.0,
        "is_finished": True,
        "is_all_chunks_transcribed": True,
        "is_over_cap": False,
        "created_at": "2026-09-01T09:00:00Z",
        "updated_at": "2026-09-01T09:30:00Z",
        **extra,
    }


@pytest.mark.asyncio
async def test_list_conversations_concise_and_detailed(fake: FakeStore) -> None:
    from dembrane.agent_access import tools as T

    access = MagicMock(workspace_id="ws-1", tier=None, org_id=_ORG, project_id="p1")
    rows = [_conversation_row("c1"), _conversation_row("c2", is_all_chunks_transcribed=False)]
    tag_rows = [{"conversation_id": "c1", "project_tag_id": {"text": "housing"}}]
    with (
        patch(
            "dembrane.agent_access.tools._project_access",
            new=AsyncMock(return_value=(access, _ORG)),
        ),
        patch(
            "dembrane.toolkit.conversations.workspace_over_cap_active",
            new=AsyncMock(return_value=False),
        ),
        patch("dembrane.toolkit.conversations.async_directus") as toolkit_directus,
        patch("dembrane.agent_access.tools.async_directus") as tools_directus,
    ):
        toolkit_directus.get_items = AsyncMock(return_value=rows)
        tools_directus.get_items = AsyncMock(return_value=tag_rows)
        concise = await T.list_conversations(_ctx(), "p1")
        detailed = await T.list_conversations(_ctx(), "p1", format="detailed", limit=1)

    assert concise.format == "concise" and concise.has_more is False
    assert [c.model_dump() for c in concise.conversations] == [
        {
            "id": "c1",
            "participant_name": "Table c1",
            "title": "Title c1",
            "created_at": "2026-09-01T09:00:00Z",
            "duration": 60.0,
            "status": "done",
        },
        {
            "id": "c2",
            "participant_name": "Table c2",
            "title": "Title c2",
            "created_at": "2026-09-01T09:00:00Z",
            "duration": 60.0,
            "status": "processing",
        },
    ]
    # Tags are read only for the detailed shape, and only for the page shown.
    assert tools_directus.get_items.call_count == 1
    assert tools_directus.get_items.call_args.args[1]["query"]["filter"] == {
        "conversation_id": {"_in": ["c1"]}
    }
    assert detailed.format == "detailed" and detailed.has_more is True
    assert [c.model_dump() for c in detailed.conversations] == [
        {
            "id": "c1",
            "participant_name": "Table c1",
            "title": "Title c1",
            "created_at": "2026-09-01T09:00:00Z",
            "duration": 60.0,
            "status": "done",
            "locked": False,
            "summary": "Summary c1",
            "tags": ["housing"],
        }
    ]


@pytest.mark.asyncio
async def test_get_conversation_is_metadata_only(fake: FakeStore) -> None:
    from dembrane.agent_access import tools as T

    access = MagicMock(workspace_id="ws-1", tier=None, org_id=_ORG, project_id="p1")

    async def _get_items(collection: str, params: dict[str, Any]) -> Any:
        if collection == "conversation_chunk":
            assert "aggregate" in params["query"], "only a count, never the chunks"
            return [{"count": {"id": "7"}}]
        return [{"conversation_id": "c1", "project_tag_id": {"text": "housing"}}]

    with (
        patch(
            "dembrane.agent_access.tools.resolve_conversation_access",
            new=AsyncMock(return_value=(access, _conversation_row("c1"))),
        ),
        patch(
            "dembrane.agent_access.context.org_agent_access_enabled",
            new=AsyncMock(return_value=True),
        ),
        patch("dembrane.agent_access.context.org_is_paid", new=AsyncMock(return_value=False)),
        patch(
            "dembrane.agent_access.tools.workspace_over_cap_active",
            new=AsyncMock(return_value=False),
        ),
        patch("dembrane.agent_access.tools.async_directus") as directus,
    ):
        directus.get_items = AsyncMock(side_effect=_get_items)
        out = await T.get_conversation(_ctx(), "c1")

    dumped = out.model_dump()
    assert "transcript" not in dumped and "chunks" not in dumped
    assert dumped["summary"] == "Summary c1" and dumped["tags"] == ["housing"]
    assert dumped["chunk_count"] == 7 and dumped["status"] == "done" and dumped["locked"] is False
    assert fake.usage == {_ORG: 1}


def test_fit_cuts_the_longest_list_and_says_how_to_continue() -> None:
    from dembrane.agent_access.mcp_server import MAX_RESULT_CHARS, fit

    chunk = {"timestamp": "t", "transcript": "word " * 200}
    page = {
        "conversation_id": "c1",
        "offset": 40,
        "limit": 200,
        "total": 500,
        "has_more": False,
        "transcript_locked": False,
        "chunks": [dict(chunk) for _ in range(200)],
    }
    out = fit(page)
    assert out["truncated"] is True and out["has_more"] is True
    assert 0 < len(out["chunks"]) < 200
    assert len(json.dumps(out, ensure_ascii=False)) <= MAX_RESULT_CHARS
    assert f"offset={40 + len(out['chunks'])}" in out["note"]
    assert f"{len(out['chunks'])} of 200 chunks" in out["note"]
    # Every field other than the cut list survives untouched.
    assert out["total"] == 500 and out["conversation_id"] == "c1"

    # A tool without paging is told to narrow instead, and has_more is not invented.
    flat = {"query": "x", "projects": [{"id": str(i), "name": "n" * 400} for i in range(400)]}
    cut = fit(flat)
    assert cut["truncated"] is True and "has_more" not in cut
    assert "narrower query" in cut["note"] and len(cut["projects"]) < 400

    # Under the cap, or with nothing to cut, the answer is returned as it was.
    small = {"a": [1, 2, 3]}
    assert fit(small) is small
    prose = {"path": "x.md", "text": "y" * (MAX_RESULT_CHARS + 10)}
    assert fit(prose) is prose


@pytest.mark.asyncio
async def test_list_tools_names_every_tool_with_its_read_only_flag(fake: FakeStore) -> None:
    from dembrane.agent_access import USER_SERVER
    from dembrane.agent_access.mcp_server import server, catalogue

    out = await catalogue(_ctx())
    names = [t.name for t in out.tools]
    assert names == sorted(USER_SERVER.tools) and len(names) == 15
    assert all(n.startswith("dembrane_") for n in names)
    assert {t.name for t in out.tools if not t.read_only} == {
        "dembrane_update_project",
        "dembrane_report_issue",
        "dembrane_request_tool",
    }
    assert all("\n" not in t.description and t.description.endswith(".") for t in out.tools)
    assert isinstance(out.build_version, str) and out.build_version

    # The registry agrees: every tool is annotated and none reaches outside dembrane.
    registered = await server.list_tools()
    assert sorted(t.name for t in registered) == names
    for tool in registered:
        assert tool.annotations is not None and tool.annotations.open_world_hint is False
        if tool.name in {
            "dembrane_update_project",
            "dembrane_report_issue",
            "dembrane_request_tool",
        }:
            assert tool.annotations.read_only_hint is False
            assert tool.annotations.destructive_hint is False
            assert tool.annotations.idempotent_hint is False
        else:
            assert tool.annotations.read_only_hint is True

    app = _rest_app(_ctx())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
        r = await ac.get("/v2/agent/tools")
    assert r.status_code == 200 and [t["name"] for t in r.json()["tools"]] == names
    assert fake.audit[-1]["tool"] == "dembrane_list_tools" and fake.usage == {}
