from logging import getLogger

from fastapi import APIRouter
from litellm import completion
from pydantic import BaseModel
from flair.data import Sentence
from langdetect import detect
from flair.models import SequenceTagger
from langchain.prompts import ChatPromptTemplate, HumanMessagePromptTemplate

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
    base_prompt = f"You are a helpful assistant. Please provide a summary of the following transcript. Only return the summary itself, do not include any other text. Focus on the most important points of the text. The language of the summary must be in {language}."
    if system_prompt:
        base_prompt += f"\nContext (ignore if None): {system_prompt}"

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
        api_base="https://llm-demo.ai-hackathon.haven.vng.cloud",
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
