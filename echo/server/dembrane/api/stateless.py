import json
from typing import Any
from logging import getLogger

import nest_asyncio
from fastapi import APIRouter

from dembrane.llms import MODELS, router_completion
from dembrane.prompts import render_prompt

# Enable nested event loops for sync-to-async bridges
nest_asyncio.apply()

logger = getLogger("api.stateless")

StatelessRouter = APIRouter(tags=["stateless"])

# Language code to full name mapping for prompt generation
LANGUAGE_NAMES: dict[str, str] = {
    "en": "English",
    "nl": "Dutch",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
}


def generate_summary(
    transcript: str,
    language: str | None,
    project_context: str | None = None,
    verified_artifacts: list[str] | None = None,
) -> str:
    """
    Generate a summary of the transcript using LangChain and a custom API endpoint.

    Args:
        transcript (str): The conversation transcript to summarize.
        language (str | None): The language of the transcript.
        project_context (str | None): Optional project context to include.
        verified_artifacts (list[str] | None): Optional list of verified artifacts.

    Returns:
        str: The generated summary.
    """
    # Prepare the prompt template
    prompt = render_prompt(
        "generate_conversation_summary",
        language if language else "en",
        {
            "quote_text_joined": transcript,
            "project_context": project_context,
            # Pass empty list instead of None for Jinja iteration safety
            "verified_artifacts": verified_artifacts or [],
        },
    )

    try:
        # Use router for load balancing and failover
        response = router_completion(
            MODELS.MULTI_MODAL_PRO,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
        )
    except Exception as e:
        logger.error(f"LiteLLM completion error: {e}")
        raise

    try:
        response_content = response.choices[0].message.content
        if response_content is None:
            logger.warning("LLM returned None content for summary")
            return ""
        return response_content
    except (IndexError, AttributeError, KeyError) as e:
        logger.error(f"Error getting response content for summary: {e}")
        return ""


def generate_conversation_title(
    summary: str,
    language: str | None,
    existing_titles: list[str] | None = None,
    custom_prompt: str | None = None,
) -> str:
    """
    Generate a 1-3 word title for a conversation based on its summary.

    Args:
        summary (str): The conversation summary to generate a title from.
        language (str | None): The language code (e.g., "en", "nl", "de").
        existing_titles (list[str] | None): Optional list of existing titles for style matching.
        custom_prompt (str | None): Optional custom instructions for title generation.

    Returns:
        str: The generated title.
    """
    language_name = LANGUAGE_NAMES.get(language if language else "en", "English")

    prompt = render_prompt(
        "generate_conversation_title",
        "en",  # Single English prompt that handles multiple languages
        {
            "summary": summary,
            "language_name": language_name,
            "existing_titles": existing_titles or [],
            "custom_prompt": custom_prompt,
        },
    )

    try:
        response = router_completion(
            MODELS.MULTI_MODAL_FAST,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
        )
    except Exception as e:
        logger.error(f"LiteLLM completion error for title generation: {e}")
        raise

    try:
        response_content = response.choices[0].message.content
        if response_content is None:
            logger.warning("LLM returned None content for title")
            return ""
        return response_content.strip()
    except (IndexError, AttributeError, KeyError) as e:
        logger.error(f"Error getting response content for title: {e}")
        return ""


def _extract_json_payload(content: str) -> Any:
    stripped = content.strip()
    if stripped.startswith("```"):
        stripped = stripped.removeprefix("```json").removeprefix("```").strip()
        stripped = stripped.removesuffix("```").strip()
    return json.loads(stripped)


def _select_valid_tag_ids_from_response(
    response_content: str,
    allowed_tag_ids: set[str],
    max_tags: int = 3,
) -> list[str]:
    try:
        parsed = _extract_json_payload(response_content)
    except json.JSONDecodeError:
        logger.warning("LLM returned invalid JSON for conversation tag assignment")
        return []

    raw_ids: list[Any]
    if isinstance(parsed, dict):
        raw_ids = parsed.get("tag_ids") or parsed.get("tags") or []
    elif isinstance(parsed, list):
        raw_ids = parsed
    else:
        return []

    selected: list[str] = []
    for raw_id in raw_ids:
        tag_id = raw_id.get("id") if isinstance(raw_id, dict) else raw_id
        if not isinstance(tag_id, str):
            continue
        tag_id = tag_id.strip()
        if tag_id in allowed_tag_ids and tag_id not in selected:
            selected.append(tag_id)
        if len(selected) >= max_tags:
            break
    return selected


def generate_conversation_tag_ids(
    summary: str,
    language: str | None,
    project_tags: list[dict[str, str]],
) -> list[str]:
    """Choose existing project tags that fit a conversation summary.

    This never creates tags. It only assigns from the host-defined project tag
    vocabulary so the result remains a draft for human review.
    """
    allowed_tag_ids = {
        tag["id"]
        for tag in project_tags
        if isinstance(tag.get("id"), str) and isinstance(tag.get("text"), str)
    }
    if not summary.strip() or not allowed_tag_ids:
        return []

    language_name = LANGUAGE_NAMES.get(language if language else "en", "English")
    prompt = render_prompt(
        "generate_conversation_tag_ids",
        "en",
        {
            "summary": summary,
            "language_name": language_name,
            "project_tags": project_tags,
            "max_tags": 3,
        },
    )

    try:
        response = router_completion(
            MODELS.MULTI_MODAL_FAST,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
        )
    except Exception as e:
        logger.error(f"LiteLLM completion error for tag assignment: {e}")
        raise

    try:
        response_content = response.choices[0].message.content
        if response_content is None:
            logger.warning("LLM returned None content for tag assignment")
            return []
        return _select_valid_tag_ids_from_response(response_content, allowed_tag_ids)
    except (IndexError, AttributeError, KeyError) as e:
        logger.error(f"Error getting response content for tag assignment: {e}")
        return []


def validate_segment_id(echo_segment_ids: list[str] | None) -> bool:
    if echo_segment_ids is None:
        return True
    try:
        [int(id) for id in echo_segment_ids]
        return True
    except Exception as e:
        logger.exception(f"Invalid segment ID: {e}")
        return False


@StatelessRouter.post("/webhook/transcribe")
async def transcribe_webhook(payload: dict) -> None:
    logger = getLogger("stateless.webhook.transcribe")
    logger.debug(f"Transcribe webhook received: {payload}")
    logger.info("Transcription webhook received but integration is disabled; ignoring payload.")
