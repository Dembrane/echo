"""Public auth helpers — endpoints that run unauthenticated.

Registration is information-neutral: the response is always the same
regardless of whether the email already exists. A transactional email
handles both cases (verification for new, sign-in nudge for existing).
"""

from __future__ import annotations

import re
import hmac as _hmac
from typing import Optional
from logging import getLogger
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx
from fastapi import Request, Response, APIRouter
from pydantic import Field, BaseModel

from dembrane.email import send_email
from dembrane.settings import get_settings
from dembrane.api.rate_limit import create_rate_limiter
from dembrane.api.v2.invites import compute_invite_hash
from dembrane.directus_async import async_directus

router = APIRouter()
logger = getLogger("api.v2.auth")

_register_rate_limiter = create_rate_limiter(
    name="auth_register",
    capacity=10,
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
# Domain segments exclude `.` to avoid polynomial backtracking (py/polynomial-redos).
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$")


def _client_ip(request: Request) -> str:
    """Best-effort client IP, respecting reverse-proxy headers."""
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


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


# ── Registration ──────────────────────────────────────────────────────


class RegisterRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)
    password: str = Field(..., min_length=8, max_length=256)
    first_name: str = Field(..., min_length=1, max_length=150)
    last_name: Optional[str] = Field(None, max_length=150)
    verification_url: str = Field(..., max_length=500)


@router.post("/register", status_code=204)
async def register_user(body: RegisterRequest, request: Request) -> Response:
    """Information-neutral registration.

    Always returns 204 regardless of whether the email is new or
    existing. New users get the Directus verification email; existing
    users get a transactional "you already have an account" email with
    sign-in and password-reset links. No enumeration leak.
    """
    await _register_rate_limiter.check(_client_ip(request))

    settings = get_settings()
    email = body.email.strip().lower()

    if not _EMAIL_RE.match(email):
        return Response(status_code=204)

    try:
        users = await async_directus.get_users(
            {
                "query": {
                    "filter": {"email": {"_eq": email}},
                    "fields": ["id"],
                    "limit": 1,
                }
            },
        )
    except Exception:
        logger.exception("Directus user lookup failed during registration for %s", email)
        return Response(status_code=204)

    if isinstance(users, list) and len(users) > 0:
        qs = urlencode({"email": email})
        sent = await send_email(
            to=email,
            subject="You already have a dembrane account",
            template="registration_existing_account",
            template_data={
                "login_url": f"{settings.urls.admin_base_url}/login?{qs}",
                "reset_url": f"{settings.urls.admin_base_url}/request-password-reset?{qs}",
            },
        )
        if not sent:
            logger.warning("Failed to send existing-account email to %s", email)
    else:
        payload: dict = {
            "email": email,
            "password": body.password,
            "first_name": body.first_name,
            "verification_url": body.verification_url,
        }
        if body.last_name and body.last_name.strip():
            payload["last_name"] = body.last_name.strip()

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    f"{settings.directus.base_url}/users/register",
                    json=payload,
                )
                if resp.status_code >= 400:
                    logger.error(
                        "Directus registration failed: %s %s",
                        resp.status_code,
                        resp.text,
                    )
        except Exception:
            logger.exception("Directus registration proxy failed for %s", email)

    return Response(status_code=204)
