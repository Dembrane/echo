"""Thumbs up / down on language model output, generic over target types.

Adding a surface: add its name to TARGET_TYPES and IMPLEMENTED_TARGET_TYPES and
register a resolver in TARGET_RESOLVERS. Nothing else changes.
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Awaitable
from logging import getLogger
from datetime import datetime
from dataclasses import dataclass

from fastapi import Query, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.directus_async import async_directus
from dembrane.api.v2.feedback import _safe_replay_url
from dembrane.api.v2.bff._access import resolve_chat_message_access
from dembrane.api.dependency_auth import DirectusSession, DependencyDirectusSession

logger = getLogger("api.v2.feedback_responses")

router = APIRouter()

COLLECTION = "model_response_feedback"
RATING_VALUES = ("up", "down")
REASON_KEYS = (
    "incorrect",
    "missed_question",
    "wrong_sources",
    "too_long_or_unclear",
    "wrong_language_or_tone",
    "other",
)
TARGET_TYPES = ("chat_message", "report", "conversation_summary", "transcript")
CHAT_MODES = ("overview", "deep_dive", "agentic")
IMPLEMENTED_TARGET_TYPES = ("chat_message",)
MAX_COMMENT_LENGTH = 2000
MAX_SNAPSHOT_LENGTH = 20000
MAX_PROMPT_LENGTH = 4000
MAX_LIST_IDS = 500

_RATE_LIMITER = create_user_rate_limiter(name="feedback_responses", capacity=60, window_seconds=60)


@dataclass
class ResolvedTarget:
    project_id: str
    response_snapshot: str
    context: dict[str, Any]


Resolver = Callable[[str, DirectusSession], Awaitable[ResolvedTarget]]


def _parse_iso_datetime(value: str, field: str) -> str:
    """Reject anything Directus would choke on; a trailing Z is accepted."""
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(
            status_code=400, detail=f"{field} must be an ISO-8601 datetime"
        ) from None
    return value


def _relation_id(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        return value.get("id")
    return value if isinstance(value, str) else None


async def _resolve_chat_message(target_id: str, auth: DirectusSession) -> ResolvedTarget:
    access, msg, chat = await resolve_chat_message_access(target_id, auth)
    access.require("chat:use")
    if str(msg.get("message_from") or "").lower() != "assistant":
        raise HTTPException(status_code=400, detail="Only assistant messages can be rated")
    project_id = _relation_id(chat.get("project_id"))
    if not project_id:
        raise HTTPException(status_code=404, detail="Message not found")
    chat_id = _relation_id(chat.get("id")) or chat.get("id")
    context: dict[str, Any] = {"project_chat_id": chat_id, "chat_mode": chat.get("chat_mode")}
    prompt = await _preceding_user_message(chat_id, msg.get("date_created"))
    if prompt:
        context["prompt"] = prompt[:MAX_PROMPT_LENGTH]
    return ResolvedTarget(
        project_id=project_id,
        response_snapshot=str(msg.get("text") or "")[:MAX_SNAPSHOT_LENGTH],
        context=context,
    )


async def _preceding_user_message(chat_id: Optional[str], answered_at: Any) -> Optional[str]:
    """Nearest user turn before the answer, else the nearest after (legacy client clocks skew)."""
    if not chat_id:
        return None
    base: dict[str, Any] = {"project_chat_id": {"_eq": chat_id}, "message_from": {"_in": ["user", "User"]}}
    attempts: list[tuple[dict[str, Any], str]] = [(dict(base), "-date_created")]
    if answered_at:
        attempts = [
            ({**base, "date_created": {"_lte": answered_at}}, "-date_created"),
            ({**base, "date_created": {"_gt": answered_at}}, "date_created"),
        ]
    for filt, sort in attempts:
        try:
            rows = await async_directus.get_items(
                "project_chat_message",
                {"query": {"filter": filt, "fields": ["text"], "sort": [sort], "limit": 1}},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not load preceding user message for chat %s: %s", chat_id, exc)
            return None
        if isinstance(rows, list) and rows:
            text = str(rows[0].get("text") or "")
            if text:
                return text
    return None


TARGET_RESOLVERS: dict[str, Resolver] = {"chat_message": _resolve_chat_message}


class SetFeedbackBody(BaseModel):
    target_type: str
    target_id: str = Field(min_length=1, max_length=255)
    rating: str
    reasons: list[str] = Field(default_factory=list)
    comment: Optional[str] = Field(default=None, max_length=MAX_COMMENT_LENGTH)
    session_replay_url: Optional[str] = Field(default=None, max_length=2048)


class FeedbackRow(BaseModel):
    id: str
    target_type: str
    target_id: str
    rating: str
    reasons: list[str]
    comment: Optional[str] = None
    date_created: Optional[str] = None


def _row_to_model(row: dict[str, Any]) -> FeedbackRow:
    reasons = row.get("reasons")
    return FeedbackRow(
        id=str(row["id"]),
        target_type=row["target_type"],
        target_id=str(row["target_id"]),
        rating=row["rating"],
        reasons=[str(r) for r in reasons] if isinstance(reasons, list) else [],
        comment=row.get("comment"),
        date_created=row.get("date_created"),
    )


def _validate_body(body: SetFeedbackBody) -> None:
    if body.target_type not in IMPLEMENTED_TARGET_TYPES:
        raise HTTPException(status_code=400, detail="Unknown target type")
    if body.rating not in RATING_VALUES:
        raise HTTPException(status_code=400, detail="Rating must be up or down")
    unknown = [r for r in body.reasons if r not in REASON_KEYS]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown reason: {unknown[0]}")


async def _find_own_row(user_id: str, target_type: str, target_id: str) -> Optional[dict[str, Any]]:
    rows = await async_directus.get_items(
        COLLECTION,
        {"query": {
            "filter": {"user_id": {"_eq": user_id}, "target_type": {"_eq": target_type}, "target_id": {"_eq": target_id}},
            "fields": ["id", "rating", "reasons", "comment", "response_snapshot", "date_created"],
            "sort": ["date_created"],
            "limit": 1,
        }},
    )
    return rows[0] if isinstance(rows, list) and rows else None


def _unwrap(result: Any) -> dict[str, Any]:
    return result["data"] if isinstance(result, dict) and "data" in result else result


class AdminFeedbackRow(FeedbackRow):
    response_snapshot: Optional[str] = None
    context: dict[str, Any] = Field(default_factory=dict)
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    org_name: Optional[str] = None
    user_name: Optional[str] = None
    user_email: Optional[str] = None


class AdminFeedbackPage(BaseModel):
    items: list[AdminFeedbackRow]
    page: int
    limit: int
    total: int


@router.put("/responses", response_model=FeedbackRow)
async def set_response_feedback(body: SetFeedbackBody, auth: DependencyDirectusSession) -> FeedbackRow:
    await _RATE_LIMITER.check(auth.user_id)
    _validate_body(body)
    reasons = [] if body.rating == "up" else list(dict.fromkeys(body.reasons))
    comment = (body.comment or "").strip() or None
    resolved = await TARGET_RESOLVERS[body.target_type](body.target_id, auth)
    replay_url = _safe_replay_url(body.session_replay_url)

    existing = await _find_own_row(auth.user_id, body.target_type, body.target_id)
    if existing:
        row = await _apply_update(existing["id"], body.rating, reasons, comment)
    else:
        try:
            created = await async_directus.create_item(
                COLLECTION,
                {
                    "target_type": body.target_type,
                    "target_id": body.target_id,
                    "rating": body.rating,
                    "reasons": reasons,
                    "reason": reasons[0] if reasons else None,
                    "chat_mode": resolved.context.get("chat_mode"),
                    "comment": comment,
                    "response_snapshot": resolved.response_snapshot,
                    "context": {**resolved.context, **({"session_replay_url": replay_url} if replay_url else {})},
                    "project_id": resolved.project_id,
                    "user_id": auth.user_id,
                },
            )
            row = _unwrap(created)
        except Exception:
            # Lost a concurrent-create race on the unique index: update the winner's row.
            existing = await _find_own_row(auth.user_id, body.target_type, body.target_id)
            if not existing:
                raise
            logger.warning("create_item conflicted on model_response_feedback, falling back to update")
            row = await _apply_update(existing["id"], body.rating, reasons, comment)
    row.setdefault("target_type", body.target_type)
    row.setdefault("target_id", body.target_id)
    return _row_to_model(row)


async def _apply_update(
    row_id: Any, rating: str, reasons: list[str], comment: Optional[str]
) -> dict[str, Any]:
    updated = await async_directus.update_item(
        COLLECTION,
        str(row_id),
        {"rating": rating, "reasons": reasons, "reason": reasons[0] if reasons else None, "comment": comment},
    )
    return _unwrap(updated)


@router.get("/responses", response_model=list[FeedbackRow])
async def list_own_response_feedback(
    auth: DependencyDirectusSession,
    target_type: str = Query(...),
    target_ids: str = Query(..., description="Comma separated target ids"),
) -> list[FeedbackRow]:
    if target_type not in TARGET_TYPES:
        raise HTTPException(status_code=400, detail="Unknown target type")
    ids = [i.strip() for i in target_ids.split(",") if i.strip()]
    if not ids:
        return []
    if len(ids) > MAX_LIST_IDS:
        raise HTTPException(status_code=400, detail=f"At most {MAX_LIST_IDS} ids per request")
    rows = await async_directus.get_items(
        COLLECTION,
        {"query": {
            "filter": {"user_id": {"_eq": auth.user_id}, "target_type": {"_eq": target_type}, "target_id": {"_in": ids}},
            "fields": ["id", "target_type", "target_id", "rating", "reasons", "comment", "date_created"],
            "limit": MAX_LIST_IDS,
        }},
    )
    return [_row_to_model(r) for r in rows] if isinstance(rows, list) else []


@router.get("/responses/admin", response_model=AdminFeedbackPage)
async def list_response_feedback_admin(
    auth: DependencyDirectusSession,
    rating: Optional[str] = None,
    target_type: Optional[str] = None,
    reason: Optional[str] = None,
    chat_mode: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
) -> AdminFeedbackPage:
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")
    filt: dict[str, Any] = {}
    if rating:
        if rating not in RATING_VALUES:
            raise HTTPException(status_code=400, detail="Unknown rating")
        filt["rating"] = {"_eq": rating}
    if target_type:
        if target_type not in TARGET_TYPES:
            raise HTTPException(status_code=400, detail="Unknown target type")
        filt["target_type"] = {"_eq": target_type}
    if reason:
        if reason not in REASON_KEYS:
            raise HTTPException(status_code=400, detail="Unknown reason")
        filt["reason"] = {"_eq": reason}
    if chat_mode:
        if chat_mode not in CHAT_MODES:
            raise HTTPException(status_code=400, detail="Unknown chat mode")
        filt["chat_mode"] = {"_eq": chat_mode}
    if date_from:
        filt["date_created"] = {
            **filt.get("date_created", {}),
            "_gte": _parse_iso_datetime(date_from, "date_from"),
        }
    if date_to:
        filt["date_created"] = {
            **filt.get("date_created", {}),
            "_lte": _parse_iso_datetime(date_to, "date_to"),
        }
    rows = await async_directus.get_items(
        COLLECTION,
        {"query": {
            "filter": filt,
            "fields": ["id", "target_type", "target_id", "rating", "reasons", "comment", "response_snapshot",
                       "context", "date_created", "project_id.id", "project_id.name",
                       "project_id.workspace_id.id", "project_id.workspace_id.name",
                       "project_id.workspace_id.org_id.name",
                       "user_id.email", "user_id.first_name", "user_id.last_name"],
            "sort": ["-date_created"],
            "page": page,
            "limit": limit,
        }},
    )
    items: list[AdminFeedbackRow] = []
    for r in rows if isinstance(rows, list) else []:
        base = _row_to_model(r)
        project = r.get("project_id") if isinstance(r.get("project_id"), dict) else {}
        workspace_raw = project.get("workspace_id")
        workspace: dict[str, Any] = workspace_raw if isinstance(workspace_raw, dict) else {}
        org_raw = workspace.get("org_id")
        org: dict[str, Any] = org_raw if isinstance(org_raw, dict) else {}
        user = r.get("user_id") if isinstance(r.get("user_id"), dict) else {}
        full_name = " ".join(p for p in (user.get("first_name"), user.get("last_name")) if p) or None
        items.append(AdminFeedbackRow(
            **base.model_dump(),
            response_snapshot=r.get("response_snapshot"),
            context=r.get("context") if isinstance(r.get("context"), dict) else {},
            project_id=project.get("id") or _relation_id(r.get("project_id")),
            project_name=project.get("name"),
            workspace_id=workspace.get("id") or _relation_id(project.get("workspace_id")),
            workspace_name=workspace.get("name"),
            org_name=org.get("name"),
            user_name=full_name,
            user_email=user.get("email"),
        ))
    total = await _count_rows(filt, fallback=(page - 1) * limit + len(items))
    return AdminFeedbackPage(items=items, page=page, limit=limit, total=total)


async def _count_rows(filt: dict[str, Any], *, fallback: int) -> int:
    try:
        agg = await async_directus.get_items(
            COLLECTION, {"query": {"aggregate": {"count": "id"}, "filter": filt}}
        )
        if isinstance(agg, list) and agg:
            count = agg[0].get("count")
            if isinstance(count, dict):
                count = count.get("id")
            return int(count)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not count model_response_feedback rows: %s", exc)
    return fallback


@router.delete("/responses/{target_type}/{target_id}", status_code=204, response_model=None)
async def clear_response_feedback(target_type: str, target_id: str, auth: DependencyDirectusSession) -> None:
    await _RATE_LIMITER.check(auth.user_id)
    if target_type not in TARGET_TYPES:
        raise HTTPException(status_code=400, detail="Unknown target type")
    existing = await _find_own_row(auth.user_id, target_type, target_id)
    if existing:
        await async_directus.delete_item(COLLECTION, str(existing["id"]))
