"""Management of agent access for signed-in users, mounted at
/api/v2/agent-access. This is what the "Connect your agent" page and the
consent page call. Normal cookie session, normal v2 rules.

- servers: the catalogue shown on the page
- authorize-requests: the consent step of the OAuth flow
- grants: what the user has connected, and revocation
- organisations: the admin switch, usage, and per-org grants
- audit: what agents did
"""

from __future__ import annotations

from typing import Any, Literal, Optional
from logging import getLogger
from datetime import datetime, timezone

from fastapi import Query, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.app_user import get_app_user_or_raise
from dembrane.analytics import capture_event
from dembrane.api.v2.orgs import _require_org_role
from dembrane.agent_access import (
    SERVERS,
    SCOPE_READ,
    SCOPE_WRITE,
    VALID_SCOPES,
    CONSENT_VERSION,
    FREE_TIER_MONTHLY_CALLS,
    GRANT_EXPIRY_CHOICES_DAYS,
    oauth,
    store,
)
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.agent_access.context import org_is_paid, guest_org_ids, invalidate_org_cache

logger = getLogger("api.v2.agent_access")

router = APIRouter()


# ── models ─────────────────────────────────────────────────────────────────


class ServerOut(BaseModel):
    id: str
    name: str
    summary: str
    data_reach: list[str]
    can_change: list[str]
    tools: list[str]
    mcp_url: str
    scopes: list[str]


class ServersOut(BaseModel):
    servers: list[ServerOut]
    consent_version: str
    expiry_choices_days: list[int]
    free_tier_monthly_calls: int


class OrgAccessOut(BaseModel):
    id: str
    name: str
    role: str
    can_manage: bool
    agent_access_enabled: bool
    is_paid: bool
    calls_this_month: int
    monthly_limit: Optional[int] = None
    updated_at: Optional[str] = None


class AuthorizeRequestOut(BaseModel):
    request_id: str
    client_name: Optional[str] = None
    client_id: str
    redirect_host: str
    requested_scopes: list[str]
    organisations: list[OrgAccessOut]
    consent_version: str
    expiry_choices_days: list[int]


class ApproveIn(BaseModel):
    org_ids: list[str] = Field(..., min_length=1)
    scopes: list[str] = Field(default_factory=lambda: [SCOPE_READ])
    expires_in_days: int = 90
    consent_accepted: bool


class RedirectOut(BaseModel):
    redirect_url: str


class GrantOut(BaseModel):
    id: str
    client_id: str
    client_name: Optional[str] = None
    org_ids: list[str]
    org_names: list[str]
    scopes: list[str]
    created_at: Optional[str] = None
    expires_at: Optional[str] = None
    last_used_at: Optional[str] = None
    revoked_at: Optional[str] = None
    status: Literal["active", "expired", "revoked"]
    user_email: Optional[str] = None
    user_display_name: Optional[str] = None


class OrgToggleIn(BaseModel):
    enabled: bool


class AuditEventOut(BaseModel):
    id: str
    grant_id: str
    client_id: str
    client_name: Optional[str] = None
    app_user_id: str
    user_display_name: Optional[str] = None
    user_email: Optional[str] = None
    org_id: Optional[str] = None
    tool: str
    params: dict[str, Any] = {}
    status: str
    duration_ms: Optional[int] = None
    created_at: Optional[str] = None


# ── helpers ────────────────────────────────────────────────────────────────


def _s(value: Any) -> Optional[str]:
    return None if value is None else str(value)


def _params(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


async def _my_org_memberships(app_user_id: str) -> list[dict[str, Any]]:
    """Org memberships plus, for guests, the orgs of workspaces they were
    added to directly. A guest has no org row but does have data in that org,
    and the grant is org-scoped, so the org must be selectable. Role "guest"
    never manages anything."""
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {"user_id": {"_eq": app_user_id}, "deleted_at": {"_null": True}},
                "fields": ["org_id", "role"],
                "limit": -1,
            }
        },
    )
    memberships = [r for r in (rows if isinstance(rows, list) else []) if r.get("org_id")]
    seen = {str(m["org_id"]) for m in memberships}
    for org_id in await guest_org_ids(app_user_id):
        if org_id not in seen:
            memberships.append({"org_id": org_id, "role": "guest"})
            seen.add(org_id)
    return memberships


async def _org_rows(org_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not org_ids:
        return {}
    rows = await async_directus.get_items(
        "org",
        {
            "query": {
                "filter": {"id": {"_in": org_ids}, "deleted_at": {"_null": True}},
                "fields": ["id", "name", "agent_access_enabled", "agent_access_updated_at"],
                "limit": -1,
            }
        },
    )
    return {str(r["id"]): r for r in (rows if isinstance(rows, list) else [])}


async def _org_access_out(org: dict[str, Any], role: str) -> OrgAccessOut:
    org_id = str(org["id"])
    paid = await org_is_paid(org_id)
    month = datetime.now(timezone.utc).strftime("%Y%m")
    return OrgAccessOut(
        id=org_id,
        name=str(org.get("name") or ""),
        role=role,
        can_manage=role in ("admin", "owner"),
        agent_access_enabled=bool(org.get("agent_access_enabled")),
        is_paid=paid,
        calls_this_month=await store.usage_get(org_id, month),
        monthly_limit=None if paid else FREE_TIER_MONTHLY_CALLS,
        updated_at=_s(org.get("agent_access_updated_at")),
    )


async def _my_orgs(app_user_id: str) -> list[OrgAccessOut]:
    memberships = await _my_org_memberships(app_user_id)
    org_map = await _org_rows([str(m["org_id"]) for m in memberships if m.get("org_id")])
    out: list[OrgAccessOut] = []
    for m in memberships:
        org = org_map.get(str(m.get("org_id")))
        if org:
            out.append(await _org_access_out(org, str(m.get("role") or "member")))
    return out


def _grant_status(grant: dict[str, Any]) -> Literal["active", "expired", "revoked"]:
    if grant.get("revoked_at"):
        return "revoked"
    return "active" if store.grant_is_live(grant) else "expired"


async def _grant_out(
    grant: dict[str, Any], org_names: dict[str, str], user: Optional[dict[str, Any]] = None
) -> GrantOut:
    org_ids = [str(o) for o in (grant.get("org_ids") or [])]
    return GrantOut(
        id=str(grant["id"]),
        client_id=str(grant.get("client_id")),
        client_name=_s(grant.get("client_name")),
        org_ids=org_ids,
        org_names=[org_names.get(o, "") for o in org_ids],
        scopes=[str(s) for s in (grant.get("scopes") or [])],
        created_at=_s(grant.get("created_at")),
        expires_at=_s(grant.get("expires_at")),
        last_used_at=_s(grant.get("last_used_at")),
        revoked_at=_s(grant.get("revoked_at")),
        status=_grant_status(grant),
        user_email=_s(user.get("email")) if user else None,
        user_display_name=_s(user.get("display_name")) if user else None,
    )


# ── catalogue ──────────────────────────────────────────────────────────────


@router.get("/servers", response_model=ServersOut)
async def list_servers(auth: DependencyDirectusSession) -> ServersOut:
    await get_app_user_or_raise(auth.user_id)
    return ServersOut(
        servers=[
            ServerOut(
                id=s.id,
                name=s.name,
                summary=s.summary,
                data_reach=s.data_reach,
                can_change=s.can_change,
                tools=s.tools,
                mcp_url=oauth.issuer_url(),
                scopes=VALID_SCOPES,
            )
            for s in SERVERS
        ],
        consent_version=CONSENT_VERSION,
        expiry_choices_days=GRANT_EXPIRY_CHOICES_DAYS,
        free_tier_monthly_calls=FREE_TIER_MONTHLY_CALLS,
    )


# ── consent step ───────────────────────────────────────────────────────────


@router.get("/authorize-requests/{request_id}", response_model=AuthorizeRequestOut)
async def get_authorize_request(
    request_id: str, auth: DependencyDirectusSession
) -> AuthorizeRequestOut:
    app_user = await get_app_user_or_raise(auth.user_id)
    pending = await oauth.load_authorize_request(request_id)
    if not pending:
        raise HTTPException(
            status_code=404,
            detail="This authorisation request has expired. Start again from your agent.",
        )
    from urllib.parse import urlparse

    return AuthorizeRequestOut(
        request_id=request_id,
        client_name=_s(pending.get("client_name")),
        client_id=str(pending.get("client_id")),
        redirect_host=urlparse(str(pending.get("redirect_uri") or "")).netloc,
        requested_scopes=[str(s) for s in (pending.get("scopes") or [SCOPE_READ])],
        organisations=await _my_orgs(app_user["id"]),
        consent_version=CONSENT_VERSION,
        expiry_choices_days=GRANT_EXPIRY_CHOICES_DAYS,
    )


@router.post("/authorize-requests/{request_id}/approve", response_model=RedirectOut)
async def approve_authorize_request(
    request_id: str, body: ApproveIn, auth: DependencyDirectusSession
) -> RedirectOut:
    app_user = await get_app_user_or_raise(auth.user_id)
    if not body.consent_accepted:
        raise HTTPException(status_code=400, detail="The data risk notice must be accepted")
    if body.expires_in_days not in GRANT_EXPIRY_CHOICES_DAYS:
        raise HTTPException(status_code=400, detail="Unsupported expiry")
    scopes = [s for s in body.scopes if s in VALID_SCOPES]
    if SCOPE_READ not in scopes:
        scopes.insert(0, SCOPE_READ)

    # Only orgs the user belongs to and that an admin has switched on.
    allowed = {o.id for o in await _my_orgs(app_user["id"]) if o.agent_access_enabled}
    org_ids = [o for o in body.org_ids if o in allowed]
    if not org_ids:
        raise HTTPException(
            status_code=400,
            detail="Pick at least one organisation where agent access is switched on",
        )
    try:
        redirect_url = await oauth.approve_authorize_request(
            request_id=request_id,
            app_user_id=app_user["id"],
            directus_user_id=auth.user_id,
            org_ids=org_ids,
            scopes=scopes,
            expires_in_days=body.expires_in_days,
            consent_version=CONSENT_VERSION,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    await capture_event(
        auth.user_id,
        "agent_grant_created",
        {"org_count": len(org_ids), "scopes": scopes, "expires_in_days": body.expires_in_days},
    )
    return RedirectOut(redirect_url=redirect_url)


@router.post("/authorize-requests/{request_id}/deny", response_model=RedirectOut)
async def deny_authorize_request(request_id: str, auth: DependencyDirectusSession) -> RedirectOut:
    await get_app_user_or_raise(auth.user_id)
    try:
        return RedirectOut(redirect_url=await oauth.deny_authorize_request(request_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None


# ── my grants ──────────────────────────────────────────────────────────────


@router.get("/grants", response_model=list[GrantOut])
async def list_my_grants(auth: DependencyDirectusSession) -> list[GrantOut]:
    app_user = await get_app_user_or_raise(auth.user_id)
    grants = await store.list_grants_for_user(app_user["id"])
    org_ids = sorted({str(o) for g in grants for o in (g.get("org_ids") or [])})
    names = {k: str(v.get("name") or "") for k, v in (await _org_rows(org_ids)).items()}
    return [await _grant_out(g, names) for g in grants]


@router.delete("/grants/{grant_id}")
async def revoke_my_grant(grant_id: str, auth: DependencyDirectusSession) -> dict[str, str]:
    app_user = await get_app_user_or_raise(auth.user_id)
    grant = await store.get_grant(grant_id)
    if not grant or str(grant.get("app_user_id")) != str(app_user["id"]):
        raise HTTPException(status_code=404, detail="Grant not found")
    await store.revoke_grant(grant_id)
    await capture_event(auth.user_id, "agent_grant_revoked", {"by": "owner"})
    return {"status": "revoked"}


# ── organisations ──────────────────────────────────────────────────────────


@router.get("/organisations", response_model=list[OrgAccessOut])
async def list_my_organisations(auth: DependencyDirectusSession) -> list[OrgAccessOut]:
    app_user = await get_app_user_or_raise(auth.user_id)
    return await _my_orgs(app_user["id"])


@router.patch("/organisations/{org_id}", response_model=OrgAccessOut)
async def set_org_agent_access(
    org_id: str, body: OrgToggleIn, auth: DependencyDirectusSession
) -> OrgAccessOut:
    app_user = await get_app_user_or_raise(auth.user_id)
    role = await _require_org_role(org_id, app_user["id"], minimum="admin")
    now = datetime.now(timezone.utc).isoformat()
    await async_directus.update_item(
        "org",
        org_id,
        {
            "agent_access_enabled": body.enabled,
            "agent_access_updated_at": now,
            "agent_access_updated_by": app_user["id"],
        },
    )
    await invalidate_org_cache(org_id)
    if not body.enabled:
        # Switching off is immediate: every grant naming this org stops working
        # on its next call through the org check. Nothing else to revoke.
        pass
    await capture_event(
        auth.user_id, "agent_access_org_toggled", {"org_id": org_id, "enabled": body.enabled}
    )
    org = (await _org_rows([org_id])).get(org_id) or {
        "id": org_id,
        "name": "",
        "agent_access_enabled": body.enabled,
    }
    return await _org_access_out(org, role)


@router.get("/organisations/{org_id}/grants", response_model=list[GrantOut])
async def list_org_grants(org_id: str, auth: DependencyDirectusSession) -> list[GrantOut]:
    app_user = await get_app_user_or_raise(auth.user_id)
    await _require_org_role(org_id, app_user["id"], minimum="admin")
    grants = await store.list_grants_for_org(org_id)
    user_ids = sorted({str(g.get("app_user_id")) for g in grants if g.get("app_user_id")})
    users: dict[str, dict[str, Any]] = {}
    if user_ids:
        rows = await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": user_ids}},
                    "fields": ["id", "email", "display_name"],
                    "limit": -1,
                }
            },
        )
        users = {str(u["id"]): u for u in (rows if isinstance(rows, list) else [])}
    org_ids = sorted({str(o) for g in grants for o in (g.get("org_ids") or [])})
    names = {k: str(v.get("name") or "") for k, v in (await _org_rows(org_ids)).items()}
    return [await _grant_out(g, names, users.get(str(g.get("app_user_id")))) for g in grants]


@router.delete("/organisations/{org_id}/grants/{grant_id}")
async def revoke_org_grant(
    org_id: str, grant_id: str, auth: DependencyDirectusSession
) -> dict[str, str]:
    app_user = await get_app_user_or_raise(auth.user_id)
    await _require_org_role(org_id, app_user["id"], minimum="admin")
    grant = await store.get_grant(grant_id)
    if not grant or org_id not in [str(o) for o in (grant.get("org_ids") or [])]:
        raise HTTPException(status_code=404, detail="Grant not found")
    await store.revoke_grant(grant_id)
    await capture_event(auth.user_id, "agent_grant_revoked", {"by": "org_admin", "org_id": org_id})
    return {"status": "revoked"}


# ── audit ──────────────────────────────────────────────────────────────────


@router.get("/audit", response_model=list[AuditEventOut])
async def list_audit(
    auth: DependencyDirectusSession,
    org_id: Optional[str] = Query(
        None, description="Org admins: every event in this organisation."
    ),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> list[AuditEventOut]:
    app_user = await get_app_user_or_raise(auth.user_id)
    if org_id:
        await _require_org_role(org_id, app_user["id"], minimum="admin")
        rows = await store.list_audit_events(org_id=org_id, limit=limit, offset=offset)
    else:
        rows = await store.list_audit_events(app_user_id=app_user["id"], limit=limit, offset=offset)
    # Names come from the grant (agent) and app_user (member) so the admin list
    # reads as people and tools, not ids. Revoked grants still resolve.
    grant_ids = sorted({str(r.get("grant_id")) for r in rows if r.get("grant_id")})
    user_ids = sorted({str(r.get("app_user_id")) for r in rows if r.get("app_user_id")})
    grants: dict[str, dict[str, Any]] = {}
    users: dict[str, dict[str, Any]] = {}
    if grant_ids:
        g_rows = await async_directus.get_items(
            store.GRANT_COLLECTION,
            {
                "query": {
                    "filter": {"id": {"_in": grant_ids}},
                    "fields": ["id", "client_name"],
                    "limit": -1,
                }
            },
        )
        grants = {str(g["id"]): g for g in (g_rows if isinstance(g_rows, list) else [])}
    if user_ids:
        u_rows = await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": user_ids}},
                    "fields": ["id", "email", "display_name"],
                    "limit": -1,
                }
            },
        )
        users = {str(u["id"]): u for u in (u_rows if isinstance(u_rows, list) else [])}
    out: list[AuditEventOut] = []
    for r in rows:
        grant = grants.get(str(r.get("grant_id")), {})
        user = users.get(str(r.get("app_user_id")), {})
        out.append(
            AuditEventOut(
                id=str(r["id"]),
                grant_id=str(r.get("grant_id")),
                client_id=str(r.get("client_id")),
                client_name=_s(grant.get("client_name")),
                app_user_id=str(r.get("app_user_id")),
                user_display_name=_s(user.get("display_name")),
                user_email=_s(user.get("email")),
                org_id=_s(r.get("org_id")),
                tool=str(r.get("tool") or ""),
                params=_params(r.get("params")),
                status=str(r.get("status") or ""),
                duration_ms=r.get("duration_ms"),
                created_at=_s(r.get("created_at")),
            )
        )
    return out


__all__ = ["router", "SCOPE_WRITE"]
