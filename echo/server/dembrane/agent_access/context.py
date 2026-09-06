"""Turn a bearer token into "who is this agent acting as, and where may it
look". Shared by the REST routes and the MCP tools so both enforce the same
rules in one place:

- the grant must be live (not revoked, not expired)
- the organisation must be in the grant and have agent access switched on
- the scope must cover the call
- a free organisation must be under its monthly call budget

Every tool call ends in `record()`, which writes the audit row.
"""

from __future__ import annotations

import time
from typing import Any, Optional
from logging import getLogger
from datetime import datetime, timezone
from dataclasses import field, dataclass

from fastapi import HTTPException

from dembrane.agent_access import SCOPE_WRITE, FREE_TIER_MONTHLY_CALLS, store
from dembrane.directus_async import async_directus
from dembrane.agent_access.oauth import AgentAccessToken
from dembrane.api.dependency_auth import DirectusSession

logger = getLogger("agent_access.context")


@dataclass
class AgentContext:
    grant_id: str
    client_id: str
    client_name: str
    app_user_id: str
    directus_user_id: str
    org_ids: list[str]
    scopes: list[str]
    session: DirectusSession
    started_at: float = field(default_factory=time.perf_counter)
    # Set by require_org so the audit row names the organisation a call
    # touched even when the tool signature does not carry one.
    touched_org_id: Optional[str] = None

    def has_scope(self, scope: str) -> bool:
        return scope in self.scopes

    def require_scope(self, scope: str) -> None:
        if not self.has_scope(scope):
            raise HTTPException(
                status_code=403, detail=f"This grant does not include the '{scope}' scope"
            )

    def require_write(self) -> None:
        self.require_scope(SCOPE_WRITE)

    async def require_org(self, org_id: Optional[str]) -> str:
        """The org must be in the grant and switched on. Returns the org id."""
        if not org_id or org_id not in self.org_ids:
            raise HTTPException(status_code=404, detail="Not found")
        self.touched_org_id = org_id
        if not await org_agent_access_enabled(org_id):
            raise HTTPException(
                status_code=403,
                detail="An organisation admin has switched off agent access for this organisation",
            )
        return org_id

    async def charge(self, org_id: str) -> None:
        """Count one call against a free organisation's monthly budget."""
        if await org_is_paid(org_id):
            return
        month = datetime.now(timezone.utc).strftime("%Y%m")
        count = await store.usage_increment(org_id, month)
        if count > FREE_TIER_MONTHLY_CALLS:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"This organisation is on the free tier and has used its "
                    f"{FREE_TIER_MONTHLY_CALLS} agent calls for this month"
                ),
            )

    async def record(
        self,
        tool: str,
        params: dict[str, Any],
        *,
        org_id: Optional[str],
        status: str,
    ) -> None:
        duration_ms = int((time.perf_counter() - self.started_at) * 1000)
        await store.write_audit_event(
            grant_id=self.grant_id,
            app_user_id=self.app_user_id,
            client_id=self.client_id,
            org_id=org_id or self.touched_org_id,
            tool=tool,
            params=params,
            status=status,
            duration_ms=duration_ms,
        )
        if status == "ok":
            await store.touch_grant(self.grant_id)


async def context_from_access_token(token: AgentAccessToken) -> AgentContext:
    grant = await store.get_grant(token.grant_id)
    if not grant or not store.grant_is_live(grant):
        raise HTTPException(status_code=401, detail="Grant is no longer active")
    return AgentContext(
        grant_id=grant["id"],
        client_id=str(grant.get("client_id")),
        client_name=str(grant.get("client_name") or "agent"),
        app_user_id=str(grant["app_user_id"]),
        directus_user_id=str(grant["directus_user_id"]),
        org_ids=[str(o) for o in (grant.get("org_ids") or [])],
        scopes=[str(s) for s in (grant.get("scopes") or [])],
        session=DirectusSession(user_id=str(grant["directus_user_id"]), is_admin=False),
    )


# ── organisation state ─────────────────────────────────────────────────────


async def guest_org_ids(app_user_id: str) -> list[str]:
    """Orgs the user reaches only through a direct, live workspace membership."""
    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {"user_id": {"_eq": app_user_id}, "deleted_at": {"_null": True}},
                "fields": ["workspace_id.org_id", "workspace_id.deleted_at", "expires_at"],
                "limit": -1,
            }
        },
    )
    out: list[str] = []
    for r in rows if isinstance(rows, list) else []:
        ws = r.get("workspace_id")
        if not isinstance(ws, dict) or ws.get("deleted_at") or not ws.get("org_id"):
            continue
        expires = store.parse_dt(r.get("expires_at"))
        if expires and expires <= datetime.now(timezone.utc):
            continue
        if str(ws["org_id"]) not in out:
            out.append(str(ws["org_id"]))
    return out


async def org_agent_access_enabled(org_id: str) -> bool:
    cached = await store.redis_get(f"org_enabled:{org_id}")
    if cached is not None:
        return bool(cached.get("enabled"))
    org = await async_directus.get_item("org", org_id)
    enabled = bool(
        isinstance(org, dict) and org.get("agent_access_enabled") and not org.get("deleted_at")
    )
    await store.redis_put(f"org_enabled:{org_id}", {"enabled": enabled}, 60)
    return enabled


async def invalidate_org_cache(org_id: str) -> None:
    await store.redis_delete(f"org_enabled:{org_id}")
    await store.redis_delete(f"org_paid:{org_id}")


async def org_is_paid(org_id: str) -> bool:
    """Any workspace in the org above the free tier makes the org paid."""
    cached = await store.redis_get(f"org_paid:{org_id}")
    if cached is not None:
        return bool(cached.get("paid"))
    from dembrane.billing_account import nested_billing_fields, billing_from_workspace

    rows = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {"org_id": {"_eq": org_id}, "deleted_at": {"_null": True}},
                "fields": ["id", *nested_billing_fields()],
                "limit": -1,
            }
        },
    )
    paid = False
    for ws in rows if isinstance(rows, list) else []:
        tier = billing_from_workspace(ws).get("tier")
        if tier and tier != "free":
            paid = True
            break
    await store.redis_put(f"org_paid:{org_id}", {"paid": paid}, 300)
    return paid
