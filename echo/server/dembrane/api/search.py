from __future__ import annotations

from typing import Any, Dict, List, Optional
from asyncio import gather
from datetime import datetime

from fastapi import Query, Depends, APIRouter
from pydantic import Field, BaseModel

from dembrane.directus import DirectusClient
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.api.dependency_auth import DependencyDirectusSession, require_directus_client

SearchRouter = APIRouter(
    tags=["search"],
    prefix="/home",
    dependencies=[Depends(require_directus_client)],
)

search_rate_limiter = create_user_rate_limiter(capacity=40, window_seconds=60, name="home_search")


class ConversationCard(BaseModel):
    id: str
    projectId: Optional[str] = None
    projectName: Optional[str] = None
    displayLabel: str
    status: str
    startedAt: Optional[datetime] = None
    lastChunkAt: Optional[datetime] = None


class ProjectCard(BaseModel):
    id: str
    name: Optional[str] = None
    lastActivityAt: Optional[datetime] = None
    conversationsCount: Optional[int] = None


class SearchConversationResult(ConversationCard):
    summary: Optional[str] = None


class SearchProjectResult(ProjectCard):
    pass


class SearchChunkResult(BaseModel):
    id: str
    conversationId: Optional[str] = None
    conversationLabel: Optional[str] = None
    excerpt: Optional[str] = None
    timestamp: Optional[datetime] = None


class SearchChatResult(BaseModel):
    id: str
    projectId: Optional[str] = None
    projectName: Optional[str] = None
    name: Optional[str] = None


class SearchResponse(BaseModel):
    projects: List[SearchProjectResult] = Field(default_factory=list)
    conversations: List[SearchConversationResult] = Field(default_factory=list)
    transcripts: List[SearchChunkResult] = Field(default_factory=list)
    chats: List[SearchChatResult] = Field(default_factory=list)


def _safe_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return str(value)
    except Exception:  # noqa: BLE001
        return None


def _conversation_status(payload: Dict[str, Any]) -> str:
    if not payload.get("is_finished"):
        return "live"
    if not payload.get("is_all_chunks_transcribed"):
        return "processing"
    return "done"


def _conversation_display_label(payload: Dict[str, Any]) -> str:
    participant_name = payload.get("participant_name")
    if isinstance(participant_name, str) and participant_name.strip():
        return participant_name

    participant_email = payload.get("participant_email")
    if isinstance(participant_email, str) and participant_email.strip():
        return participant_email

    short_id = _safe_str(payload.get("id"))
    if short_id:
        return f"Conversation {short_id[:6]}"

    return "Conversation"


def _extract_project_reference(project_payload: Any) -> Dict[str, Optional[str]]:
    if isinstance(project_payload, dict):
        project_id = _safe_str(project_payload.get("id"))
        name = _safe_str(project_payload.get("name"))
        return {"id": project_id, "name": name}

    project_id = _safe_str(project_payload)
    return {"id": project_id, "name": None}


def _extract_latest_chunk_timestamp(payload: Dict[str, Any]) -> Optional[datetime]:
    chunks = payload.get("chunks")
    if isinstance(chunks, list) and chunks:
        latest = chunks[0]
        if isinstance(latest, dict):
            timestamp = latest.get("timestamp") or latest.get("created_at")
            if isinstance(timestamp, str):
                try:
                    return datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                except ValueError:
                    return None
    return None


def _normalize_conversation(payload: Dict[str, Any]) -> ConversationCard:
    project_ref = _extract_project_reference(payload.get("project_id"))

    started_at_raw = payload.get("created_at")
    started_at = None
    if isinstance(started_at_raw, str):
        try:
            started_at = datetime.fromisoformat(started_at_raw.replace("Z", "+00:00"))
        except ValueError:
            started_at = None

    return ConversationCard(
        id=_safe_str(payload.get("id")) or "",
        projectId=project_ref.get("id"),
        projectName=project_ref.get("name"),
        displayLabel=_conversation_display_label(payload),
        status=_conversation_status(payload),
        startedAt=started_at,
        lastChunkAt=_extract_latest_chunk_timestamp(payload),
    )


def _normalize_project(payload: Dict[str, Any]) -> ProjectCard:
    updated_at_raw = payload.get("updated_at")
    updated_at = None
    if isinstance(updated_at_raw, str):
        try:
            updated_at = datetime.fromisoformat(updated_at_raw.replace("Z", "+00:00"))
        except ValueError:
            updated_at = None

    conversations_count = payload.get("conversations_count") or payload.get("count_conversations")
    if isinstance(conversations_count, dict):
        conversations_count = conversations_count.get("aggregate")
    if isinstance(conversations_count, dict):
        conversations_count = conversations_count.get("count")

    if isinstance(conversations_count, list) and conversations_count:
        conversations_count = conversations_count[0]

    if not isinstance(conversations_count, int):
        try:
            conversations_count = int(conversations_count or 0)
        except Exception:  # noqa: BLE001
            conversations_count = None

    return ProjectCard(
        id=_safe_str(payload.get("id")) or "",
        name=_safe_str(payload.get("name")),
        lastActivityAt=updated_at,
        conversationsCount=conversations_count,
    )


def _search_like_filter(field: str, term: str) -> Dict[str, Any]:
    return {field: {"_icontains": term}}


def _search_projects(client: DirectusClient, term: str, limit: int) -> List[SearchProjectResult]:
    payload = client.get_items(
        "project",
        {
            "query": {
                "filter": _search_like_filter("name", term),
                "fields": ["id", "name", "updated_at", "count(conversations)"],
                "sort": ["-updated_at"],
                "limit": limit,
            }
        },
    )
    if not isinstance(payload, list):
        return []
    results: List[SearchProjectResult] = []
    for item in payload:
        card = _normalize_project(item)
        results.append(SearchProjectResult.model_validate(card.model_dump()))
    return results


def _search_conversations(
    client: DirectusClient, term: str, limit: int
) -> List[SearchConversationResult]:
    payload = client.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "_or": [
                        _search_like_filter("participant_name", term),
                        _search_like_filter("participant_email", term),
                        _search_like_filter("summary", term),
                        _search_like_filter("id", term),
                    ]
                },
                "fields": [
                    "id",
                    "created_at",
                    "is_finished",
                    "is_all_chunks_transcribed",
                    "participant_name",
                    "participant_email",
                    "summary",
                    {
                        "project_id": ["id", "name"],
                    },
                    {
                        "chunks": [
                            "timestamp",
                            "created_at",
                        ],
                    },
                ],
                "deep": {
                    "chunks": {
                        "_limit": 1,
                        "_sort": "-timestamp",
                    }
                },
                "sort": ["-created_at"],
                "limit": limit,
            }
        },
    )

    if not isinstance(payload, list):
        return []

    results: List[SearchConversationResult] = []
    for item in payload:
        card = _normalize_conversation(item)
        results.append(
            SearchConversationResult(
                **card.model_dump(),
                summary=_safe_str(item.get("summary")),
            )
        )
    return results


def _search_chunks(client: DirectusClient, term: str, limit: int) -> List[SearchChunkResult]:
    payload = client.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {
                    "_or": [
                        _search_like_filter("transcript", term),
                        _search_like_filter("raw_transcript", term),
                    ]
                },
                "fields": [
                    "id",
                    "transcript",
                    "timestamp",
                    "created_at",
                    {
                        "conversation_id": ["id", "participant_name"],
                    },
                ],
                "sort": ["-timestamp"],
                "limit": limit,
            }
        },
    )

    if not isinstance(payload, list):
        return []

    results: List[SearchChunkResult] = []
    for item in payload:
        conversation_ref = item.get("conversation_id")
        conversation_id = None
        conversation_label = None
        if isinstance(conversation_ref, dict):
            conversation_id = _safe_str(conversation_ref.get("id"))
            conversation_label = _safe_str(conversation_ref.get("participant_name"))
        elif isinstance(conversation_ref, str):
            conversation_id = conversation_ref

        timestamp = item.get("timestamp") or item.get("created_at")
        parsed_timestamp = None
        if isinstance(timestamp, str):
            try:
                parsed_timestamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            except ValueError:
                parsed_timestamp = None

        excerpt = _safe_str(item.get("transcript"))
        if excerpt and len(excerpt) > 280:
            excerpt = f"{excerpt[:277]}…"

        results.append(
            SearchChunkResult(
                id=_safe_str(item.get("id")) or "",
                conversationId=conversation_id,
                conversationLabel=conversation_label,
                excerpt=excerpt,
                timestamp=parsed_timestamp,
            )
        )
    return results


def _search_chats(client: DirectusClient, term: str, limit: int) -> List[SearchChatResult]:
    payload = client.get_items(
        "project_chat",
        {
            "query": {
                "filter": {
                    "_or": [
                        _search_like_filter("name", term),
                        _search_like_filter("id", term),
                    ]
                },
                "fields": [
                    "id",
                    "name",
                    {
                        "project_id": ["id", "name"],
                    },
                ],
                "sort": ["-date_updated", "-date_created"],
                "limit": limit,
            }
        },
    )

    if not isinstance(payload, list):
        return []

    results: List[SearchChatResult] = []
    for item in payload:
        project_ref = _extract_project_reference(item.get("project_id"))
        results.append(
            SearchChatResult(
                id=_safe_str(item.get("id")) or "",
                name=_safe_str(item.get("name")),
                projectId=project_ref.get("id"),
                projectName=project_ref.get("name"),
            )
        )
    return results


@SearchRouter.get("/search", response_model=SearchResponse)
async def search_home(
    auth: DependencyDirectusSession,
    q: str = Query(..., min_length=1, max_length=120, alias="query"),
    limit: int = Query(5, ge=1, le=20),
) -> SearchResponse:
    await search_rate_limiter.check(auth.user_id)
    term = q.strip()
    if not term:
        return SearchResponse()

    client = auth.client
    limit = max(1, min(limit, 25))
    projects_task = run_in_thread_pool(_search_projects, client, term, limit)
    conversations_task = run_in_thread_pool(_search_conversations, client, term, limit)
    chunks_task = run_in_thread_pool(_search_chunks, client, term, limit)
    chats_task = run_in_thread_pool(_search_chats, client, term, limit)

    projects, conversations, chunks, chats = await gather(
        projects_task, conversations_task, chunks_task, chats_task
    )

    return SearchResponse(
        projects=projects,
        conversations=conversations,
        transcripts=chunks,
        chats=chats,
    )
