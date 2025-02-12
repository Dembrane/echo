from logging import getLogger

from fastapi import APIRouter
from litellm import completion
from pydantic import BaseModel
from flair.data import Sentence
from langdetect import detect
from flair.models import SequenceTagger
from langchain.prompts import ChatPromptTemplate, HumanMessagePromptTemplate
from fastapi.exceptions import HTTPException

from dembrane.directus import directus
from dembrane.api.dependency_auth import DependencyDirectusSession

logger = getLogger("api.stateless")

StatelessRouter = APIRouter(tags=["stateless"])

language_models = [
    {"lang": "nl", "model": SequenceTagger.load("flair/ner-dutch-large"), "person_tag": "PER", "replacement": "[Persoon]"},
    {"lang": "en", "model": SequenceTagger.load("xlm-roberta-large"), "person_tag": "PER", "replacement": "[Person]"}
]

class AudioFileRequest(BaseModel):
    audio_file_path: str

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

@StatelessRouter.post("/anonymize")
async def anonymize_conversation_transcript(
    # auth: DependencyDirectusSession,
    body: TranscriptRequest,
) -> TranscriptResponse:
    # Use the provided transcript (if any) for processing
    transcript = body.transcript

    # Generate a summary from the transcript (placeholder logic)
    anonymized_text = await anonymize_text(transcript)

    # Return the full transcript as a single string
    return TranscriptResponse(summary=anonymized_text)


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

async def anonymize_text(text):
    try:
        detected_lang = detect(text)
    except Exception:
        detected_lang = "unknown"

    # Zoek het juiste model op basis van de taal
    tagger_info = next((lm for lm in language_models if lm["lang"] == detected_lang), None)

    if not tagger_info:
        return text  # Geen geschikt model gevonden

    tagger = tagger_info["model"]
    person_tag = tagger_info["person_tag"]
    replacement = tagger_info["replacement"]

    # Maak een Flair-zin en pas NER toe
    sentence = Sentence(text)
    tagger.predict(sentence)

    # Vervang persoonsnamen
    for entity in sentence.get_spans("ner"):
        if entity.tag == person_tag:
            text = text.replace(entity.text, replacement)

    return text
