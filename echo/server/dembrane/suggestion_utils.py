"""
Suggestion generation utilities for chat.

This module generates contextual question suggestions using LLM
based on project context, chat mode, and recent conversation history.
"""

import json
import hashlib
import logging
import traceback
from typing import Any, Dict, List, Optional

from litellm import acompletion
from pydantic import BaseModel

from dembrane.llms import MODELS, get_completion_kwargs
from dembrane.prompts import render_prompt
from dembrane.service import (
    build_chat_service,
    build_project_service,
    build_conversation_service,
)
from dembrane.redis_async import get_redis_client
from dembrane.async_helpers import run_in_thread_pool

logger = logging.getLogger(__name__)

# Cache TTL for suggestions (3 minutes)
# Short enough to pick up changes, long enough to avoid redundant LLM calls
SUGGESTIONS_CACHE_TTL_SECONDS = 180

# Use high-quality model for better, more relevant suggestions
SUGGESTION_LLM = MODELS.MULTI_MODAL_PRO


def _generate_cache_key(
    chat_mode: str,
    language: str,
    conversation_ids: List[str],
    has_chat_history: bool,
) -> str:
    """
    Generate a cache key for suggestions based on inputs.

    For deep_dive mode: key is based on sorted conversation IDs + language + has_history
    For overview mode: key is based on project conversations which change less frequently

    The has_chat_history flag differentiates between fresh chats (no messages)
    and chats with history (where last_response and recent_queries matter).
    """
    # Sort conversation IDs for consistent hashing
    sorted_ids = sorted(conversation_ids)
    key_parts = [
        chat_mode,
        language,
        str(has_chat_history),
        ",".join(sorted_ids),
    ]
    key_string = "|".join(key_parts)
    # Use SHA256 hash for a compact, consistent key
    key_hash = hashlib.sha256(key_string.encode()).hexdigest()[:32]
    return f"suggestions:{chat_mode}:{key_hash}"


async def _get_cached_suggestions(cache_key: str) -> Optional[List[Dict[str, str]]]:
    """Try to get cached suggestions from Redis."""
    try:
        redis = await get_redis_client()
        cached = await redis.get(cache_key)
        if cached:
            data = json.loads(cached)
            logger.debug(f"[suggestions] Cache hit for key {cache_key}")
            return data
    except Exception as e:
        logger.warning(f"[suggestions] Cache read error: {e}")
    return None


async def _set_cached_suggestions(cache_key: str, suggestions: List[Dict[str, str]]) -> None:
    """Store suggestions in Redis cache."""
    try:
        redis = await get_redis_client()
        await redis.setex(
            cache_key,
            SUGGESTIONS_CACHE_TTL_SECONDS,
            json.dumps(suggestions),
        )
        logger.debug(f"[suggestions] Cached suggestions with key {cache_key}")
    except Exception as e:
        logger.warning(f"[suggestions] Cache write error: {e}")


class Suggestion(BaseModel):
    """A single suggestion for the user."""

    icon: str  # "sparkles", "search", "quote", "lightbulb", "list"
    label: str  # Short 2-4 word label
    prompt: str  # Full question text


class SuggestionsResult(BaseModel):
    """Result from suggestion generation."""

    suggestions: List[Suggestion]


async def generate_suggestions(
    project_id: str,
    chat_id: str,
    chat_mode: Optional[str],
    language: str,
) -> List[Suggestion]:
    """
    Generate contextual question suggestions for a chat.

    Args:
        project_id: The project ID
        chat_id: The current chat ID
        chat_mode: "overview" or "deep_dive" (or None)
        language: Language code (e.g., "en", "nl")

    Returns:
        List of Suggestion objects (max 3)
    """
    if not chat_mode:
        logger.debug("No chat mode set, returning empty suggestions")
        return []

    try:
        logger.debug(
            f"[suggestions] Starting for chat={chat_id}, project={project_id}, mode={chat_mode}"
        )

        # Initialize services
        project_service = build_project_service()
        chat_service = build_chat_service()
        conversation_service = build_conversation_service()

        # Gather context in parallel
        logger.debug("[suggestions] Fetching project context...")
        project_context_task = run_in_thread_pool(
            project_service.get_context_for_prompt, project_id
        )

        logger.debug("[suggestions] Fetching last assistant message...")
        last_response_task = run_in_thread_pool(chat_service.get_last_assistant_message, chat_id)

        logger.debug("[suggestions] Fetching recent queries...")
        recent_queries_task = run_in_thread_pool(
            chat_service.list_recent_user_queries, project_id, chat_id, 5
        )

        # Get conversation context based on mode
        if chat_mode == "overview":
            logger.debug("[suggestions] Overview mode: fetching all conversations...")
            conversations_task = run_in_thread_pool(
                conversation_service.list_by_project, project_id, False, False
            )
        else:
            logger.debug("[suggestions] Deep dive mode: fetching locked conversations...")
            conversations_task = run_in_thread_pool(
                chat_service.get_locked_conversations_with_summaries, chat_id
            )

        # Await all tasks
        project_context = await project_context_task
        logger.debug(f"[suggestions] project_context type={type(project_context)}")

        last_response = await last_response_task
        logger.debug(
            f"[suggestions] last_response type={type(last_response)}, value={last_response[:100] if last_response else None}..."
        )

        recent_queries = await recent_queries_task
        logger.debug(
            f"[suggestions] recent_queries type={type(recent_queries)}, count={len(recent_queries) if recent_queries else 0}"
        )

        conversations = await conversations_task
        logger.debug(
            f"[suggestions] conversations type={type(conversations)}, count={len(conversations) if conversations else 0}"
        )

        # Check cache for suggestions
        # Cache is most effective for fresh chats (no history) where inputs are stable
        has_chat_history = bool(last_response or (recent_queries and len(recent_queries) > 0))
        conversation_ids = [
            conv.get("id", "") for conv in (conversations or []) if isinstance(conv, dict)
        ]

        cache_key = _generate_cache_key(
            chat_mode=chat_mode,
            language=language,
            conversation_ids=conversation_ids,
            has_chat_history=has_chat_history,
        )

        # Only use cache for fresh chats (no history) - these have stable inputs
        # Chats with history have dynamic inputs (last_response, recent_queries)
        if not has_chat_history:
            cached = await _get_cached_suggestions(cache_key)
            if cached:
                return [Suggestion(**s) for s in cached]

        # Log first conversation structure for debugging
        if conversations and len(conversations) > 0:
            first_conv = conversations[0]
            logger.debug(
                f"[suggestions] First conversation type={type(first_conv)}, value={first_conv}"
            )

        # Extract conversation summaries for context
        # This is the PRIMARY source for suggestions - actual conversation content
        conversation_summaries: List[str] = []
        if conversations:
            for conv in conversations[:10]:  # Limit to 10 for token efficiency
                if isinstance(conv, dict):
                    name = conv.get("participant_name") or conv.get("name") or "Participant"
                    summary = conv.get("summary")
                    if summary:
                        # Truncate long summaries
                        summary_text = summary[:300] + "..." if len(summary) > 300 else summary
                        conversation_summaries.append(f"- {name}: {summary_text}")

        # If we have no meaningful context, return empty - don't generate generic suggestions
        has_summaries = len(conversation_summaries) > 0
        has_last_response = bool(last_response)
        has_recent_queries = bool(recent_queries and len(recent_queries) > 0)

        if not has_summaries and not has_last_response and not has_recent_queries:
            logger.debug(
                "[suggestions] No context available (no summaries, no history), returning empty"
            )
            return []

        # Build template context
        template_context: Dict[str, Any] = {
            "chat_mode": chat_mode,
            "language": language,
            "last_response": last_response,
            "recent_queries": recent_queries,
            "conversation_summaries": conversation_summaries,
            "conversation_count": len(conversations) if conversations else 0,
        }

        logger.debug("[suggestions] Rendering prompts...")
        # Render prompts
        system_prompt = render_prompt("suggestions_system", language, {})
        user_prompt = render_prompt("suggestions_user", language, template_context)

        logger.debug(f"[suggestions] Calling LLM for chat {chat_id} in {chat_mode} mode")

        # Call LLM
        response = await acompletion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            timeout=30,  # 15 seconds - suggestions should be fast
            **get_completion_kwargs(SUGGESTION_LLM),
        )

        # Parse response
        content = response.choices[0].message.content
        if not content:
            logger.warning("Empty response from LLM for suggestions")
            return []

        suggestions = _parse_suggestions(content)
        logger.info(f"Generated {len(suggestions)} suggestions for chat {chat_id}")

        # Cache suggestions for fresh chats (no history)
        if not has_chat_history and suggestions:
            await _set_cached_suggestions(
                cache_key,
                [s.model_dump() for s in suggestions],
            )

        return suggestions

    except Exception as e:
        logger.error(f"Failed to generate suggestions for chat {chat_id}: {e}")
        logger.error(f"[suggestions] Full traceback:\n{traceback.format_exc()}")
        return []


def _parse_suggestions(content: str) -> List[Suggestion]:
    """
    Parse LLM response into Suggestion objects.

    Handles various JSON formats from the LLM.
    """
    try:
        data = json.loads(content)
        logger.debug(
            f"[suggestions] Parsed JSON type={type(data).__name__}, keys={list(data.keys()) if isinstance(data, dict) else 'N/A'}"
        )

        # Handle different formats
        suggestions_data: List[dict] = []

        if isinstance(data, list):
            # Direct array: [{...}, {...}, {...}]
            suggestions_data = data
        elif isinstance(data, dict):
            # Check if this is a single suggestion object (has icon/label/prompt keys)
            if "prompt" in data and ("label" in data or "icon" in data):
                logger.debug("[suggestions] Found single suggestion object, wrapping in list")
                suggestions_data = [data]
            else:
                # Try various common keys the LLM might use
                for key in ("suggestions", "questions", "prompts", "items", "results", "data"):
                    if key in data and isinstance(data[key], list):
                        suggestions_data = data[key]
                        logger.debug(f"[suggestions] Found suggestions under key '{key}'")
                        break
                else:
                    # If no known key, check if dict values contain a list
                    for key, value in data.items():
                        if isinstance(value, list) and len(value) > 0:
                            suggestions_data = value
                            logger.debug(
                                f"[suggestions] Found suggestions under fallback key '{key}'"
                            )
                            break

                    if not suggestions_data:
                        logger.warning(
                            f"[suggestions] Could not find suggestions array in dict with keys: {list(data.keys())}"
                        )
                        return []

        suggestions = []
        for item in suggestions_data[:3]:  # Max 3 suggestions
            if isinstance(item, dict):
                # Validate icon
                icon = item.get("icon", "sparkles")
                if icon not in ("sparkles", "search", "quote", "lightbulb", "list"):
                    icon = "sparkles"

                suggestions.append(
                    Suggestion(
                        icon=icon,
                        label=str(item.get("label", ""))[:50],  # Truncate long labels
                        prompt=str(item.get("prompt", "")),
                    )
                )

        return suggestions

    except json.JSONDecodeError as e:
        logger.error(f"[suggestions] Failed to parse JSON: {e}, content: {content[:200]}...")
        return []
    except Exception as e:
        logger.error(f"[suggestions] Error parsing: {e}")
        return []
