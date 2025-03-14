from logging import getLogger

from fastapi import APIRouter
from litellm import completion
from pydantic import BaseModel

logger = getLogger("api.stateless")

StatelessRouter = APIRouter(tags=["stateless"])


class TranscriptRequest(BaseModel):
    system_prompt: str | None = None
    transcript: str
    language: str | None = None


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
    summary = generate_summary(transcript, system_prompt, body.language)

    # Return the full transcript as a single string
    return TranscriptResponse(summary=summary)


def generate_summary(transcript: str, system_prompt: str | None, language: str | None) -> str:
    """
    Generate a summary of the transcript using LangChain and a custom API endpoint.

    Args:
        transcript (str): The conversation transcript to summarize.
        system_prompt (str | None): Additional context or instructions for the summary.

    Returns:
        str: The generated summary.
    """
    # Prepare the prompt template
    base_prompt = f"You are a helpful assistant. Please provide a summary of the following transcript. Only return the summary itself, do not include any other text. Focus on the most interesting/surprise invoking points of the text. Ignore any personal information. The language of the summary must be in {language}."
    if system_prompt:
        base_prompt += f"\nContext (ignore if None): {system_prompt}"

    final_prompt = f"{base_prompt}\n\n{transcript}"

    # Call the model over the provided API endpoint
    response = completion(
        # model="ollama/llama3.1:8b",
        # api_base="https://llm-demo.ai-hackathon.haven.vng.cloud",
        model="anthropic/claude-3-5-sonnet-20240620",
        messages=[
            {
                "content": final_prompt,
                "role": "user",
            }
        ],
    )

    response_content = response["choices"][0]["message"]["content"]

    return response_content
