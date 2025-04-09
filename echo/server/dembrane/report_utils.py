import logging

from sqlalchemy.orm import Session

from dembrane.prompts import render_prompt
from dembrane.database import ConversationModel
from dembrane.anthropic import async_anthropic_client, count_tokens_anthropic
from dembrane.api.conversation import get_conversation_transcript
from dembrane.api.dependency_auth import DirectusSession

MAX_REPORT_CONTEXT_LENGTH = 128000


class ContextTooLongException(Exception):
    """Exception raised when the context length exceeds the maximum allowed."""

    pass


logger = logging.getLogger("report_utils")


async def get_report_content_for_project(project_id: str, db: Session, language: str) -> str:
    conversations = (
        db.query(ConversationModel).filter(ConversationModel.project_id == project_id).all()
    )

    token_count = 0
    conversation_data_list = []

    for conversation in conversations:
        transcript = get_conversation_transcript(
            conversation.id,
            # fake auth to get this fn call
            DirectusSession(user_id="none", is_admin=True),
        )

        conversation_data_list.append(
            {
                "name": conversation.participant_name,
                "tags": ", ".join([tag.text for tag in conversation.tags]),
                "transcript": transcript,
            }
        )

        try:
            token_count += count_tokens_anthropic(transcript)

        except Exception as e:
            logger.error(f"Error counting tokens for conversation {conversation.id}: {e}")
            token_count += len(str(transcript).split(" ")) // 4
            continue

        if token_count > MAX_REPORT_CONTEXT_LENGTH:
            logger.info(
                f"Context too long for report for project{project_id}, token count: {token_count}"
            )
            raise ContextTooLongException

    logger.debug(f"Getting report content for project {project_id}. Token count: {token_count}.")

    prompt_message = render_prompt(
        "system_report", language, {"conversations": conversation_data_list}
    )

    response = await async_anthropic_client.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=4096,
        messages=[
            {"role": "user", "content": prompt_message},
            # prefill message
            {"role": "assistant", "content": "<article>"},
        ],
    )

    response_content = response.content[0].text  # type: ignore

    # remove <article> and </article> if found
    response_content = response_content.replace("<article>", "").replace("</article>", "")

    logger.debug(f"Report content for project {project_id}: {response_content}")

    return response_content
