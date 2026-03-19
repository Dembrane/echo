import json
import logging
from typing import Any, Optional

from dembrane.llms import MODELS, router_completion
from dembrane.prompts import render_prompt
from dembrane.service import conversation_service
from dembrane.utils import generate_uuid

logger = logging.getLogger("dembrane.signposting")

SIGNPOSTING_LLM = MODELS.MULTI_MODAL_FAST
MAX_ACTIVE_SIGNPOSTS = 12
MAX_READY_CHUNKS = 10
ALLOWED_CATEGORIES = {"agreement", "disagreement", "tension", "theme"}
ALLOWED_STATUSES = {"active", "resolved"}

SIGNPOSTING_RESPONSE_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "live_conversation_signposts",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "create": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "category": {
                                "type": "string",
                                "enum": sorted(ALLOWED_CATEGORIES),
                            },
                            "title": {"type": "string"},
                            "summary": {"type": "string"},
                            "evidence_quote": {"type": "string"},
                            "confidence": {"type": "number"},
                            "evidence_chunk_id": {"type": "string"},
                        },
                        "required": [
                            "category",
                            "title",
                            "summary",
                            "evidence_quote",
                            "confidence",
                            "evidence_chunk_id",
                        ],
                        "additionalProperties": False,
                    },
                },
                "update": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "category": {
                                "type": "string",
                                "enum": sorted(ALLOWED_CATEGORIES),
                            },
                            "title": {"type": "string"},
                            "summary": {"type": "string"},
                            "evidence_quote": {"type": "string"},
                            "confidence": {"type": "number"},
                            "evidence_chunk_id": {"type": "string"},
                        },
                        "required": [
                            "id",
                            "category",
                            "title",
                            "summary",
                            "evidence_quote",
                            "confidence",
                            "evidence_chunk_id",
                        ],
                        "additionalProperties": False,
                    },
                },
                "resolve": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                        },
                        "required": ["id"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["create", "update", "resolve"],
            "additionalProperties": False,
        },
    },
}


def _normalize_focus_terms(raw_value: Optional[str]) -> list[str]:
    if not raw_value:
        return []

    normalized: list[str] = []
    seen: set[str] = set()
    for part in raw_value.replace(",", "\n").splitlines():
        cleaned = part.strip()
        if not cleaned:
            continue
        dedupe_key = cleaned.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        normalized.append(cleaned)
    return normalized


def _sanitize_text(value: Any, max_length: int) -> str:
    if value is None:
        return ""
    cleaned = " ".join(str(value).split())
    if len(cleaned) <= max_length:
        return cleaned
    return cleaned[: max_length - 3].rstrip() + "..."


def _coerce_confidence(value: Any) -> Optional[float]:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return None
    if confidence < 0:
        return 0.0
    if confidence > 1:
        return 1.0
    return confidence


def _dedupe_key(category: str, title: str) -> tuple[str, str]:
    return category.strip().lower(), " ".join(title.lower().split())


def _build_prompt(
    project_context: Optional[str],
    focus_terms: list[str],
    active_signposts: list[dict[str, Any]],
    ready_chunks: list[dict[str, Any]],
) -> str:
    active_payload = [
        {
            "id": signpost.get("id"),
            "category": signpost.get("category"),
            "title": signpost.get("title"),
            "summary": signpost.get("summary"),
            "evidence_quote": signpost.get("evidence_quote"),
            "updated_at": signpost.get("updated_at"),
        }
        for signpost in active_signposts[:MAX_ACTIVE_SIGNPOSTS]
    ]
    chunk_payload = [
        {
            "id": chunk.get("id"),
            "timestamp": chunk.get("timestamp") or chunk.get("created_at"),
            "transcript": chunk.get("transcript"),
        }
        for chunk in ready_chunks[:MAX_READY_CHUNKS]
    ]

    return render_prompt(
        "live_conversation_signposts",
        "en",
        {
            "project_context": project_context or "",
            "focus_terms_json": json.dumps(focus_terms, ensure_ascii=True),
            "active_signposts_json": json.dumps(active_payload, ensure_ascii=True),
            "ready_chunks_json": json.dumps(chunk_payload, ensure_ascii=True),
        },
    )


def generate_signpost_operations(
    project_context: Optional[str],
    focus_terms: list[str],
    active_signposts: list[dict[str, Any]],
    ready_chunks: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    prompt = _build_prompt(project_context, focus_terms, active_signposts, ready_chunks)
    response = router_completion(
        SIGNPOSTING_LLM,
        messages=[
            {
                "role": "user",
                "content": prompt,
            }
        ],
        response_format=SIGNPOSTING_RESPONSE_SCHEMA,
        timeout=45,
    )
    content = response.choices[0].message.content
    if not content:
        return {"create": [], "update": [], "resolve": []}
    return json.loads(content)


def apply_signpost_operations(
    conversation_id: str,
    ready_chunks: list[dict[str, Any]],
    active_signposts: list[dict[str, Any]],
    operations: dict[str, list[dict[str, Any]]],
    service: Any = None,
) -> dict[str, int]:
    svc = service or conversation_service
    chunk_ids = {chunk["id"] for chunk in ready_chunks if chunk.get("id")}
    active_by_id = {
        signpost["id"]: signpost for signpost in active_signposts if signpost.get("id")
    }
    active_by_key = {
        _dedupe_key(
            str(signpost.get("category") or ""),
            str(signpost.get("title") or ""),
        ): signpost
        for signpost in active_signposts
        if signpost.get("category") and signpost.get("title")
    }

    created = 0
    updated = 0
    resolved = 0

    for item in operations.get("update", []):
        signpost_id = item.get("id")
        category = str(item.get("category") or "").lower()
        evidence_chunk_id = item.get("evidence_chunk_id")
        if signpost_id not in active_by_id:
            continue
        if category not in ALLOWED_CATEGORIES or evidence_chunk_id not in chunk_ids:
            continue

        svc.update_signpost(
            signpost_id,
            {
                "category": category,
                "title": _sanitize_text(item.get("title"), 140),
                "summary": _sanitize_text(item.get("summary"), 500),
                "evidence_quote": _sanitize_text(item.get("evidence_quote"), 500),
                "confidence": _coerce_confidence(item.get("confidence")),
                "evidence_chunk_id": evidence_chunk_id,
                "status": "active",
            },
        )
        active_by_key[_dedupe_key(category, str(item.get("title") or ""))] = {
            "id": signpost_id,
            "category": category,
            "title": _sanitize_text(item.get("title"), 140),
        }
        updated += 1

    for item in operations.get("create", []):
        category = str(item.get("category") or "").lower()
        title = _sanitize_text(item.get("title"), 140)
        summary = _sanitize_text(item.get("summary"), 500)
        evidence_quote = _sanitize_text(item.get("evidence_quote"), 500)
        evidence_chunk_id = item.get("evidence_chunk_id")
        if category not in ALLOWED_CATEGORIES or evidence_chunk_id not in chunk_ids:
            continue
        if not title or not summary or not evidence_quote:
            continue

        existing = active_by_key.get(_dedupe_key(category, title))
        payload = {
            "category": category,
            "title": title,
            "summary": summary,
            "evidence_quote": evidence_quote,
            "confidence": _coerce_confidence(item.get("confidence")),
            "evidence_chunk_id": evidence_chunk_id,
            "status": "active",
        }
        if existing and existing.get("id"):
            svc.update_signpost(existing["id"], payload)
            active_by_key[_dedupe_key(category, title)] = {
                "id": existing["id"],
                "category": category,
                "title": title,
            }
            updated += 1
            continue

        signpost_id = generate_uuid()
        svc.create_signpost(
            {
                "id": signpost_id,
                "conversation_id": conversation_id,
                **payload,
            }
        )
        active_by_key[_dedupe_key(category, title)] = {
            "id": signpost_id,
            "category": category,
            "title": title,
        }
        created += 1

    for item in operations.get("resolve", []):
        signpost_id = item.get("id")
        if signpost_id not in active_by_id:
            continue
        svc.update_signpost(signpost_id, {"status": "resolved"})
        resolved += 1

    return {
        "created": created,
        "updated": updated,
        "resolved": resolved,
    }


def refresh_conversation_signposts(
    conversation_id: str,
    service: Any = None,
) -> dict[str, Any]:
    svc = service or conversation_service
    context = svc.get_signposting_context(conversation_id)
    project = context.get("project_id") or {}
    if not project.get("is_signposting_enabled", False):
        logger.debug("Skipping signposts for %s because project config is disabled", conversation_id)
        return {
            "processed_chunk_ids": [],
            "has_more": False,
            "operations": {"created": 0, "updated": 0, "resolved": 0},
        }

    ready_chunks = svc.list_ready_chunks_for_signposting(
        conversation_id,
        limit=MAX_READY_CHUNKS + 1,
    )
    if not ready_chunks:
        return {
            "processed_chunk_ids": [],
            "has_more": False,
            "operations": {"created": 0, "updated": 0, "resolved": 0},
        }

    batch = ready_chunks[:MAX_READY_CHUNKS]
    has_more = len(ready_chunks) > MAX_READY_CHUNKS
    active_signposts = svc.list_signposts(
        conversation_id,
        status="active",
        limit=MAX_ACTIVE_SIGNPOSTS,
    )
    focus_terms = _normalize_focus_terms(project.get("signposting_focus_terms"))
    operations = generate_signpost_operations(
        project_context=project.get("context"),
        focus_terms=focus_terms,
        active_signposts=active_signposts,
        ready_chunks=batch,
    )
    applied = apply_signpost_operations(
        conversation_id=conversation_id,
        ready_chunks=batch,
        active_signposts=active_signposts,
        operations=operations,
        service=svc,
    )
    processed_chunk_ids = [chunk["id"] for chunk in batch if chunk.get("id")]
    svc.mark_chunks_signpost_processed(processed_chunk_ids)

    return {
        "processed_chunk_ids": processed_chunk_ids,
        "has_more": has_more,
        "operations": applied,
    }
