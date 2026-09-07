"""Persistence for agent access: Directus rows for clients, grants, tokens and
audit events; Redis for the short-lived pieces (pending authorisations, auth
codes, usage counters).

Tokens are never stored: only their SHA-256. Client secrets are encrypted with
a key derived from the Directus secret, because the OAuth token endpoint has
to compare the plain secret and cannot work from a hash.
"""

from __future__ import annotations

import json
import base64
import hashlib
import secrets
from typing import Any, Optional
from logging import getLogger
from datetime import datetime, timezone, timedelta

from cryptography.fernet import Fernet

from dembrane.utils import generate_uuid
from dembrane.settings import get_settings
from dembrane.redis_async import get_redis_client
from dembrane.agent_access import (
    TOKEN_PREFIX_ACCESS,
    TOKEN_PREFIX_REFRESH,
    ACCESS_TOKEN_TTL_SECONDS,
    REFRESH_TOKEN_TTL_SECONDS,
)
from dembrane.directus_async import async_directus

logger = getLogger("agent_access.store")

CLIENT_COLLECTION = "agent_client"
GRANT_COLLECTION = "agent_grant"
TOKEN_COLLECTION = "agent_token"
AUDIT_COLLECTION = "agent_audit_event"

_REDIS_PREFIX = "dembrane:agent_access"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat()


def parse_dt(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def mint_token(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(32)


def _fernet() -> Fernet:
    secret = get_settings().directus.secret or ""
    key = base64.urlsafe_b64encode(hashlib.sha256(("agent_client:" + secret).encode()).digest())
    return Fernet(key)


def encrypt_secret(plain: str) -> str:
    return _fernet().encrypt(plain.encode()).decode()


def decrypt_secret(token: str) -> str:
    return _fernet().decrypt(token.encode()).decode()


def _rows(value: Any) -> list[dict[str, Any]]:
    return value if isinstance(value, list) else []


# ── clients ────────────────────────────────────────────────────────────────


async def get_client_row(client_id: str) -> Optional[dict[str, Any]]:
    row = await async_directus.get_item(CLIENT_COLLECTION, client_id)
    return row if isinstance(row, dict) else None


async def create_client_row(
    *,
    client_id: str,
    client_name: Optional[str],
    auth_method: str,
    client_secret: Optional[str],
    redirect_uris: list[str],
    metadata: dict[str, Any],
) -> None:
    await async_directus.create_item(
        CLIENT_COLLECTION,
        {
            "id": client_id,
            "client_name": client_name,
            "token_endpoint_auth_method": auth_method,
            "client_secret_encrypted": encrypt_secret(client_secret) if client_secret else None,
            "redirect_uris": redirect_uris,
            "metadata": metadata,
            "created_at": iso(now_utc()),
        },
    )


async def touch_client(client_id: str) -> None:
    try:
        await async_directus.update_item(
            CLIENT_COLLECTION, client_id, {"last_seen_at": iso(now_utc())}
        )
    except Exception as exc:  # noqa: BLE001 — bookkeeping only
        logger.debug("touch_client failed client=%s: %s", client_id, exc)


# ── grants ─────────────────────────────────────────────────────────────────


async def create_grant(
    *,
    app_user_id: str,
    directus_user_id: str,
    client_id: str,
    client_name: Optional[str],
    org_ids: list[str],
    scopes: list[str],
    expires_at: datetime,
    consent_version: str,
) -> dict[str, Any]:
    grant_id = generate_uuid()
    now = now_utc()
    row = {
        "id": grant_id,
        "app_user_id": app_user_id,
        "directus_user_id": directus_user_id,
        "client_id": client_id,
        "client_name": client_name,
        "org_ids": org_ids,
        "scopes": scopes,
        "consent_accepted_at": iso(now),
        "consent_version": consent_version,
        "expires_at": iso(expires_at),
        "revoked_at": None,
        "last_used_at": None,
        "created_at": iso(now),
    }
    await async_directus.create_item(GRANT_COLLECTION, row)
    return row


async def get_grant(grant_id: str) -> Optional[dict[str, Any]]:
    row = await async_directus.get_item(GRANT_COLLECTION, grant_id)
    return row if isinstance(row, dict) else None


def grant_is_live(grant: dict[str, Any], at: Optional[datetime] = None) -> bool:
    at = at or now_utc()
    if grant.get("revoked_at"):
        return False
    expires = parse_dt(grant.get("expires_at"))
    return bool(expires and expires > at)


async def list_grants_for_user(app_user_id: str) -> list[dict[str, Any]]:
    rows = await async_directus.get_items(
        GRANT_COLLECTION,
        {
            "query": {
                "filter": {"app_user_id": {"_eq": app_user_id}},
                "sort": ["-created_at"],
                "limit": -1,
            }
        },
    )
    return _rows(rows)


async def list_grants_for_org(org_id: str) -> list[dict[str, Any]]:
    """Grants that name this org. `org_ids` is JSON, so filter in Python."""
    rows = _rows(
        await async_directus.get_items(
            GRANT_COLLECTION,
            {
                "query": {
                    "filter": {"revoked_at": {"_null": True}},
                    "sort": ["-created_at"],
                    "limit": -1,
                }
            },
        )
    )
    return [g for g in rows if org_id in (g.get("org_ids") or [])]


async def revoke_grant(grant_id: str) -> None:
    now = iso(now_utc())
    await async_directus.update_item(GRANT_COLLECTION, grant_id, {"revoked_at": now})
    tokens = _rows(
        await async_directus.get_items(
            TOKEN_COLLECTION,
            {
                "query": {
                    "filter": {"grant_id": {"_eq": grant_id}, "revoked_at": {"_null": True}},
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
    )
    for t in tokens:
        await async_directus.update_item(TOKEN_COLLECTION, t["id"], {"revoked_at": now})


async def touch_grant(grant_id: str) -> None:
    try:
        await async_directus.update_item(
            GRANT_COLLECTION, grant_id, {"last_used_at": iso(now_utc())}
        )
    except Exception as exc:  # noqa: BLE001 — bookkeeping only
        logger.debug("touch_grant failed grant=%s: %s", grant_id, exc)


# ── tokens ─────────────────────────────────────────────────────────────────


async def mint_token_pair(grant_id: str) -> tuple[str, str, datetime]:
    """Create one access + one refresh token for a grant. Returns the raw
    strings (shown to the client once) and the access token's expiry."""
    now = now_utc()
    pair_id = generate_uuid()
    access_raw = mint_token(TOKEN_PREFIX_ACCESS)
    refresh_raw = mint_token(TOKEN_PREFIX_REFRESH)
    access_expires = now + timedelta(seconds=ACCESS_TOKEN_TTL_SECONDS)
    refresh_expires = now + timedelta(seconds=REFRESH_TOKEN_TTL_SECONDS)
    await async_directus.create_item(
        TOKEN_COLLECTION,
        [
            {
                "id": generate_uuid(),
                "grant_id": grant_id,
                "kind": "access",
                "token_hash": hash_token(access_raw),
                "pair_id": pair_id,
                "expires_at": iso(access_expires),
                "revoked_at": None,
                "created_at": iso(now),
            },
            {
                "id": generate_uuid(),
                "grant_id": grant_id,
                "kind": "refresh",
                "token_hash": hash_token(refresh_raw),
                "pair_id": pair_id,
                "expires_at": iso(refresh_expires),
                "revoked_at": None,
                "created_at": iso(now),
            },
        ],
    )
    return access_raw, refresh_raw, access_expires


async def find_token(raw: str, kind: str) -> Optional[dict[str, Any]]:
    """Live token row for a raw token string, or None."""
    rows = _rows(
        await async_directus.get_items(
            TOKEN_COLLECTION,
            {
                "query": {
                    "filter": {
                        "token_hash": {"_eq": hash_token(raw)},
                        "kind": {"_eq": kind},
                        "revoked_at": {"_null": True},
                    },
                    "limit": 1,
                }
            },
        )
    )
    if not rows:
        return None
    row = rows[0]
    expires = parse_dt(row.get("expires_at"))
    if not expires or expires <= now_utc():
        return None
    return row


async def revoke_pair(pair_id: str) -> None:
    now = iso(now_utc())
    rows = _rows(
        await async_directus.get_items(
            TOKEN_COLLECTION,
            {
                "query": {
                    "filter": {"pair_id": {"_eq": pair_id}, "revoked_at": {"_null": True}},
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
    )
    for t in rows:
        await async_directus.update_item(TOKEN_COLLECTION, t["id"], {"revoked_at": now})


# ── redis: pending authorisations, codes, usage ────────────────────────────


async def redis_put(key: str, value: dict[str, Any], ttl_seconds: int) -> None:
    client = await get_redis_client()
    await client.set(f"{_REDIS_PREFIX}:{key}", json.dumps(value), ex=ttl_seconds)


async def redis_get(key: str) -> Optional[dict[str, Any]]:
    client = await get_redis_client()
    raw = await client.get(f"{_REDIS_PREFIX}:{key}")
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


async def redis_delete(key: str) -> None:
    client = await get_redis_client()
    await client.delete(f"{_REDIS_PREFIX}:{key}")


async def redis_take(key: str) -> Optional[dict[str, Any]]:
    """Read and delete in one go, so an auth code is single use."""
    client = await get_redis_client()
    full = f"{_REDIS_PREFIX}:{key}"
    pipe = client.pipeline()
    pipe.get(full)
    pipe.delete(full)
    raw, _ = await pipe.execute()
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


async def usage_increment(org_id: str, month: str) -> int:
    client = await get_redis_client()
    key = f"{_REDIS_PREFIX}:usage:{org_id}:{month}"
    count = await client.incr(key)
    if count == 1:
        await client.expire(key, 40 * 24 * 60 * 60)
    return int(count)


async def usage_get(org_id: str, month: str) -> int:
    client = await get_redis_client()
    raw = await client.get(f"{_REDIS_PREFIX}:usage:{org_id}:{month}")
    try:
        return int(raw) if raw else 0
    except (TypeError, ValueError):
        return 0


# ── audit ──────────────────────────────────────────────────────────────────


async def write_audit_event(
    *,
    grant_id: str,
    app_user_id: str,
    client_id: str,
    org_id: Optional[str],
    tool: str,
    params: dict[str, Any],
    status: str,
    duration_ms: int,
) -> None:
    """Best-effort. Audit failure must never roll back the call it records."""
    try:
        await async_directus.create_item(
            AUDIT_COLLECTION,
            {
                "id": generate_uuid(),
                "grant_id": grant_id,
                "app_user_id": app_user_id,
                "client_id": client_id,
                "org_id": org_id,
                "tool": tool,
                "params": params,
                "status": status,
                "duration_ms": duration_ms,
                "created_at": iso(now_utc()),
            },
        )
    except Exception as exc:  # noqa: BLE001 — audit is best-effort
        logger.warning("agent audit write failed tool=%s grant=%s: %s", tool, grant_id, exc)


async def list_audit_events(
    *,
    app_user_id: Optional[str] = None,
    org_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    flt: dict[str, Any] = {}
    if app_user_id:
        flt["app_user_id"] = {"_eq": app_user_id}
    if org_id:
        flt["org_id"] = {"_eq": org_id}
    rows = await async_directus.get_items(
        AUDIT_COLLECTION,
        {"query": {"filter": flt, "sort": ["-created_at"], "limit": limit, "offset": offset}},
    )
    return _rows(rows)
