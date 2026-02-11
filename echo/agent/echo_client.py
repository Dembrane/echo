"""
Echo API client placeholder for future tool expansion.

Use this from agent tools once server gateway contracts are finalized.
"""

from typing import Any, Optional

import httpx

from settings import get_settings


class EchoClient:
    def __init__(self, bearer_token: Optional[str] = None) -> None:
        settings = get_settings()
        headers: dict[str, str] = {}
        if bearer_token:
            headers["Authorization"] = f"Bearer {bearer_token}"
        self._client = httpx.AsyncClient(
            base_url=settings.echo_api_url,
            headers=headers,
            timeout=30.0,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def get(self, path: str) -> Any:
        response = await self._client.get(path)
        response.raise_for_status()
        return response.json()
