import re
import logging

from litellm import completion
from litellm.utils import token_counter

from dembrane.config import (
    MEDIUM_LITELLM_MODEL,
    MEDIUM_LITELLM_API_KEY,
    MEDIUM_LITELLM_API_BASE,
    MEDIUM_LITELLM_API_VERSION,
)
from dembrane.prompts import render_prompt
from dembrane.directus import directus
from dembrane.api.conversation import get_conversation_transcript
from dembrane.api.dependency_auth import DirectusSession

logger = logging.getLogger("report_utils")

if "4.1" in str(MEDIUM_LITELLM_MODEL):
    logger.info("using 700k context length for report")
    MAX_REPORT_CONTEXT_LENGTH = 700000
else:
    logger.info("using 128k context length for report")
    MAX_REPORT_CONTEXT_LENGTH = 128000


class ContextTooLongException(Exception):
    """Exception raised when the context length exceeds the maximum allowed."""

    pass


async def get_report_content_for_project(project_id: str, language: str) -> str:
    conversations = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "project_id": project_id,
                },
                "fields": [
                    "id",
                    "participant_name",
                    "tags.project_tag_id.text",
                    "summary",
                    "created_at",
                    "updated_at",
                ],
                # Sort by updated_at descending to get most recent conversations first
                "sort": "-updated_at",
            }
        },
    )

    logger.debug(f"Found {len(conversations)} conversations for project {project_id}")
    logger.debug(f"Conversations: {conversations}")

    token_count = 0
    conversation_data_dict: dict = {}

    # first add all the summaries to the list
    for conversation in conversations:
        logger.info(f"Adding conversation {conversation['id']} to report")

        if conversation["summary"] is None:
            logger.info(f"Conversation {conversation['id']} has no summary")
            continue

        # Count tokens before adding
        summary_tokens = token_counter(model=MEDIUM_LITELLM_MODEL, text=conversation["summary"])

        # Check if adding this conversation would exceed the limit
        if token_count + summary_tokens >= MAX_REPORT_CONTEXT_LENGTH:
            logger.info(
                f"Reached context limit. Added {len(conversation_data_dict)} conversations. "
                f"Token count: {token_count}, attempted to add: {summary_tokens}"
            )
            break

        # Guard against missing or null tags coming back from the API
        try:
            tags = conversation["tags"] or []
        except KeyError:
            tags = []

        tags_text = ""
        for tag in tags:
            # In some older DB dumps we have seen empty tag objects – guard against that too
            try:
                tag_text = tag["project_tag_id"]["text"]
                tags_text += tag_text + ", "
            except (KeyError, TypeError):
                continue

        # Add the conversation after confirming it fits
        conversation_data_dict[conversation["id"]] = {
            "name": conversation["participant_name"],
            "tags": tags_text,
            "transcript": conversation["summary"],
            "created_at": conversation.get("created_at"),
            "updated_at": conversation.get("updated_at"),
        }
        token_count += summary_tokens

    # Now try to add full transcripts for conversations that have summaries
    # Process in the same order (most recent first)
    for conversation in conversations:
        # Only attempt to append a transcript if the conversation was added during the
        # first pass (i.e. it had a non-empty summary).
        if conversation["id"] not in conversation_data_dict:
            continue

        transcript = await get_conversation_transcript(
            conversation["id"],
            DirectusSession(user_id="none", is_admin=True),
        )

        # Gracefully handle a null / empty transcript
        transcript = transcript or ""
        if transcript == "":
            logger.info(f"Conversation {conversation['id']} has empty transcript – skipping")
            continue

        # Calculate token count for the transcript
        transcript_tokens = token_counter(model=MEDIUM_LITELLM_MODEL, text=transcript)

        if token_count + transcript_tokens < MAX_REPORT_CONTEXT_LENGTH:
            # Append with a newline to keep paragraphs separated
            conversation_data_dict[conversation["id"]]["transcript"] += "\n" + transcript
            token_count += transcript_tokens
            logger.info(
                f"Added transcript for conversation {conversation['id']}. Total tokens: {token_count}"
            )
        else:
            logger.info(
                f"Cannot add transcript for conversation {conversation['id']}. "
                f"Would exceed limit: {token_count} + {transcript_tokens} > {MAX_REPORT_CONTEXT_LENGTH}"
            )
            # Since conversations are sorted by recency, if we can't fit this one,
            # we likely can't fit any subsequent ones either
            break

    conversation_data_list = list(conversation_data_dict.values())

    logger.info(
        f"Report for project {project_id} will include {len(conversation_data_list)} conversations. "
        f"Total token count: {token_count} of {MAX_REPORT_CONTEXT_LENGTH} allowed."
    )

    prompt_message = render_prompt(
        "system_report", language, {"conversations": conversation_data_list}
    )

    # Use litellm.completion instead of anthropic client
    response = completion(
        model=MEDIUM_LITELLM_MODEL,
        api_key=MEDIUM_LITELLM_API_KEY,
        api_version=MEDIUM_LITELLM_API_VERSION,
        api_base=MEDIUM_LITELLM_API_BASE,
        # max tokens needed for "anthropic"
        # max_tokens=4096,
        messages=[
            {"role": "user", "content": prompt_message},
            # prefill message only for "anthropic"
            # {"role": "assistant", "content": "<article>"},
        ],
    )

    response_content = response.choices[0].message.content

    # Extract content between <article> tags
    article_pattern = r"<article>(.*?)</article>"
    match = re.search(article_pattern, response_content, re.DOTALL)

    if match:
        response_content = match.group(1)
    else:
        # If no <article> tags found, keep original content but remove any existing tags
        response_content = response_content.replace("<article>", "").replace("</article>", "")

    logger.debug(f"Report content for project {project_id}: {response_content}")

    return response_content
