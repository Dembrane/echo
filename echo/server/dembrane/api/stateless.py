from logging import getLogger

import nest_asyncio
from fastapi import APIRouter
from litellm import completion

from dembrane.llms import MODELS, get_completion_kwargs
from dembrane.prompts import render_prompt

# LightRAG requires nest_asyncio for nested event loops
nest_asyncio.apply()

logger = getLogger("api.stateless")

StatelessRouter = APIRouter(tags=["stateless"])


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
        response = completion(
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
            **get_completion_kwargs(MODELS.MULTI_MODAL_PRO),
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
