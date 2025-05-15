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
                "fields": ["id", "participant_name", "tags.project_tag_id.text", "summary"],
            }
        },
    )

    logger.debug(f"Found {len(conversations)} conversations for project {project_id}")
    logger.debug(f"Conversations: {conversations}")

    token_count = 0
    conversation_data_dict = {}

    # first add all the summaries to the list
    for conversation in conversations:
        logger.info(f"Adding conversation {conversation['id']} to report")

        if conversation["summary"] is None:
            logger.info(f"Conversation {conversation['id']} has no summary")
            continue

        token_count += token_counter(model=MEDIUM_LITELLM_MODEL, text=conversation["summary"])

        tags_text = ""
        for tag in conversation["tags"]:
            tag_text = tag["project_tag_id"]["text"]
            tags_text += tag_text + ", "

        if token_count < MAX_REPORT_CONTEXT_LENGTH:
            conversation_data_dict[conversation["id"]] = {
                "name": conversation["participant_name"],
                "tags": tags_text,
                "transcript": conversation["summary"],
            }
        else:
            logger.info(
                f"Context too long for report for project {project_id}, token count: {token_count}"
            )
            break

    for conversation in conversations:
        transcript = get_conversation_transcript(
            conversation["id"],
            DirectusSession(user_id="none", is_admin=True),
        )

        token_count += token_counter(model=MEDIUM_LITELLM_MODEL, text=transcript)

        if token_count < MAX_REPORT_CONTEXT_LENGTH:
            conversation_data_dict[conversation["id"]]["transcript"] = (
                conversation_data_dict[conversation["id"]]["transcript"] + transcript
            )
        else:
            logger.info(
                f"Context too long for report for project {project_id}, token count: {token_count}"
            )
            break

    conversation_data_list = list(conversation_data_dict.values())

    logger.debug(f"Getting report content for project {project_id}. Token count: {token_count}.")

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
