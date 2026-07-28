"""
Async Directus client for FastAPI endpoints.

Uses httpx.AsyncClient for non-blocking I/O. Same API surface and return
value semantics as the sync DirectusClient in directus.py.

Usage:
    from dembrane.directus_async import async_directus, create_async_directus_client

    # Module-level singleton (admin token)
    items = await async_directus.get_items("collection", {"query": {"filter": {...}}})

    # Per-request client (user token)
    client = create_async_directus_client(token=user_jwt)
    items = await client.get_items("collection", {"query": {"filter": {...}}})

Return value contract (matches sync client):
    - create_item() returns {"data": {...}} — caller MUST unwrap with ["data"]
    - get_items() returns list directly
    - get_item() returns dict directly
    - update_item() returns {"data": {...}} — caller MUST unwrap with ["data"]
    - delete_item() returns None
"""

from __future__ import annotations

import json
import asyncio
import logging
from typing import Any

import httpx

from dembrane.directus import (
    DirectusBadRequest,
    DirectusServerError,
)
from dembrane.settings import get_settings

logger = logging.getLogger(__name__)

RECOVERABLE_STATUS_CODES = {401, 403, 408, 429, 500, 502, 503, 504}

DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_DELAY = 1.0


def _is_forbidden_record(response: "httpx.Response") -> bool:
    """Directus returns 403 FORBIDDEN (not 404) for a missing/inaccessible
    single item. Matches only that, never a 401/token failure."""
    if response.status_code != 403:
        return False
    try:
        body = response.json()
    except Exception:
        return False
    if not isinstance(body, dict):
        return False
    errors = body.get("errors") or []
    first = errors[0] if errors else {}
    code = (first.get("extensions") or {}).get("code")
    return code == "FORBIDDEN"


class AsyncDirectusClient:
    """Async Directus HTTP client using httpx.AsyncClient."""

    def __init__(
        self,
        url: str,
        token: str | None = None,
        verify: bool = False,
    ):
        self.url = url.rstrip("/")
        self.token = token or ""
        self._clients_by_loop: dict[int, httpx.AsyncClient] = {}
        self._verify = verify

    @property
    def _client(self) -> httpx.AsyncClient | None:
        """Compatibility hook for tests that inject the current loop's client."""
        loop_id = id(asyncio.get_running_loop())
        return self._clients_by_loop.get(loop_id)

    @_client.setter
    def _client(self, client: httpx.AsyncClient | None) -> None:
        loop_id = id(asyncio.get_running_loop())
        if client is None:
            self._clients_by_loop.pop(loop_id, None)
        else:
            self._clients_by_loop[loop_id] = client

    def _get_client(self) -> httpx.AsyncClient:
        """Lazy-init one httpx.AsyncClient per event loop."""
        loop_id = id(asyncio.get_running_loop())
        client = self._clients_by_loop.get(loop_id)
        if client is None or client.is_closed:
            client = httpx.AsyncClient(
                base_url=self.url,
                headers={"Authorization": f"Bearer {self.token}"},
                verify=self._verify,
                timeout=DEFAULT_TIMEOUT,
            )
            self._clients_by_loop[loop_id] = client
        return client

    async def close(self) -> None:
        """Close all underlying httpx clients. Call on shutdown."""
        clients = list(self._clients_by_loop.values())
        self._clients_by_loop.clear()
        for client in clients:
            if not client.is_closed:
                await client.aclose()

    def reset_clients(self) -> int:
        """
        Drop all cached httpx clients without awaiting close.

        This is a recovery hook for loop/library corruption in long-lived
        workers. The next request creates a fresh client on the current loop.
        """
        clients = list(self._clients_by_loop.values())
        self._clients_by_loop.clear()
        return len(clients)

    # ------------------------------------------------------------------
    # Low-level request with retry
    # ------------------------------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        *,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_delay: float = DEFAULT_RETRY_DELAY,
        recoverable_status_codes: "set[int] | None" = None,
        **kwargs: Any,
    ) -> httpx.Response:
        """Make an HTTP request with retry logic for recoverable errors.

        At most `max_retries` requests are sent. A response with a
        recoverable status that persists through every attempt is
        returned as-is so callers can interpret the Directus error
        envelope; transport errors raise once retries are exhausted.
        """
        client = self._get_client()
        recoverable = (
            recoverable_status_codes
            if recoverable_status_codes is not None
            else RECOVERABLE_STATUS_CODES
        )
        retries = 0

        while True:
            try:
                response = await client.request(method, path, **kwargs)
            except httpx.HTTPError:
                retries += 1
                if retries >= max_retries:
                    raise
                await asyncio.sleep(retry_delay * (2 ** (retries - 1)))
                continue

            if response.status_code in recoverable:
                retries += 1
                if retries >= max_retries:
                    return response
                await asyncio.sleep(retry_delay * (2 ** (retries - 1)))
                continue

            return response

    # ------------------------------------------------------------------
    # HTTP verbs (match sync client return semantics)
    # ------------------------------------------------------------------

    async def get(self, path: str, none_on_forbidden: bool = False, **kwargs: Any) -> Any:
        """GET request. Returns response.json()["data"].

        none_on_forbidden: return None (not raise, not retried) on a record-level
        403 FORBIDDEN, so callers can do ``if not item: raise 404``.
        """
        recoverable = RECOVERABLE_STATUS_CODES - {403} if none_on_forbidden else None
        try:
            response = await self._request(
                "GET", path, recoverable_status_codes=recoverable, **kwargs
            )
            if none_on_forbidden and _is_forbidden_record(response):
                return None
            try:
                data = response.json()
            except json.JSONDecodeError:
                return response.text

            if "errors" in data:
                raise AssertionError(data["errors"])

            return data["data"]
        except httpx.ConnectError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    async def post(self, path: str, **kwargs: Any) -> dict[str, Any]:
        """POST request. Returns full response.json() (includes {"data": ...})."""
        try:
            response = await self._request("POST", path, **kwargs)
            if response.status_code not in (200, 201):
                raise AssertionError(response.text)
            return response.json()
        except httpx.ConnectError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    async def search(self, path: str, query: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        """SEARCH request. Returns response.json()["data"] (list).

        Failure modes the caller cares about:
          - permission denied / collection missing: Directus responds
            200/4xx with `{"errors": [...]}` and no `data` key. We log
            at warning level and return the error envelope so callers
            can tell "empty" from "broken" by `isinstance(..., list)`.
          - connection refused: raise DirectusServerError.
        """
        try:
            response = await self._request("SEARCH", path, json=query, **kwargs)
            try:
                body = response.json()
            except Exception:
                logger.warning(
                    "SEARCH %s returned non-JSON body (status=%s)",
                    path,
                    response.status_code,
                )
                return {"error": "non-json response"}
            if isinstance(body, dict) and "data" in body:
                return body["data"]
            # No 'data' key — surface Directus's error envelope if present,
            # at warning level. Previously crashed with KeyError 'data'
            # which masked the underlying permission / schema issue.
            if isinstance(body, dict) and "errors" in body:
                first = (body["errors"] or [{}])[0]
                msg = first.get("message") or "unknown error"
                logger.warning(
                    "SEARCH %s (status=%s) errored: %s",
                    path,
                    response.status_code,
                    msg,
                )
                return {"error": msg}
            logger.warning(
                "SEARCH %s returned unexpected shape (status=%s)",
                path,
                response.status_code,
            )
            return {"error": "unexpected response shape"}
        except httpx.ConnectError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    async def patch(self, path: str, **kwargs: Any) -> dict[str, Any]:
        """PATCH request. Returns full response.json() (includes {"data": ...})."""
        try:
            response = await self._request("PATCH", path, **kwargs)
            if response.status_code not in (200, 204):
                raise AssertionError(response.text)
            return response.json()
        except httpx.ConnectError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    async def delete(self, path: str, **kwargs: Any) -> None:
        """DELETE request. Returns None."""
        try:
            response = await self._request("DELETE", path, **kwargs)
            if response.status_code != 204:
                raise AssertionError(response.text)
        except httpx.ConnectError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    # ------------------------------------------------------------------
    # Collection CRUD (match sync client method signatures exactly)
    # ------------------------------------------------------------------

    async def get_items(
        self, collection: str, params: dict[str, Any] | None = None, **kwargs: Any
    ) -> Any:
        """Get items from a collection. Returns list directly.

        Usage: items = await client.get_items("coll", {"query": {"filter": {...}}})
        """
        return await self.search(f"/items/{collection}", query=params, **kwargs)

    async def get_item(self, collection: str, item_id: str, **kwargs: Any) -> Any:
        """Get a single item, or None when it doesn't exist / isn't accessible
        (Directus answers 403 FORBIDDEN for both)."""
        return await self.get(f"/items/{collection}/{item_id}", none_on_forbidden=True, **kwargs)

    async def create_item(
        self, collection: str, data: dict[str, Any] | list[dict[str, Any]], **kwargs: Any
    ) -> dict[str, Any]:
        """Create item(s). Returns {"data": {...}} — caller MUST unwrap with ["data"]."""
        return await self.post(f"/items/{collection}", json=data, **kwargs)

    async def update_item(
        self, collection: str, item_id: str, data: dict[str, Any], **kwargs: Any
    ) -> dict[str, Any]:
        """Update an item. Returns {"data": {...}} — caller MUST unwrap with ["data"]."""
        return await self.patch(f"/items/{collection}/{item_id}", json=data, **kwargs)

    async def delete_item(self, collection: str, item_id: str, **kwargs: Any) -> None:
        """Delete an item. Returns None."""
        await self.delete(f"/items/{collection}/{item_id}", **kwargs)

    # ------------------------------------------------------------------
    # User operations
    # ------------------------------------------------------------------

    async def get_users(self, query: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        """Get users. Returns list directly."""
        return await self.search("/users", query=query, **kwargs)

    async def get_user(self, user_id: str, **kwargs: Any) -> Any:
        """Get a single user. Returns dict directly."""
        return await self.get(f"/users/{user_id}", **kwargs)

    # ------------------------------------------------------------------
    # File operations
    # ------------------------------------------------------------------

    async def delete_file(self, file_id: str, **kwargs: Any) -> None:
        """Delete a file."""
        await self.delete(f"/files/{file_id}", **kwargs)

    # ------------------------------------------------------------------
    # Mail (for workspace invites)
    # ------------------------------------------------------------------

    async def send_mail(
        self,
        to: str | list[str],
        subject: str,
        template_name: str,
        template_data: dict[str, Any],
    ) -> dict[str, Any]:
        """Send email via Directus /utils/mail/send endpoint.

        Requires admin token. Uses Directus's configured email transport
        (SendGrid SMTP) and Liquid templates from directus/templates/.
        """
        return await self.post(
            "/utils/mail/send",
            json={
                "to": to if isinstance(to, list) else [to],
                "subject": subject,
                "template": {
                    "name": template_name,
                    "data": template_data,
                },
            },
        )


# ---------------------------------------------------------------------------
# Factory + singleton
# ---------------------------------------------------------------------------

_settings = get_settings()
_DEFAULT_VERIFY = bool(getattr(_settings.directus, "verify_ssl", False))


def create_async_directus_client(
    *,
    token: str | None = None,
    verify: bool | None = None,
) -> AsyncDirectusClient:
    """Factory for AsyncDirectusClient instances."""
    return AsyncDirectusClient(
        url=_settings.directus.base_url,
        token=token,
        verify=verify if verify is not None else _DEFAULT_VERIFY,
    )


# Module-level admin client singleton.
# Used by workspace/org endpoints that need full access.
async_directus = create_async_directus_client(token=_settings.directus.token)
