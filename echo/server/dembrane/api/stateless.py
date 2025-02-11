from logging import getLogger

from fastapi import APIRouter
from litellm import completion
from pydantic import BaseModel
from langchain.prompts import ChatPromptTemplate, HumanMessagePromptTemplate
from fastapi.exceptions import HTTPException

from dembrane.directus import directus
from dembrane.api.dependency_auth import DependencyDirectusSession

logger = getLogger("api.stateless")

StatelessRouter = APIRouter(tags=["stateless"])


class TranscriptRequest(BaseModel):
    system_prompt: str | None = None
    transcript: str


class TranscriptResponse(BaseModel):
    summary: str


@StatelessRouter.post("/summarize")
async def summarize_conversation_transcript(
    # auth: DependencyDirectusSession,
    body: TranscriptRequest,
) -> TranscriptResponse:
    # Use the provided transcript and system prompt (if any) for processing
    system_prompt = body.system_prompt
    transcript = body.transcript

    # Generate a summary from the transcript (placeholder logic)
    summary = await generate_summary(transcript, system_prompt)

    # Return the full transcript as a single string
    return TranscriptResponse(summary=summary)


def raise_if_conversation_not_found_or_not_authorized(
    conversation_id: str, auth: DependencyDirectusSession
) -> None:
    conversation = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {"id": {"_eq": conversation_id}},
                "fields": ["project_id.directus_user_id"],
            }
        },
    )

    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    if not auth.is_admin and conversation[0]["project_id"]["directus_user_id"] != auth.user_id:
        raise HTTPException(
            status_code=403, detail="You are not authorized to access this conversation"
        )


async def generate_summary(transcript: str, system_prompt: str | None) -> str:
    """
    Generate a summary of the transcript using LangChain and a custom API endpoint.

    Args:
        transcript (str): The conversation transcript to summarize.
        system_prompt (str | None): Additional context or instructions for the summary.

    Returns:
        str: The generated summary.
    """
    # Prepare the prompt template
    base_prompt = "You are a helpful assistant. Please summarize the following transcript."
    if system_prompt:
        base_prompt += f"\nContext: {system_prompt}"

    prompt_template = ChatPromptTemplate.from_messages(
        [HumanMessagePromptTemplate.from_template(f"{base_prompt}\n\n{{transcript}}")]
    )
    # Call the model over the provided API endpoint
    response = completion(
        model="ollama/llama3.1:8b",
        messages=[
            {
                "content": prompt_template.format_prompt(transcript=transcript).to_messages(),
                "role": "user",
            }
        ],
        api_base="http://host.docker.internal:8080",
    )

    response_content = response["choices"][0]["message"]["content"]

    return response_content
