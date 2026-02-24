from typing import Any, Optional, TypedDict, cast

import httpx

from settings import get_settings


class SearchConversationResult(TypedDict, total=False):
    id: str
    projectId: str
    projectName: Optional[str]
    displayLabel: str
    status: str
    startedAt: Optional[str]
    lastChunkAt: Optional[str]
    summary: Optional[str]


class SearchTranscriptResult(TypedDict, total=False):
    id: str
    conversationId: Optional[str]
    conversationLabel: Optional[str]
    excerpt: Optional[str]
    timestamp: Optional[str]


class HomeSearchResponse(TypedDict, total=False):
    projects: list[dict[str, Any]]
    conversations: list[SearchConversationResult]
    transcripts: list[SearchTranscriptResult]
    chats: list[dict[str, Any]]


class AgentProjectConversation(TypedDict, total=False):
    conversation_id: str
    participant_name: Optional[str]
    status: str
    summary: Optional[str]
    started_at: Optional[str]
    last_chunk_at: Optional[str]


class AgentProjectConversationsResponse(TypedDict, total=False):
    project_id: str
    count: int
    conversations: list[AgentProjectConversation]


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

    async def search_home(self, query: str, limit: int = 5) -> HomeSearchResponse:
        response = await self._client.get(
            "/home/search",
            params={"query": query, "limit": limit},
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("Unexpected search response shape")
        return cast(HomeSearchResponse, payload)

    async def get_conversation_transcript(self, conversation_id: str) -> str:
        response = await self._client.get(f"/conversations/{conversation_id}/transcript")
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, str):
            return payload
        if isinstance(payload, dict) and isinstance(payload.get("transcript"), str):
            return payload["transcript"]
        return str(payload)

    async def list_project_conversations(
        self,
        project_id: str,
        limit: int = 20,
        conversation_id: str | None = None,
        transcript_query: str | None = None,
    ) -> AgentProjectConversationsResponse:
        params: dict[str, object] = {"limit": limit}
        if conversation_id:
            params["conversation_id"] = conversation_id
        if transcript_query:
            params["transcript_query"] = transcript_query

        response = await self._client.get(
            f"/agentic/projects/{project_id}/conversations",
            params=params,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("Unexpected list project conversations response shape")
        return cast(AgentProjectConversationsResponse, payload)
