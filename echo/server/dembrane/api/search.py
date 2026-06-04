from __future__ import annotations

from typing import Any, Dict, List, Callable, Optional
from asyncio import gather
from datetime import datetime

from fastapi import Query, Depends, APIRouter
from pydantic import Field, BaseModel

from dembrane.directus import DirectusClient, directus
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
    workspaceId: Optional[str] = None
    displayLabel: str
    status: str
    startedAt: Optional[datetime] = None
    lastChunkAt: Optional[datetime] = None


class ProjectCard(BaseModel):
    id: str
    name: Optional[str] = None
    workspaceId: Optional[str] = None
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
    projectId: Optional[str] = None
    workspaceId: Optional[str] = None
    excerpt: Optional[str] = None
    timestamp: Optional[datetime] = None


class SearchChatResult(BaseModel):
    id: str
    projectId: Optional[str] = None
    projectName: Optional[str] = None
    workspaceId: Optional[str] = None
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
        return {
            "id": _safe_str(project_payload.get("id")),
            "name": _safe_str(project_payload.get("name")),
            "workspace_id": _safe_str(project_payload.get("workspace_id")),
        }

    return {"id": _safe_str(project_payload), "name": None, "workspace_id": None}


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
        workspaceId=project_ref.get("workspace_id"),
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
        workspaceId=_safe_str(payload.get("workspace_id")),
        lastActivityAt=updated_at,
        conversationsCount=conversations_count,
    )


def _search_like_filter(field: str, term: str) -> Dict[str, Any]:
    return {field: {"_icontains": term}}


def _fetch_projects(client: DirectusClient, term: str, limit: int) -> List[dict]:
    payload = client.get_items(
        "project",
        {
            "query": {
                "filter": {**_search_like_filter("name", term), "deleted_at": {"_null": True}},
                "fields": ["id", "name", "workspace_id", "updated_at", "count(conversations)"],
                "sort": ["-updated_at"],
                "limit": limit,
            }
        },
    )
    return payload if isinstance(payload, list) else []


def _fetch_conversations(client: DirectusClient, term: str, limit: int) -> List[dict]:
    payload = client.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "_and": [
                        {"deleted_at": {"_null": True}},
                        {"_or": [
                            _search_like_filter("participant_name", term),
                            _search_like_filter("participant_email", term),
                            _search_like_filter("summary", term),
                            _search_like_filter("id", term),
                        ]},
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
                    "project_id.id",
                    "project_id.name",
                    "project_id.workspace_id",
                    "chunks.timestamp",
                    "chunks.created_at",
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
    return payload if isinstance(payload, list) else []


def _fetch_chunks(client: DirectusClient, term: str, limit: int) -> List[dict]:
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
                    "conversation_id.id",
                    "conversation_id.participant_name",
                    "conversation_id.project_id.id",
                    "conversation_id.project_id.workspace_id",
                ],
                "sort": ["-timestamp"],
                "limit": limit,
            }
        },
    )
    return payload if isinstance(payload, list) else []


def _fetch_chats(client: DirectusClient, term: str, limit: int) -> List[dict]:
    payload = client.get_items(
        "project_chat",
        {
            "query": {
                "filter": {
                    "_and": [
                        {"deleted_at": {"_null": True}},
                        {"_or": [
                            _search_like_filter("name", term),
                            _search_like_filter("id", term),
                        ]},
                    ]
                },
                "fields": [
                    "id",
                    "name",
                    "project_id.id",
                    "project_id.name",
                    "project_id.workspace_id",
                ],
                "sort": ["-date_updated", "-date_created"],
                "limit": limit,
            }
        },
    )
    return payload if isinstance(payload, list) else []


def _project_id_of_row(row: Dict[str, Any]) -> Optional[str]:
    """Project id from a row with a `project_id` M2O (conversation, chat)."""
    ref = row.get("project_id")
    if isinstance(ref, dict):
        return _safe_str(ref.get("id"))
    return _safe_str(ref)


def _project_id_of_chunk(row: Dict[str, Any]) -> Optional[str]:
    conv = row.get("conversation_id")
    if not isinstance(conv, dict):
        return None
    proj = conv.get("project_id")
    if isinstance(proj, dict):
        return _safe_str(proj.get("id"))
    return _safe_str(proj)


def _normalize_chunk(item: Dict[str, Any]) -> SearchChunkResult:
    conversation_ref = item.get("conversation_id")
    conversation_id = None
    conversation_label = None
    project_id = None
    workspace_id = None
    if isinstance(conversation_ref, dict):
        conversation_id = _safe_str(conversation_ref.get("id"))
        conversation_label = _safe_str(conversation_ref.get("participant_name"))
        project_ref = conversation_ref.get("project_id")
        if isinstance(project_ref, dict):
            project_id = _safe_str(project_ref.get("id"))
            workspace_id = _safe_str(project_ref.get("workspace_id"))
        else:
            project_id = _safe_str(project_ref)
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

    return SearchChunkResult(
        id=_safe_str(item.get("id")) or "",
        conversationId=conversation_id,
        conversationLabel=conversation_label,
        projectId=project_id,
        workspaceId=workspace_id,
        excerpt=excerpt,
        timestamp=parsed_timestamp,
    )


def _normalize_chat(item: Dict[str, Any]) -> SearchChatResult:
    project_ref = _extract_project_reference(item.get("project_id"))
    return SearchChatResult(
        id=_safe_str(item.get("id")) or "",
        name=_safe_str(item.get("name")),
        projectId=project_ref.get("id"),
        projectName=project_ref.get("name"),
        workspaceId=project_ref.get("workspace_id"),
    )


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

    limit = max(1, min(limit, 25))
    # Post-lockdown the user token can't read app collections, so search
    # runs with the admin client and results are scoped in the app layer.
    # Over-fetch for non-staff so access filtering doesn't starve the
    # visible result count.
    fetch_limit = limit if auth.is_admin else limit * 3

    projects_raw, conversations_raw, chunks_raw, chats_raw = await gather(
        run_in_thread_pool(_fetch_projects, directus, term, fetch_limit),
        run_in_thread_pool(_fetch_conversations, directus, term, fetch_limit),
        run_in_thread_pool(_fetch_chunks, directus, term, fetch_limit),
        run_in_thread_pool(_fetch_chats, directus, term, fetch_limit),
    )

    if not auth.is_admin:
        from dembrane.app_user import resolve_app_user
        from dembrane.inheritance import get_user_project_access

        app_user = await resolve_app_user(auth.user_id)
        if not app_user:
            # Not onboarded: nothing is accessible; mirror the old
            # empty-results behavior instead of erroring the palette.
            return SearchResponse()
        app_user_id = app_user["id"]

        allowed: Dict[str, bool] = {}

        async def _can_access(project_id: Optional[str]) -> bool:
            if not project_id:
                return False
            if project_id not in allowed:
                access = await get_user_project_access(
                    project_id=project_id,
                    user_id=app_user_id,
                    directus_user_id=auth.user_id,
                )
                allowed[project_id] = access is not None
            return allowed[project_id]

        async def _scope(
            rows: List[dict], project_id_of: Callable[[Dict[str, Any]], Optional[str]]
        ) -> List[dict]:
            out: List[dict] = []
            for row in rows:
                if await _can_access(project_id_of(row)):
                    out.append(row)
                    if len(out) >= limit:
                        break
            return out

        projects_raw = await _scope(projects_raw, lambda r: _safe_str(r.get("id")))
        conversations_raw = await _scope(conversations_raw, _project_id_of_row)
        chunks_raw = await _scope(chunks_raw, _project_id_of_chunk)
        chats_raw = await _scope(chats_raw, _project_id_of_row)

    return SearchResponse(
        projects=[
            SearchProjectResult.model_validate(_normalize_project(item).model_dump())
            for item in projects_raw[:limit]
        ],
        conversations=[
            SearchConversationResult(
                **_normalize_conversation(item).model_dump(),
                summary=_safe_str(item.get("summary")),
            )
            for item in conversations_raw[:limit]
        ],
        transcripts=[_normalize_chunk(item) for item in chunks_raw[:limit]],
        chats=[_normalize_chat(item) for item in chats_raw[:limit]],
    )
