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
        self._client: httpx.AsyncClient | None = None
        self._verify = verify

    def _get_client(self) -> httpx.AsyncClient:
        """Lazy-init the httpx.AsyncClient. Reuses connection pool."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.url,
                headers={"Authorization": f"Bearer {self.token}"},
                verify=self._verify,
                timeout=DEFAULT_TIMEOUT,
            )
        return self._client

    async def close(self) -> None:
        """Close the underlying httpx client. Call on shutdown."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

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
        **kwargs: Any,
    ) -> httpx.Response:
        """Make an HTTP request with retry logic for recoverable errors."""
        client = self._get_client()
        retries = 0

        while retries < max_retries:
            try:
                response = await client.request(method, path, **kwargs)

                if response.status_code in RECOVERABLE_STATUS_CODES:
                    retries += 1
                    if retries == max_retries:
                        response.raise_for_status()

                    wait_time = retry_delay * (2 ** (retries - 1))
                    await asyncio.sleep(wait_time)
                    continue

                return response

            except httpx.HTTPError:
                retries += 1
                if retries == max_retries:
                    raise

                wait_time = retry_delay * (2 ** (retries - 1))
                await asyncio.sleep(wait_time)
                continue

        return await client.request(method, path, **kwargs)

    # ------------------------------------------------------------------
    # HTTP verbs (match sync client return semantics)
    # ------------------------------------------------------------------

    async def get(self, path: str, **kwargs: Any) -> Any:
        """GET request. Returns response.json()["data"]."""
        try:
            response = await self._request("GET", path, **kwargs)
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
                    path, response.status_code,
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
                    path, response.status_code, msg,
                )
                return {"error": msg}
            logger.warning(
                "SEARCH %s returned unexpected shape (status=%s)",
                path, response.status_code,
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
        """Get a single item. Returns dict directly."""
        return await self.get(f"/items/{collection}/{item_id}", **kwargs)

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
        return await self.post("/utils/mail/send", json={
            "to": to if isinstance(to, list) else [to],
            "subject": subject,
            "template": {
                "name": template_name,
                "data": template_data,
            },
        })


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
