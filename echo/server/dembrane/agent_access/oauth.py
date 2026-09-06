"""The OAuth 2.1 authorisation server behind agent access.

Implements the MCP SDK's provider protocol on top of `store`. The consent
step lives in the dashboard: `authorize()` parks the request in Redis and
redirects the browser to the "Connect your agent" page, which calls the
session-authenticated management API to approve or deny. Approval mints a
single-use code; the client then trades it for a token pair at /token.

Refresh rotates the whole pair. Revoking either token kills both.
"""

from __future__ import annotations

import time
from typing import Any, Optional
from logging import getLogger
from datetime import datetime, timezone, timedelta
from urllib.parse import urlencode

from pydantic import AnyUrl, AnyHttpUrl
from mcp.shared.auth import OAuthToken, OAuthClientInformationFull
from mcp.server.auth.provider import (
    TokenError,
    AccessToken,
    RefreshToken,
    AuthorizationCode,
    AuthorizationParams,
    IdentityAssertionParams,
    construct_redirect_uri,
)
from mcp.server.auth.settings import AuthSettings, RevocationOptions, ClientRegistrationOptions

from dembrane.utils import generate_uuid
from dembrane.settings import get_settings
from dembrane.agent_access import (
    SCOPE_READ,
    VALID_SCOPES,
    AUTH_CODE_TTL_SECONDS,
    ACCESS_TOKEN_TTL_SECONDS,
    AUTHORIZE_REQUEST_TTL_SECONDS,
    store,
)

logger = getLogger("agent_access.oauth")

MCP_PATH = "/api/mcp"
CONSENT_PATH = "/settings/agents/authorize"


def issuer_url() -> str:
    return get_settings().urls.api_base_url.rstrip("/") + MCP_PATH


def resource_url() -> str:
    return issuer_url()


def consent_url(request_id: str) -> str:
    base = get_settings().urls.admin_base_url.rstrip("/")
    return f"{base}{CONSENT_PATH}?" + urlencode({"request": request_id})


def auth_settings() -> AuthSettings:
    return AuthSettings(
        issuer_url=AnyHttpUrl(issuer_url()),
        resource_server_url=AnyHttpUrl(resource_url()),
        client_registration_options=ClientRegistrationOptions(
            enabled=True,
            valid_scopes=VALID_SCOPES,
            default_scopes=[SCOPE_READ],
        ),
        revocation_options=RevocationOptions(enabled=True),
        required_scopes=[SCOPE_READ],
    )


class AgentAuthorizationCode(AuthorizationCode):
    grant_id: str


class AgentRefreshToken(RefreshToken):
    grant_id: str
    pair_id: str


class AgentAccessToken(AccessToken):
    grant_id: str
    pair_id: str


def _client_from_row(row: dict[str, Any]) -> OAuthClientInformationFull:
    metadata = dict(row.get("metadata") or {})
    metadata["client_id"] = row["id"]
    encrypted = row.get("client_secret_encrypted")
    metadata["client_secret"] = store.decrypt_secret(encrypted) if encrypted else None
    return OAuthClientInformationFull.model_validate(metadata)


class AgentOAuthProvider:
    """Provider protocol implementation. Every method is a thin mapping onto
    `store`; the rules live here, the IO lives there."""

    # ── clients ────────────────────────────────────────────────────────

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        row = await store.get_client_row(client_id)
        if not row:
            return None
        try:
            return _client_from_row(row)
        except Exception as exc:  # noqa: BLE001 — a corrupt row must read as "no client"
            logger.warning("agent_client row %s unreadable: %s", client_id, exc)
            return None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        metadata = client_info.model_dump(mode="json", exclude={"client_secret"})
        await store.create_client_row(
            client_id=client_info.client_id,
            client_name=client_info.client_name,
            auth_method=client_info.token_endpoint_auth_method or "none",
            client_secret=client_info.client_secret,
            redirect_uris=[str(u) for u in (client_info.redirect_uris or [])],
            metadata=metadata,
        )

    # ── authorise → consent page ───────────────────────────────────────

    async def authorize(
        self, client: OAuthClientInformationFull, params: AuthorizationParams
    ) -> str:
        request_id = generate_uuid()
        await store.redis_put(
            f"authz:{request_id}",
            {
                "client_id": client.client_id,
                "client_name": client.client_name,
                "state": params.state,
                "scopes": params.scopes or [SCOPE_READ],
                "code_challenge": params.code_challenge,
                "redirect_uri": str(params.redirect_uri),
                "redirect_uri_provided_explicitly": params.redirect_uri_provided_explicitly,
                "resource": params.resource,
                "created_at": time.time(),
            },
            AUTHORIZE_REQUEST_TTL_SECONDS,
        )
        return consent_url(request_id)

    # ── codes ──────────────────────────────────────────────────────────

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AgentAuthorizationCode | None:
        data = await store.redis_get(f"code:{authorization_code}")
        if not data or data.get("client_id") != client.client_id:
            return None
        return AgentAuthorizationCode(
            code=authorization_code,
            scopes=list(data.get("scopes") or []),
            expires_at=float(data.get("expires_at") or 0),
            client_id=client.client_id,
            code_challenge=str(data.get("code_challenge") or ""),
            redirect_uri=AnyUrl(str(data.get("redirect_uri"))),
            redirect_uri_provided_explicitly=bool(data.get("redirect_uri_provided_explicitly")),
            resource=data.get("resource"),
            subject=data.get("app_user_id"),
            grant_id=str(data.get("grant_id")),
        )

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AgentAuthorizationCode
    ) -> OAuthToken:
        taken = await store.redis_take(f"code:{authorization_code.code}")
        if not taken:
            raise TokenError("invalid_grant", "authorization code already used")
        grant = await store.get_grant(authorization_code.grant_id)
        if not grant or not store.grant_is_live(grant):
            raise TokenError("invalid_grant", "grant is not active")
        access_raw, refresh_raw, _expires = await store.mint_token_pair(grant["id"])
        await store.touch_client(client.client_id)
        return OAuthToken(
            access_token=access_raw,
            token_type="Bearer",
            expires_in=ACCESS_TOKEN_TTL_SECONDS,
            scope=" ".join(grant.get("scopes") or []),
            refresh_token=refresh_raw,
        )

    # ── refresh ────────────────────────────────────────────────────────

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> AgentRefreshToken | None:
        row = await store.find_token(refresh_token, "refresh")
        if not row:
            return None
        grant = await store.get_grant(row["grant_id"])
        if (
            not grant
            or not store.grant_is_live(grant)
            or grant.get("client_id") != client.client_id
        ):
            return None
        expires = store.parse_dt(row.get("expires_at"))
        return AgentRefreshToken(
            token=refresh_token,
            client_id=client.client_id,
            scopes=list(grant.get("scopes") or []),
            expires_at=int(expires.timestamp()) if expires else None,
            subject=grant.get("app_user_id"),
            grant_id=grant["id"],
            pair_id=row["pair_id"],
        )

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: AgentRefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        granted = set(refresh_token.scopes)
        wanted = set(scopes) if scopes else granted
        if not wanted.issubset(granted):
            raise TokenError("invalid_scope", "requested scope exceeds the grant")
        await store.revoke_pair(refresh_token.pair_id)
        access_raw, refresh_raw, _expires = await store.mint_token_pair(refresh_token.grant_id)
        await store.touch_client(client.client_id)
        return OAuthToken(
            access_token=access_raw,
            token_type="Bearer",
            expires_in=ACCESS_TOKEN_TTL_SECONDS,
            scope=" ".join(sorted(wanted)),
            refresh_token=refresh_raw,
        )

    # ── access tokens ──────────────────────────────────────────────────

    async def load_access_token(self, token: str) -> AgentAccessToken | None:
        row = await store.find_token(token, "access")
        if not row:
            return None
        grant = await store.get_grant(row["grant_id"])
        if not grant or not store.grant_is_live(grant):
            return None
        expires = store.parse_dt(row.get("expires_at"))
        return AgentAccessToken(
            token=token,
            client_id=str(grant.get("client_id")),
            scopes=list(grant.get("scopes") or []),
            expires_at=int(expires.timestamp()) if expires else None,
            resource=resource_url(),
            subject=grant.get("app_user_id"),
            claims={"iss": issuer_url()},
            grant_id=grant["id"],
            pair_id=row["pair_id"],
        )

    async def verify_token(self, token: str) -> AccessToken | None:
        return await self.load_access_token(token)

    async def revoke_token(self, token: AgentAccessToken | AgentRefreshToken) -> None:
        await store.revoke_pair(token.pair_id)

    async def exchange_identity_assertion(
        self,
        client: OAuthClientInformationFull,  # noqa: ARG002
        params: IdentityAssertionParams,  # noqa: ARG002
    ) -> OAuthToken:
        # Enterprise IdP assertions (SEP-990) are not offered: every grant
        # starts at the consent page.
        raise TokenError("unsupported_grant_type", "identity assertions are not supported")


# ── consent outcome (called by the management API) ─────────────────────────


async def load_authorize_request(request_id: str) -> Optional[dict[str, Any]]:
    return await store.redis_get(f"authz:{request_id}")


async def approve_authorize_request(
    *,
    request_id: str,
    app_user_id: str,
    directus_user_id: str,
    org_ids: list[str],
    scopes: list[str],
    expires_in_days: int,
    consent_version: str,
) -> str:
    """Create the grant and the single-use code. Returns the redirect back to
    the client. Raises ValueError when the request is unknown or expired."""
    pending = await store.redis_take(f"authz:{request_id}")
    if not pending:
        raise ValueError("authorization request expired")
    requested = set(pending.get("scopes") or [SCOPE_READ])
    granted = sorted(set(scopes) & requested & set(VALID_SCOPES))
    if SCOPE_READ not in granted:
        granted.insert(0, SCOPE_READ)
    grant = await store.create_grant(
        app_user_id=app_user_id,
        directus_user_id=directus_user_id,
        client_id=str(pending["client_id"]),
        client_name=pending.get("client_name"),
        org_ids=org_ids,
        scopes=granted,
        expires_at=datetime.now(timezone.utc) + timedelta(days=expires_in_days),
        consent_version=consent_version,
    )
    code = generate_uuid()
    await store.redis_put(
        f"code:{code}",
        {
            "client_id": pending["client_id"],
            "grant_id": grant["id"],
            "app_user_id": app_user_id,
            "scopes": granted,
            "code_challenge": pending.get("code_challenge"),
            "redirect_uri": pending.get("redirect_uri"),
            "redirect_uri_provided_explicitly": pending.get("redirect_uri_provided_explicitly"),
            "resource": pending.get("resource"),
            "expires_at": time.time() + AUTH_CODE_TTL_SECONDS,
        },
        AUTH_CODE_TTL_SECONDS,
    )
    return construct_redirect_uri(
        str(pending["redirect_uri"]), code=code, state=pending.get("state")
    )


async def deny_authorize_request(request_id: str) -> str:
    pending = await store.redis_take(f"authz:{request_id}")
    if not pending:
        raise ValueError("authorization request expired")
    return construct_redirect_uri(
        str(pending["redirect_uri"]),
        error="access_denied",
        error_description="The user declined",
        state=pending.get("state"),
    )
