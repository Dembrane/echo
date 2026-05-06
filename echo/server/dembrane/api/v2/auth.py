"""Public auth helpers — endpoints that run unauthenticated.

Email enumeration is the explicit tradeoff (same call Linear / Notion /
GitHub / Stripe make): silent registration failure is worse UX than the
small leak. Strict per-IP rate limits keep brute-force expensive.
"""

from __future__ import annotations

import re
import hmac as _hmac
from typing import Optional
from logging import getLogger
from datetime import datetime, timezone

from fastapi import Request, APIRouter
from pydantic import Field, BaseModel

from dembrane.api.rate_limit import create_rate_limiter
from dembrane.api.v2.invites import compute_invite_hash
from dembrane.directus_async import async_directus

router = APIRouter()
logger = getLogger("api.v2.auth")

_check_email_rate_limiter = create_rate_limiter(
    name="auth_check_email",
    capacity=15,
    window_seconds=300,
)

# Hash is the security gate (HMAC), email is just an index hint —
# 30 req / 5 min makes brute-forcing hashes per email expensive.
_invite_status_rate_limiter = create_rate_limiter(
    name="auth_invite_status",
    capacity=30,
    window_seconds=300,
)

# Cheap shape check — rejects obvious garbage before hitting Directus.
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _client_ip(request: Request) -> str:
    """Best-effort client IP, respecting reverse-proxy headers."""
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


class CheckEmailRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)


class CheckEmailResponse(BaseModel):
    """available = safe to register; registered = block + offer login;
    invalid = failed regex. Verified vs unverified is intentionally
    not distinguished (finer-grained leak, same recovery path)."""

    status: str


@router.post("/check-email", response_model=CheckEmailResponse)
async def check_email(
    body: CheckEmailRequest,
    request: Request,
) -> CheckEmailResponse:
    """Public probe — returns whether an email already has a Directus user.
    Uses the admin client for lookup; rate-limited per IP."""
    await _check_email_rate_limiter.check(_client_ip(request))

    email = body.email.strip().lower()
    if not _EMAIL_RE.match(email):
        return CheckEmailResponse(status="invalid")

    users = await async_directus.get_users(
        {
            "query": {
                "filter": {"email": {"_eq": email}},
                "fields": ["id"],
                "limit": 1,
            }
        },
    )

    if isinstance(users, list) and len(users) > 0:
        return CheckEmailResponse(status="registered")

    return CheckEmailResponse(status="available")


class PublicInviteStatus(BaseModel):
    """Same status enum as /me/invites/by-hash, minus `is_member`
    (only meaningful with a session)."""

    status: str
    workspace_name: Optional[str] = None
    role: Optional[str] = None
    expires_at: Optional[str] = None


@router.get("/invite-status", response_model=PublicInviteStatus)
async def public_invite_status(
    email: str,
    h: str,
    request: Request,
) -> PublicInviteStatus:
    """Public invite-state probe — closes the loophole where a
    cancelled/expired hash bounces an unauth visitor into register →
    stray personal org. HMAC is the gate; email is just a lookup hint."""
    await _invite_status_rate_limiter.check(_client_ip(request))

    email_normalized = (email or "").strip().lower()
    if not email_normalized or not h:
        return PublicInviteStatus(status="not_found")
    if not _EMAIL_RE.match(email_normalized):
        return PublicInviteStatus(status="not_found")

    invites = await async_directus.get_items(
        "workspace_invite",
        {
            "query": {
                "filter": {"email": {"_eq": email_normalized}},
                "fields": [
                    "id",
                    "workspace_id",
                    "role",
                    "accepted_at",
                    "expires_at",
                ],
                "limit": -1,
            }
        },
    )

    target = None
    if isinstance(invites, list):
        for inv in invites:
            if _hmac.compare_digest(compute_invite_hash(inv["id"]), h):
                target = inv
                break

    if target is None:
        return PublicInviteStatus(status="not_found")

    ws = await async_directus.get_item("workspace", target["workspace_id"])
    if not ws or ws.get("deleted_at"):
        return PublicInviteStatus(
            status="workspace_deleted",
            workspace_name=(ws or {}).get("name") or "",
        )

    now_iso = datetime.now(timezone.utc).isoformat()

    if target.get("accepted_at"):
        return PublicInviteStatus(
            status="accepted",
            workspace_name=ws.get("name") or "",
            role=target.get("role"),
        )

    if target.get("expires_at") and target["expires_at"] < now_iso:
        return PublicInviteStatus(
            status="expired",
            workspace_name=ws.get("name") or "",
            role=target.get("role"),
            expires_at=target.get("expires_at"),
        )

    return PublicInviteStatus(
        status="pending",
        workspace_name=ws.get("name") or "",
        role=target.get("role"),
        expires_at=target.get("expires_at"),
    )
