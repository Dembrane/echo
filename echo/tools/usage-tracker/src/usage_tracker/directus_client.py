"""Simplified Directus client for the usage tracker."""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urljoin

import backoff
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)

# HTTP status codes that are recoverable with retry
RECOVERABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}


class DirectusError(Exception):
    """Base exception for Directus errors."""


class DirectusConnectionError(DirectusError):
    """Connection failed."""


class DirectusAuthError(DirectusError):
    """Authentication failed."""


class DirectusRequestError(DirectusError):
    """Request failed."""


def _on_backoff(details: dict) -> None:
    """Log backoff retry attempts."""
    wait = details["wait"]
    tries = details["tries"]
    target = details.get("target", {})
    func_name = getattr(target, "__name__", "request")
    logger.warning(
        f"Backing off {func_name}(...) for {wait:.1f}s after {tries} tries"
    )


def _on_giveup(details: dict) -> None:
    """Log when retries are exhausted."""
    tries = details["tries"]
    elapsed = details.get("elapsed", 0)
    logger.error(f"Gave up after {tries} tries ({elapsed:.1f}s elapsed)")


class DirectusClient:
    """
    A simplified Directus client focused on read operations for the usage tracker.

    Uses static token authentication (no session management needed).
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        verify_ssl: bool = True,
        timeout: int = 180,
        max_retries: int = 5,
        pool_connections: int = 20,
        pool_maxsize: int = 20,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.verify_ssl = verify_ssl
        self.timeout = timeout
        self.max_retries = max_retries

        # Create a retry strategy for urllib3 (no automatic retries - we use backoff)
        retry_strategy = Retry(
            total=0,
            backoff_factor=0,
        )

        adapter = HTTPAdapter(
            pool_connections=pool_connections,
            pool_maxsize=pool_maxsize,
            max_retries=retry_strategy,
        )

        self._session = requests.Session()
        self._session.mount("http://", adapter)
        self._session.mount("https://", adapter)
        self._session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            }
        )

    def _url(self, path: str) -> str:
        """Build full URL from path."""
        if not path.startswith("/"):
            path = f"/{path}"
        return urljoin(self.base_url, path)

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Make an HTTP request with exponential backoff retry logic.

        Returns the 'data' field from the response.
        """
        url = self._url(path)

        @backoff.on_exception(
            backoff.expo,
            (requests.exceptions.ConnectionError, requests.exceptions.Timeout, DirectusRequestError),
            max_tries=self.max_retries,
            max_time=300,  # Max 5 minutes total
            on_backoff=_on_backoff,
            on_giveup=_on_giveup,
            jitter=backoff.full_jitter,
        )
        def _do_request() -> Dict[str, Any]:
            response = self._session.request(
                method=method,
                url=url,
                params=params,
                json=json_data,
                verify=self.verify_ssl,
                timeout=self.timeout,
            )

            # Handle auth errors immediately (don't retry)
            if response.status_code in (401, 403):
                raise DirectusAuthError(
                    f"Authentication failed: {response.status_code} - {response.text[:200]}"
                )

            # Retry recoverable errors via exception
            if response.status_code in RECOVERABLE_STATUS_CODES:
                raise DirectusRequestError(
                    f"Recoverable error {response.status_code}: {response.text[:200]}"
                )

            # Raise on other errors (don't retry)
            if response.status_code >= 400:
                raise DirectusRequestError(
                    f"Request failed: {response.status_code} - {response.text[:500]}"
                )

            # Parse response
            result = response.json()
            return result.get("data", result)

        try:
            return _do_request()
        except requests.exceptions.ConnectionError as e:
            raise DirectusConnectionError(f"Connection failed: {e}") from e
        except requests.exceptions.Timeout as e:
            raise DirectusConnectionError(f"Request timed out: {e}") from e

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Perform a GET request."""
        return self._request("GET", path, params=params)

    def search(self, path: str, query: Optional[Dict[str, Any]] = None) -> Any:
        """
        Perform a SEARCH request (Directus uses this for complex queries).

        Falls back to GET with params if SEARCH fails.
        """
        if query is None:
            return self.get(path)

        try:
            return self._request("SEARCH", path, json_data=query)
        except DirectusRequestError:
            # Some Directus versions don't support SEARCH, fall back to GET
            logger.debug("SEARCH not supported, falling back to GET with params")
            flat_params = self._flatten_query(query.get("query", query))
            return self.get(path, params=flat_params)

    def _flatten_query(self, query: Dict[str, Any]) -> Dict[str, str]:
        """Flatten a nested query dict to URL params (limited support)."""
        import json as json_module

        params = {}
        for key, value in query.items():
            if isinstance(value, (dict, list)):
                params[key] = json_module.dumps(value)
            else:
                params[key] = str(value)
        return params

    # -------------------------------------------------------------------------
    # High-level methods
    # -------------------------------------------------------------------------

    def get_users(
        self,
        fields: Optional[List[str]] = None,
        filter_query: Optional[Dict[str, Any]] = None,
        limit: int = -1,
    ) -> List[Dict[str, Any]]:
        """
        Get Directus users.

        Args:
            fields: Fields to return (default: id, email, first_name, last_name)
            filter_query: Filter conditions
            limit: Max results (-1 for all)
        """
        if fields is None:
            fields = ["id", "email", "first_name", "last_name"]

        query: Dict[str, Any] = {
            "query": {
                "fields": fields,
                "limit": limit,
                "sort": ["email"],
            }
        }
        if filter_query:
            query["query"]["filter"] = filter_query

        result = self.search("/users", query)
        return result if isinstance(result, list) else []

    def get_items(
        self,
        collection: str,
        fields: Optional[List[str]] = None,
        filter_query: Optional[Dict[str, Any]] = None,
        sort: Optional[List[str]] = None,
        limit: int = -1,
        offset: int = 0,
        deep: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Get items from a collection.

        Args:
            collection: Collection name
            fields: Fields to return
            filter_query: Filter conditions
            sort: Sort order
            limit: Max results (-1 for all)
            offset: Pagination offset
            deep: Deep filter/sort for relations
        """
        query: Dict[str, Any] = {"query": {"limit": limit}}

        if fields:
            query["query"]["fields"] = fields
        if filter_query:
            query["query"]["filter"] = filter_query
        if sort:
            query["query"]["sort"] = sort
        if offset > 0:
            query["query"]["offset"] = offset
        if deep:
            query["query"]["deep"] = deep

        result = self.search(f"/items/{collection}", query)
        return result if isinstance(result, list) else []

    def get_item_count(
        self,
        collection: str,
        filter_query: Optional[Dict[str, Any]] = None,
    ) -> int:
        """
        Get count of items in a collection using aggregate.

        More efficient than fetching all items.
        """
        query: Dict[str, Any] = {
            "query": {
                "aggregate": {"count": "*"},
            }
        }
        if filter_query:
            query["query"]["filter"] = filter_query

        result = self.search(f"/items/{collection}", query)

        # Handle different response formats
        if isinstance(result, list) and result:
            count_data = result[0]
            if isinstance(count_data, dict):
                count = count_data.get("count", 0)
                if isinstance(count, dict):
                    return int(count.get("*", 0) or count.get("id", 0) or 0)
                return int(count or 0)
        return 0

    def get_aggregate(
        self,
        collection: str,
        aggregate: Dict[str, Any],
        filter_query: Optional[Dict[str, Any]] = None,
        group_by: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Get aggregated data from a collection.

        Args:
            collection: Collection name
            aggregate: Aggregate functions (e.g., {"sum": "duration", "count": "*"})
            filter_query: Filter conditions
            group_by: Fields to group by
        """
        query: Dict[str, Any] = {
            "query": {
                "aggregate": aggregate,
                "limit": -1,
            }
        }
        if filter_query:
            query["query"]["filter"] = filter_query
        if group_by:
            query["query"]["groupBy"] = group_by

        result = self.search(f"/items/{collection}", query)
        return result if isinstance(result, list) else []

    def test_connection(self) -> bool:
        """Test if the connection to Directus works."""
        try:
            self.get("/server/info")
            return True
        except DirectusError:
            return False

    def get_server_info(self) -> Dict[str, Any]:
        """Get Directus server info."""
        return self.get("/server/info")
