from typing import Any, Optional, TypedDict, cast
from urllib.parse import urlparse

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
    matches: list[dict[str, Optional[str]]]


class AgentProjectConversationsResponse(TypedDict, total=False):
    project_id: str
    count: int
    conversations: list[AgentProjectConversation]


class ProjectGoalResponse(TypedDict, total=False):
    project_id: str
    current: Optional[dict[str, Any]]
    revisions: list[dict[str, Any]]


def portal_base_url_for_cors_origins(agent_cors_origins: str) -> str | None:
    for origin in agent_cors_origins.split(","):
        candidate = origin.strip()
        if not candidate:
            continue
        parsed = urlparse(candidate)
        if (parsed.hostname or "").startswith("portal."):
            return f"{parsed.scheme}://{parsed.netloc}"
    return None


def portal_base_url_for_api_url(echo_api_url: str) -> str | None:
    parsed = urlparse(echo_api_url)
    hostname = parsed.hostname or ""
    scheme = parsed.scheme or "https"

    if hostname in {"localhost", "127.0.0.1", "0.0.0.0"}:
        return "http://localhost:5174"

    explicit_hosts = {
        "api.echo-next.dembrane.com": "https://portal.echo-next.dembrane.com",
        "api.echo-testing.dembrane.com": "https://portal.echo-testing.dembrane.com",
        "api.dembrane.com": "https://portal.dembrane.com",
    }
    if hostname in explicit_hosts:
        return explicit_hosts[hostname]

    if hostname.startswith("api."):
        return f"{scheme}://portal.{hostname.removeprefix('api.')}"
    return None


def normalize_portal_language(language: Any) -> str:
    value = str(language or "").strip()
    if not value or value == "default":
        return "en"
    return value


def build_project_portal_link(
    project_id: str,
    language: Any,
    echo_api_url: str | None = None,
    agent_cors_origins: str | None = None,
) -> str | None:
    settings = get_settings()
    base_url = portal_base_url_for_cors_origins(
        agent_cors_origins
        if agent_cors_origins is not None
        else settings.agent_cors_origins
    ) or portal_base_url_for_api_url(echo_api_url or settings.echo_api_url)
    if base_url is None:
        return None
    normalized_language = normalize_portal_language(language)
    return f"{base_url}/{normalized_language}/{project_id}/start"


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

    async def get_project_settings(self, project_id: str) -> dict[str, Any]:
        payload = await self.get(f"/agentic/projects/{project_id}/settings")
        return payload if isinstance(payload, dict) else {}

    async def list_project_tags(self, project_id: str) -> list[dict[str, Any]]:
        payload = await self.get(f"/v2/bff/tags?project_id={project_id}")
        return payload if isinstance(payload, list) else []

    async def get_conversation_transcript(self, conversation_id: str) -> str:
        response = await self._client.get(f"/conversations/{conversation_id}/transcript")
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, str):
            return payload
        if isinstance(payload, dict) and isinstance(payload.get("transcript"), str):
            return payload["transcript"]
        return str(payload)

    async def list_memory(self, project_id: str) -> dict[str, Any]:
        payload = await self.get(f"/agentic/projects/{project_id}/memory")
        return payload if isinstance(payload, dict) else {}

    async def get_project_goal(self, project_id: str) -> ProjectGoalResponse:
        payload = await self.get(f"/agentic/projects/{project_id}/goal")
        if not isinstance(payload, dict):
            raise ValueError("Unexpected project goal response shape")
        return cast(ProjectGoalResponse, payload)

    async def list_methodologies(self, project_id: str) -> dict[str, Any]:
        payload = await self.get(f"/agentic/projects/{project_id}/methodologies")
        return payload if isinstance(payload, dict) else {}

    async def list_canvases(self, project_id: str) -> list[dict[str, Any]]:
        payload = await self.get(f"/agentic/projects/{project_id}/canvases")
        return payload if isinstance(payload, list) else []

    async def list_chat_canvas_activity(
        self,
        project_id: str,
        chat_id: str,
        limit: int = 5,
    ) -> dict[str, Any]:
        response = await self._client.get(
            f"/agentic/projects/{project_id}/chats/{chat_id}/canvas-activity",
            params={"limit": limit},
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def get_canvas(self, project_id: str, canvas_id: str) -> dict[str, Any]:
        payload = await self.get(f"/agentic/projects/{project_id}/canvases/{canvas_id}")
        return payload if isinstance(payload, dict) else {}

    async def get_canvas_history(
        self,
        project_id: str,
        canvas_id: str,
        limit: int = 30,
    ) -> dict[str, Any]:
        response = await self._client.get(
            f"/agentic/projects/{project_id}/canvases/{canvas_id}/history",
            params={"limit": max(1, min(limit, 100))},
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def edit_canvas(
        self,
        project_id: str,
        canvas_id: str,
        instruction: str,
        content_html: str,
        chat_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "instruction": instruction,
            "content_html": content_html,
        }
        if chat_id:
            body["chat_id"] = chat_id
        response = await self._client.post(
            f"/agentic/projects/{project_id}/canvases/{canvas_id}/edit",
            json=body,
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def add_canvas_host_item(
        self,
        project_id: str,
        canvas_id: str,
        text: str,
        target_tab: str,
        person: str | None = None,
        chat_id: str | None = None,
        message_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"text": text, "target_tab": target_tab}
        if person:
            body["person"] = person
        if chat_id:
            body["chat_id"] = chat_id
        if message_id:
            body["message_id"] = message_id
        response = await self._client.post(
            f"/agentic/projects/{project_id}/canvases/{canvas_id}/host-items",
            json=body,
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def remove_canvas_host_item(
        self,
        project_id: str,
        canvas_id: str,
        item: str,
        chat_id: str | None = None,
        message_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"item": item}
        if chat_id:
            body["chat_id"] = chat_id
        if message_id:
            body["message_id"] = message_id
        response = await self._client.post(
            f"/agentic/projects/{project_id}/canvases/{canvas_id}/host-items/remove",
            json=body,
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def update_canvas_loop(
        self,
        project_id: str,
        canvas_id: str,
        action: str,
    ) -> dict[str, Any]:
        response = await self._client.post(
            f"/agentic/projects/{project_id}/canvases/{canvas_id}/loop/{action}"
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def write_memory(
        self,
        project_id: str,
        scope: str,
        content: str,
        memory_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"scope": scope, "content": content}
        if memory_key:
            body["memory_key"] = memory_key

        response = await self._client.post(
            f"/agentic/projects/{project_id}/memory",
            json=body,
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

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

    async def get_project_monitor(
        self,
        project_id: str,
        window_seconds: int = 45,
    ) -> dict[str, Any]:
        response = await self._client.get(
            f"/agentic/projects/{project_id}/monitor",
            params={"window_seconds": window_seconds},
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def list_project_chats(
        self,
        project_id: str,
        limit: int = 30,
        workspace_wide: bool = False,
    ) -> list[dict[str, Any]]:
        response = await self._client.get(
            f"/agentic/projects/{project_id}/chats",
            params={"limit": limit, "workspace_wide": workspace_wide},
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, list) else []

    async def read_chat(self, chat_id: str, limit: int = 100) -> list[dict[str, Any]]:
        response = await self._client.get(
            f"/agentic/chats/{chat_id}/messages",
            params={"limit": limit},
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, list) else []

    async def create_support_request(
        self,
        project_id: str,
        message: str,
        page_context: Optional[str] = None,
        chat_id: Optional[str] = None,
        app_user_id: Optional[str] = None,
        message_id: Optional[str] = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "message": message,
            "page_context": page_context,
            "chat_id": chat_id,
            "app_user_id": app_user_id,
            "message_id": message_id,
        }
        response = await self._client.post(
            f"/agentic/projects/{project_id}/support-request",
            json=body,
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def create_agent_insight(
        self,
        project_id: str,
        kind: str,
        content: str,
        suggested_capability: Optional[str] = None,
        chat_id: Optional[str] = None,
        message_id: Optional[str] = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "kind": kind,
            "content": content,
            "suggested_capability": suggested_capability,
            "chat_id": chat_id,
            "message_id": message_id,
        }
        response = await self._client.post(
            f"/agentic/projects/{project_id}/insight",
            json=body,
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}
